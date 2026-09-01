import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, FieldValue, Timestamp, requireAuth, invalid } from './lib/context.js';
import { hashPassword, verifyPassword } from './lib/password.js';

// Port of create_exam()/delete_exam()/purge_old_exams() (db/schema.sql).
// exam_file's rows become the embedded `files` array field (design doc §3) —
// no subcollection, since attachments never need to be queried independently
// of their parent archive doc.

export const createExam = onCall(async (request) => {
  const uid = requireAuth(request);
  const { courseCode, srcYear, srcTerm, title, examType, description, files, postPassword } = request.data ?? {};

  if (!courseCode) invalid('courseCode가 필요합니다.');
  if (!title) invalid('제목이 필요합니다.');
  if (String(title).length > 300) invalid('제목이 너무 깁니다.');
  if (description != null && String(description).length > 5000) invalid('설명이 너무 깁니다.');
  if (!Array.isArray(files) || files.length === 0) invalid('첨부파일이 필요합니다.');
  if (files.length > 20) invalid('첨부파일이 너무 많습니다.');

  const embeddedFiles = files
    .filter((f) => f && typeof f.key === 'string' && f.key !== '')
    .map((f, i) => ({
      seq: i + 1,
      objectKey: f.key,
      filename: f.name && f.name !== '' ? f.name : '파일',
      fileSize: f.size ?? null,
      mimeType: f.mime ?? null,
    }));
  if (embeddedFiles.length === 0) invalid('첨부파일이 필요합니다.');

  const passwordHash = postPassword ? await hashPassword(postPassword) : null;

  const examRef = db.collection('examArchive').doc();
  const batch = db.batch();
  batch.set(examRef, {
    courseCode,
    srcYear: srcYear ?? null,
    srcTerm: srcTerm ?? null,
    title,
    examType: examType ?? null,
    description: description ?? null,
    files: embeddedFiles,
    hasPassword: !!passwordHash,
    createdAt: FieldValue.serverTimestamp(),
  });
  if (passwordHash) {
    batch.set(examRef.collection('_private').doc('auth'), { postPasswordHash: passwordHash });
  }
  batch.update(db.collection('users').doc(uid), { postCount: FieldValue.increment(1) });
  await batch.commit();

  return { id: examRef.id };
});

export const deleteExam = onCall(async (request) => {
  const uid = requireAuth(request);
  const { id, postPassword } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');

  const examRef = db.collection('examArchive').doc(id);
  const [examSnap, authSnap] = await Promise.all([
    examRef.get(),
    examRef.collection('_private').doc('auth').get(),
  ]);
  if (!examSnap.exists) return { deleted: false };

  const isAdmin = request.auth.token.admin === true;
  const hash = authSnap.exists ? authSnap.get('postPasswordHash') : null;
  if (hash && !isAdmin) {
    const ok = await verifyPassword(postPassword, hash);
    if (!ok) throw new HttpsError('permission-denied', '비밀번호가 일치하지 않습니다.');
  }

  await db.recursiveDelete(examRef); // covers _private/auth
  // See reviews.js deleteReview for why this stays a plain increment(-1)
  // rather than reproducing the old GREATEST(post_count - 1, 0) clamp.
  await db.collection('users').doc(uid).update({ postCount: FieldValue.increment(-1) });

  return { deleted: true };
});

// Old cron ran '0 18 1 * *' in pg_cron's UTC clock (matches board purge's
// '0 15 * * *' = KST midnight comment) — 18:00 UTC on the 1st = 03:00 KST on
// the 2nd. Kept as literal UTC cron + explicit timeZone for the same result.
export const purgeOldExams = onSchedule({ schedule: '0 18 1 * *', timeZone: 'UTC' }, async () => {
  const cutoffDate = new Date();
  cutoffDate.setUTCFullYear(cutoffDate.getUTCFullYear() - 5); // calendar-year subtraction, matches Postgres interval '5 years'
  const cutoff = Timestamp.fromDate(cutoffDate);

  const snap = await db.collection('examArchive').where('createdAt', '<', cutoff).get();
  if (snap.empty) return;

  // recursiveDelete() also removes each archive's _private/auth doc (the old
  // schema's FK CASCADE from exam_file/post_password no longer applies —
  // Firestore subcollections are never deleted implicitly).
  const CONCURRENCY = 20;
  for (let i = 0; i < snap.docs.length; i += CONCURRENCY) {
    await Promise.all(snap.docs.slice(i, i + CONCURRENCY).map((d) => db.recursiveDelete(d.ref)));
  }
});
