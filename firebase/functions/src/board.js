import { randomUUID } from 'node:crypto';
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { db, FieldValue, Timestamp, requireAuth, invalid } from './lib/context.js';
import { actorHashSalt, pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { actorHash } from './lib/hash.js';
import { hashPassword, verifyPassword } from './lib/password.js';
import { archiveDeleted } from './lib/archive.js';
import { pushFanout } from './lib/pushFanout.js';
import { adminPush } from './lib/adminNotify.js';

// Port of create_board()/create_post()/get_post_b()/check_hot()/board_react()/
// create_comment_b()/delete_post()/delete_comment_b()/purge_board()/
// board_referenced_keys()/create_share()/get_shared_post()/share_image_ok()/
// notify_comment_push()/notify_hot_push() (db/schema.sql). Design doc §3 has
// the Firestore collection map, §4 the anonymity/hash/password redesign, §5
// the webhook/trigger table.

async function boardEnabledGuard() {
  const appConfigSnap = await db.doc('config/app').get();
  if (appConfigSnap.get('boardEnabled') === false) {
    throw new HttpsError('failed-precondition', '익명게시판이 비활성화되었습니다.');
  }
}

// Port of check_hot(): counts events of one kind in the last 30 minutes and
// promotes the post once the count clears app_setting.hot_threshold.
async function checkHot(postRef, kind) {
  // hotThreshold is never in the old get_boot_info() bundle, so it lives in
  // config/secrets, not config/app (design doc §3).
  const secretsConfigSnap = await db.doc('config/secrets').get();
  const threshold = Math.max(1, secretsConfigSnap.get('hotThreshold') ?? 10);
  const thirtyMinAgo = Timestamp.fromMillis(Date.now() - 30 * 60 * 1000);
  const countSnap = await postRef
    .collection('events')
    .where('kind', '==', kind)
    .where('createdAt', '>', thirtyMinAgo)
    .count()
    .get();
  if (countSnap.data().count >= threshold) {
    await postRef.update({ hot: true });
  }
}

// parentId is a logical self-reference (old schema: board_comment.parent_id
// REFERENCES board_comment(id) ON DELETE CASCADE) — Firestore has no cascade
// for it, so replies are walked and deleted explicitly to avoid leaving
// dangling parentId references behind after a parent comment is removed.
async function deleteCommentTree(postRef, commentId) {
  const repliesSnap = await postRef.collection('comments').where('parentId', '==', commentId).get();
  for (const reply of repliesSnap.docs) {
    await deleteCommentTree(postRef, reply.id);
  }
  await db.recursiveDelete(postRef.collection('comments').doc(commentId));
}

export const createBoard = onCall(async (request) => {
  requireAuth(request);
  const { name } = request.data ?? {};
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) invalid('게시판 이름을 입력하세요.');
  await boardEnabledGuard();

  const boardsCol = db.collection('boards');
  // INSERT ... ON CONFLICT (name) DO NOTHING + fallback SELECT, ported as a
  // query-then-create transaction (Firestore has no unique constraint).
  const id = await db.runTransaction(async (tx) => {
    const existing = await tx.get(boardsCol.where('name', '==', trimmed).limit(1));
    if (!existing.empty) return existing.docs[0].id;
    const ref = boardsCol.doc();
    tx.set(ref, { name: trimmed, createdAt: FieldValue.serverTimestamp(), lastActivityAt: FieldValue.serverTimestamp() });
    return ref.id;
  });
  return { id };
});

