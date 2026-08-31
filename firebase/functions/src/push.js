import { createHash } from 'node:crypto';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, requireAdmin, invalid } from './lib/context.js';
import { pushFanoutSecret } from './lib/secrets.js';

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
