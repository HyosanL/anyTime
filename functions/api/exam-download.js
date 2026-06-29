// 족보 파일 다운로드 ← R2. 인증된 사용자만(미들웨어). R2→Worker→클라이언트 egress 무료.
// 요청: GET /api/exam-download?key=...&name=...
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const name = url.searchParams.get('name') || 'exam';
  if (!key) return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });

  const obj = await env.EXAM_FILES.get(key);
  if (!obj) return Response.json({ status: 'NOT_FOUND' }, { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set('Cache-Control', 'private, max-age=0');
  return new Response(obj.body, { headers });
}
