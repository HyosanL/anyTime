import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { db, FieldValue, Timestamp, requireAuth, invalid } from './lib/context.js';
import { actorHashSalt, pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { actorHash } from './lib/hash.js';
import { hashPassword, verifyPassword } from './lib/password.js';
import { archiveDeleted } from './lib/archive.js';
import { inPrimaryTimetable, timetableHeldDays } from './lib/eligibility.js';
import { adminPush } from './lib/adminNotify.js';

// Port of create_review()/delete_review()/like_review()/report_review()
// (db/schema.sql) plus the course_professor_rating/professor_rating views,
// which become denormalized aggregate docs kept in sync by onReviewWritten.

function isValidScore(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;
}

export const createReview = onCall(async (request) => {
  const uid = requireAuth(request);
  const {
    courseCode, professorCode, year, term, sectionNo,
    overall, workload, progress, difficulty, classTime,
    profComment, courseComment, fail, teamplay, presentation,
    postPassword,
  } = request.data ?? {};

  if (!courseCode) invalid('courseCode가 필요합니다.');
  if (year == null || term == null || sectionNo == null) invalid('분반 정보가 필요합니다.');
  if (!isValidScore(overall)) invalid('총별점(overall)은 1~5 사이 정수여야 합니다.');
  for (const [name, v] of [['workload', workload], ['progress', progress], ['difficulty', difficulty], ['classTime', classTime]]) {
    if (v != null && !isValidScore(v)) invalid(`${name}은 1~5 사이 정수여야 합니다.`);
  }

  // Old create_review() ran one EXISTS(...) query combining "row present" and
  // "held >= min_days" — the Firestore port needs both eligibility.js calls
  // because timetableHeldDays() returns 0 (not an error) when the entry is
  // missing, which would wrongly pass when reviewMinDays is configured as 0.
  const configSnap = await db.collection('config').doc('app').get();
  const minDays = configSnap.get('reviewMinDays') ?? 30;
  const held = await inPrimaryTimetable(db, uid, courseCode, year, term, sectionNo);
  if (!held) invalid(`이 강의를 확정시간표에 ${minDays}일 이상 보유한 생도만 강의평을 작성할 수 있습니다.`);
  const heldDays = await timetableHeldDays(db, uid, courseCode, year, term, sectionNo);
  if (heldDays < minDays) invalid(`이 강의를 확정시간표에 ${minDays}일 이상 보유한 생도만 강의평을 작성할 수 있습니다.`);

  const passwordHash = postPassword ? await hashPassword(postPassword) : null;

  const reviewRef = db.collection('reviews').doc();
  const batch = db.batch();
  batch.set(reviewRef, {
    courseCode,
    professorCode: professorCode || null,
    overall,
    workload: workload ?? null,
    progress: progress ?? null,
    difficulty: difficulty ?? null,
    classTime: classTime ?? null,
    profComment: profComment || null,
    courseComment: courseComment || null,
    fail: fail ?? null,
    teamplay: teamplay ?? null,
    presentation: presentation ?? null,
    likeCount: 0,
    reportCount: 0,
    reportReviewedCount: 0, // admin "확인처리" cutoff, set by the future adminAction gateway — not touched here
    hasPassword: !!passwordHash,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (passwordHash) {
    batch.set(reviewRef.collection('_private').doc('auth'), { postPasswordHash: passwordHash });
  }
  batch.update(db.collection('users').doc(uid), { postCount: FieldValue.increment(1) });
  await batch.commit();

  return { id: reviewRef.id };
});

export const deleteReview = onCall(async (request) => {
  const uid = requireAuth(request);
  const { id, postPassword } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');

  const reviewRef = db.collection('reviews').doc(id);
  const [reviewSnap, authSnap] = await Promise.all([
    reviewRef.get(),
    reviewRef.collection('_private').doc('auth').get(),
  ]);
  if (!reviewSnap.exists) return { deleted: false };

  const isAdmin = request.auth.token.admin === true;
  const hash = authSnap.exists ? authSnap.get('postPasswordHash') : null;
  if (hash && !isAdmin) {
    const ok = await verifyPassword(postPassword, hash);
    if (!ok) throw new HttpsError('permission-denied', '비밀번호가 일치하지 않습니다.');
  }

  await db.recursiveDelete(reviewRef); // covers _private/auth + reactions/* + events/*
  // Old GREATEST(post_count - 1, 0) clamp has no atomic Firestore equivalent;
  // per CONVENTIONS counters always use increment(), never read-modify-write —
  // only this function ever decrements, so drift is not expected in practice.
  await db.collection('users').doc(uid).update({ postCount: FieldValue.increment(-1) });

  return { deleted: true };
});

export const likeReview = onCall(async (request) => {
  requireAuth(request);
  const { id } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');

  // Port of like_review(): no dedup in the original RPC either — anyone can
  // like the same review repeatedly. Do not add actor-hash dedup here.
  try {
    await db.collection('reviews').doc(id).update({ likeCount: FieldValue.increment(1) });
  } catch (e) {
    if (e.code === 5 || e.code === 'not-found') return { status: 'NOT_FOUND' };
    throw e;
  }
  return { status: 'OK' };
});

export const reportReview = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { id } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');

  const hash = actorHash(actorHashSalt.value(), uid, 'review-report', id);
  const reviewRef = db.collection('reviews').doc(id);
  const reactionRef = reviewRef.collection('reactions').doc(hash);
  const eventsRef = reviewRef.collection('events');

  // Dedup via "document ID = actor hash" (hash.js) mirrors the old
  // UNIQUE(review_id, reporter_hash) — a second report from the same actor
  // just finds the doc already present. The events doc is written only on a
  // genuinely-new report, same as one row per successful review_report insert,
  // so it doubles as the 15-minute burst-count source (§4 of the design doc).
  const outcome = await db.runTransaction(async (tx) => {
    const [reviewSnap, reactionSnap] = await Promise.all([tx.get(reviewRef), tx.get(reactionRef)]);
    if (!reviewSnap.exists) return { status: 'NOT_FOUND' };
    if (reactionSnap.exists) return { status: 'ALREADY' };
    tx.set(reactionRef, { kind: 'report', createdAt: FieldValue.serverTimestamp() });
    tx.set(eventsRef.doc(), { kind: 'report', createdAt: FieldValue.serverTimestamp() });
    tx.update(reviewRef, { reportCount: FieldValue.increment(1) });
    return { status: 'OK', reportCountBefore: reviewSnap.get('reportCount') ?? 0 };
  });
  if (outcome.status !== 'OK') return { status: outcome.status };

  const reportCount = outcome.reportCountBefore + 1;
  // reportDeleteCount/reportBurstCount are never exposed via the old
  // get_boot_info() bundle, so they live in config/secrets, not config/app
  // (design doc §3 — the app/secrets split mirrors exactly which app_setting
  // columns that RPC returned, nothing more).
  const configSnap = await db.collection('config').doc('secrets').get();
  const deleteThreshold = Math.max(1, configSnap.get('reportDeleteCount') ?? 30);
  const burstThreshold = Math.max(1, configSnap.get('reportBurstCount') ?? 10);

  const fifteenMinAgo = Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
  const burstSnap = await eventsRef
    .where('kind', '==', 'report')
    .where('createdAt', '>', fifteenMinAgo)
    .count().get();
  const burstCount = burstSnap.data().count;

  if (reportCount < deleteThreshold && burstCount < burstThreshold) return { status: 'OK' };

  const reason = reportCount >= deleteThreshold ? 'threshold' : 'burst';
  let archived = false;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(reviewRef);
    if (!snap.exists) return;
    const data = snap.data();
    archiveDeleted(tx, db, {
      type: 'review',
      origId: id,
      label: data.courseCode,
      text: [data.profComment, data.courseComment].filter(Boolean).join(' / ') || null,
      reportCount,
      reason,
      snapshot: { id, ...data },
    });
    tx.delete(snap.ref);
    archived = true;
  });

  if (archived) {
    await db.recursiveDelete(reviewRef); // leftover _private/reactions/events after the tx-scoped doc delete
    // Fired outside the transaction on purpose — network calls don't belong
    // inside a Firestore transaction (design doc §4).
    await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
      kind: 'report_deleted',
      title: '🗑️ 신고 누적 자동삭제',
      body: '강의평 1건이 신고 누적으로 자동삭제되었습니다. 복구가 필요한지 확인하세요.',
    });
  }

  return { status: 'DELETED' };
});