export const createPost = onCall(async (request) => {
  const uid = requireAuth(request);
  const { boardId, title, content, imageKeys, postPassword } = request.data ?? {};
  if (!boardId) invalid('게시판을 지정하세요.');
  if (!content) invalid('내용을 입력하세요.');
  // Old create_post()'s BEFORE INSERT trigger fires before the board_id FK
  // check runs, so the guard is evaluated before the board lookup here too.
  await boardEnabledGuard();

  const boardRef = db.collection('boards').doc(boardId);
  const boardSnap = await boardRef.get();
  if (!boardSnap.exists) throw new HttpsError('not-found', '게시판을 찾을 수 없습니다.');

  const images = Array.isArray(imageKeys)
    ? imageKeys.filter((k) => typeof k === 'string' && k !== '').map((objectKey, i) => ({ seq: i + 1, objectKey }))
    : [];
  const passwordHash = postPassword ? await hashPassword(postPassword) : null;

  const postRef = db.collection('boardPosts').doc();
  const batch = db.batch();
  batch.set(postRef, {
    boardId,
    title: title || null,
    content,
    images,
    likeCount: 0,
    dislikeCount: 0,
    commentCount: 0,
    reportCount: 0,
    reportReviewedCount: 0,
    viewCount: 0,
    hot: false,
    hasPassword: !!passwordHash,
    shareToken: null,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (passwordHash) {
    batch.set(postRef.collection('_private').doc('auth'), { postPasswordHash: passwordHash });
  }
  batch.update(boardRef, { lastActivityAt: FieldValue.serverTimestamp() });
  batch.update(db.collection('users').doc(uid), { postCount: FieldValue.increment(1) });
  await batch.commit();

  return { id: postRef.id };
});

export const getPost = onCall(async (request) => {
  requireAuth(request);
  const { postId, view } = request.data ?? {};
  if (!postId) invalid('잘못된 요청입니다.');

  const postRef = db.collection('boardPosts').doc(postId);
  let snap = await postRef.get();
  if (!snap.exists) return null;
  // p_view=TRUE only — mirrors the old RPC's client-controlled once-per-open flag.
  if (view === true) {
    await postRef.update({ viewCount: FieldValue.increment(1) });
    snap = await postRef.get();
  }
  return { id: snap.id, ...snap.data() };
});

export const boardReact = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { postId, kind } = request.data ?? {};
  if (!postId) invalid('잘못된 요청입니다.');
  if (!['like', 'dislike', 'report', 'unlike', 'undislike'].includes(kind)) invalid('잘못된 요청입니다.');

  const postRef = db.collection('boardPosts').doc(postId);
  // Single hash per (uid, post) — same as the old actor_hash('board_post', p_post_id)
  // call, which didn't vary by reaction kind either. Dedup granularity instead
  // comes from prefixing the reaction doc ID with kind, mirroring the old
  // composite unique index board_event(post_id, kind, actor_hash): the same
  // person CAN like AND dislike AND report the same post — only a repeat of
  // the SAME kind is blocked.
  const hash = actorHash(actorHashSalt.value(), uid, 'board-post-react', postId);
  const reactionsCol = postRef.collection('reactions');

  if (kind === 'unlike' || kind === 'undislike') {
    const targetKind = kind === 'unlike' ? 'like' : 'dislike';
    const field = targetKind === 'like' ? 'likeCount' : 'dislikeCount';
    const reactionRef = reactionsCol.doc(`${targetKind}_${hash}`);
    await db.runTransaction(async (tx) => {
      const reactSnap = await tx.get(reactionRef);
      if (!reactSnap.exists) return; // nothing to remove — mirrors the old DELETE matching 0 rows silently
      tx.update(postRef, { [field]: FieldValue.increment(-1) });
      tx.delete(reactionRef);
    });
    return { status: 'OK' };
  }

  // Existence check happens before the enabled-guard, matching the old
  // function's statement order: `SELECT board_id ... IF NULL THEN RETURN
  // 'NOT_FOUND'` runs before the INSERT that board_enabled_guard gates.
  const postSnap = await postRef.get();
  if (!postSnap.exists) return { status: 'NOT_FOUND' };
  const boardId = postSnap.get('boardId');
  await boardEnabledGuard();
  // reportDeleteCount/reportBurstCount live in config/secrets, not config/app
  // (design doc §3 — never part of the old get_boot_info() bundle).
  const secretsConfigSnap = await db.doc('config/secrets').get();

  const reactionRef = reactionsCol.doc(`${kind}_${hash}`);
  const eventsRef = postRef.collection('events');

  const outcome = await db.runTransaction(async (tx) => {
    const [freshPostSnap, reactSnap] = await Promise.all([tx.get(postRef), tx.get(reactionRef)]);
    if (!freshPostSnap.exists) return { status: 'NOT_FOUND' };
    if (reactSnap.exists) return { status: 'ALREADY' };
    tx.set(reactionRef, { kind, createdAt: FieldValue.serverTimestamp() });
    tx.set(eventsRef.doc(), { kind, actorHash: hash, createdAt: FieldValue.serverTimestamp() });
    if (kind === 'like') tx.update(postRef, { likeCount: FieldValue.increment(1) });
    else if (kind === 'dislike') tx.update(postRef, { dislikeCount: FieldValue.increment(1) });
    else tx.update(postRef, { reportCount: FieldValue.increment(1) });
    return { status: 'OK', reportCountBefore: freshPostSnap.get('reportCount') ?? 0 };
  });
  if (outcome.status !== 'OK') return { status: outcome.status };

  if (kind !== 'report') {
    // check_hot() runs before the board.last_activity_at bump in the old
    // function, for like/dislike only — report never calls check_hot().
    await checkHot(postRef, kind);
    await db.collection('boards').doc(boardId).update({ lastActivityAt: FieldValue.serverTimestamp() });
    return { status: 'OK' };
  }

  const reportCount = outcome.reportCountBefore + 1;
  const deleteThreshold = Math.max(1, secretsConfigSnap.get('reportDeleteCount') ?? 30);
  const burstThreshold = Math.max(1, secretsConfigSnap.get('reportBurstCount') ?? 10);
  const fifteenMinAgo = Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
  const burstSnap = await eventsRef.where('kind', '==', 'report').where('createdAt', '>', fifteenMinAgo).count().get();
  const burstCount = burstSnap.data().count;

  if (reportCount < deleteThreshold && burstCount < burstThreshold) {
    await db.collection('boards').doc(boardId).update({ lastActivityAt: FieldValue.serverTimestamp() });
    return { status: 'OK' };
  }

  const reason = reportCount >= deleteThreshold ? 'threshold' : 'burst';
  let archived = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(postRef);
    if (!snap.exists) return;
    const data = snap.data();
    const boardSnap = await tx.get(db.collection('boards').doc(data.boardId));
    archiveDeleted(tx, db, {
      type: 'board_post',
      origId: postId,
      label: boardSnap.exists ? boardSnap.get('name') : '게시판',
      text: [data.title, data.content].filter(Boolean).join(' — ') || null,
      reportCount,
      reason,
      snapshot: { id: postId, ...data },
    });
    tx.delete(snap.ref);
    archived = true;
  });

  if (archived) {
    await db.recursiveDelete(postRef); // leftover comments/_private/events/reactions/watchers after the tx-scoped doc delete
    // Fired outside the transaction on purpose — network calls don't belong
    // inside a Firestore transaction (matches reportReview()'s identical note).
    await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
      kind: 'report_deleted',
      title: '🗑️ 신고 누적 자동삭제',
      body: '게시글 1건이 신고 누적으로 자동삭제되었습니다. 복구가 필요한지 확인하세요.',
    });
  }
  return { status: 'DELETED' };
});

