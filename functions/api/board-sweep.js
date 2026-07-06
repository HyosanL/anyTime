// 게시판 이미지 고아 스윕: board_post 가 더는 참조하지 않는 R2 'board/' 객체를 정리.
// - purge_board(90일)·관리자 일괄삭제 등 서버측 삭제는 R2 를 못 지우므로, 이 스윕이 대조 정리한다.
// - 미들웨어가 X-Sweep-Secret 로 게이트(유저 JWT 대신, 크론 전용).
// - 방금 업로드됐지만 글이 아직 안 만들어진 이미지를 지우지 않도록 GRACE(48h) 이후 것만 삭제.
// 트리거: pg_cron + pg_net(net.http_post) 로 매일 호출(schema.sql 하단 템플릿 참고).
const GRACE_MS = 48 * 60 * 60 * 1000;

export async function onRequest(context) {
  const { env } = context;

  // 1) 현재 참조 중인 key 집합 (SECURITY DEFINER RPC, anon)
  const refRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/board_referenced_keys`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!refRes.ok) return Response.json({ status: 'ERROR', step: 'refs' }, { status: 500 });
  const referenced = new Set((await refRes.json()) || []);

  // 2) R2 'board/' 순회하며 고아(참조X + GRACE 경과) 삭제
  //    저화질 썸네일은 원본과 같은 key + '.thumb' 규약(DB 미기록)이므로,
  //    원본 key 가 참조 중이면 그 썸네일도 참조 중으로 간주한다.
  const cutoff = Date.now() - GRACE_MS;
  let listed = 0, deleted = 0, cursor;
  do {
    const page = await env.EXAM_FILES.list({ prefix: 'board/', limit: 1000, cursor });
    for (const obj of page.objects) {
      listed++;
      const baseKey = obj.key.endsWith('.thumb') ? obj.key.slice(0, -'.thumb'.length) : obj.key;
      const uploadedMs = obj.uploaded ? new Date(obj.uploaded).getTime() : 0;
      if (!referenced.has(obj.key) && !referenced.has(baseKey) && uploadedMs && uploadedMs < cutoff) {
        await env.EXAM_FILES.delete(obj.key);
        deleted++;
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  return Response.json({ status: 'OK', listed, deleted, referenced: referenced.size });
}
