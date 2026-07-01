// 모든 /api/* 요청에 대해 Supabase JWT 를 검증(로그인 사용자만 R2 접근).
// - 기본: JWT 서명을 로컬(HS256)로 검증해 Supabase 왕복(/auth/v1/user)을 없앤다(egress·지연 절감).
// - SUPABASE_JWT_SECRET 미설정 시: 안전하게 원격검증으로 폴백(기존 동작).
//   ※ 로컬검증은 레거시 HS256 프로젝트용. 비대칭 서명키로 마이그레이션했다면 시크릿을 비워 폴백 사용.
// - /api/board-sweep 는 유저 JWT 대신 X-Sweep-Secret 으로 게이트(크론 전용).
// context.data.token 에 사용자 토큰을 실어 다음 핸들러로 전달.

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]))); }
  catch { return null; }
}

async function verifyHs256(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sig = b64urlToBytes(parts[2]);
  const signed = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  return crypto.subtle.verify('HMAC', key, sig, signed);
}

function unauth() {
  return new Response(JSON.stringify({ status: 'UNAUTH' }), {
    status: 401, headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequest(context) {
  const { request, env, next, data } = context;
  if (request.method === 'OPTIONS') return next();

  // 크론 전용 고아 스윕: 유저 JWT 대신 공유 시크릿.
  const path = new URL(request.url).pathname;
  if (path === '/api/board-sweep') {
    if (env.SWEEP_SECRET && request.headers.get('X-Sweep-Secret') === env.SWEEP_SECRET) return next();
    return unauth();
  }

  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return unauth();
  const token = auth.slice(7);

  if (env.SUPABASE_JWT_SECRET) {
    // 로컬 검증: 서명(HS256) + 만료(exp) + role=authenticated. Supabase 왕복 없음.
    const payload = decodeJwtPayload(token);
    const valid = payload
      && payload.role === 'authenticated'
      && (!payload.exp || payload.exp * 1000 > Date.now())
      && await verifyHs256(token, env.SUPABASE_JWT_SECRET);
    if (!valid) return unauth();
    data.user = { id: payload.sub, email: payload.email, role: payload.role };
  } else {
    // 폴백: 원격 검증(시크릿 미설정 시). 인증된 내부 사용자만.
    const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: auth },
    });
    if (!res.ok) return unauth();
    data.user = await res.json();
  }

  data.token = auth;
  return next();
}
