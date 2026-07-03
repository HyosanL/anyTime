// 게시판 이미지 인라인 스트리밍 ← R2. 인증 사용자만(미들웨어). <img> 는 blob 으로 표시.
// 보안: 저장된 MIME 이 래스터 이미지 allowlist 가 아니면(구버전/악성 객체 포함)
//       octet-stream 으로 강등하고, nosniff + 잠금 CSP 로 브라우저가 능동콘텐츠로
//       해석하지 못하게 한다.
const OK_IMAGE = /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/i;
export async function onRequestGet(context) {
  const { request, env } = context;
  const key = new URL(request.url).searchParams.get('key');
  if (!key || !key.startsWith('board/')) return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });
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
