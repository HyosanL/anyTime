// 게시판 이미지 업로드 → R2 (board/ prefix). 미들웨어가 JWT 검증.
function safeExt(name) {
  const i = (name || '').lastIndexOf('.');
  return i < 0 ? '.jpg' : name.slice(i).toLowerCase().replace(/[^.a-z0-9]/g, '');
}
export async function onRequestPost(context) {
  const { request, env } = context;
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });
  if (file.size > 12 * 1024 * 1024) return Response.json({ status: 'TOO_LARGE' }, { status: 413 });
  const key = `board/${crypto.randomUUID()}${safeExt(file.name)}`;
  await env.EXAM_FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' },
  });
  return Response.json({ status: 'OK', key });
}
