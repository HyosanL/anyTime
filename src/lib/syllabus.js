// 강의 PDF → 구조화 → 기존 DB 대조 플랜 → 적용.
// 흐름: pdf.js(브라우저)로 페이지 텍스트 추출 → /api/parse-syllabus(Workers AI)로 구조화
//      → reconcile(기존 catalog와 대조: 과목 병합/교수 매칭·동명이인) → admin-action 으로 적용.
// 무거운 pdfjs 는 이 모듈을 동적 import 하는 관리자 화면에서만 로드된다.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { supabase } from '../supabase';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const DAY_KO = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 };

// ---------- PDF → 페이지별 텍스트 ----------
async function pageToText(page) {
  const tc = await page.getTextContent();
  const lines = {};
  for (const it of tc.items) {
    if (!it.str) continue;
    const y = Math.round(it.transform[5]);
    (lines[y] ??= []).push({ x: it.transform[4], s: it.str });
  }
  return Object.keys(lines)
    .map(Number)
    .sort((a, b) => b - a) // 위에서 아래로
    .map((y) => lines[y].sort((a, b) => a.x - b.x).map((i) => i.s).join(' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export async function extractPdfPages(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    pages.push(await pageToText(page)); // eslint-disable-line no-await-in-loop
  }
  return pages;
}

// ---------- Workers AI 파싱 호출 ----------
async function authHeader() {
  const { data } = await supabase.auth.getSession();
  const t = data?.session?.access_token;
  return t ? `Bearer ${t}` : '';
}

async function callParse(kind, text, token) {
  try {
    const res = await fetch('/api/parse-syllabus', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ kind, text }),
    });
    if (!res.ok) return [];
    const j = await res.json().catch(() => ({}));
    return Array.isArray(j.rows) ? j.rows : [];
  } catch {
    return [];
  }
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- 정규화 ----------
const cleanName = (s) => String(s || '').replace(/\s+/g, '').trim();
const cleanProf = (s) => {
  const first = String(s || '').split(/[,，]/)[0]; // 팀티칭이면 대표 1명
  const n = first.replace(/\s+/g, '').trim();
  return n || null;
};

function normRow(r) {
  const course = cleanName(r.course);
  const sectionNo = Number(r.sectionNo) || 1;
  if (!course) return null;
  const times = Array.isArray(r.times)
    ? r.times
        .map((t) => ({ day: Number(t.day) || DAY_KO[String(t.day)] || 0, period: Number(t.period) || 0 }))
        .filter((t) => t.day >= 1 && t.day <= 7 && t.period >= 1)
    : [];
  return {
    course,
    credits: r.credits == null ? null : Number(r.credits) || null,
    sectionNo,
    professor: cleanProf(r.professor),
    department: r.department ? String(r.department).trim() : null,
    times,
    room: r.room ? String(r.room).trim() : null,
  };
}

// 연속 교시를 한 블록으로 묶음: [{day,period}] → [{day,start,end}]
function groupTimes(slots) {
  const byDay = {};
  for (const s of slots) (byDay[s.day] ??= new Set()).add(s.period);
  const blocks = [];
  for (const day of Object.keys(byDay)) {
    const ps = [...byDay[day]].sort((a, b) => a - b);
    let start = ps[0];
    let prev = ps[0];
    for (let i = 1; i < ps.length; i++) {
      if (ps[i] === prev + 1) prev = ps[i];
      else { blocks.push({ day: Number(day), start, end: prev }); start = ps[i]; prev = ps[i]; }
    }
    blocks.push({ day: Number(day), start, end: prev });
  }
  return blocks;
}

