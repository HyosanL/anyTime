import { createHash } from 'node:crypto';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, requireAdmin, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { pushFanout } from './lib/pushFanout.js';

// Port of push_subscribe()/push_unsubscribe()/push_set_hot()/push_watch()/
// push_unwatch()/push_prune()/admin_push_subscribe()/admin_push_unsubscribe()
// (db/schema.sql). Design doc §3 has the pushSubscriptions/adminPushSubscriptions/
// boardPosts/{id}/watchers collection map, §5 the push-fanout webhook table.
// board.js's onCommentCreatedPush/onPostHotChangedPush already read
// pushSubscriptions (by field query) and watchers (by doc ID = subscription
// doc ID) — every write below matches that shape exactly.

// Doc ID scheme: sha256(endpoint) hex. The endpoint itself is already an
// unguessable capability URL (schema.sql's own comment: "본인만 안다") — no
// salt needed, this is just a stable way to turn "upsert by endpoint" into a
// plain doc ID set() instead of a query. Same hash is reused for the
// watchers/{subscriptionId} doc ID and the adminPushSubscriptions/{uid}_{hash}
// doc ID (design doc §3).
function subscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}

// 지금(Asia/Seoul)의 '주간 분값' — 월요일 00:00 = 0 … 일요일 23:59 = 10079.
// nextClass.js 에 같은 함수가 있다(subscriptionId 처럼 이 코드베이스는 이런 소형
// 헬퍼는 파일별 사본으로 둔다). 오늘 수업 요약/다음 수업 테스트 푸시의 mow 계산용.
function seoulMinuteOfWeek(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const isoDay = kst.getUTCDay() === 0 ? 7 : kst.getUTCDay();
  return (isoDay - 1) * 1440 + kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

// Mirrors the identical validation duplicated in push_subscribe() and
// admin_push_subscribe() in the old schema.
function assertSubscriptionShape(endpoint, p256dh, authKey) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1024) {
    invalid('잘못된 구독 정보입니다.');
  }
  if (typeof p256dh !== 'string' || p256dh.length > 256) invalid('잘못된 구독 정보입니다.');
  if (typeof authKey !== 'string' || authKey.length > 64) invalid('잘못된 구독 정보입니다.');
}

export const pushSubscribe = onCall(async (request) => {
  // uid is an abuse gate only, per push_subscribe()'s own comment — never
  // stored anywhere (pushSubscriptions has no uid field, design doc §3).
  requireAuth(request);
  const { endpoint, p256dh, auth: authKey } = request.data ?? {};
  assertSubscriptionShape(endpoint, p256dh, authKey);

  const ref = db.collection('pushSubscriptions').doc(subscriptionId(endpoint));
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    // ON CONFLICT (endpoint) DO UPDATE SET p256dh=…, auth=… never touched
    // hot_alerts — only set it here on first-create, so an existing device's
    // toggle survives a re-subscribe (e.g. after a key rotation).
    tx.set(
      ref,
      { endpoint, p256dh, auth: authKey, ...(snap.exists ? {} : { hotAlerts: true }) },
      { merge: true }
    );
  });
  return { status: 'OK' };
});

export const pushUnsubscribe = onCall(async (request) => {
  requireAuth(request);
  const { endpoint } = request.data ?? {};
  if (typeof endpoint !== 'string') invalid('잘못된 요청입니다.');
  // Old DELETE cascaded into post_watch via FK; here stale
  // watchers/{subscriptionId} docs are simply skipped by the `.exists` check
  // in onCommentCreatedPush (board.js) — no reverse index exists to find
  // every post this subscription watched, and none is needed for correctness.
  await db.collection('pushSubscriptions').doc(subscriptionId(endpoint)).delete();
  return { status: 'OK' };
});

