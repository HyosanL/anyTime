import { FieldValue } from './context.js';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Port of archive_deleted(): snapshots content that's about to be hard-deleted
// by a report-threshold breach, for admin recovery. No author identity is
// ever stored — only "what", never "who" (design doc §4).
//
// `tx` is a Firestore Transaction; call this from inside runTransaction().
// `expireAt` is a plain Date on a field named to match a Firestore TTL policy
// configured on `deletedContent.expireAt` (console/gcloud one-time setup —
// TTL policies aren't expressible in firestore.indexes.json).
export function archiveDeleted(tx, db, { type, origId, label, text, reportCount, reason, snapshot, adminNote }) {
  const ref = db.collection('deletedContent').doc();
  tx.set(ref, {
    type,
    origId,
    label,
    text,
    reportCount,
    reason,
    snapshot,
    adminNote: adminNote ?? null, // 관리자가 신고글을 직접 삭제하며 남긴 메모(신고자에게 표시). 자동삭제 경로는 미전달 → null.
    reviewed: false,
    createdAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + THIRTY_DAYS_MS),
  });
  return ref.id;
}