// ---------- 메인: PDF → rows + periods ----------
export async function parseSyllabus(file, { onProgress } = {}) {
  const pages = await extractPdfPages(file);
  const coursePages = pages.filter((p) => p.includes('담당교수'));
  const periodPages = pages.filter((p) => p.includes('일과시간표') || (p.includes('교시') && p.includes('점심식사')));
  const token = await authHeader();

  let periods = [];
  if (periodPages.length) {
    const raw = await callParse('periods', periodPages[0], token);
    periods = raw
      .map((p) => ({ no: Number(p.no) || 0, start: String(p.start || '').slice(0, 5), end: String(p.end || '').slice(0, 5) }))
      .filter((p) => p.no >= 1 && /^\d\d:\d\d$/.test(p.start) && /^\d\d:\d\d$/.test(p.end))
      .sort((a, b) => a.no - b.no);
  }

  let done = 0;
  const perPage = await mapLimit(coursePages, 3, async (txt) => {
    const rows = await callParse('courses', txt, token);
    done += 1;
    onProgress?.(done, coursePages.length);
    return rows.map(normRow).filter(Boolean);
  });

  // 페이지 간 중복(교양선택 등 반복) 제거: course|sectionNo 키
  const byKey = new Map();
  for (const r of perPage.flat()) {
    const key = `${r.course}|${r.sectionNo}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, r);
    else {
      // 더 정보가 많은 쪽 유지(교수/시간 보강)
      if (!prev.professor && r.professor) prev.professor = r.professor;
      if (!prev.department && r.department) prev.department = r.department;
      if ((r.times?.length || 0) > (prev.times?.length || 0)) prev.times = r.times;
      if (!prev.room && r.room) prev.room = r.room;
      if (prev.credits == null && r.credits != null) prev.credits = r.credits;
    }
  }
  return { rows: [...byKey.values()], periods, pageCount: pages.length, coursePages: coursePages.length };
}

// ---------- CSV 소스: 표 CSV → rows (parseSyllabus 와 같은 rows 형태) ----------
// 헤더 인식(유연): 과목명/학점/분반/담당교수/학과/강의시간/강의실. 그 외 열(대상·비고 등)은 무시.
// 분반을 비우면 과목별 파일 등장 순서대로 1,2,3… 자동 부여(명시된 번호와 겹치지 않게).
// 강의시간은 "수1 수2 금1"(요일+교시), 연속은 "수1-2"/"수1~2" 허용. 팀티칭 교수는 첫 1명만 사용.
const CSV_ALIASES = {
  course: ['과목명', '과목', 'course', 'name'],
  credits: ['학점', 'credits', 'credit'],
  sectionNo: ['분반', 'section', '섹션'],
  professor: ['담당교수', '교수', 'professor', 'prof'],
  department: ['학과', '소속', 'department', 'dept'],
  times: ['강의시간', '시간', 'times', 'time'],
  room: ['강의실', '장소', 'room'],
};

// RFC4180 유사: 따옴표/이스케이프("") 처리해 [행][열] 문자열 표를 만든다.
function parseCsvTable(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function mapCsvHeader(header) {
  const idx = { course: -1, credits: -1, sectionNo: -1, professor: -1, department: -1, times: -1, room: -1 };
  header.forEach((h, i) => {
    const key = String(h || '').replace(/\s+/g, '').toLowerCase();
    if (!key) return;
    for (const [field, aliases] of Object.entries(CSV_ALIASES)) {
      if (idx[field] === -1 && aliases.some((a) => key.includes(a))) idx[field] = i;
    }
  });
  return idx;
}

// "수1 수2 금1" / "수1-2" → [{day,period}]
export function parseTimeString(str) {
  const out = [];
  for (const tok of String(str || '').split(/[\s,]+/)) {
    const m = tok.match(/^([월화수목금토일])(\d+)(?:[-~](\d+))?$/);
    if (!m) continue;
    const day = DAY_KO[m[1]];
    const a = Number(m[2]);
    const b = m[3] ? Number(m[3]) : a;
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.push({ day, period: p });
  }
  return out;
}

export function parseCsvRows(text) {
  const table = parseCsvTable(text).filter((r) => r.some((c) => String(c).trim()));
  if (!table.length) return { rows: [], periods: [] };
  let hi = table.findIndex((r) => r.some((c) => /과목|course/i.test(c)));
  if (hi < 0) hi = 0;
  const idx = mapCsvHeader(table[hi]);
  const hasHeader = idx.course >= 0;
  if (!hasHeader) { idx.course = 0; idx.credits = 1; idx.sectionNo = 2; idx.professor = 3; idx.department = 4; idx.times = 5; idx.room = 6; }
  const get = (r, k) => (idx[k] >= 0 ? String(r[idx[k]] ?? '').trim() : '');

  const prelim = [];
  for (const r of table.slice(hasHeader ? hi + 1 : 0)) {
    if (/^\s*#/.test(r[0] ?? '')) continue; // 주석행
    const course = cleanName(get(r, 'course'));
    if (!course) continue;
    prelim.push({
      course,
      credits: get(r, 'credits') ? Number(get(r, 'credits')) || null : null,
      sectionRaw: get(r, 'sectionNo'),
      professor: get(r, 'professor'),
      department: get(r, 'department') || null,
      times: parseTimeString(get(r, 'times')),
      room: get(r, 'room') || null,
    });
  }

  // 분반 자동 부여: 명시된 번호를 먼저 예약한 뒤, 빈 칸에 과목별로 빈 최소 번호 채움.
  const used = new Map();
  const setOf = (c) => used.get(c) ?? used.set(c, new Set()).get(c);
  for (const p of prelim) { const n = Number(p.sectionRaw); if (p.sectionRaw && n > 0) setOf(p.course).add(n); }
  const nextFree = (c) => { const s = setOf(c); let n = 1; while (s.has(n)) n += 1; s.add(n); return n; };

  const rows = prelim
    .map((p) => normRow({
      course: p.course,
      credits: p.credits,
      sectionNo: (p.sectionRaw && Number(p.sectionRaw) > 0) ? Number(p.sectionRaw) : nextFree(p.course),
      professor: p.professor,
      department: p.department,
      times: p.times,
      room: p.room,
    }))
    .filter(Boolean);
  return { rows, periods: [] };
}

export const CSV_TEMPLATE = [
  '과목명,학점,분반,담당교수,학과,강의시간,강의실,대상',
  '# 분반을 비우면 과목별로 1,2,3… 자동 부여됩니다. 시간은 "요일+교시"(예: 수1 수2 금1), 연속교시는 수1-2 도 가능. 팀티칭은 대표교수 1명만.',
  '기초물리학및실험,2,,김득수,,수1 수2 금1,403,3반',
  '기초물리학및실험,2,,김득수,,수5 수6 금3,403,4반',
  '대학수학,3,,이용균,,화6 목3 목4,401,1반',
  '대학수학,3,,이용균,,화5 목1 목2,402,2반',
].join('\n');

// ---------- 대조(reconcile): 기존 catalog와 비교 ----------
// catalog: { course[], professor[], section[], section_time[] }
export function reconcile(rows, periods, catalog, year, term) {
  const courses = catalog?.course ?? [];
  const profs = catalog?.professor ?? [];
  const sections = catalog?.section ?? [];

  const courseByName = new Map();
  for (const c of courses) if (!courseByName.has(c.name)) courseByName.set(c.name, c);
  const profsByName = new Map();
  for (const p of profs) (profsByName.get(p.name) ?? profsByName.set(p.name, []).get(p.name)).push(p);

  // 과목별 그룹
  const courseGroups = new Map();
  for (const r of rows) {
    const g = courseGroups.get(r.course) ?? courseGroups.set(r.course, { name: r.course, credits: null, sections: new Map() }).get(r.course);
    if (g.credits == null && r.credits != null) g.credits = r.credits;
    const sec = g.sections.get(r.sectionNo) ?? g.sections.set(r.sectionNo, { sectionNo: r.sectionNo, professor: r.professor, slots: [], room: r.room }).get(r.sectionNo);
    if (!sec.professor && r.professor) sec.professor = r.professor;
    if (!sec.room && r.room) sec.room = r.room;
    sec.slots.push(...r.times);
  }

  // 교수별 추정 학과 + 가르치는 과목코드 모으기
  const profDept = new Map(); // name -> dept(추정)
  const profCourseCodes = new Map(); // name -> Set(course_code) (기존에 있는 과목만)
  for (const r of rows) {
    if (!r.professor) continue;
    if (!profDept.has(r.professor) && r.department) profDept.set(r.professor, r.department);
    const existing = courseByName.get(r.course);
    if (existing) (profCourseCodes.get(r.professor) ?? profCourseCodes.set(r.professor, new Set()).get(r.professor)).add(existing.code);
  }

  // 교수 해석(매칭/신규/동명이인)
  const profNames = [...new Set(rows.map((r) => r.professor).filter(Boolean))];
  const professors = profNames.map((name) => {
    const matches = profsByName.get(name) ?? [];
    const candidates = matches.map((m) => ({ code: m.code, department: m.department }));
    if (matches.length === 0) {
      return { name, code: null, action: 'create', department: profDept.get(name) ?? null, candidates };
    }
    if (matches.length === 1) {
      return { name, code: matches[0].code, action: 'match', department: matches[0].department ?? null, candidates };
    }
    // 동명이인: 과목 이력으로 보정
    const myCodes = profCourseCodes.get(name) ?? new Set();
    const byHistory = matches.find((m) => sections.some((s) => s.professor_code === m.code && myCodes.has(s.course_code)));
    const pick = byHistory ?? matches[0];
    return {
      name, code: pick.code, action: byHistory ? 'match' : 'ambiguous',
      department: pick.department ?? null, candidates,
    };
  });

  // 과목 플랜
  const courseList = [...courseGroups.values()].map((g) => {
    const existing = courseByName.get(g.name);
    return {
      name: g.name,
      code: existing?.code ?? null,
      credits: g.credits,
      include: true,
      sections: [...g.sections.values()]
        .sort((a, b) => a.sectionNo - b.sectionNo)
        .map((s) => ({ sectionNo: s.sectionNo, professorName: s.professor, times: groupTimes(s.slots), room: s.room })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));

  return {
    year, term,
    periods, includePeriods: periods.length > 0,
    professors: professors.sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    courses: courseList,
    stats: {
      courses: courseList.length,
      newCourses: courseList.filter((c) => c.code == null).length,
      professors: professors.length,
      newProfessors: professors.filter((p) => p.action === 'create').length,
      ambiguous: professors.filter((p) => p.action === 'ambiguous').length,
    },
  };
}

// ---------- 적용 ----------
async function callAdmin(action, payload) {
  const { data, error } = await supabase.functions.invoke('admin-action', { body: { action, payload } });
  if (error) {
    let status;
    try { status = (await error.context?.json?.())?.status; } catch { /* ignore */ }
    throw new Error(status || error.message || 'admin-action 실패');
  }
  if (data?.status && data.status !== 'OK') throw new Error(data.status);
  return data;
}

export async function applyPlan(plan, { onProgress } = {}) {
  // 1) 교수 + 교시
  const meta = await callAdmin('apply_syllabus_meta', {
    year: plan.year,
    term: plan.term,
    periods: plan.includePeriods ? plan.periods : [],
    professors: plan.professors.map((p) => ({
      name: p.name, code: p.code, department: p.department || null,
      create: p.code == null, update: !!p.update && p.code != null,
    })),
  });
  const profCodes = meta.profCodes || {};

  // 2) 과목 배치 적용
  const courses = plan.courses.filter((c) => c.include !== false);
  let totalC = 0;
  let totalS = 0;
  let done = 0;
  const BATCH = 12;
  for (let i = 0; i < courses.length; i += BATCH) {
    const batch = courses.slice(i, i + BATCH).map((c) => ({
      name: c.name, code: c.code, credits: c.credits, create: c.code == null,
      sections: c.sections.map((s) => ({
        sectionNo: s.sectionNo,
        professorCode: s.professorName ? (profCodes[s.professorName] ?? null) : null,
        times: s.times,
        room: s.room,
      })),
    }));
    // eslint-disable-next-line no-await-in-loop
    const r = await callAdmin('apply_syllabus_courses', { year: plan.year, term: plan.term, courses: batch });
    totalC += r.courses || 0;
    totalS += r.sections || 0;
    done += batch.length;
    onProgress?.(done, courses.length);
  }
  return { courses: totalC, sections: totalS };
}