export const createComment = onCall(async (request) => {
  const uid = requireAuth(request);
  const { postId, parentId, content, postPassword } = request.data ?? {};
  if (!postId) invalid('잘못된 요청입니다.');
  if (!content) invalid('내용을 입력하세요.');

  const postRef = db.collection('boardPosts').doc(postId);
  const postSnap = await postRef.get();
  if (!postSnap.exists) throw new HttpsError('not-found', '게시글 없음');
  await boardEnabledGuard();

  const passwordHash = postPassword ? await hashPassword(postPassword) : null;
  const commentRef = postRef.collection('comments').doc();
  const batch = db.batch();
  batch.set(commentRef, {
    parentId: parentId || null,
    content,
    hasPassword: !!passwordHash,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (passwordHash) {
    batch.set(commentRef.collection('_private').doc('auth'), { postPasswordHash: passwordHash });
  }
  batch.set(postRef.collection('events').doc(), { kind: 'comment', createdAt: FieldValue.serverTimestamp() });
  batch.update(postRef, { commentCount: FieldValue.increment(1) });
  batch.update(db.collection('boards').doc(postSnap.get('boardId')), { lastActivityAt: FieldValue.serverTimestamp() });
  batch.update(db.collection('users').doc(uid), { postCount: FieldValue.increment(1) });
  await batch.commit();

  await checkHot(postRef, 'comment');
  return { id: commentRef.id };
});

export const deletePost = onCall(async (request) => {
  const uid = requireAuth(request);
  const { postId, postPassword } = request.data ?? {};
  if (!postId) invalid('잘못된 요청입니다.');

  const postRef = db.collection('boardPosts').doc(postId);
  const [postSnap, authSnap] = await Promise.all([postRef.get(), postRef.collection('_private').doc('auth').get()]);
  if (!postSnap.exists) return { deleted: false };

  const isAdmin = request.auth.token.admin === true;
  const hash = authSnap.exists ? authSnap.get('postPasswordHash') : null;
  if (hash && !isAdmin) {
    const ok = await verifyPassword(postPassword, hash);
    if (!ok) throw new HttpsError('permission-denied', '비밀번호가 일치하지 않습니다.');
  }

  await db.recursiveDelete(postRef); // covers _private/auth + comments/* + events/* + reactions/* + watchers/*
  // See reviews.js deleteReview for why this stays a plain increment(-1)
  // rather than reproducing the old GREATEST(post_count - 1, 0) clamp. Note
  // the old function decremented the CALLER's post_count, not the author's
  // (there is no author tracking) — kept exactly, even for an admin bypass.
  await db.collection('users').doc(uid).update({ postCount: FieldValue.increment(-1) });

  return { deleted: true };
});

export const deleteComment = onCall(async (request) => {
  const uid = requireAuth(request);
  const { postId, commentId, postPassword } = request.data ?? {};
  if (!postId || !commentId) invalid('잘못된 요청입니다.');

  const postRef = db.collection('boardPosts').doc(postId);
  const commentRef = postRef.collection('comments').doc(commentId);
  const [commentSnap, authSnap] = await Promise.all([
    commentRef.get(),
    commentRef.collection('_private').doc('auth').get(),
  ]);
  if (!commentSnap.exists) return { deleted: false };

  const isAdmin = request.auth.token.admin === true;
  const hash = authSnap.exists ? authSnap.get('postPasswordHash') : null;
  if (hash && !isAdmin) {
    const ok = await verifyPassword(postPassword, hash);
    if (!ok) throw new HttpsError('permission-denied', '비밀번호가 일치하지 않습니다.');
  }

  await deleteCommentTree(postRef, commentId);
  // Old delete_comment_b() only ever decremented comment_count/post_count by
  // 1 too, even when the CASCADE silently removed reply rows underneath it —
  // kept exactly (not "fixed" to subtract the whole reply subtree).
  await postRef.update({ commentCount: FieldValue.increment(-1) });
  await db.collection('users').doc(uid).update({ postCount: FieldValue.increment(-1) });

  return { deleted: true };
});

export const createShare = onCall(async (request) => {
  requireAuth(request);
  const { postId } = request.data ?? {};
  if (!postId) invalid('잘못된 요청입니다.');

  const postRef = db.collection('boardPosts').doc(postId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(postRef);
    if (!snap.exists) invalid('게시글 없음');
    const existing = snap.get('shareToken');
    if (existing) return { token: existing };
    const token = randomUUID();
    tx.update(postRef, { shareToken: token });
    return { token };
  });
});

// Deliberately public — no requireAuth() (design doc §3's "one public read
// path", mirrors get_shared_post()'s anon GRANT). request.auth may still be
// present if the caller happens to be signed in; that's consulted below to
// reproduce the old function's `auth.uid() IS NULL` branches exactly.
export const getSharedPost = onCall(async (request) => {
  const { token, view } = request.data ?? {};
  if (!token) invalid('잘못된 요청입니다.');

  const snap = await db.collection('boardPosts').where('shareToken', '==', token).limit(1).get();
  if (snap.empty) return null;
  const postSnap = snap.docs[0];
  const post = postSnap.data();
  const isAuthed = !!request.auth;

  const appConfigSnap = await db.doc('config/app').get();
  const shareEnabled = appConfigSnap.get('shareEnabled') ?? true;
  if (!shareEnabled && !isAuthed) return { disabled: true };

  // Only bumps for anonymous viewers — signed-in members are counted through
  // getPost() instead, avoiding a double count (old function's exact guard).
  if (view === true && !isAuthed) {
    await postSnap.ref.update({ viewCount: FieldValue.increment(1) });
  }

  const boardSnap = await db.collection('boards').doc(post.boardId).get();
  const commentsSnap = await postSnap.ref.collection('comments').orderBy('createdAt').get();

  // No password hash, no report counts — never exposed to this projection
  // (design doc §4: structurally impossible here, hashes live in _private/*).
  return {
    postId: postSnap.id,
    board: boardSnap.exists ? boardSnap.get('name') : null,
    post: {
      title: post.title ?? null,
      content: post.content,
      createdAt: post.createdAt,
      likeCount: post.likeCount ?? 0,
      dislikeCount: post.dislikeCount ?? 0,
      commentCount: post.commentCount ?? 0,
      viewCount: post.viewCount ?? 0,
      hot: post.hot === true,
    },
    images: post.images ?? [],
    comments: commentsSnap.docs.map((d) => ({
      id: d.id,
      parentId: d.get('parentId'),
      content: d.get('content'),
      createdAt: d.get('createdAt'),
    })),
  };
});

// Deliberately public — no requireAuth(). Called by the R2 image-serving
// Cloudflare Pages Function (/api/share-image) on behalf of anonymous
// visitors who followed a share link but have no Firebase session (port of
// share_image_ok()).
export const shareImageOk = onCall(async (request) => {
  const { token, key } = request.data ?? {};
  if (!token || !key) return false;

  const appConfigSnap = await db.doc('config/app').get();
  if (!(appConfigSnap.get('shareEnabled') ?? true)) return false;

  const snap = await db.collection('boardPosts').where('shareToken', '==', token).limit(1).get();
  if (snap.empty) return false;
  const images = snap.docs[0].get('images') || [];
  return images.some((img) => img.objectKey === key || `${img.objectKey}.thumb` === key);
});

// Secret-gated HTTP endpoint (NOT onCall) — invoked by a cron job with no
// Firebase user session, same as the old board_referenced_keys(p_secret) RPC.
// Reuses pushFanoutSecret/header X-Push-Secret rather than defining a new
// Secret Manager param (CONVENTIONS.md forbids editing lib/secrets.js here) —
// see the migration report for the functions/api/board-sweep.js follow-up
// this implies (out of scope for this task: repoint it at this function's
// HTTPS URL with an X-Push-Secret header instead of its current p_secret body
// param against the old Supabase RPC).
export const boardReferencedKeys = onRequest({ secrets: [pushFanoutSecret] }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ status: 'METHOD_NOT_ALLOWED' });
    return;
  }
  if (req.get('X-Push-Secret') !== pushFanoutSecret.value()) {
    res.status(403).json({ status: 'FORBIDDEN' });
    return;
  }

  const keys = new Set();
  const snap = await db.collection('boardPosts').select('images').get();
  snap.forEach((doc) => {
    for (const img of doc.get('images') || []) {
      if (img?.objectKey) {
        keys.add(img.objectKey);
        keys.add(`${img.objectKey}.thumb`);
      }
    }
  });
  res.status(200).json([...keys]);
});

