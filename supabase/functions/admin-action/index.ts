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
      case 'add_codes': {
        const codes = (payload.codes as string[]) ?? []
        const label = (payload.label as string) ?? null
        const rows = []
        for (const c of codes) {
          const code = String(c).trim()
          if (!code) continue
          const { data: hash } = await admin.rpc('hash_signup_code', { p_code: code })
          if (hash) rows.push({ code_hash: hash, label })
        }
        if (rows.length) await admin.from('signup_code').upsert(rows, { onConflict: 'code_hash', ignoreDuplicates: true })
        return json({ status: 'OK', added: rows.length })
      }
      case 'set_professor':
        await admin.from('professor').upsert({ code: payload.code, name: payload.name }).throwOnError()
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
        const { data } = await admin.from('admin').select('id, cadet:cadet(username)')
        const admins = (data ?? []).map((a) => ({ id: a.id, username: a.cadet?.username ?? '(알수없음)' }))
        return json({ status: 'OK', admins })
      }
      case 'grant_admin': {
        const username = String(payload.username ?? '').trim()
        const { data: c } = await admin.from('cadet').select('id').eq('username', username).maybeSingle()
        if (!c) return json({ status: 'NO_USER' }, 404)
        await admin.from('admin').upsert({ id: c.id }, { onConflict: 'id', ignoreDuplicates: true })
        return json({ status: 'OK' })
      }
      case 'revoke_admin': {
        const username = String(payload.username ?? '').trim()
        const { data: c } = await admin.from('cadet').select('id').eq('username', username).maybeSingle()
        if (!c) return json({ status: 'NO_USER' }, 404)
        // 마지막 관리자 제거 방지
        const { count } = await admin.from('admin').select('id', { count: 'exact', head: true })
        if ((count ?? 0) <= 1) return json({ status: 'LAST_ADMIN' }, 409)
        await admin.from('admin').delete().eq('id', c.id)
        return json({ status: 'OK' })
      }
      default:
        return json({ status: 'BAD_REQUEST', detail: 'unknown action' }, 400)
    }
  } catch (e) {
    return json({ status: 'ERROR', detail: (e as Error).message }, 500)
  }
})
