// 족보 삭제: 게시글 비번 검증(delete_exam RPC, 유저 JWT) 후 R2 객체 제거.
// 요청: POST { id, password }
export async function onRequestPost(context) {
  const { request, env, data } = context;
  const { id, password } = await request.json().catch(() => ({}));
  if (!id) return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });

  const H = { apikey: env.SUPABASE_ANON_KEY, Authorization: data.token, 'Content-Type': 'application/json' };

  // 1) 파일 key 확보(삭제 전) — 첨부는 exam_file 릴레이션(정규화), embedded select 로 함께 조회
  const rowRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/exam_archive?id=eq.${id}&select=id,exam_file(object_key)`, { headers: H });
  const row = (await rowRes.json())?.[0];
  if (!row) return Response.json({ status: 'NOT_FOUND' }, { status: 404 });

  const keys = new Set();
  if (Array.isArray(row.exam_file)) for (const f of row.exam_file) { if (f?.object_key) keys.add(f.object_key); }

  // 2) 비번 검증 + 행 삭제 + 레벨 -1 (유저 JWT 로 RPC)
  const delRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/delete_exam`, {
    method: 'POST', headers: H, body: JSON.stringify({ p_id: id, p_post_password: password || '' }),
  });
  if (!delRes.ok) {
    const t = await delRes.text();
    if (/비밀번호/.test(t)) return Response.json({ status: 'BAD_PASSWORD' }, { status: 403 });
    return Response.json({ status: 'ERROR' }, { status: 500 });
  }
  if ((await delRes.json()) === false) return Response.json({ status: 'NOT_FOUND' }, { status: 404 });

  // 3) R2 객체 제거(첨부 전체)
  for (const key of keys) await env.EXAM_FILES.delete(key);
  return Response.json({ status: 'OK' });
}
