// 공유 링크(비회원)용 게시판 이미지 스트리밍 ← R2. 유저 JWT 대신 공유 토큰으로 게이트:
// share_image_ok RPC(anon·SECURITY DEFINER)가 "이 토큰이 가리키는 글의 이미지인가 +
// 비회원 열람이 허용 상태인가"를 검증한다(미들웨어는 이 경로만 무인증 통과시킨다).
// 응답 보안 헤더는 board-image.js 와 동일 — allowlist 외 MIME 강등 + nosniff + 잠금 CSP.
const OK_IMAGE = /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const share = url.searchParams.get('share');
  if (!key || !key.startsWith('board/') || !UUID_RE.test(share || '')) {
    return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });
  }
  const chk = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/share_image_ok`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_token: share, p_key: key }),
  });
  if (!chk.ok || (await chk.json()) !== true) {
    return Response.json({ status: 'FORBIDDEN' }, { status: 403 });
  }
  const obj = await env.EXAM_FILES.get(key);
  if (!obj) return Response.json({ status: 'NOT_FOUND' }, { status: 404 });
  const stored = obj.httpMetadata?.contentType || '';
  const type = OK_IMAGE.test(stored) ? stored : 'application/octet-stream';
  const h = new Headers();
  h.set('Content-Type', type);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', "default-src 'none'; sandbox");
  h.set('Cache-Control', 'private, max-age=600');
  return new Response(obj.body, { headers: h });
}
