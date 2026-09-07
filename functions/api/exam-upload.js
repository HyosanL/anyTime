// 족보 파일 업로드 → Cloudflare R2 (바인딩 EXAM_FILES). 메타데이터 반환.
// 요청: multipart/form-data { courseCode, file }
// 보안: 확장자 allowlist(1차 게이트 — .hwp 등은 브라우저가 MIME 을 빈 값/octet-stream 으로
//       주는 일이 잦아 MIME 만으론 부족). exam-download 는 항상 attachment + nosniff 로
//       내려주므로 위장 파일이 인라인 실행되지는 않지만, R2 를 임의 파일 호스트로 쓰는
//       남용을 막는다. 크기 상한 25MB.
const OK_EXT = /\.(pdf|hwp|hwpx|docx?|xlsx?|pptx?|jpe?g|png|webp|gif|heic|heif|avif|zip|txt|md)$/i;
const MAX_BYTES = 25 * 1024 * 1024;

function safeExt(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase().replace(/[^.a-z0-9]/g, '');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const form = await request.formData();
  const file = form.get('file');
  const courseCode = String(form.get('courseCode') || 'etc').replace(/[^A-Za-z0-9_-]/g, '');
  if (!file || typeof file === 'string') {
    return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });
  }
  if (!OK_EXT.test(file.name || '')) {
    return Response.json({ status: 'BAD_TYPE' }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ status: 'TOO_LARGE' }, { status: 413 });
  }

  const key = `${courseCode}/${crypto.randomUUID()}${safeExt(file.name)}`;
  await env.EXAM_FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return Response.json({
    status: 'OK',
    key,
    file_name: file.name,
    file_size: file.size,
    mime_type: file.type || 'application/octet-stream',
  });
}
