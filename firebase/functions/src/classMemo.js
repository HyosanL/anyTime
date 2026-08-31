import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, FieldValue, Timestamp, requireAuth, invalid } from './lib/context.js';
import { actorHashSalt, pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { actorHash } from './lib/hash.js';
import { hashPassword, verifyPassword } from './lib/password.js';
import { archiveDeleted } from './lib/archive.js';
import { inPrimaryTimetable } from './lib/eligibility.js';
import { adminPush } from './lib/adminNotify.js';

// Port of create_memo()/get_memos()/delete_memo()/report_memo()/purge_past_memos()
// (db/schema.sql 7장. 강의 메모). Unlike review/examArchive, class_memo has NO
// SELECT RLS policy at all in the old schema — every read went through
// get_memos() so it could enforce "확정시간표에 등록한 분반만" — so getMemos
// stays an onCall here too (design doc §3's stated exception), instead of
// becoming a direct client Firestore read like reviews/examArchive did.

export const createMemo = onCall(async (request) => {
  const uid = requireAuth(request);
  const { courseCode, year, term, sectionNo, content, postPassword } = request.data ?? {};

  if (!courseCode) invalid('courseCode가 필요합니다.');
  if (year == null || term == null || sectionNo == null) invalid('분반 정보가 필요합니다.');
  if (typeof content !== 'string' || !content.trim()) invalid('내용을 입력하세요.');

  const held = await inPrimaryTimetable(db, uid, courseCode, year, term, sectionNo);
  if (!held) invalid('확정시간표에 등록한 분반만 메모를 작성할 수 있습니다.');

  const passwordHash = postPassword ? await hashPassword(postPassword) : null;

  const memoRef = db.collection('classMemos').doc();
  const batch = db.batch();
  batch.set(memoRef, {
    courseCode,
    year,
    term,
    sectionNo,
    content: content.trim(),
    reportCount: 0,
    reportReviewedCount: 0, // admin "확인처리" cutoff, set by the future adminAction gateway — not touched here
    hasPassword: !!passwordHash,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (passwordHash) {
    batch.set(memoRef.collection('_private').doc('auth'), { postPasswordHash: passwordHash });
  }
  batch.update(db.collection('users').doc(uid), { postCount: FieldValue.increment(1) });
  await batch.commit();

  return { id: memoRef.id };
});

export const getMemos = onCall(async (request) => {
  const uid = requireAuth(request);
  const { courseCode, year, term, sectionNo } = request.data ?? {};
  if (!courseCode) invalid('courseCode가 필요합니다.');
  if (year == null || term == null || sectionNo == null) invalid('분반 정보가 필요합니다.');

  const held = await inPrimaryTimetable(db, uid, courseCode, year, term, sectionNo);
  if (!held) invalid('확정시간표에 등록한 분반만 메모를 볼 수 있습니다.');

  const snap = await db
    .collection('classMemos')
    .where('courseCode', '==', courseCode)
    .where('year', '==', year)
    .where('term', '==', term)
    .where('sectionNo', '==', sectionNo)
    .orderBy('createdAt', 'desc')
    .get();

  // Old get_memos() had to defensively strip post_password_hash from its
  // result (jsonb_populate_record(... to_jsonb(m) - 'post_password_hash'))
  // because SECURITY DEFINER bypasses column-level REVOKE. That hash never
  // lands on this public doc in the first place (it's isolated in
  // `{memo}/_private/auth`, design doc §4) — nothing to strip here.
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
});

export const deleteMemo = onCall(async (request) => {
  const uid = requireAuth(request);
  const { id, postPassword } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');

  const memoRef = db.collection('classMemos').doc(id);
  const [memoSnap, authSnap] = await Promise.all([
    memoRef.get(),
    memoRef.collection('_private').doc('auth').get(),
  ]);
  if (!memoSnap.exists) return { deleted: false };

  const isAdmin = request.auth.token.admin === true;
  const hash = authSnap.exists ? authSnap.get('postPasswordHash') : null;
  if (hash && !isAdmin) {
    const ok = await verifyPassword(postPassword, hash);
    if (!ok) throw new HttpsError('permission-denied', '비밀번호가 일치하지 않습니다.');
  }

  await db.recursiveDelete(memoRef); // covers _private/auth + reactions/* + events/*
  // See reviews.js deleteReview for why this stays a plain increment(-1)
  // rather than reproducing the old GREATEST(post_count - 1, 0) clamp.
  await db.collection('users').doc(uid).update({ postCount: FieldValue.increment(-1) });

  return { deleted: true };
});

export const reportMemo = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { id } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');

  // Mirrors reviews.js's reportReview shape exactly: dedup via "document ID =
  // actor hash" under reactions/, events/ subcollection doubling as the
  // 15-minute burst-count source (design doc §4).
  const hash = actorHash(actorHashSalt.value(), uid, 'memo-report', id);
  const memoRef = db.collection('classMemos').doc(id);
  const reactionRef = memoRef.collection('reactions').doc(hash);
  const eventsRef = memoRef.collection('events');

  const outcome = await db.runTransaction(async (tx) => {
    const [memoSnap, reactionSnap] = await Promise.all([tx.get(memoRef), tx.get(reactionRef)]);
    if (!memoSnap.exists) return { status: 'NOT_FOUND' };
    if (reactionSnap.exists) return { status: 'ALREADY' };
    tx.set(reactionRef, { kind: 'report', createdAt: FieldValue.serverTimestamp() });
    tx.set(eventsRef.doc(), { kind: 'report', createdAt: FieldValue.serverTimestamp() });
    tx.update(memoRef, { reportCount: FieldValue.increment(1) });
    return { status: 'OK', reportCountBefore: memoSnap.get('reportCount') ?? 0 };
  });
  if (outcome.status !== 'OK') return { status: outcome.status };

  const reportCount = outcome.reportCountBefore + 1;
  // reportDeleteCount/reportBurstCount live in config/secrets, not config/app
  // (design doc §3 — the app/secrets split mirrors exactly which app_setting
  // columns the old get_boot_info() RPC returned, nothing more).
  const configSnap = await db.collection('config').doc('secrets').get();
  const deleteThreshold = Math.max(1, configSnap.get('reportDeleteCount') ?? 30);
  const burstThreshold = Math.max(1, configSnap.get('reportBurstCount') ?? 10);

  const fifteenMinAgo = Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
  const burstSnap = await eventsRef
    .where('kind', '==', 'report')
    .where('createdAt', '>', fifteenMinAgo)
    .count()
    .get();
  const burstCount = burstSnap.data().count;

  if (reportCount < deleteThreshold && burstCount < burstThreshold) return { status: 'OK' };

  const reason = reportCount >= deleteThreshold ? 'threshold' : 'burst';
  let archived = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(memoRef);
    if (!snap.exists) return;
    const data = snap.data();
    archiveDeleted(tx, db, {
      type: 'class_memo',
      origId: id,
      label: data.courseCode,
      text: data.content ?? null,
      reportCount,
      reason,
      snapshot: { id, ...data },
    });
    tx.delete(snap.ref);
    archived = true;
  });

  if (archived) {
    await db.recursiveDelete(memoRef); // leftover _private/reactions/events after the tx-scoped doc delete
    // Fired outside the transaction on purpose — network calls don't belong
    // inside a Firestore transaction (design doc §4).
    await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
      kind: 'report_deleted',
      title: '🗑️ 신고 누적 자동삭제',
      body: '메모 1건이 신고 누적으로 자동삭제되었습니다. 복구가 필요한지 확인하세요.',
    });
  }

  return { status: 'DELETED' };
});

