// 웹푸시 발송 팬아웃 — 호출원은 Supabase pg_net 트리거(새 댓글·HOT 승격)뿐.
// 인증: X-Push-Secret 공유 시크릿(_middleware.js 에서 검증 — 유저 JWT 아님).
// 익명성: 본문 targets 는 구독 endpoint·암호키만 담는다(사용자 식별자·작성자 정보 없음).
// 무료 플랜 한도(호출당 서브요청 50)는 DB 트리거가 30건씩 잘라 호출하는 것으로 지킨다
// (Worker 자기호출 체인 없음). 만료 구독(404/410)은 push_prune RPC 로 정리.
import { sendPush } from '../lib/webpush.js';

const MAX_TARGETS = 45;   // 방어적 상한(트리거는 30씩 보냄): 45 발송 + prune 1 < 서브요청 50

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return json({ status: 'BAD_REQUEST' }, 400); }
  const { kind, post_id, title, board, path, body: msgBody, targets } = body || {};
  if (!Array.isArray(targets) || targets.length === 0) return json({ status: 'OK', sent: 0 });
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return json({ status: 'NO_VAPID' }, 500);

  // 발송은 응답과 분리해 백그라운드로 — pg_net 타임아웃(5s)과 무관하게 완주한다.
  context.waitUntil(fanout(env, { kind, post_id, title, board, path, body: msgBody }, targets.slice(0, MAX_TARGETS)));
  return json({ status: 'ACCEPTED', targets: Math.min(targets.length, MAX_TARGETS) });
}

async function fanout(env, { kind, post_id, title, board, path, body: msgBody }, targets) {
  const vapid = {
    subject: env.VAPID_SUBJECT || 'mailto:hyosanl0211@gmail.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  // board 는 HOT 알림에서 "어느 게시판" 표시에 쓰인다(댓글 알림엔 없음 → undefined 로 빠짐).
  // path·body 는 관리자 알림(수정제안·신고삭제·자동반영)에서 목적지·본문으로 쓰인다.
  const data = { kind, post_id, title, board, path, body: msgBody };
  // topic: 같은 글의 미전달 알림은 최신 1건으로 대체(오프라인 기기 폭주 방지).
  // 댓글은 즉시성(urgency=high — 도즈 모드 관통), HOT 은 일반 우선순위.
  // 관리자 알림은 post_id 가 없으므로 글 topic 을 붙이지 않는다(서로 덮어쓰지 않게).
  const opts = kind === 'hot'
    ? { ttl: 43200, urgency: 'normal', topic: `hot-${post_id}` }
    : { ttl: 86400, urgency: 'high', ...(post_id != null ? { topic: `post-${post_id}` } : {}) };

  const jwtCache = new Map();   // VAPID JWT 는 푸시서비스 origin 당 1회만 서명
  const results = await Promise.allSettled(
    targets.map((t) => sendPush(t, data, opts, vapid, jwtCache)));

  // 404/410 = 만료·해지된 구독 → DB 에서 제거(다음 앱 실행 때 클라이언트가 재등록)
  const dead = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && (r.value === 404 || r.value === 410)) dead.push(targets[i].endpoint);
  });
  if (dead.length && env.PUSH_SECRET) {
    await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/push_prune`, {
      method: 'POST',
      headers: {
        apikey: env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_secret: env.PUSH_SECRET, p_endpoints: dead }),
    }).catch(() => { /* 정리 실패는 다음 발송 때 재시도됨 */ });
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
