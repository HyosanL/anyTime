// 웹푸시 발송 팬아웃 — 호출원은 Supabase pg_net 트리거(새 댓글·HOT 승격)와
// Firebase nextClassNotify / sendSelfTestPush.
// 인증: X-Push-Secret 공유 시크릿(_middleware.js 에서 검증 — 유저 JWT 아님).
// 익명성: 본문 targets 는 구독 endpoint·암호키만 담는다(사용자 식별자·작성자 정보 없음).
// 무료 플랜 한도(호출당 서브요청 50)는 DB 트리거가 30건씩 잘라 호출하는 것으로 지킨다
// (Worker 자기호출 체인 없음). 만료 구독(404/410)은 push_prune RPC 로 정리.
//
// sync:true — 발송 결과(푸시서비스 HTTP 상태)를 응답에 실어 돌려준다. 테스트 버튼
// (sendSelfTestPush)이 "구독 만료/거부/네트워크 실패"를 사용자에게 보여주려고 쓴다.
// 단일 타깃이라 Workers 서브요청 한도와 무관하고, waitUntil 대신 await 한다.
import { sendPush } from '../lib/webpush.js';

const MAX_TARGETS = 45;   // 방어적 상한(트리거는 30씩 보냄): 45 발송 + prune 1 < 서브요청 50

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return json({ status: 'BAD_REQUEST' }, 400); }
  const { kind, post_id, title, board, path, body: msgBody, mow, quiet, test, targets, sync } = body || {};
  if (!Array.isArray(targets) || targets.length === 0) return json({ status: 'OK', sent: 0 });
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return json({ status: 'NO_VAPID' }, 500);

  const payload = { kind, post_id, title, board, path, body: msgBody, mow, quiet, test };
  const slice = targets.slice(0, MAX_TARGETS);

  // 동기 모드: 결과를 기다렸다가 그대로 반환(테스트 버튼 전용).
  if (sync === true) {
    const results = await fanout(env, payload, slice);
    return json({ status: 'OK', results });
  }

  // 발송은 응답과 분리해 백그라운드로 — pg_net 타임아웃(5s)과 무관하게 완주한다.
  context.waitUntil(fanout(env, payload, slice));
  return json({ status: 'ACCEPTED', targets: slice.length });
}

// 반환: [{ endpoint, status, detail? }] — status 는 푸시서비스 HTTP 상태(201 등) 또는
// 0(fetch 예외); detail 은 실패 시 푸시서비스 응답 본문 일부(있을 때만).
async function fanout(env, { kind, post_id, title, board, path, body: msgBody, mow, quiet, test }, targets) {
  const vapid = {
    subject: env.VAPID_SUBJECT || 'mailto:hyosanl0211@gmail.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  // board 는 HOT 알림에서 "어느 게시판" 표시에 쓰인다(댓글 알림엔 없음 → undefined 로 빠짐).
  // path·body 는 관리자 알림(수정제안·신고삭제·자동반영)에서 목적지·본문으로 쓰인다.
  // mow 는 "다음 수업"·"오늘 수업 요약" 알림에서 SW 가 기기 Cache 의 슬롯/요일을 찾는 데 쓴다.
  // quiet·test 는 테스트 푸시 전용(SW 가 강제 무음 / 샘플 내용 렌더링).
  const data = { kind, post_id, title, board, path, body: msgBody, mow, quiet, test };
  // topic: 같은 글의 미전달 알림은 최신 1건으로 대체(오프라인 기기 폭주 방지).
  // 댓글은 즉시성(urgency=high — 도즈 모드 관통), HOT 은 일반 우선순위.
  // 관리자 알림은 post_id 가 없으므로 글 topic 을 붙이지 않는다(서로 덮어쓰지 않게).
  // "다음 수업"은 늦게 오면 무의미 → TTL 5분. "오늘 수업 요약"은 조금 늦어도 유효 →
  //   TTL 1시간(잠긴 아이폰이 5분 안에 못 받아 APNs 가 버리는 문제 대응).
  const opts = kind === 'hot'
    // post_id 없는 발송(🔔 테스트 알림 버튼)에서 topic 이 문자 그대로 "hot-undefined" 가
    // 되는 걸 막는다 — 실서비스 HOT 발송은 항상 post_id 를 넘기므로 여기서만 해당.
    ? { ttl: 43200, urgency: 'normal', ...(post_id != null ? { topic: `hot-${post_id}` } : {}) }
    : kind === 'next_class'
      ? { ttl: 300, urgency: 'high', topic: 'next-class' }
      : kind === 'today_summary'
        ? { ttl: 3600, urgency: 'high', topic: 'today-summary' }
        : { ttl: 86400, urgency: 'high', ...(post_id != null ? { topic: `post-${post_id}` } : {}) };

  const jwtCache = new Map();   // VAPID JWT 는 푸시서비스 origin 당 1회만 서명
  const settled = await Promise.allSettled(
    targets.map((t) => sendPush(t, data, opts, vapid, jwtCache)));

  // 404/410 = 만료·해지된 구독 → DB 에서 제거(다음 앱 실행 때 클라이언트가 재등록)
  const dead = [];
  const results = settled.map((r, i) => {
    const { status, detail } = r.status === 'fulfilled' ? r.value : { status: 0 };
    if (status === 404 || status === 410) dead.push(targets[i].endpoint);
    return { endpoint: targets[i].endpoint, status, ...(detail ? { detail } : {}) };
  });
  if (dead.length && env.PUSH_SECRET) {
    await fetch('https://asia-northeast3-anytime-rokafa.cloudfunctions.net/pushPrune', {
      method: 'POST',
      headers: {
        'X-Push-Secret': env.PUSH_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoints: dead }),
    }).catch(() => { /* 정리 실패는 다음 발송 때 재시도됨 */ });
  }
  return results;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
