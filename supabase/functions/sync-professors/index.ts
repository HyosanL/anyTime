// =====================================================================
//  애타 (AnyTime) — 교수 명단 동기화 Edge Function : sync-professors
//  공군사관학교 공식 '교수소개'(https://rokaf.airforce.mil.kr) 페이지를 크롤링해
//  professor 테이블을 갱신한다. 파괴적 변경 없음(추가 + 학과 변경만, 삭제 안 함).
//
//  호출 경로 2가지:
//    1) 관리자 수동 : 프론트가 사용자 JWT 로 invoke → is_admin() 검증.
//                     body.mode = 'preview'(크롤 후 미리보기, 쓰기 없음) | 'apply'(반영)
//    2) 주기 실행   : pg_cron + pg_net 이 헤더 x-sync-secret == SYNC_SECRET 으로 호출.
//                     이 경우 항상 mode='apply'.  (db/schema.sql 하단 크론 템플릿)
//
//  배포: supabase functions deploy sync-professors --no-verify-jwt
//    (JWT 검증을 함수 내부에서 is_admin / 시크릿으로 직접 하므로 — signup 과 동일 패턴)
//  필요 env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
//            SYNC_SECRET(주기 실행용, 미설정 시 주기 실행 비활성)
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), { status: code, headers: { ...cors, 'Content-Type': 'application/json' } })

// ── 공사 홈페이지 교수소개 구조 ──────────────────────────────────────
//  교수소개 = 교수부장(1인) + 5개 '처'. 각 '처'는 여러 '학과'(li_4 하위메뉴)를 가지며,
//  각 학과 = 독립 subview 페이지(= 게시판) 로 교수를 카드로 나열한다.
//  '처' 페이지를 읽어 학과 목록을 자동 발견하므로, 학과가 추가/삭제돼도 따라간다.
//  ※ 사이트 개편으로 진입 ID 가 바뀌면 아래 두 배열만 수정하면 된다.
const BASE = 'https://rokaf.airforce.mil.kr'
const DIVISIONS = [                       // 하위 학과(li_4)를 발견해 각 학과를 리프로 크롤
  { id: '1437', name: '인문학처' },
  { id: '1431', name: '사회과학처' },
  { id: '1501', name: '이학처' },
  { id: '1421', name: '공학처' },
]
const STANDALONE = [                       // 하위 학과가 없어 페이지 자체가 리프(교수 직접 나열)
  { id: '1428', name: '항공체육처' },
  { id: '1417', name: '교수부장' },
]
const MAX_PAGES = 8                         // 학과별 페이지네이션 상한(안전장치)
const CONCURRENCY = 5

type Prof = {
  name: string; dept: string
  position: string | null; degree: string | null
  phone: string | null; research: string | null; office: string | null
}

// ── HTML 유틸 ────────────────────────────────────────────────────────
const clean = (s: string | null | undefined) => String(s ?? '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

// 이름 정규화: 괄호주석 제거 → 순수 한글이면 내부 공백 제거(외국인명은 공백 유지)
function normName(raw: string): string | null {
  let s = clean(raw).split(/[(（]/)[0].trim()
  if (!s) return null
  if (!/[A-Za-z]/.test(s)) s = s.replace(/\s+/g, '')
  return /^[가-힣A-Za-z·.\s]{2,20}$/.test(s) ? s : null
}

async function fetchPage(id: string, page = 1): Promise<string> {
  const url = `${BASE}/afa/${id}/subview.do${page > 1 ? `?page=${page}` : ''}`
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(to)
  }
}

// 학과(depth-4) 하위 메뉴 발견: [{id, dept}]
function discoverChildren(html: string): { id: string; dept: string }[] {
  const out: { id: string; dept: string }[] = []
  const re = /<li id="li_4_(\d+)"[\s\S]*?href="\/afa\/(\d+)\/subview\.do"[\s\S]*?value="([^"]*)"\s*\/?>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) out.push({ id: m[2], dept: clean(m[3]) })
  return out
}

