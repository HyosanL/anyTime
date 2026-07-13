// 족보 파일 다운로드 ← R2. 인증된 사용자만(미들웨어). R2→Worker→클라이언트 egress 무료.
// 요청: GET /api/exam-download?key=...&name=...
// 족보 key 는 exam-upload 이 만든 `<과목코드>/<uuid><확장자>` 뿐이다. 임의의 key 를 그대로
// R2 에 넘기면 이 경로로 게시판 이미지(board/…) 등 다른 네임스페이스까지 첨부파일로 끌어낼 수 있다.
const EXAM_KEY_RE = /^[A-Za-z0-9_-]{1,32}\/[0-9a-fA-F-]{36}(\.[A-Za-z0-9]{1,8})?$/;

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const name = url.searchParams.get('name') || 'exam';
  if (!key || !EXAM_KEY_RE.test(key) || key.startsWith('board/')) {
    return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });
  }

  const obj = await env.EXAM_FILES.get(key);
  if (!obj) return Response.json({ status: 'NOT_FOUND' }, { status: 404 });

  const headers = new Headers();
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
  // 보안: 항상 첨부(다운로드)로만 내려주고, MIME 스니핑 차단 → 위장 파일이 브라우저에서
  //       인라인 실행되지 않게 한다.
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', 'private, max-age=0');
  return new Response(obj.body, { headers });
}
