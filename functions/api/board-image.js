// 게시판 이미지 인라인 스트리밍 ← R2. 인증 사용자만(미들웨어). <img> 는 blob 으로 표시.
export async function onRequestGet(context) {
  const { request, env } = context;
  const key = new URL(request.url).searchParams.get('key');
  if (!key || !key.startsWith('board/')) return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });
  const obj = await env.EXAM_FILES.get(key);
  if (!obj) return Response.json({ status: 'NOT_FOUND' }, { status: 404 });
  const h = new Headers();
  h.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg');
  h.set('Cache-Control', 'private, max-age=600');
  return new Response(obj.body, { headers: h });
}