function aggregateReviews(reviews) {
  const avg = (key) => {
    const vals = reviews.map((r) => r[key]).filter((v) => v != null);
    if (!vals.length) return null;
    return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
  };
  const failVals = reviews.map((r) => r.fail).filter((v) => v != null);
  return {
    reviewCount: reviews.length,
    avgOverall: avg('overall'),
    avgWorkload: avg('workload'),
    avgProgress: avg('progress'),
    avgDifficulty: avg('difficulty'),
    avgClassTime: avg('classTime'),
    failRatio: failVals.length ? Math.round((failVals.filter(Boolean).length / failVals.length) * 100) / 100 : null,
  };
}

// Port of the course_professor_rating/professor_rating views (db/schema.sql),
// now materialized because Firestore has no live GROUP BY. Full requery on
// every write instead of incremental delta math: deltas are error-prone for
// an average (a like/report doesn't change it, but create/delete does, and
// getting count+sum bookkeeping wrong silently corrupts the average forever)
// — at this app's review volume, requerying all rows per write is cheap and
// trivially correct, so that tradeoff is deliberate, not an oversight.
export const onReviewWritten = onDocumentWritten('reviews/{id}', async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;

  const pairs = new Map();
  for (const d of [before, after]) {
    if (!d) continue;
    const key = `${d.courseCode} ${d.professorCode ?? ''}`;
    pairs.set(key, { courseCode: d.courseCode, professorCode: d.professorCode ?? null });
  }

  for (const { courseCode, professorCode } of pairs.values()) {
    let q = db.collection('reviews').where('courseCode', '==', courseCode);
    q = q.where('professorCode', '==', professorCode);
    const snap = await q.get();

    // courseCode_professorCode per design doc §3; professorCode can be null
    // (professor unspecified) so it needs a sentinel to stay a valid doc ID.
    const cpRef = db.collection('courseProfessorRatings').doc(`${courseCode}_${professorCode ?? 'none'}`);
    if (snap.empty) {
      await cpRef.delete().catch(() => {});
    } else {
      await cpRef.set({ courseCode, professorCode, ...aggregateReviews(snap.docs.map((d) => d.data())), updatedAt: FieldValue.serverTimestamp() });
    }

    if (!professorCode) continue;
    const profSnap = await db.collection('reviews').where('professorCode', '==', professorCode).get();
    const profRef = db.collection('professorRatings').doc(professorCode);
    if (profSnap.empty) {
      await profRef.delete().catch(() => {});
    } else {
      const agg = aggregateReviews(profSnap.docs.map((d) => d.data()));
      await profRef.set({
        professorCode,
        reviewCount: agg.reviewCount,
        avgOverall: agg.avgOverall,
        failRatio: agg.failRatio,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  }
});
