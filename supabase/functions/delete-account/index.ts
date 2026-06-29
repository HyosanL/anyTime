// =====================================================================
//  애타 (AnyTime) — 회원 탈퇴 Edge Function : delete-account
//  본인 비밀번호 재확인 후 service-role 로 Auth 계정 삭제.
//  → cadet / timetable / admin 은 FK ON DELETE CASCADE 로 함께 삭제.
//  ※ 게시글(강의평·메모·족보)은 완전 익명(작성자 컬럼 없음)이라 남는다.
//  배포: supabase functions deploy delete-account --no-verify-jwt
//  요청 body: { password }
//  응답 status: 'OK' | 'BAD_PASSWORD' | 'UNAUTH' | 'BAD_REQUEST' | 'ERROR'
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (status: string, code: number) =>
  new Response(JSON.stringify({ status }), { status: code, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json('BAD_REQUEST', 405)

  let body: { password?: string }
  try { body = await req.json() } catch { return json('BAD_REQUEST', 400) }
  const password = body.password ?? ''
  if (!password) return json('BAD_REQUEST', 400)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

  // 1) 호출자 식별 (JWT)
  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user } } = await userClient.auth.getUser()
  if (!user?.email) return json('UNAUTH', 401)

  // 2) 비밀번호 재확인
  const check = createClient(url, anonKey, { auth: { persistSession: false } })
  const { error: pwErr } = await check.auth.signInWithPassword({ email: user.email, password })
  if (pwErr) return json('BAD_PASSWORD', 403)

  // 3) Auth 계정 삭제 → cadet/timetable/admin cascade
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { error: delErr } = await admin.auth.admin.deleteUser(user.id)
  if (delErr) return json('ERROR', 500)

  return json('OK', 200)
})
