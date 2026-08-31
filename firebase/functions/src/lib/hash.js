import { createHmac } from 'node:crypto';

// Port of the old actor_hash() Postgres function: a per-target, per-kind salted
// hash so the same person gets a different hash per object and can never be
// traced back to a uid. Dedup (1 reaction per person) is enforced by using
// this hash AS the document ID under a `reactions` subcollection — a second
// write to the same ID is a merge/overwrite, not a duplicate, exactly like the
// old UNIQUE(target_id, kind, reporter_hash) constraint.
export function actorHash(salt, uid, kind, targetId) {
  return createHmac('sha256', salt).update(`${uid}:${kind}:${targetId}`).digest('hex');
}
