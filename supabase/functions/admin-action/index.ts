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

const POST_TABLES = new Set(['review', 'exam_archive', 'class_memo'])
const EDITABLE: Record<string, string[]> = {
  review: ['prof_comment', 'course_comment'],
  class_memo: ['content'],
  exam_archive: ['title', 'description'],
}

// "수3 수4 금1" / "수1-2" → 연속교시 블록 [{day,start,end}] (수정 제안 적용용)
const DAY_KO: Record<string, number> = { 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6, 일: 7 }
function parseTimeBlocks(str: string) {
  const slots: { day: number; period: number }[] = []
  for (const tok of String(str || '').split(/[\s,]+/)) {
    const m = tok.match(/^([월화수목금토일])(\d+)(?:[-~](\d+))?$/)
    if (!m) continue
    const day = DAY_KO[m[1]]
    const a = Number(m[2])
    const b = m[3] ? Number(m[3]) : a
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) slots.push({ day, period: p })
  }
  const byDay: Record<number, Set<number>> = {}
  for (const s of slots) (byDay[s.day] ??= new Set()).add(s.period)
  const blocks: { day: number; start: number; end: number }[] = []
  for (const d of Object.keys(byDay)) {
    const ps = [...byDay[+d]].sort((a, b) => a - b)
    let start = ps[0]
    let prev = ps[0]
    for (let i = 1; i < ps.length; i++) {
      if (ps[i] === prev + 1) prev = ps[i]
      else { blocks.push({ day: +d, start, end: prev }); start = ps[i]; prev = ps[i] }
    }
    blocks.push({ day: +d, start, end: prev })
  }
  return blocks
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

  try {
    switch (action) {
      case 'get_app_setting': {
        const { data } = await admin.from('app_setting')
          .select('campus_lat, campus_lng, radius_m, review_min_days, geo_valid_days, account_delete_days, board_enabled').eq('id', 1).maybeSingle()
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
        const allow = ['geo_valid_days', 'review_min_days', 'radius_m', 'campus_lat', 'campus_lng', 'account_delete_days']
        const field = String(payload.field)
        if (!allow.includes(field)) return json({ status: 'BAD_REQUEST' }, 400)
        await admin.from('app_setting').update({ [field]: payload.value }).eq('id', 1).throwOnError()
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
        if (table === 'exam_archive') {
          const { data: row } = await admin.from('exam_archive').select('file_url').eq('id', payload.id).maybeSingle()
          if (row?.file_url) await admin.storage.from('exam-files').remove([row.file_url])
        }
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
        const [rev, memo, exam] = await Promise.all([
          recent('review', 'id,course_code,professor_code,prof_comment,course_comment,created_at'),
          recent('class_memo', 'id,course_code,year,term,section_no,content,created_at'),
          recent('exam_archive', 'id,course_code,title,description,created_at'),
        ])
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
          .select('id, target, target_key, label, field, suggested, note, status, created_at')
          .eq('status', st).order('created_at', { ascending: false }).limit(200)
        return json({ status: 'OK', items: data ?? [] })
      }
      case 'reject_correction': {
        await admin.from('correction').update({ status: 'rejected' }).eq('id', payload.id).throwOnError()
        return json({ status: 'OK' })
      }
      case 'apply_correction': {
        const { data: c } = await admin.from('correction').select('*').eq('id', payload.id).maybeSingle()
        if (!c) return json({ status: 'NOT_FOUND' }, 404)
        if (c.status !== 'pending') return json({ status: 'ALREADY_DONE' }, 409)
        const key = (c.target_key ?? {}) as Record<string, any>
        const val = (c.suggested ?? null) as string | null
        const secMatch = { course_code: key.course_code, year: key.year, term: key.term, section_no: key.section_no }
        if (c.target === 'professor') {
          if (c.field === 'name') await admin.from('professor').update({ name: val }).eq('code', key.code).throwOnError()
          else if (c.field === 'department') await admin.from('professor').update({ department: val || null }).eq('code', key.code).throwOnError()
          else return json({ status: 'UNSUPPORTED_FIELD' }, 400)
        } else if (c.target === 'course') {
          if (c.field === 'name') await admin.from('course').update({ name: val }).eq('code', key.code).throwOnError()
          else return json({ status: 'UNSUPPORTED_FIELD' }, 400)
        } else if (c.target === 'section') {
          if (c.field !== 'professor') return json({ status: 'UNSUPPORTED_FIELD' }, 400)
          let profCode: string | null = null
          if (val) { const { data: p } = await admin.from('professor').select('code').eq('name', val).limit(1); profCode = p?.[0]?.code ?? null }
          await admin.from('section').update({ professor_code: profCode }).match(secMatch).throwOnError()
        } else if (c.target === 'section_time') {
          if (c.field === 'room') {
            await admin.from('section_time').update({ room: val || null }).match(secMatch).throwOnError()
          } else if (c.field === 'time') {
            const blocks = parseTimeBlocks(val ?? '')
            if (!blocks.length) return json({ status: 'BAD_TIME' }, 400)
            const { data: ex } = await admin.from('section_time').select('room').match(secMatch).limit(1)
            const room = ex?.[0]?.room ?? null
            await admin.from('section_time').delete().match(secMatch).throwOnError()
            for (const b of blocks) {
              await admin.from('section_time').insert({
                ...secMatch, day_of_week: b.day, start_period: b.start, end_period: b.end, room,
              }).throwOnError()
            }
          } else return json({ status: 'UNSUPPORTED_FIELD' }, 400)
        } else return json({ status: 'UNSUPPORTED_TARGET' }, 400)
        await admin.from('correction').update({ status: 'applied' }).eq('id', c.id).throwOnError()
        return json({ status: 'OK' })
      }
      default:
        return json({ status: 'BAD_REQUEST', detail: 'unknown action' }, 400)
    }
  } catch (e) {
    return json({ status: 'ERROR', detail: (e as Error).message }, 500)
  }
})