export const pushSetHot = onCall(async (request) => {
  requireAuth(request);
  const { endpoint, on } = request.data ?? {};
  if (typeof endpoint !== 'string') invalid('잘못된 요청입니다.');

  const ref = db.collection('pushSubscriptions').doc(subscriptionId(endpoint));
  const snap = await ref.get();
  if (!snap.exists) return { status: 'OK' }; // old UPDATE ... WHERE matching 0 rows was silent
  // COALESCE(p_on, TRUE): null/undefined means "on", anything else is coerced.
  await ref.update({ hotAlerts: on === null || on === undefined ? true : Boolean(on) });
  return { status: 'OK' };
});

export const pushWatch = onCall(async (request) => {
  requireAuth(request);
  const { endpoint, postId } = request.data ?? {};
  if (typeof endpoint !== 'string' || !postId) invalid('잘못된 요청입니다.');

  const postRef = db.collection('boardPosts').doc(postId);
  const postSnap = await postRef.get();
  if (!postSnap.exists) return { status: 'OK' }; // old function: silent RETURN if the post doesn't exist

  const subId = subscriptionId(endpoint);
  const subSnap = await db.collection('pushSubscriptions').doc(subId).get();
  // INSERT ... SELECT ... FROM push_subscription WHERE endpoint=… matched 0
  // rows (and inserted nothing) for an endpoint with no subscription row.
  if (!subSnap.exists) return { status: 'OK' };

  await postRef.collection('watchers').doc(subId).set({ createdAt: FieldValue.serverTimestamp() }, { merge: true });
  return { status: 'OK' };
});

export const pushUnwatch = onCall(async (request) => {
  requireAuth(request);
  const { endpoint, postId } = request.data ?? {};
  if (typeof endpoint !== 'string' || !postId) invalid('잘못된 요청입니다.');
  await db.collection('boardPosts').doc(postId).collection('watchers').doc(subscriptionId(endpoint)).delete();
  return { status: 'OK' };
});

// Secret-gated HTTP endpoint (NOT onCall) — invoked by functions/api/push-fanout.js
// after a Web Push send 404/410s, with no Firebase user session. Reuses
// pushFanoutSecret/X-Push-Secret rather than a new Secret Manager param
// (CONVENTIONS.md forbids editing lib/secrets.js here), same pattern as
// board.js's boardReferencedKeys.
export const pushPrune = onRequest({ secrets: [pushFanoutSecret] }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ status: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (req.get('X-Push-Secret') !== pushFanoutSecret.value()) {
    res.status(403).json({ status: 'FORBIDDEN' });
    return;
  }

  const endpoints = Array.isArray(req.body?.endpoints)
    ? req.body.endpoints.filter((e) => typeof e === 'string' && e)
    : [];
  if (!endpoints.length) {
    res.status(200).json({ status: 'OK' });
    return;
  }

  const subsBatch = db.batch();
  for (const endpoint of endpoints) {
    subsBatch.delete(db.collection('pushSubscriptions').doc(subscriptionId(endpoint)));
  }
  await subsBatch.commit();

  // adminPushSubscriptions' doc ID is `${uid}_${endpointHash}` (design doc
  // §3) — uid isn't known here, so dead endpoints are matched by the
  // `endpoint` field instead, chunked under Firestore's 30-value `in` cap
  // (mirrors the old push_prune()'s single DELETE ... WHERE endpoint = ANY(…)
  // across both tables).
  const CHUNK = 30;
  for (let i = 0; i < endpoints.length; i += CHUNK) {
    const chunk = endpoints.slice(i, i + CHUNK);
    const snap = await db.collection('adminPushSubscriptions').where('endpoint', 'in', chunk).get();
    if (snap.empty) continue;
    const adminBatch = db.batch();
    snap.docs.forEach((d) => adminBatch.delete(d.ref));
    await adminBatch.commit();
  }

  res.status(200).json({ status: 'OK' });
});

