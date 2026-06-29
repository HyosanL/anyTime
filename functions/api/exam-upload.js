// 족보 파일 업로드 → Cloudflare R2 (바인딩 EXAM_FILES). 메타데이터 반환.
// 요청: multipart/form-data { courseCode, file }
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
  if (file.size > 100 * 1024 * 1024) {
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