// Old cron ran purge_old_exams()/purge_past_memos()/purge_expired_accounts()
// together under one '0 18 1 * *' pg_cron job (schema.sql "purge-monthly") —
// same literal UTC cron as examArchive.js's purgeOldExams, kept as its own
// onSchedule function here (Cloud Scheduler has no equivalent of bundling
// several unrelated SQL statements into one job).
export const purgePastMemos = onSchedule({ schedule: '0 18 1 * *', timeZone: 'UTC' }, async () => {
  const semSnap = await db.collection('semesters').where('isCurrent', '==', true).get();
  const currentKeys = new Set(semSnap.docs.map((d) => `${d.get('year')}_${d.get('term')}`));

  // Firestore has no "NOT IN (SELECT ... WHERE is_current)" join equivalent,
  // so this ports the old correlated-subquery DELETE as a full collection
  // scan + in-memory filter. class_memo is small/volatile (purged monthly,
  // section-scoped), so this stays cheap — unlike purgeOldExams, which can
  // filter server-side on createdAt alone.
  const memosSnap = await db.collection('classMemos').get();
  const staleDocs = memosSnap.docs.filter((d) => !currentKeys.has(`${d.get('year')}_${d.get('term')}`));
  if (!staleDocs.length) return;

  const CONCURRENCY = 20;
  for (let i = 0; i < staleDocs.length; i += CONCURRENCY) {
    await Promise.all(staleDocs.slice(i, i + CONCURRENCY).map((d) => db.recursiveDelete(d.ref)));
  }
});
