// =====================================================================
//  애타 (AnyTime) — 관리자 작업 Edge Function : admin-action
//  호출자가 admin 인지 검증(is_admin) 후 service-role 로 작업 수행.
//  (프론트에 service-role 키를 절대 두지 않기 위함 — PROJECT.md §보안)
//  배포: supabase functions deploy admin-action  (JWT 검증 필요 → --no-verify-jwt 안 씀)
//  요청 body: { action, payload }
//  지원 action:
//   add_codes(codes[], label) / set_professor / set_course / set_semester /
//   set_section / set_section_time / delete_post(table,id)
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, code = 200) =>
  new Response(JSON.stringify(body), { status: code, headers: { ...cors, 'Content-Type': 'application/json' } })

const POST_TABLES = new Set(['review', 'exam_archive', 'class_memo', 'board_post', 'board_comment'])
const EDITABLE: Record<string, string[]> = {
  review: ['prof_comment', 'course_comment'],
  class_memo: ['content'],
  exam_archive: ['title', 'description'],
  board_post: ['title', 'content'],
  board_comment: ['content'],
}

// (요일·교시 파싱/적용 로직은 DB 함수 apply_correction_row 로 이관됨 — db/schema.sql)

// 분반을 넣기 전, 그 학기가 semester 에 없으면 만들어 준다(section 의 FK 대상).
// 이미 있으면 건드리지 않는다 — is_current 를 덮어써 현재 학기를 강등시키면 안 되므로
// upsert(ignoreDuplicates) = INSERT … ON CONFLICT DO NOTHING.
async function ensureSemester(admin: any, year: unknown, term: unknown) {
  const y = Number(year)
  const t = Number(term)
  if (!Number.isInteger(y) || (t !== 1 && t !== 2)) return
  await admin.from('semester')
    .upsert({ year: y, term: t, is_current: false }, { onConflict: 'year,term', ignoreDuplicates: true })
    .throwOnError()
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ status: 'BAD_REQUEST' }, 405)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  // 1) 관리자 검증 (호출자 JWT 로 is_admin())
  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: isAdmin, error: adminErr } = await userClient.rpc('is_admin')
  if (adminErr) return json({ status: 'ERROR', detail: adminErr.message }, 500)
  if (!isAdmin) return json({ status: 'FORBIDDEN' }, 403)

  let body: { action?: string; payload?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return json({ status: 'BAD_REQUEST' }, 400)
  }
  const { action, payload = {} } = body

  // 액션 하나를 처리한다. 아래 'batch' 가 이걸 여러 번 불러 한 번의 호출로 묶는다
  // (파라미터 이름이 바깥 action/payload 를 가리므로 switch 본문은 그대로다).
  const handle = async (action: string, payload: Record<string, unknown>): Promise<Response> => {
   try {
    switch (action) {
      case 'get_app_setting': {
        const { data } = await admin.from('app_setting')
          .select('campus_lat, campus_lng, radius_m, review_min_days, geo_valid_days, account_delete_days, board_enabled, share_enabled, hot_threshold, report_delete_count, report_burst_count').eq('id', 1).maybeSingle()
        const setting: Record<string, unknown> = data ?? {}
        // professors_synced_at 은 라이브에 컬럼이 아직 없을 수 있어 별도·방어적으로 조회(없으면 무시).
        const { data: s2 } = await admin.from('app_setting').select('professors_synced_at').eq('id', 1).maybeSingle()
        if (s2 && 'professors_synced_at' in s2) setting.professors_synced_at = (s2 as Record<string, unknown>).professors_synced_at
        return json({ status: 'OK', setting })
      }
      case 'set_board_enabled': {
        await admin.from('app_setting').update({ board_enabled: !!payload.value }).eq('id', 1).throwOnError()
        return json({ status: 'OK' })
      }
      // 공유 링크 비회원 열람 허용/차단 (회원 링크는 항상 동작)
      case 'set_share_enabled': {
        await admin.from('app_setting').update({ share_enabled: !!payload.value }).eq('id', 1).throwOnError()
        return json({ status: 'OK' })
      }
      case 'delete_board': {
        await admin.from('board').delete().eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      case 'purge_all_boards': {
        await admin.from('board_post').delete().gt('id', 0).throwOnError()
        return json({ status: 'OK' })
      }
      case 'set_app_setting': {
        const allow = ['geo_valid_days', 'review_min_days', 'radius_m', 'campus_lat', 'campus_lng', 'account_delete_days',
          'hot_threshold', 'report_delete_count', 'report_burst_count']
        const field = String(payload.field)
        if (!allow.includes(field)) return json({ status: 'BAD_REQUEST' }, 400)
        // 개수·일수 기준값은 정수만 허용(음수·소수면 자동화 로직이 깨짐). 대부분 1 이상이어야 하지만
        // 강의평 작성자격(review_min_days)만은 0 허용 — '보유 즉시 작성 가능'(대기 없음)을 뜻한다.
        const intMin1 = ['geo_valid_days', 'account_delete_days', 'radius_m',
          'hot_threshold', 'report_delete_count', 'report_burst_count']
        const intMin0 = ['review_min_days']
        let value = payload.value
        if (intMin1.includes(field) || intMin0.includes(field)) {
          value = Math.round(Number(value))
          const min = intMin0.includes(field) ? 0 : 1
          if (!Number.isFinite(value) || value < min) return json({ status: 'BAD_REQUEST' }, 400)
        }
        await admin.from('app_setting').update({ [field]: value }).eq('id', 1).throwOnError()
        return json({ status: 'OK' })
      }
      // ── 공지사항 ──
      // 관리자 목록(비활성 포함 — RLS 는 활성만 노출하므로 여기서 service_role 로 조회)
      case 'list_notices': {
        const { data } = await admin.from('notice')
          .select('id, title, content, is_active, expires_at, created_at, updated_at')
          .order('created_at', { ascending: false }).limit(100)
        return json({ status: 'OK', items: data ?? [] })
      }
      // id 없으면 생성, 있으면 수정. 수정 시 updated_at 갱신 → 이미 본 사용자에게도 팝업 재표시.
      case 'set_notice': {
        const title = String(payload.title ?? '').trim()
        const content = String(payload.content ?? '').trim()
        if (!title || !content) return json({ status: 'BAD_REQUEST' }, 400)
        if (payload.id) {
          // 수정: 활성 상태는 유지(내림/게시는 set_notice_active 로만)
          await admin.from('notice').update({ title, content, updated_at: new Date().toISOString() })
            .eq('id', payload.id).throwOnError()
        } else {
          await admin.from('notice').insert({ title, content, is_active: true }).throwOnError()
        }
        return json({ status: 'OK' })
      }
      case 'set_notice_active': {
        const on = !!payload.value
        const patch: Record<string, unknown> = { is_active: on, updated_at: new Date().toISOString() }
        // 게시(재게시)하면 그 시점부터 48시간 게시. updated_at 갱신으로 본 사람에게도 다시 표시.
        if (on) patch.expires_at = new Date(Date.now() + 48 * 3600_000).toISOString()
        await admin.from('notice').update(patch).eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      case 'delete_notice': {
        await admin.from('notice').delete().eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      // ── 금지어(작성 시 부분 마스킹) ──
      case 'list_banned_words': {
        const { data } = await admin.from('banned_word')
          .select('word, created_at').order('created_at', { ascending: false })
        return json({ status: 'OK', words: data ?? [] })
      }
      case 'add_banned_word': {
        const word = String(payload.word ?? '').trim()
        if (!word) return json({ status: 'BAD_REQUEST' }, 400)
        if (word.length > 40) return json({ status: 'TOO_LONG' }, 400)
        // 이미 있으면 조용히 성공(중복 무시).
        await admin.from('banned_word').upsert({ word }, { onConflict: 'word' }).throwOnError()
        return json({ status: 'OK' })
      }
      case 'delete_banned_word': {
        const word = String(payload.word ?? '')
        await admin.from('banned_word').delete().eq('word', word).throwOnError()
        return json({ status: 'OK' })
      }
      case 'get_signup_code': {
        const { data } = await admin.from('app_setting').select('signup_code').eq('id', 1).maybeSingle()
        return json({ status: 'OK', code: data?.signup_code ?? '' })
      }
      case 'set_signup_code': {
        const code = String(payload.code ?? '').trim()
        if (!code) return json({ status: 'BAD_REQUEST' }, 400)
        const { error } = await admin.rpc('set_signup_code', { p_code: code })
        if (error) return json({ status: 'ERROR', detail: error.message }, 500)
        return json({ status: 'OK' })
      }
      case 'add_professor': {
        const { data: code } = await admin.rpc('gen_professor_code')
        await admin.from('professor').insert({
          code, name: payload.name, department: payload.department ?? null,
        }).throwOnError()
        return json({ status: 'OK', code })
      }
      case 'set_professor':
        await admin.from('professor').upsert({
          code: payload.code, name: payload.name,
          department: payload.department ?? null,
        }).throwOnError()
        return json({ status: 'OK' })
      // 통합 전 확인용: 교수별 분반·강의평 수(= 어느 쪽을 남길지 판단 근거).
      // 분반은 카탈로그에 있어 프런트가 셀 수 있지만 강의평은 없다 — 여기서 같이 센다.
      case 'professor_usage': {
        const codes = ((payload.codes as unknown[]) ?? []).map(String).filter(Boolean).slice(0, 50)
        const usage: Record<string, { sections: number; reviews: number }> = {}
        await Promise.all(codes.map(async (code) => {
          const [s, r] = await Promise.all([
            admin.from('section').select('*', { count: 'exact', head: true }).eq('professor_code', code),
            admin.from('review').select('*', { count: 'exact', head: true }).eq('professor_code', code),
          ])
          usage[code] = { sections: s.count ?? 0, reviews: r.count ?? 0 }
        }))
        return json({ status: 'OK', usage })
      }
      // 교수 통합: from[] 의 분반·강의평·수정제안을 into 로 옮기고 from 을 삭제.
      // 한 건씩 DB 함수(merge_professor)로 — 함수 하나가 곧 한 트랜잭션이라 부분 반영이 없다.
      case 'merge_professors': {
        const into = String(payload.into ?? '')
        const from = [...new Set(((payload.from as unknown[]) ?? []).map(String))]
          .filter((c) => c && c !== into)
        if (!into || !from.length) return json({ status: 'BAD_REQUEST' }, 400)
        let sections = 0
        let reviews = 0
        let corrections = 0
        for (const code of from) {
          const { data, error } = await admin.rpc('merge_professor', { p_from: code, p_into: into })
          if (error) return json({ status: 'ERROR', detail: error.message }, 500)
          const r = (data ?? {}) as { status?: string; sections?: number; reviews?: number; corrections?: number }
          if (r.status !== 'OK') {
            return json({ status: r.status ?? 'ERROR', detail: `교수 ${code}` }, r.status === 'NOT_FOUND' ? 404 : 400)
          }
          sections += r.sections ?? 0
          reviews += r.reviews ?? 0
          corrections += r.corrections ?? 0
        }
        return json({ status: 'OK', merged: from.length, sections, reviews, corrections })
      }
      case 'set_course':
        await admin.from('course').upsert({
          code: payload.code, name: payload.name,
          department: payload.department ?? null,
        }).throwOnError()
        return json({ status: 'OK' })
      case 'set_semester': {
        if (payload.is_current) {
          await admin.from('semester').update({ is_current: false }).neq('year', -1)
          await admin.from('semester').upsert({
            year: payload.year, term: payload.term, is_current: true,
          }).throwOnError()
        } else {
          // 학기 '추가'(다음 학기 미리 열기) — 이미 있으면 그대로 둔다.
          // upsert 로 is_current:false 를 덮어쓰면 현재 학기를 강등시켜 버린다.
          await ensureSemester(admin, payload.year, payload.term)
        }
        return json({ status: 'OK' })
      }
      // 공통 공강 시간 한 칸 추가/수정. PK=(year,term,day_of_week,start_period).
      // 요일·시작교시는 PK 라 '수정'이 upsert 만으로 안 된다 — old(원래 자리)를 함께 받아
      // 자리가 바뀌었으면 옛 행을 지우고 새 자리에 넣는다(관리자가 요일까지 고칠 수 있어야 한다).
      // (편람 일괄등록은 apply_common_blocks 로 그 학기를 통째로 교체한다 — 이건 낱개 편집용)
      case 'set_common_block': {
        await ensureSemester(admin, payload.year, payload.term)
        const old = payload.old as { day_of_week?: number; start_period?: number } | undefined
        const moved = old?.day_of_week != null
          && (old.day_of_week !== payload.day_of_week || old.start_period !== payload.start_period)
        if (moved) {
          await admin.from('common_block').delete().match({
            year: payload.year, term: payload.term,
            day_of_week: old!.day_of_week, start_period: old!.start_period,
          }).throwOnError()
        }
        await admin.from('common_block').upsert({
          year: payload.year,
          term: payload.term,
          day_of_week: payload.day_of_week,
          start_period: payload.start_period,
          end_period: payload.end_period ?? payload.start_period,
          label: String(payload.label ?? '').trim().slice(0, 20),
        }).throwOnError()
        return json({ status: 'OK' })
      }
      case 'set_period':
        await admin.from('period').upsert({
          no: payload.no, start_time: payload.start_time, end_time: payload.end_time,
        }).throwOnError()
        return json({ status: 'OK' })
      case 'set_section':
        await ensureSemester(admin, payload.year, payload.term)   // 없는 학기면 자동 개설
        await admin.from('section').upsert({
          course_code: payload.course_code, year: payload.year, term: payload.term,
          section_no: payload.section_no, professor_code: payload.professor_code ?? null,
        }).throwOnError()
        return json({ status: 'OK' })
      // 강의시간 추가/수정. PK=(분반키, day_of_week, start_period) 라 요일·시작교시를 바꾸면
      // upsert 만으로는 옛 행이 유령으로 남는다 — old(원래 자리)를 받아 먼저 지운다.
      // (common_block 과 같은 함정. 수정 제안 경로(apply_correction_row)는 DELETE+재삽입이라 무관)
      case 'set_section_time': {
        const old = payload.old as { day_of_week?: number; start_period?: number } | undefined
        const moved = old?.day_of_week != null
          && (old.day_of_week !== payload.day_of_week || old.start_period !== payload.start_period)
        if (moved) {
          await admin.from('section_time').delete().match({
            course_code: payload.course_code, year: payload.year, term: payload.term,
            section_no: payload.section_no,
            day_of_week: old!.day_of_week, start_period: old!.start_period,
          }).throwOnError()
        }
        await admin.from('section_time').upsert({
          course_code: payload.course_code, year: payload.year, term: payload.term,
          section_no: payload.section_no, day_of_week: payload.day_of_week,
          start_period: payload.start_period, end_period: payload.end_period,
          room: payload.room ?? null,
        }).throwOnError()
        return json({ status: 'OK' })
      }
      case 'delete_post': {
        const table = String(payload.table)
        if (!POST_TABLES.has(table)) return json({ status: 'BAD_REQUEST' }, 400)
        // board_post 삭제 시 댓글·이벤트·이미지(board_post_image), exam_archive 삭제 시
        // 첨부(exam_file)는 FK CASCADE 로 함께 삭제. 파일 실체(R2)는 이 Edge 에서 접근 불가 —
        // 게시판 이미지 고아는 R2 스윕이 정리(사진 90일 바운드), 족보 파일은 사용자 삭제(/api/exam-delete) 경로만 R2 즉시 제거.
        await admin.from(table).delete().eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      case 'edit_post': {
        const table = String(payload.table)
        const allow = EDITABLE[table]
        if (!allow) return json({ status: 'BAD_REQUEST' }, 400)
        const fields = (payload.fields ?? {}) as Record<string, unknown>
        const patch: Record<string, unknown> = {}
        for (const k of allow) if (k in fields) patch[k] = fields[k]
        if (!Object.keys(patch).length) return json({ status: 'BAD_REQUEST' }, 400)
        await admin.from(table).update(patch).eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      case 'list_recent': {
        const limit = Math.min(Number(payload.limit) || 80, 200)
        // '모두 확인 처리' 컷오프 이후 글만 노출 (이전 글은 데이터는 남고 표시만 숨김)
        const { data: setting } = await admin.from('app_setting').select('mod_reviewed_at').eq('id', 1).maybeSingle()
        const cutoff = (setting?.mod_reviewed_at as string | null) ?? null
        // deno-lint-ignore no-explicit-any
        const recent = (t: string, cols: string): any => {
          const q = admin.from(t).select(cols).order('created_at', { ascending: false }).limit(limit)
          return cutoff ? q.gt('created_at', cutoff) : q
        }
        const [rev, memo, exam, bpost, bcmt] = await Promise.all([
          recent('review', 'id,course_code,professor_code,prof_comment,course_comment,created_at'),
          recent('class_memo', 'id,course_code,year,term,section_no,content,created_at'),
          recent('exam_archive', 'id,course_code,title,description,created_at'),
          recent('board_post', 'id,board_id,title,content,created_at'),
          recent('board_comment', 'id,post_id,content,created_at'),
        ])
        // 게시판 글/댓글 라벨용: 게시판명(+댓글은 원글제목)을 붙여 관리자가 맥락을 알 수 있게.
        const boardIds = new Set((bpost.data ?? []).map((p) => p.board_id))
        const postIds = new Set((bcmt.data ?? []).map((c) => c.post_id))
        const postMap = new Map()
        if (postIds.size) {
          const { data: ps } = await admin.from('board_post').select('id,board_id,title').in('id', [...postIds])
          for (const p of (ps ?? [])) { postMap.set(p.id, p); boardIds.add(p.board_id) }
        }
        const boardMap = new Map()
        if (boardIds.size) {
          const { data: bs } = await admin.from('board').select('id,name').in('id', [...boardIds])
          for (const b of (bs ?? [])) boardMap.set(b.id, b.name)
        }
        const items = [
          ...(rev.data ?? []).map((r) => ({
            type: 'review', id: r.id, course_code: r.course_code, created_at: r.created_at,
            text: [r.prof_comment, r.course_comment].filter(Boolean).join(' / '),
            meta: { professor_code: r.professor_code },
          })),
          ...(memo.data ?? []).map((m) => ({
            type: 'class_memo', id: m.id, course_code: m.course_code, created_at: m.created_at,
            text: m.content, meta: { year: m.year, term: m.term, section_no: m.section_no },
          })),
          ...(exam.data ?? []).map((e) => ({
            type: 'exam_archive', id: e.id, course_code: e.course_code, created_at: e.created_at,
            text: [e.title, e.description].filter(Boolean).join(' — '), meta: {},
          })),
          ...(bpost.data ?? []).map((p) => ({
            type: 'board_post', id: p.id, course_code: boardMap.get(p.board_id) ?? '게시판', created_at: p.created_at,
            text: [p.title, p.content].filter(Boolean).join(' — '), meta: {},
          })),
          ...(bcmt.data ?? []).map((c) => {
            const parent = postMap.get(c.post_id)
            const bname = (parent && boardMap.get(parent.board_id)) || '게시판'
            return {
              type: 'board_comment', id: c.id,
              course_code: parent?.title ? `${bname}·${parent.title}` : bname,
              created_at: c.created_at, text: c.content, meta: { post_id: c.post_id },
            }
          }),
        ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
        return json({ status: 'OK', items, reviewed_at: cutoff })
      }
      // 모더레이션 '모두 확인 처리': 컷오프를 현재로 갱신 → 이전 글은 대시보드에서 숨김(삭제 아님)
      case 'clear_moderation': {
        const at = new Date().toISOString()
        await admin.from('app_setting').update({ mod_reviewed_at: at }).eq('id', 1).throwOnError()
        return json({ status: 'OK', reviewed_at: at })
      }
      case 'list_admins': {
        const { data } = await admin.from('cadet').select('id, username').eq('is_admin', true)
        return json({ status: 'OK', admins: (data ?? []).map((c) => ({ id: c.id, username: c.username })) })
      }
      case 'grant_admin': {
        const username = String(payload.username ?? '').trim()
        const { data: c } = await admin.from('cadet').select('id').eq('username', username).maybeSingle()
        if (!c) return json({ status: 'NO_USER' }, 404)
        await admin.from('cadet').update({ is_admin: true }).eq('id', c.id)
        return json({ status: 'OK' })
      }
      case 'revoke_admin': {
        const username = String(payload.username ?? '').trim()
        const { data: c } = await admin.from('cadet').select('id').eq('username', username).maybeSingle()
        if (!c) return json({ status: 'NO_USER' }, 404)
        // 마지막 관리자 제거 방지
        const { count } = await admin.from('cadet').select('id', { count: 'exact', head: true }).eq('is_admin', true)
        if ((count ?? 0) <= 1) return json({ status: 'LAST_ADMIN' }, 409)
        await admin.from('cadet').update({ is_admin: false }).eq('id', c.id)
        return json({ status: 'OK' })
      }
      case 'add_course': {
        const { data: code } = await admin.rpc('gen_course_code')
        await admin.from('course').insert({
          code, name: payload.name, department: payload.department ?? null,
        }).throwOnError()
        return json({ status: 'OK', code })
      }
      case 'bulk_catalog': {
        const courses = (payload.courses as any[]) ?? []
        // CSV 안에 아직 없는 학기가 섞여 있으면 먼저 개설한다(section 의 FK).
        const sems = new Set<string>()
        for (const co of courses) {
          for (const se of (co.sections ?? [])) sems.add(`${se.year}-${se.term}`)
        }
        for (const s of sems) {
          const [y, t] = s.split('-')
          await ensureSemester(admin, y, t)
        }
        let created = 0
        for (const co of courses) {
          const { data: code } = await admin.rpc('gen_course_code')
          await admin.from('course').insert({
            code, name: co.name, department: co.department ?? null,
          }).throwOnError()
          for (const se of (co.sections ?? [])) {
            await admin.from('section').insert({
              course_code: code, year: se.year, term: se.term, section_no: se.section_no,
              professor_code: se.professor_code ?? null,
            }).throwOnError()
            for (const t of (se.times ?? [])) {
              await admin.from('section_time').insert({
                course_code: code, year: se.year, term: se.term, section_no: se.section_no,
                day_of_week: t.day, start_period: t.start, end_period: t.end ?? t.start, room: t.room ?? null,
              }).throwOnError()
            }
          }
          created++
        }
        return json({ status: 'OK', created })
      }
      case 'delete_catalog': {
        const table = String(payload.table)
        if (!['professor', 'course', 'semester', 'period', 'section', 'section_time', 'common_block'].includes(table)) {
          return json({ status: 'BAD_REQUEST' }, 400)
        }
        await admin.from(table).delete().match(payload.key as Record<string, unknown>).throwOnError()
        return json({ status: 'OK' })
      }
      // 전 생도 공통 비수업 시간(생도대시간·군사훈련…)의 '이름'을 그 학기 통째로 교체한다.
      // 시각(요일·교시)은 편람에서 자동 유도되므로 여기서는 이름만 싣는다.
      // section_time 과 같은 교체 의미(그 학기 것을 지우고 새로 넣는다) — 재적용이 멱등.
      case 'apply_common_blocks': {
        const year = payload.year
        const term = payload.term
        await ensureSemester(admin, year, term)
        await admin.from('common_block').delete().match({ year, term }).throwOnError()
        const rows = ((payload.blocks as any[]) ?? [])
          .filter((b) => b?.day && b?.start && String(b.label ?? '').trim())
          .map((b) => ({
            year, term,
            day_of_week: b.day,
            start_period: b.start,
            end_period: b.end ?? b.start,
            label: String(b.label).trim().slice(0, 20),
          }))
        if (rows.length) await admin.from('common_block').insert(rows).throwOnError()
        return json({ status: 'OK', blocks: rows.length })
      }
      // AI 강의 일괄등록 1단계: 교수 생성/수정 + 교시. 교수 이름→코드 맵 반환.
      case 'apply_syllabus_meta': {
        for (const pr of ((payload.periods as any[]) ?? [])) {
          if (pr?.no != null && pr.start && pr.end) {
            await admin.from('period').upsert({ no: pr.no, start_time: pr.start, end_time: pr.end }).throwOnError()
          }
        }
        const profCodes: Record<string, string> = {}
        for (const pf of ((payload.professors as any[]) ?? [])) {
          const name = String(pf.name ?? '').trim()
          if (!name) continue
          let code = pf.code
          if (!code || pf.create) {
            const { data: c } = await admin.rpc('gen_professor_code')
            code = c
            await admin.from('professor').insert({
              code, name, department: pf.department ?? null,
            }).throwOnError()
          } else if (pf.update) {
            await admin.from('professor').update({
              department: pf.department ?? null,
            }).eq('code', code).throwOnError()
          }
          profCodes[name] = code
        }
        return json({ status: 'OK', profCodes })
      }
      // AI 강의 일괄등록 2단계: 과목(병합/신규) + 분반 + 강의시간(교체). 배치로 호출됨.
      case 'apply_syllabus_courses': {
        const year = payload.year
        const term = payload.term
        await ensureSemester(admin, year, term)   // 다음 학기 편람을 올려도 학기가 자동 개설된다
        let nC = 0
        let nS = 0
        for (const co of ((payload.courses as any[]) ?? [])) {
          let code = co.code
          if (!code || co.create) {
            const { data: c } = await admin.rpc('gen_course_code')
            code = c
            await admin.from('course').insert({ code, name: co.name }).throwOnError()
            nC++
          }
          for (const se of ((co.sections as any[]) ?? [])) {
            await admin.from('section').upsert({
              course_code: code, year, term, section_no: se.sectionNo, professor_code: se.professorCode ?? null,
            }).throwOnError()
            await admin.from('section_time').delete()
              .match({ course_code: code, year, term, section_no: se.sectionNo }).throwOnError()
            for (const t of ((se.times as any[]) ?? [])) {
              if (t?.day && t?.start) {
                await admin.from('section_time').insert({
                  course_code: code, year, term, section_no: se.sectionNo,
                  day_of_week: t.day, start_period: t.start, end_period: t.end ?? t.start,
                  room: t.room ?? se.room ?? null,
                }).throwOnError()
              }
            }
            nS++
          }
        }
        return json({ status: 'OK', courses: nC, sections: nS })
      }
      // AI/CSV 일괄등록 3단계(선택): 편람에 없는 기존 분반 삭제 = 그 학기를 이번 파일로 '대체'.
      // 분반번호는 소스마다 다르게 매겨져(CSV 자동번호 vs 편람 교반번호) 같은 강의가 두 벌로 남기 쉬운데,
      // 프런트(reconcile)가 내용으로 대조해 뽑아낸 잉여 분반만 여기로 넘어온다.
      // section 삭제는 section_time·timetable_entry 로 CASCADE 된다 — 생도 시간표에서 사라지는 건수를
      // 함께 세어 돌려주고(관리자 화면에 표시), 학기 전체를 지우는 사고를 막기 위해 목록은 반드시 명시받는다.
      case 'delete_sections': {
        const year = Number(payload.year)
        const term = Number(payload.term)
        const list = (payload.sections as any[]) ?? []
        let removed = 0
        let entries = 0
        for (const s of list) {
          const key = { course_code: String(s.course_code), year, term, section_no: Number(s.section_no) }
          const { data: sec } = await admin.from('section').select('id').match(key).maybeSingle()
          if (!sec) continue
          const { count } = await admin.from('timetable_entry')
            .select('*', { count: 'exact', head: true }).eq('section_id', sec.id)
          entries += count ?? 0
          await admin.from('section').delete().match(key).throwOnError()
          removed++
        }
        return json({ status: 'OK', removed, entries })
      }
      // ── 정보 수정 제안 ──
      case 'list_corrections': {
        const st = payload.status ? String(payload.status) : 'pending'
        const { data } = await admin.from('correction')
          .select('id, target, professor_code, course_code, year, term, section_no, label, field, suggested, note, status, prev_value, created_at')
          .eq('status', st).order('created_at', { ascending: false }).limit(200)
        return json({ status: 'OK', items: data ?? [] })
      }
      case 'reject_correction': {
        // 반려는 기록 불필요 → 즉시 삭제(익명이라 이력 가치도 없음).
        await admin.from('correction').delete().eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      case 'apply_correction': {
        // 실제 반영 로직은 DB 함수(apply_correction_row)에 단일화 — 자동반영과 동일 경로.
        // 반영 성공(OK) 또는 '이미 있음'(ALREADY_DONE, 예: 분반추가인데 그 사이 이미 생성됨)은
        // 큐에 남길 이유가 없어 삭제한다.
        const { data: st, error } = await admin.rpc('apply_correction_row', { p_id: payload.id })
        if (error) return json({ status: 'ERROR', detail: error.message }, 500)
        if (st === 'OK' || st === 'ALREADY_DONE') await admin.from('correction').delete().eq('id', payload.id).throwOnError()
        const code = st === 'OK' ? 200 : st === 'NOT_FOUND' ? 404 : st === 'ALREADY_DONE' ? 409 : 400
        return json({ status: st ?? 'ERROR' }, code)
      }
      // 수정 제안을 '실제 반영 없이' 큐에서 정리(삭제). 관리자가 편집 페이지에서 직접 고친 뒤
      // 그 제안(동일 묶음 전체)을 처리완료로 치울 때 쓴다. ids 배열 또는 단일 id 를 받는다.
      case 'resolve_correction': {
        const ids = Array.isArray(payload.ids) ? payload.ids : (payload.id != null ? [payload.id] : [])
        if (ids.length) await admin.from('correction').delete().in('id', ids).throwOnError()
        return json({ status: 'OK' })
      }
      // 수정 제안 1건 조회 — 편집 페이지로 딥링크했을 때 배너에 제안값을 그리기 위해(새로고침 등으로
      // 라우터 state 가 사라진 경우 id 로 다시 읽는다).
      case 'get_correction': {
        const { data } = await admin.from('correction')
          .select('id, target, professor_code, course_code, year, term, section_no, label, field, suggested, note, status, auto_applied, created_at')
          .eq('id', payload.id).maybeSingle()
        return json({ status: data ? 'OK' : 'NOT_FOUND', item: data ?? null })
      }
      // 자동반영 알림: 사용자 동일 제안 3건↑로 시스템이 반영한 건. 관리자 확인 전까지만 유지.
      case 'list_auto_notices': {
        const { data } = await admin.from('correction')
          .select('id, target, professor_code, course_code, year, term, section_no, label, field, suggested, note, prev_value, created_at')
          .eq('auto_applied', true)
          .order('created_at', { ascending: false }).limit(200)
        return json({ status: 'OK', items: data ?? [] })
      }
      case 'ack_correction': {
        // 알림 확인 = 처리 끝 → 삭제.
        await admin.from('correction').delete().eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      // ── 신고 확인 ──
      // 신고 누적 중(아직 자동삭제 임계치 미도달)인 살아있는 글 목록.
      // 신고 가능한 대상: review / class_memo / board_post (board_comment 는 신고 미지원).
      case 'list_reported': {
        const [rev, memo, bpost] = await Promise.all([
          admin.from('review').select('id,course_code,prof_comment,course_comment,report_count,report_reviewed_count,created_at')
            .gt('report_count', 0).order('report_count', { ascending: false }).limit(200),
          admin.from('class_memo').select('id,course_code,year,term,section_no,content,report_count,report_reviewed_count,created_at')
            .gt('report_count', 0).order('report_count', { ascending: false }).limit(200),
          admin.from('board_post').select('id,board_id,title,content,report_count,report_reviewed_count,created_at')
            .gt('report_count', 0).order('report_count', { ascending: false }).limit(200),
        ])
        // '확인처리'(ack_report)한 글은 그 시점 신고수까지 검토완료 → 그 뒤로 신고가 더 쌓인 것만 노출.
        // (col-대-col 비교는 PostgREST 로 못 걸어서 JS 로 필터 — 목록 최대 200건이라 부담 없음)
        const unreviewed = (r: { report_count?: number; report_reviewed_count?: number }) =>
          (r.report_count ?? 0) > (r.report_reviewed_count ?? 0)
        const revRows = (rev.data ?? []).filter(unreviewed)
        const memoRows = (memo.data ?? []).filter(unreviewed)
        const bpostRows = (bpost.data ?? []).filter(unreviewed)
        // 게시판명 라벨(맥락)
        const boardIds = new Set(bpostRows.map((p) => p.board_id))
        const boardMap = new Map()
        if (boardIds.size) {
          const { data: bs } = await admin.from('board').select('id,name').in('id', [...boardIds])
          for (const b of (bs ?? [])) boardMap.set(b.id, b.name)
        }
        const items = [
          ...revRows.map((r) => ({
            type: 'review', id: r.id, course_code: r.course_code, created_at: r.created_at,
            report_count: r.report_count, text: [r.prof_comment, r.course_comment].filter(Boolean).join(' / '), meta: {},
          })),
          ...memoRows.map((m) => ({
            type: 'class_memo', id: m.id, course_code: m.course_code, created_at: m.created_at,
            report_count: m.report_count, text: m.content, meta: { year: m.year, term: m.term, section_no: m.section_no },
          })),
          ...bpostRows.map((p) => ({
            type: 'board_post', id: p.id, course_code: boardMap.get(p.board_id) ?? '게시판', created_at: p.created_at,
            report_count: p.report_count, text: [p.title, p.content].filter(Boolean).join(' — '), meta: {},
          })),
        ].sort((a, b) => (b.report_count - a.report_count) || (a.created_at < b.created_at ? 1 : -1))
        return json({ status: 'OK', items })
      }
      // 신고 무시(정상 처리): 신고 이벤트 삭제 + report_count 초기화. 글은 유지.
      // 누적을 '없애는' 쪽 — 담합/오신고 폭주를 리셋할 때. (검토만 하고 넘어가려면 ack_report 사용)
      case 'dismiss_report': {
        const table = String(payload.table)
        const id = payload.id
        if (table === 'review') {
          await admin.from('review_report').delete().eq('review_id', id)
        } else if (table === 'class_memo') {
          await admin.from('memo_report').delete().eq('memo_id', id)
        } else if (table === 'board_post') {
          await admin.from('board_event').delete().eq('post_id', id).eq('kind', 'report')
        } else return json({ status: 'BAD_REQUEST' }, 400)
        // report_reviewed_count 도 0 으로 되돌린다 — 안 그러면 이후 새 신고가 옛 검토수까지 가려짐.
        await admin.from(table).update({ report_count: 0, report_reviewed_count: 0 }).eq('id', id).throwOnError()
        return json({ status: 'OK' })
      }
      // 신고 확인처리: 신고 내용을 검토했고 삭제할 정도는 아니라 넘어감. 신고수·이벤트는 그대로 두고
      // report_reviewed_count = 현재 report_count 로 올려 목록에서만 감춘다(누적 보존).
      // 이후 신고가 더 쌓이면(report_count 증가) 다시 신고탭에 나타난다. — 검열 '확인처리'와 동일 개념.
      case 'ack_report': {
        const table = String(payload.table)
        if (!['review', 'class_memo', 'board_post'].includes(table)) return json({ status: 'BAD_REQUEST' }, 400)
        // report_reviewed_count := report_count (열-대-열 대입은 PostgREST 불가 → 현재값 읽어 반영).
        const { data: row } = await admin.from(table).select('report_count').eq('id', payload.id).maybeSingle()
        if (!row) return json({ status: 'NOT_FOUND' }, 404)
        await admin.from(table).update({ report_reviewed_count: row.report_count }).eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      // ── 삭제됨(신고 누적 자동삭제 아카이브) ──
      // 스냅샷 목록(복구·검토용). snapshot 원본은 반환하지 않음(비번 해시 등 미노출).
      case 'list_deleted': {
        const { data } = await admin.from('deleted_content')
          .select('id, type, orig_id, label, text, report_count, reason, reviewed, deleted_at')
          .order('deleted_at', { ascending: false }).limit(200)
        const items = (data ?? []).map((d) => ({
          id: d.id, type: d.type, orig_id: d.orig_id, course_code: d.label ?? '',
          text: d.text ?? '', report_count: d.report_count, reason: d.reason,
          reviewed: d.reviewed, created_at: d.deleted_at,
        }))
        return json({ status: 'OK', items })
      }
      // 복구: 스냅샷을 원본 테이블로 재삽입(DB 함수) 후 아카이브 행 제거.
      case 'restore_deleted': {
        const { data: st, error } = await admin.rpc('restore_deleted', { p_arch_id: payload.id })
        if (error) return json({ status: 'ERROR', detail: error.message }, 500)
        const code = st === 'OK' ? 200 : st === 'NOT_FOUND' ? 404
          : (st === 'ALREADY_EXISTS' || st === 'PARENT_GONE') ? 409 : 400
        return json({ status: st ?? 'ERROR' }, code)
      }
      // 확인(검토완료): 미확인 배지에서 제외. 데이터는 30일 자동 파기까지 유지.
      case 'ack_deleted': {
        await admin.from('deleted_content').update({ reviewed: true }).eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      default:
        return json({ status: 'BAD_REQUEST', detail: 'unknown action' }, 400)
    }
   } catch (e) {
    return json({ status: 'ERROR', detail: (e as Error).message }, 500)
   }
  }

  // 검열 대시보드는 목록 5개를 한 화면에서 함께 본다. 예전엔 그걸 5번의 Edge Function 호출로 받아
  // 15초 폴링 동안 시간당 1,200회를 썼다 — 목록만 한 번의 호출로 묶는다(부수효과 없는 읽기 전용만 허용).
  if (action === 'batch') {
    const list = Array.isArray(payload.actions) ? payload.actions : []
    if (list.length > 8) return json({ status: 'BAD_REQUEST', detail: 'too many actions' }, 400)
    const results = await Promise.all(list.map(async (a) => {
      const act = String((a as Record<string, unknown>).action ?? '')
      if (!act.startsWith('list_')) return { action: act, ok: false, data: { status: 'BAD_REQUEST' } }
      const res = await handle(act, ((a as Record<string, unknown>).payload ?? {}) as Record<string, unknown>)
      return { action: act, ok: res.status === 200, data: await res.json() }
    }))
    return json({ status: 'OK', results })
  }

  return handle(String(action), payload as Record<string, unknown>)
})