export const adminPushSubscribe = onCall(async (request) => {
  // Old admin_push_subscribe() silently no-op'd for non-admins (IF NOT
  // is_admin() THEN RETURN). requireAdmin() throws instead — an intentional
  // tightening to match this codebase's explicit-denial governance model
  // (CONVENTIONS.md) rather than the legacy silent-ignore behavior.
  const uid = requireAdmin(request);
  const { endpoint, p256dh, auth: authKey } = request.data ?? {};
  assertSubscriptionShape(endpoint, p256dh, authKey);

  const id = `${uid}_${subscriptionId(endpoint)}`;
  await db.collection('adminPushSubscriptions').doc(id).set({ uid, endpoint, p256dh, auth: authKey }, { merge: true });
  return { status: 'OK' };
});

export const adminPushUnsubscribe = onCall(async (request) => {
  // Deleting your own subscription doesn't need admin — matches the old
  // function, which was REVOKE ALL + GRANT authenticated only (no is_admin()
  // check at all), scoped to auth.uid() in the WHERE clause.
  const uid = requireAuth(request);
  const { endpoint } = request.data ?? {};
  if (typeof endpoint !== 'string') invalid('잘못된 요청입니다.');
  await db.collection('adminPushSubscriptions').doc(`${uid}_${subscriptionId(endpoint)}`).delete();
  return { status: 'OK' };
});

// 실기기 푸시 테스트 — 프로필 "알림 테스트" 버튼 4종이 호출한다. 실제 푸시와 100%
// 같은 경로(pushFanout → /api/push-fanout → webpush.js → 푸시서비스)를 타고, sync 로
// 발송 결과(HTTP 상태)를 받아 온다. 성공이면 클라이언트는 예전처럼 담백한 문구만,
// 실패면 "구독 만료/거부/네트워크" 를 사용자에게 보여준다. 익명 유지: endpoint 로만
// 구독 문서를 찾고 uid 는 저장하지 않는다(setNextClassAlerts 와 동일 패턴).
const TEST_KINDS = ['plain', 'quiet', 'next_class', 'today_summary'];

function testPayload(kind) {
  switch (kind) {
    case 'plain':
      // 구버전 SW 도 그대로 그리는 legacy 형태 — "푸시가 물리적으로 도착하는가" 만 확인.
      return { kind: 'hot', title: '🔔 테스트 알림', board: '테스트', path: '/' };
    case 'quiet':
      return { kind: 'test', quiet: true, title: '🌙 무음 테스트', body: '소리·진동 없이 왔으면 정상이에요.', path: '/' };
    case 'next_class':
      return { kind: 'next_class', test: true, mow: seoulMinuteOfWeek(), path: '/' };
    case 'today_summary':
      return { kind: 'today_summary', test: true, mow: seoulMinuteOfWeek(), path: '/' };
    default:
      return null;
  }
}

function classifyStatus(status, detail) {
  if (status >= 200 && status < 300) return { status: 'OK' };
  if (status === 404 || status === 410) return { status: 'GONE' };
  if (status === 401 || status === 403) return { status: 'REJECTED', code: status };
  if (status === 0) return { status: 'NETWORK' };
  return { status: 'ERROR', code: status, ...(detail ? { detail } : {}) };
}

export const sendSelfTestPush = onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  requireAuth(request);
  const { endpoint, kind } = request.data ?? {};
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1024) {
    invalid('잘못된 구독 정보입니다.');
  }
  if (!TEST_KINDS.includes(kind)) invalid('알 수 없는 테스트 종류입니다.');

  const snap = await db.collection('pushSubscriptions').doc(subscriptionId(endpoint)).get();
  if (!snap.exists) invalid('이 기기의 푸시 구독을 찾을 수 없어요. 푸시를 껐다 켜 주세요.');
  const d = snap.data();
  if (!d.endpoint || !d.p256dh || !d.auth) invalid('구독 정보가 손상됐어요. 푸시를 껐다 켜 주세요.');

  const results = await pushFanout(
    pushFanoutUrl.value(),
    pushFanoutSecret.value(),
    testPayload(kind),
    [{ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }],
    { sync: true }
  );
  const r0 = results?.[0];
  return classifyStatus(r0?.status ?? 0, r0?.detail);
});
