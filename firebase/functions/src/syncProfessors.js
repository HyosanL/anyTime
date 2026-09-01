// Port of supabase/functions/sync-professors/index.ts (retrieved from git history —
// removed during Supabase cleanup, revived per user request 2026-09-01).
// Crawls the academy's official '교수소개' pages and diffs against the `professors`
// collection. Non-destructive by design: only adds new professors and updates
// department/office on exact-name matches — never deletes, and same-name
// collisions (겸직/동명이인) are surfaced but never auto-applied.
import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAdmin, invalid } from './lib/context.js';
import { genCatalogCode } from './admin/catalogActions.js';

// ── 공사 홈페이지 교수소개 구조 (원본 그대로) ──────────────────────────
const BASE = 'https://rokaf.airforce.mil.kr';
const DIVISIONS = [
  { id: '1437', name: '인문학처' },
  { id: '1431', name: '사회과학처' },
  { id: '1501', name: '이학처' },
  { id: '1421', name: '공학처' },
];
const STANDALONE = [
  { id: '1428', name: '항공체육처' },
  { id: '1417', name: '교수부장' },
];
const MAX_PAGES = 8;
const CONCURRENCY = 5;

const clean = (s) => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// 이름 정규화: 괄호주석 제거 → 순수 한글이면 내부 공백 제거(외국인명은 공백 유지)
function normName(raw) {
  let s = clean(raw).split(/[(（]/)[0].trim();
  if (!s) return null;
  if (!/[A-Za-z]/.test(s)) s = s.replace(/\s+/g, '');
  return /^[가-힣A-Za-z·.\s]{2,20}$/.test(s) ? s : null;
}

async function fetchPage(id, page = 1) {
  const url = `${BASE}/afa/${id}/subview.do${page > 1 ? `?page=${page}` : ''}`;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(to);
  }
}

function discoverChildren(html) {
  const out = [];
  const re = /<li id="li_4_(\d+)"[\s\S]*?href="\/afa\/(\d+)\/subview\.do"[\s\S]*?value="([^"]*)"\s*\/?>/g;
  let m;
  while ((m = re.exec(html))) out.push({ id: m[2], dept: clean(m[3]) });
  return out;
}

