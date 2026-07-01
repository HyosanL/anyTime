// 게시글 삭제: 게시글 비번 검증(delete_post RPC, 유저 JWT) 후 R2 이미지 객체 제거.
// exam-delete.js 와 동일 패턴. 미들웨어가 JWT 검증(data.token).
// 요청: POST { id, password }
export async function onRequestPost(context) {
  const { request, env, data } = context;
  const { id, password } = await request.json().catch(() => ({}));
  if (!id || !password) return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });

  const H = { apikey: env.SUPABASE_ANON_KEY, Authorization: data.token, 'Content-Type': 'application/json' };

  // 1) 이미지 key 확보(삭제 전) — 다중(image_keys) + 구버전 단일(image_key)
  const rowRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/board_post?id=eq.${id}&select=image_key,image_keys`, { headers: H });
  const row = (await rowRes.json())?.[0];
  if (!row) return Response.json({ status: 'NOT_FOUND' }, { status: 404 });

  const keys = new Set();
  if (Array.isArray(row.image_keys)) for (const k of row.image_keys) { if (k) keys.add(k); }
  if (row.image_key) keys.add(row.image_key);

  // 2) 비번 검증 + 행 삭제(댓글·board_event CASCADE) — 유저 JWT 로 RPC
  const delRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/delete_post`, {
    method: 'POST', headers: H, body: JSON.stringify({ p_id: id, p_password: password }),
  });
  if (!delRes.ok) {
    const t = await delRes.text();
    if (/비밀번호/.test(t)) return Response.json({ status: 'BAD_PASSWORD' }, { status: 403 });
    return Response.json({ status: 'ERROR' }, { status: 500 });
  }
  if ((await delRes.json()) === false) return Response.json({ status: 'NOT_FOUND' }, { status: 404 });

  // 3) R2 이미지 제거 (board/ prefix 만) — 실패해도 스윕이 뒤늦게 정리하므로 치명적이지 않음
  for (const key of keys) {
    if (typeof key === 'string' && key.startsWith('board/')) {
      try { await env.EXAM_FILES.delete(key); } catch { /* 스윕이 정리 */ }
    }
  }
  return Response.json({ status: 'OK' });
}
