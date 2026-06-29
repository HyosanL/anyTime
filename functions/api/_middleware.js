// 모든 /api/* 요청에 대해 Supabase JWT 를 검증(로그인 사용자만 R2 접근).
// context.data.token 에 사용자 토큰을 실어 다음 핸들러로 전달.
export async function onRequest(context) {
  const { request, env, next, data } = context;
  if (request.method === 'OPTIONS') return next();

  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ status: 'UNAUTH' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  // 토큰 유효성 확인(인증된 내부 사용자만)
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth },
  });
  if (!res.ok) {
    return new Response(JSON.stringify({ status: 'UNAUTH' }), {
      status: 401, headers: { 'Content-Type': 'application/json' },
    });
  }
  data.token = auth;
  data.user = await res.json();
  return next();
}
