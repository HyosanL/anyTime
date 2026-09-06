import { db } from './context.js';

const YOUNG_MS = 24 * 60 * 60 * 1000;

// Accounts created before signup started stamping `createdAt` return false —
// they predate this control and must not be treated as "young".
export function isYoung(createdAtMs, nowMs) {
  if (!createdAtMs) return false;
  return nowMs - createdAtMs < YOUNG_MS;
}

export async function isYoungAccount(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return isYoung(snap.get('createdAt')?.toMillis?.() ?? 0, Date.now());
}
