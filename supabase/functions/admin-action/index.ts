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
        return json({ status: 'OK', setting: data ?? {} })
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
          code, name: payload.name, department: payload.department ?? null, title: payload.title ?? null,
        }).throwOnError()
        return json({ status: 'OK', code })
      }
      case 'set_professor':
        await admin.from('professor').upsert({
          code: payload.code, name: payload.name,
          department: payload.department ?? null, title: payload.title ?? null,
        }).throwOnError()
        return json({ status: 'OK' })
      case 'set_course':
        await admin.from('course').upsert({
          code: payload.code, name: payload.name,
          department: payload.department ?? null, credits: payload.credits ?? null,
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
        const [rev, memo, exam] = await Promise.all([
          admin.from('review').select('id,course_code,professor_code,prof_comment,course_comment,created_at').order('created_at', { ascending: false }).limit(limit),
          admin.from('class_memo').select('id,course_code,year,term,section_no,content,created_at').order('created_at', { ascending: false }).limit(limit),
          admin.from('exam_archive').select('id,course_code,title,description,created_at').order('created_at', { ascending: false }).limit(limit),
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
        return json({ status: 'OK', items })
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
          code, name: payload.name, department: payload.department ?? null, credits: payload.credits ?? null,
        }).throwOnError()
        return json({ status: 'OK', code })
      }
      case 'bulk_catalog': {
        const courses = (payload.courses as any[]) ?? []
        let created = 0
        for (const co of courses) {
          const { data: code } = await admin.rpc('gen_course_code')
          await admin.from('course').insert({
            code, name: co.name, department: co.department ?? null, credits: co.credits ?? null,
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
              code, name, department: pf.department ?? null, title: pf.title ?? null,
            }).throwOnError()
          } else if (pf.update) {
            await admin.from('professor').update({
              department: pf.department ?? null, title: pf.title ?? null,
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
            await admin.from('course').insert({ code, name: co.name, credits: co.credits ?? null }).throwOnError()
            nC++
          } else if (co.credits != null) {
            await admin.from('course').update({ credits: co.credits }).eq('code', code).throwOnError()
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
      default:
        return json({ status: 'BAD_REQUEST', detail: 'unknown action' }, 400)
    }
  } catch (e) {
    return json({ status: 'ERROR', detail: (e as Error).message }, 500)
  }
})