// Daily cron, same wall-clock target as the old pg_cron 'purge-board' job
// ('0 15 * * *' with no explicit timezone = UTC = KST midnight, per that
// job's own schema.sql comment).
export const purgeBoard = onSchedule({ schedule: '0 15 * * *', timeZone: 'Etc/UTC' }, async () => {
  const now = Date.now();
  const postsCutoff = Timestamp.fromMillis(now - 90 * 24 * 60 * 60 * 1000);
  const boardsCutoff = Timestamp.fromMillis(now - 30 * 24 * 60 * 60 * 1000);
  const eventsCutoff = Timestamp.fromMillis(now - 24 * 60 * 60 * 1000);
  const CONCURRENCY = 20;

  const oldPosts = await db.collection('boardPosts').where('createdAt', '<', postsCutoff).get();
  for (let i = 0; i < oldPosts.docs.length; i += CONCURRENCY) {
    await Promise.all(oldPosts.docs.slice(i, i + CONCURRENCY).map((d) => db.recursiveDelete(d.ref)));
  }

  // board_post.board_id REFERENCES board(id) ON DELETE CASCADE in the old
  // schema — Firestore has no cascade, so a stale board's posts are found and
  // deleted explicitly before the board doc itself.
  const staleBoards = await db.collection('boards').where('lastActivityAt', '<', boardsCutoff).get();
  for (const boardDoc of staleBoards.docs) {
    const postsInBoard = await db.collection('boardPosts').where('boardId', '==', boardDoc.id).get();
    for (let i = 0; i < postsInBoard.docs.length; i += CONCURRENCY) {
      await Promise.all(postsInBoard.docs.slice(i, i + CONCURRENCY).map((d) => db.recursiveDelete(d.ref)));
    }
    await db.recursiveDelete(boardDoc.ref);
  }

  // Non-report events only — report events are the anti-repeat-report dedup
  // memory (reactions/{kind_hash} + events, actor_hash) and are NEVER purged
  // (old purge_board()'s explicit comment): deleting them would let the same
  // actor re-report the same post every day and eventually rebuild past the
  // threshold. Covered by the existing COLLECTION_GROUP composite index on
  // events(kind, createdAt) in firestore.indexes.json.
  for (const kind of ['like', 'dislike', 'comment']) {
    const staleEvents = await db
      .collectionGroup('events')
      .where('kind', '==', kind)
      .where('createdAt', '<', eventsCutoff)
      .get();
    for (let i = 0; i < staleEvents.docs.length; i += CONCURRENCY) {
      await Promise.all(staleEvents.docs.slice(i, i + CONCURRENCY).map((d) => d.ref.delete()));
    }
  }
});

