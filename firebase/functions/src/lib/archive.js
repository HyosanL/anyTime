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
export function archiveDeleted(tx, db, { type, origId, label, text, reportCount, reason, snapshot }) {
  const ref = db.collection('deletedContent').doc();
  tx.set(ref, {
    type,
    origId,
    label,
    text,
    reportCount,
    reason,
    snapshot,
    reviewed: false,
    createdAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + THIRTY_DAYS_MS),
  });
  return ref.id;
}
