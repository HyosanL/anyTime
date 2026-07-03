// 게시판 이미지 업로드 → R2 (board/ prefix). 미들웨어가 JWT 검증.
// 보안: 래스터 이미지 MIME 만 허용(allowlist). SVG/HTML/JS 등 '실행 가능' 콘텐츠는 거부해
//       버킷이 능동콘텐츠 호스트로 악용되거나 저장형 XSS 로 이어지지 않게 한다.
const OK_IMAGE = /^image\/(jpeg|png|webp|gif|heic|heif|avif|bmp)$/i;
function safeExt(name) {
  const i = (name || '').lastIndexOf('.');
  return i < 0 ? '.jpg' : name.slice(i).toLowerCase().replace(/[^.a-z0-9]/g, '');
}
export async function onRequestPost(context) {
  const { request, env } = context;
  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });
  if (!OK_IMAGE.test(file.type || '')) return Response.json({ status: 'BAD_TYPE' }, { status: 415 });
  if (file.size > 12 * 1024 * 1024) return Response.json({ status: 'TOO_LARGE' }, { status: 413 });
  const key = `board/${crypto.randomUUID()}${safeExt(file.name)}`;
  await env.EXAM_FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type },
  });
  return Response.json({ status: 'OK', key });
}
