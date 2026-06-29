// =====================================================================
//  애타 (AnyTime) — 가입 게이트 Edge Function : signup
//  흐름: 가입코드 + 지오펜싱 서버검증(verify_gate) → 통과 시 service-role 로
//        Auth 계정 생성(합성 이메일) → cadet 프로필 생성 → 가입코드 1회 소모.
//  배포: supabase functions deploy signup --no-verify-jwt
//        (SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY 는 자동 주입)
//  요청 body: { username, password, code, lat, lng }
//  응답 status: 'OK' | 'INVALID_CODE' | 'OUT_OF_AREA' | 'USERNAME_TAKEN'
//             | 'WEAK_PASSWORD' | 'BAD_REQUEST' | 'ERROR'
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ALLOW_ORIGIN = '*'
const cors = {
  'Access-Control-Allow-Origin': ALLOW_ORIGIN,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status: string, init: number, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ status, ...extra }), {
    status: init,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

// 아이디 규칙: 영문/숫자/언더스코어 3~20자
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json('BAD_REQUEST', 405)

  let body: { username?: string; password?: string; code?: string; lat?: number; lng?: number }
  try {
    body = await req.json()
  } catch {
    return json('BAD_REQUEST', 400)
  }

  const username = (body.username ?? '').trim()
  const password = body.password ?? ''
  const code = (body.code ?? '').trim()
  const lat = typeof body.lat === 'number' ? body.lat : null
  const lng = typeof body.lng === 'number' ? body.lng : null

  if (!USERNAME_RE.test(username)) return json('BAD_REQUEST', 400, { reason: 'username' })
  if (!code) return json('BAD_REQUEST', 400, { reason: 'code' })
  if (password.length < 6) return json('WEAK_PASSWORD', 400)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  // 1) 게이트 검증 (코드 + 지오펜싱). service_role 로만 실행 가능.
  const { data: gate, error: gateErr } = await admin.rpc('verify_gate', {
    p_code: code,
    p_lat: lat,
    p_lng: lng,
  })
  if (gateErr) return json('ERROR', 500, { detail: gateErr.message })
  if (gate !== 'OK') return json(gate as string, 403) // INVALID_CODE | OUT_OF_AREA

  // 2) 아이디 선점 확인 (합성 이메일 충돌 전에 친절한 메시지)
  const { data: existing } = await admin
    .from('cadet')
    .select('id')
    .eq('username', username)
    .maybeSingle()
  if (existing) return json('USERNAME_TAKEN', 409)

  // 3) Auth 계정 생성 (합성 이메일, 이메일 확인 즉시 완료)
  const email = `${username.toLowerCase()}@anytime.app`
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { username },
  })
  if (createErr || !created?.user) {
    const msg = createErr?.message ?? ''
    if (/already.*registered|exists/i.test(msg)) return json('USERNAME_TAKEN', 409)
    if (/password/i.test(msg)) return json('WEAK_PASSWORD', 400)
    return json('ERROR', 500, { detail: msg })
  }
  const uid = created.user.id

  // 4) cadet 프로필 생성 (실패 시 생성한 Auth 계정 롤백)
  const { error: cadetErr } = await admin
    .from('cadet')
    .insert({ id: uid, username })
  if (cadetErr) {
    await admin.auth.admin.deleteUser(uid)
    if (/duplicate|unique/i.test(cadetErr.message)) return json('USERNAME_TAKEN', 409)
    return json('ERROR', 500, { detail: cadetErr.message })
  }

  // 5) 가입코드 1회 소모 (계정 생성 성공 후에만). 코드는 해시로만 저장됨 → RPC 로 소모.
  await admin.rpc('consume_signup_code', { p_code: code })

  return json('OK', 200, { username })
})