// Port of notify_comment_push(): fires on every new comment, fans out to that
// post's watchers only. kind: reply (has parentId) vs comment — the SW uses
// this to pick the notification string, matching the old trigger's branch.
export const onCommentCreatedPush = onDocumentCreated(
  { document: 'boardPosts/{postId}/comments/{commentId}', secrets: [pushFanoutUrl, pushFanoutSecret] },
  async (event) => {
    const { postId } = event.params;
    const comment = event.data?.data();
    if (!comment) return;

    const postSnap = await db.collection('boardPosts').doc(postId).get();
    if (!postSnap.exists) return;
    const post = postSnap.data();
    const title = (post.title?.trim() || post.content || '').slice(0, 40);

    const watchersSnap = await db.collection('boardPosts').doc(postId).collection('watchers').get();
    if (watchersSnap.empty) return;

    // watchers/{subscriptionId} — doc ID is the subscription's own ID, so a
    // direct doc().get() per watcher resolves the endpoint/keys to notify.
    const subsSnaps = await Promise.all(
      watchersSnap.docs.map((d) => db.collection('pushSubscriptions').doc(d.id).get())
    );
    const targets = subsSnaps
      .filter((s) => s.exists)
      .map((s) => ({ endpoint: s.get('endpoint'), p256dh: s.get('p256dh'), auth: s.get('auth') }));
    if (!targets.length) return;

    await pushFanout(
      pushFanoutUrl.value(),
      pushFanoutSecret.value(),
      { kind: comment.parentId ? 'reply' : 'comment', post_id: postId, title },
      targets
    );
  }
);

// Port of notify_hot_push(): only the false→true transition fires (old
// trigger's WHEN clause), broadcasting to every hotAlerts-on subscription.
export const onPostHotChangedPush = onDocumentUpdated(
  { document: 'boardPosts/{postId}', secrets: [pushFanoutUrl, pushFanoutSecret] },
  async (event) => {
    const before = event.data?.before?.get('hot');
    const after = event.data?.after?.get('hot');
    if (before || !after) return;

    const { postId } = event.params;
    const post = event.data.after.data();
    const title = (post.title?.trim() || post.content || '').slice(0, 40);
    const boardSnap = await db.collection('boards').doc(post.boardId).get();

    const subsSnap = await db.collection('pushSubscriptions').where('hotAlerts', '==', true).get();
    if (subsSnap.empty) return;
    const targets = subsSnap.docs.map((d) => ({ endpoint: d.get('endpoint'), p256dh: d.get('p256dh'), auth: d.get('auth') }));

    await pushFanout(
      pushFanoutUrl.value(),
      pushFanoutSecret.value(),
      { kind: 'hot', post_id: postId, title, board: boardSnap.exists ? boardSnap.get('name') : null },
      targets
    );
  }
);
