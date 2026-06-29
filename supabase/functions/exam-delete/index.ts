// =====================================================================
//  애타 (AnyTime) — 족보 삭제 Edge Function : exam-delete
//  게시글 비밀번호 검증(delete_exam RPC) 후 service-role 로 Storage 파일까지 제거.
//  (일반 사용자에게 storage 삭제 권한을 주지 않아 고아 파일·무단삭제 방지)
//  배포: supabase functions deploy exam-delete --no-verify-jwt
//  요청 body: { id, password }
//  응답 status: 'OK' | 'BAD_PASSWORD' | 'NOT_FOUND' | 'BAD_REQUEST' | 'ERROR'
// =====================================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(status: string, code: number) {
  return new Response(JSON.stringify({ status }), {
    status: code,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json('BAD_REQUEST', 405)

  let body: { id?: number; password?: string }
  try {
    body = await req.json()
  } catch {
    return json('BAD_REQUEST', 400)
  }
  const id = Number(body.id)
  const password = body.password ?? ''
  if (!id || !password) return json('BAD_REQUEST', 400)

  const url = Deno.env.get('SUPABASE_URL')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  // 호출자(생도) JWT 로 동작하는 클라이언트 → delete_exam 안에서 auth.uid() 유지
  // (작성자의 레벨 -1 을 정확히 반영하기 위함)
  const authHeader = req.headers.get('Authorization') ?? ''
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })

  // 1) 파일 key 미리 확보 (삭제되면 못 읽으므로)
  const { data: row } = await admin
    .from('exam_archive')
    .select('file_url')
    .eq('id', id)
    .maybeSingle()
  if (!row) return json('NOT_FOUND', 404)

  // 2) 비밀번호 검증 + 행 삭제 + 레벨 -1 (유저 JWT 로 RPC 호출)
  const { data: ok, error } = await userClient.rpc('delete_exam', {
    p_id: id,
    p_post_password: password,
  })
  if (error) {
    if (/비밀번호/.test(error.message)) return json('BAD_PASSWORD', 403)
    return json('ERROR', 500)
  }
  if (ok === false) return json('NOT_FOUND', 404)

  // 3) Storage 파일 제거 (service-role)
  if (row.file_url) {
    await admin.storage.from('exam-files').remove([row.file_url])
  }
  return json('OK', 200)
})