// 한 페이지에서 교수 카드 파싱
function parseProfessors(html: string, dept: string): Prof[] {
  const out: Prof[] = []
  const re = /jf_viewArtcl\('afa',\s*'(\d+)',\s*'(\d+)'\)([\s\S]*?)<\/li>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const block = m[3]
    const nameM = block.match(/artclTitle[\s\S]*?<strong>\s*([\s\S]*?)\s*<\/strong>/)
    const name = nameM ? normName(nameM[1]) : null
    if (!name) continue
    const field = (label: string) => {
      const fm = block.match(new RegExp(`${label}\\s*:\\s*</strong>([^<]*)`))
      return fm ? (clean(fm[1]) || null) : null
    }
    out.push({
      name, dept,
      position: field('직위 또는 학위'),
      degree: field('최종학력'),
      phone: field('전화번호'),
      research: field('연구분야'),
      office: field('연구실'),
    })
  }
  return out
}

// 한 학과(리프) 크롤 — 페이지네이션(빈 페이지 or 상한까지)
async function crawlLeaf(id: string, dept: string): Promise<Prof[]> {
  const collected: Prof[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchPage(id, page)
    const profs = parseProfessors(html, dept)
    if (profs.length === 0) break
    let fresh = 0
    for (const p of profs) {
      if (seen.has(p.name)) continue          // 같은 페이지 반복 방지(마지막 페이지 재노출 등)
      seen.add(p.name); collected.push(p); fresh++
    }
    if (fresh === 0) break                     // 새 인원이 없으면 종료
  }
  return collected
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

// 공사 홈페이지 전체 교수 명단 크롤(이름 기준 전역 중복 제거)
async function scrapeAll(): Promise<{ profs: Prof[]; departments: string[]; errors: string[] }> {
  const errors: string[] = []
  const leaves = new Map<string, string>()   // pageId -> dept name

  // 1) 각 '처'에서 학과(리프) 발견
  await mapLimit(DIVISIONS, CONCURRENCY, async (d) => {
    try {
      const kids = discoverChildren(await fetchPage(d.id, 1))
      if (kids.length) for (const k of kids) leaves.set(k.id, k.dept)
      else leaves.set(d.id, d.name)           // 폴백: 학과가 안 잡히면 처 자체를 리프로
    } catch (e) {
      errors.push(`${d.name}(${d.id}): ${(e as Error).message}`)
    }
  })
  // 2) 하위 학과 없는 리프(교수부장·항공체육처) 추가
  for (const s of STANDALONE) leaves.set(s.id, s.name)

  // 3) 각 리프 크롤
  const leafList = [...leaves.entries()].map(([id, dept]) => ({ id, dept }))
  const perLeaf = await mapLimit(leafList, CONCURRENCY, async (l) => {
    try {
      return await crawlLeaf(l.id, l.dept)
    } catch (e) {
      errors.push(`${l.dept}(${l.id}): ${(e as Error).message}`)
      return [] as Prof[]
    }
  })

  // 4) 이름 기준 전역 중복 제거(겸직 교수 = 최초 학과 유지)
  const profs: Prof[] = []
  const seen = new Set<string>()
  for (const list of perLeaf) {
    for (const p of list) {
      if (seen.has(p.name)) continue
      seen.add(p.name); profs.push(p)
    }
  }
  return { profs, departments: [...leaves.values()], errors }
}

type DbProf = { code: string; name: string; department: string | null; office: string | null }

// 크롤 결과 ↔ DB professor 비교(이름 기준 매칭)
function diff(scraped: Prof[], dbRows: DbProf[]) {
  const byName = new Map<string, DbProf[]>()
  for (const r of dbRows) {
    const arr = byName.get(r.name) ?? []
    arr.push(r); byName.set(r.name, arr)
  }
  const add: Prof[] = []
  const deptChanges: { code: string; name: string; from: string | null; to: string }[] = []
  const officeChanges: { code: string; name: string; from: string | null; to: string | null }[] = []
  const ambiguous: { name: string; dept: string }[] = []   // 동명이인 → 자동 변경 보류
  let unchanged = 0
  for (const p of scraped) {
    const rows = byName.get(p.name) ?? []
    if (rows.length === 0) { add.push(p); continue }
    if (rows.length > 1) { ambiguous.push({ name: p.name, dept: p.dept }); continue }  // 동명이인 보류
    const r = rows[0]
    let changed = false
    if ((r.department ?? '') !== p.dept) {
      deptChanges.push({ code: r.code, name: p.name, from: r.department, to: p.dept }); changed = true
    }
    // 연구실은 신규 채움(기존 NULL→값) 및 이전도 자동 반영. 사이트에서 못 읽어 빈값이면 건드리지 않음.
    if (p.office && (r.office ?? '') !== p.office) {
      officeChanges.push({ code: r.code, name: p.name, from: r.office, to: p.office }); changed = true
    }
    if (!changed) unchanged++
  }
  const scrapedNames = new Set(scraped.map((p) => p.name))
  const orphans = dbRows                                    // DB엔 있으나 사이트엔 없음(삭제 안 함, 안내만)
    .filter((r) => !scrapedNames.has(r.name))
    .map((r) => ({ code: r.code, name: r.name, department: r.department }))
  return { add, deptChanges, officeChanges, ambiguous, orphans, unchanged }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ status: 'BAD_REQUEST' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  // ── 인증: 주기 실행 시크릿 or 관리자 JWT ──
  let mode: 'preview' | 'apply' = 'preview'
  let body: { mode?: string } = {}
  try { body = await req.json() } catch { /* 빈 본문 허용(주기 실행) */ }

  const secret = Deno.env.get('SYNC_SECRET')
  const provided = req.headers.get('x-sync-secret')
  const isCron = !!secret && !!provided && provided === secret

  if (isCron) {
    mode = 'apply'                                          // 주기 실행은 항상 반영
  } else {
    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
      auth: { persistSession: false },
    })
    const { data: isAdmin, error: adminErr } = await userClient.rpc('is_admin')
    if (adminErr) return json({ status: 'ERROR', detail: adminErr.message }, 500)
    if (!isAdmin) return json({ status: 'FORBIDDEN' }, 403)
    mode = body.mode === 'apply' ? 'apply' : 'preview'
  }

  try {
    const { profs, departments, errors } = await scrapeAll()
    if (profs.length === 0) {
      // 사이트 접근 실패 등으로 한 명도 못 읽으면 절대 반영하지 않는다(기존 데이터 보호).
      return json({ status: 'NO_DATA', detail: '교수 명단을 가져오지 못했습니다.', errors }, 502)
    }

    const { data: dbRows } = await admin.from('professor').select('code, name, department, office')
    const d = diff(profs, dbRows ?? [])

    if (mode === 'preview') {
      return json({
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
      })
    }

    // ── 반영(apply): 추가 + 학과/연구실 변경만. 삭제/보류(동명이인·orphan)는 손대지 않음. ──
    let added = 0
    for (const p of d.add) {
      const { data: code } = await admin.rpc('gen_professor_code')
      await admin.from('professor')
        .insert({ code, name: p.name, department: p.dept, office: p.office })
        .throwOnError()
      added++
    }
    let updated = 0
    for (const c of d.deptChanges) {
      await admin.from('professor').update({ department: c.to }).eq('code', c.code).throwOnError()
      updated++
    }
    let officeUpdated = 0
    for (const c of d.officeChanges) {
      await admin.from('professor').update({ office: c.to }).eq('code', c.code).throwOnError()
      officeUpdated++
    }
    const syncedAt = new Date().toISOString()
    await admin.from('app_setting').update({ professors_synced_at: syncedAt }).eq('id', 1)

    return json({
      status: 'OK', mode,
      scanned: { departments: departments.length, professors: profs.length },
      added, updated, officeUpdated, unchanged: d.unchanged,
      ambiguous: d.ambiguous.length, orphans: d.orphans.length,
      syncedAt, errors,
    })
  } catch (e) {
    return json({ status: 'ERROR', detail: (e as Error).message }, 500)
  }
})
