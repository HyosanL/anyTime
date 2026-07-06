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

  try {
    switch (action) {
      case 'get_app_setting': {
        const { data } = await admin.from('app_setting')
          .select('campus_lat, campus_lng, radius_m, review_min_days, geo_valid_days, account_delete_days, board_enabled, hot_threshold, report_delete_count, report_burst_count').eq('id', 1).maybeSingle()
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
        // 개수·일수 기준값은 1 이상의 정수만 허용(0/음수/소수면 자동화 로직이 깨짐).
        const intMin1 = ['review_min_days', 'geo_valid_days', 'account_delete_days', 'radius_m',
          'hot_threshold', 'report_delete_count', 'report_burst_count']
        let value = payload.value
        if (intMin1.includes(field)) {
          value = Math.round(Number(value))
          if (!Number.isFinite(value) || value < 1) return json({ status: 'BAD_REQUEST' }, 400)
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
      case 'set_course':
        await admin.from('course').upsert({
          code: payload.code, name: payload.name,
          department: payload.department ?? null,
        }).throwOnError()
        return json({ status: 'OK' })
      case 'set_semester': {
        if (payload.is_current) {
          await admin.from('semester').update({ is_current: false }).neq('year', -1)
        }
        await admin.from('semester').upsert({
          year: payload.year, term: payload.term, is_current: !!payload.is_current,
        }).throwOnError()
        return json({ status: 'OK' })
      }
      case 'set_period':
        await admin.from('period').upsert({
          no: payload.no, start_time: payload.start_time, end_time: payload.end_time,
        }).throwOnError()
        return json({ status: 'OK' })
      case 'set_section':
        await admin.from('section').upsert({
          course_code: payload.course_code, year: payload.year, term: payload.term,
          section_no: payload.section_no, professor_code: payload.professor_code ?? null,
          capacity: payload.capacity ?? null,
        }).throwOnError()
        return json({ status: 'OK' })
      case 'set_section_time':
        await admin.from('section_time').upsert({
          course_code: payload.course_code, year: payload.year, term: payload.term,
          section_no: payload.section_no, day_of_week: payload.day_of_week,
          start_period: payload.start_period, end_period: payload.end_period,
          room: payload.room ?? null,
        }).throwOnError()
        return json({ status: 'OK' })
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
        let created = 0
        for (const co of courses) {
          const { data: code } = await admin.rpc('gen_course_code')
          await admin.from('course').insert({
            code, name: co.name, department: co.department ?? null,
          }).throwOnError()
          for (const se of (co.sections ?? [])) {
            await admin.from('section').insert({
              course_code: code, year: se.year, term: se.term, section_no: se.section_no,
              professor_code: se.professor_code ?? null, capacity: se.capacity ?? null,
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
        if (!['professor', 'course', 'semester', 'period', 'section', 'section_time'].includes(table)) {
          return json({ status: 'BAD_REQUEST' }, 400)
        }
        await admin.from(table).delete().match(payload.key as Record<string, unknown>).throwOnError()
        return json({ status: 'OK' })
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
      case 'block_user': {
        const username = String(payload.username ?? '').trim()
        const days = Number(payload.days) || 7
        if (!username) return json({ status: 'BAD_REQUEST' }, 400)
        const until = new Date(Date.now() + days * 86400000).toISOString()
        await admin.from('block').insert({
          username, blocked_until: until, reason: payload.reason ?? null,
        }).throwOnError()
        return json({ status: 'OK', until })
      }
      case 'unblock': {
        const username = String(payload.username ?? '').trim()
        await admin.from('block').delete().eq('username', username)
        return json({ status: 'OK' })
      }
      case 'list_blocks': {
        const { data } = await admin.from('block')
          .select('id, username, blocked_until, reason')
          .gt('blocked_until', new Date().toISOString())
          .order('blocked_until', { ascending: false })
        return json({ status: 'OK', blocks: data ?? [] })
      }
      // ── 정보 수정 제안 ──
      case 'list_corrections': {
        const st = payload.status ? String(payload.status) : 'pending'
        const { data } = await admin.from('correction')
          .select('id, target, professor_code, course_code, year, term, section_no, label, field, suggested, note, status, created_at')
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
        // 반영 성공한 제안은 테이블에 남길 이유가 없어 즉시 삭제.
        const { data: st, error } = await admin.rpc('apply_correction_row', { p_id: payload.id })
        if (error) return json({ status: 'ERROR', detail: error.message }, 500)
        if (st === 'OK') await admin.from('correction').delete().eq('id', payload.id).throwOnError()
        const code = st === 'OK' ? 200 : st === 'NOT_FOUND' ? 404 : st === 'ALREADY_DONE' ? 409 : 400
        return json({ status: st ?? 'ERROR' }, code)
      }
      // 자동반영 알림: 사용자 동일 제안 3건↑로 시스템이 반영한 건. 관리자 확인 전까지만 유지.
      case 'list_auto_notices': {
        const { data } = await admin.from('correction')
          .select('id, target, professor_code, course_code, year, term, section_no, label, field, suggested, note, created_at')
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
          admin.from('review').select('id,course_code,prof_comment,course_comment,report_count,created_at')
            .gt('report_count', 0).order('report_count', { ascending: false }).limit(200),
          admin.from('class_memo').select('id,course_code,year,term,section_no,content,report_count,created_at')
            .gt('report_count', 0).order('report_count', { ascending: false }).limit(200),
          admin.from('board_post').select('id,board_id,title,content,report_count,created_at')
            .gt('report_count', 0).order('report_count', { ascending: false }).limit(200),
        ])
        // 게시판명 라벨(맥락)
        const boardIds = new Set((bpost.data ?? []).map((p) => p.board_id))
        const boardMap = new Map()
        if (boardIds.size) {
          const { data: bs } = await admin.from('board').select('id,name').in('id', [...boardIds])
          for (const b of (bs ?? [])) boardMap.set(b.id, b.name)
        }
        const items = [
          ...(rev.data ?? []).map((r) => ({
            type: 'review', id: r.id, course_code: r.course_code, created_at: r.created_at,
            report_count: r.report_count, text: [r.prof_comment, r.course_comment].filter(Boolean).join(' / '), meta: {},
          })),
          ...(memo.data ?? []).map((m) => ({
            type: 'class_memo', id: m.id, course_code: m.course_code, created_at: m.created_at,
            report_count: m.report_count, text: m.content, meta: { year: m.year, term: m.term, section_no: m.section_no },
          })),
          ...(bpost.data ?? []).map((p) => ({
            type: 'board_post', id: p.id, course_code: boardMap.get(p.board_id) ?? '게시판', created_at: p.created_at,
            report_count: p.report_count, text: [p.title, p.content].filter(Boolean).join(' — '), meta: {},
          })),
        ].sort((a, b) => (b.report_count - a.report_count) || (a.created_at < b.created_at ? 1 : -1))
        return json({ status: 'OK', items })
      }
      // 신고 무시(정상 처리): 신고 이벤트 삭제 + report_count 초기화. 글은 유지.
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
        await admin.from(table).update({ report_count: 0 }).eq('id', id).throwOnError()
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
})