function parseProfessors(html, dept) {
  const out = [];
  const re = /jf_viewArtcl\('afa',\s*'(\d+)',\s*'(\d+)'\)([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const block = m[3];
    const nameM = block.match(/artclTitle[\s\S]*?<strong>\s*([\s\S]*?)\s*<\/strong>/);
    const name = nameM ? normName(nameM[1]) : null;
    if (!name) continue;
    const field = (label) => {
      const fm = block.match(new RegExp(`${label}\\s*:\\s*</strong>([^<]*)`));
      return fm ? (clean(fm[1]) || null) : null;
    };
    out.push({
      name, dept,
      position: field('직위 또는 학위'),
      degree: field('최종학력'),
      phone: field('전화번호'),
      research: field('연구분야'),
      office: field('연구실'),
    });
  }
  return out;
}

async function crawlLeaf(id, dept) {
  const collected = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchPage(id, page);
    const profs = parseProfessors(html, dept);
    if (profs.length === 0) break;
    let fresh = 0;
    for (const p of profs) {
      if (seen.has(p.name)) continue;
      seen.add(p.name); collected.push(p); fresh++;
    }
    if (fresh === 0) break;
  }
  return collected;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function scrapeAll() {
  const errors = [];
  const leaves = new Map();

  await mapLimit(DIVISIONS, CONCURRENCY, async (d) => {
    try {
      const kids = discoverChildren(await fetchPage(d.id, 1));
      if (kids.length) for (const k of kids) leaves.set(k.id, k.dept);
      else leaves.set(d.id, d.name);
    } catch (e) {
      errors.push(`${d.name}(${d.id}): ${e.message}`);
    }
  });
  for (const s of STANDALONE) leaves.set(s.id, s.name);

  const leafList = [...leaves.entries()].map(([id, dept]) => ({ id, dept }));
  const perLeaf = await mapLimit(leafList, CONCURRENCY, async (l) => {
    try {
      return await crawlLeaf(l.id, l.dept);
    } catch (e) {
      errors.push(`${l.dept}(${l.id}): ${e.message}`);
      return [];
    }
  });

  const profs = [];
  const seen = new Set();
  for (const list of perLeaf) {
    for (const p of list) {
      if (seen.has(p.name)) continue;
      seen.add(p.name); profs.push(p);
    }
  }
  return { profs, departments: [...leaves.values()], errors };
}

// 크롤 결과 ↔ Firestore professors 비교(이름 기준 매칭). dbRows: [{code, name, department, office}]
function diffProfessors(scraped, dbRows) {
  const byName = new Map();
  for (const r of dbRows) {
    const arr = byName.get(r.name) ?? [];
    arr.push(r); byName.set(r.name, arr);
  }
  const add = [];
  const deptChanges = [];
  const officeChanges = [];
  const ambiguous = [];
  let unchanged = 0;
  for (const p of scraped) {
    const rows = byName.get(p.name) ?? [];
    if (rows.length === 0) { add.push(p); continue; }
    if (rows.length > 1) { ambiguous.push({ name: p.name, dept: p.dept }); continue; }
    const r = rows[0];
    let changed = false;
    if ((r.department ?? '') !== p.dept) {
      deptChanges.push({ code: r.code, name: p.name, from: r.department, to: p.dept }); changed = true;
    }
    if (p.office && (r.office ?? '') !== p.office) {
      officeChanges.push({ code: r.code, name: p.name, from: r.office, to: p.office }); changed = true;
    }
    if (!changed) unchanged++;
  }
  const scrapedNames = new Set(scraped.map((p) => p.name));
  const orphans = dbRows
    .filter((r) => !scrapedNames.has(r.name))
    .map((r) => ({ code: r.code, name: r.name, department: r.department }));
  return { add, deptChanges, officeChanges, ambiguous, orphans, unchanged };
}

// onCall(admin-only) — matches src/pages/Admin.jsx's existing invokeSync() call
// (already wired client-side, was 404ing until this function existed).
// payload: { mode: 'preview' | 'apply' }. No separate cron/secret path (the old
// pg_cron trigger for this was already disabled before the Firebase migration).
export const syncProfessors = onCall({ timeoutSeconds: 180 }, async (request) => {
  requireAdmin(request);
  const mode = request.data?.mode === 'apply' ? 'apply' : 'preview';

  const { profs, departments, errors } = await scrapeAll();
  if (profs.length === 0) {
    // 사이트 접근 실패 등으로 한 명도 못 읽으면 절대 반영하지 않는다(기존 데이터 보호).
    return { status: 'NO_DATA', detail: '교수 명단을 가져오지 못했습니다.', errors };
  }

  const snap = await db.collection('professors').get();
  const dbRows = snap.docs.map((d) => ({ code: d.id, name: d.get('name'), department: d.get('department') ?? null, office: d.get('office') ?? null }));
  const d = diffProfessors(profs, dbRows);

  if (mode === 'preview') {
    return {
      status: 'OK', mode,
      scanned: { departments: departments.length, professors: profs.length },
      departments,
      add: d.add.map((p) => ({ name: p.name, department: p.dept, office: p.office })),
      deptChanges: d.deptChanges,
      officeChanges: d.officeChanges,
      ambiguous: d.ambiguous,
      orphans: d.orphans,
      unchanged: d.unchanged,
      errors,
    };
  }

  // ── 반영(apply): 추가 + 학과/연구실 변경만. 삭제/보류(동명이인·orphan)는 손대지 않음. ──
  let added = 0;
  for (const p of d.add) {
    const code = await genCatalogCode('professors', 'P', 6);
    await db.collection('professors').doc(code).set({ name: p.name, department: p.dept, office: p.office ?? null });
    added++;
  }
  let updated = 0;
  for (const c of d.deptChanges) {
    await db.collection('professors').doc(c.code).update({ department: c.to });
    updated++;
  }
  let officeUpdated = 0;
  for (const c of d.officeChanges) {
    await db.collection('professors').doc(c.code).update({ office: c.to });
    officeUpdated++;
  }
  if (added || updated || officeUpdated) {
    await db.doc('config/app').update({ catalogVersion: FieldValue.increment(1) });
  }
  const syncedAt = new Date().toISOString();
  await db.doc('config/secrets').set({ professorsSyncedAt: syncedAt }, { merge: true });

  return {
    status: 'OK', mode,
    scanned: { departments: departments.length, professors: profs.length },
    added, updated, officeUpdated, unchanged: d.unchanged,
    ambiguous: d.ambiguous.length, orphans: d.orphans.length,
    syncedAt, errors,
  };
});
