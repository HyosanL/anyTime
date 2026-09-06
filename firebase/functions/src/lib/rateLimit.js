import { HttpsError } from 'firebase-functions/v2/https';
import { db, FieldValue, Timestamp } from './context.js';

// Fixed-window per-(uid, action) counter. One transactional write per call —
// writes are ~free at this app's scale ([[capacity-cost-800dau]]). Docs live in
// `rateLimits/{uid}_{action}` (Rules: Admin SDK only) and are swept by a
// Firestore TTL policy on `rateLimits.expireAt` (console one-time setup).

const HOUR = 3600;
const DAY = 86400;

export const LIMITS = {
  createPost: { limit: 10, windowSec: HOUR },
  createReview: { limit: 10, windowSec: HOUR },
  createExam: { limit: 10, windowSec: HOUR },
  createMemo: { limit: 10, windowSec: HOUR },
  createComment: { limit: 30, windowSec: HOUR },
  createBoard: { limit: 5, windowSec: DAY },
  boardReact: { limit: 60, windowSec: HOUR },
  reportContent: { limit: 20, windowSec: HOUR },
  likeReview: { limit: 60, windowSec: HOUR },
  getPostView: { limit: 120, windowSec: HOUR },
  submitCorrection: { limit: 20, windowSec: DAY },
  submitAppReport: { limit: 20, windowSec: DAY },
  replyFeedbackThread: { limit: 30, windowSec: HOUR },
  sendSelfTestPush: { limit: 5, windowSec: HOUR },
};

// Pure decision — no Firestore. `doc` is { count, windowStartMs } or null.
export function evaluateWindow(doc, nowMs, { limit, windowMs }) {
  const startMs = doc?.windowStartMs ?? 0;
  if (!doc || nowMs - startMs >= windowMs) return { action: 'reset' };
  if ((doc.count ?? 0) >= limit) return { action: 'reject' };
  return { action: 'increment' };
}

export async function assertUnderLimit(uid, action) {
  const cfg = LIMITS[action];
  if (!cfg) throw new Error(`rateLimit: unknown action "${action}"`);
  const windowMs = cfg.windowSec * 1000;
  const ref = db.collection('rateLimits').doc(`${uid}_${action}`);
  const now = Date.now();

  const rejected = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists
      ? { count: snap.get('count') ?? 0, windowStartMs: snap.get('windowStart')?.toMillis?.() ?? 0 }
      : null;
    const { action: decision } = evaluateWindow(doc, now, { limit: cfg.limit, windowMs });
    if (decision === 'reject') return true;
    if (decision === 'reset') {
      tx.set(ref, {
        count: 1,
        windowStart: Timestamp.fromMillis(now),
        expireAt: new Date(now + windowMs + DAY * 1000),
      });
    } else {
      tx.update(ref, { count: FieldValue.increment(1) });
    }
    return false;
  });

  if (rejected) {
    throw new HttpsError('resource-exhausted', '요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.');
  }
}
