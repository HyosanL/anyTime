import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { HttpsError } from 'firebase-functions/v2/https';

// Single admin app init point — every other module imports db/auth from here,
// never calls initializeApp() itself.
initializeApp();

export const db = getFirestore();
export const auth = getAuth();
export { FieldValue, Timestamp };

// Governance note (design doc §2): Cloud Functions onCall defaults to
// "callable by any signed-in user" unless guarded. Every onCall handler in
// this codebase MUST call requireAuth() or requireAdmin() as its first line —
// there is no REVOKE-by-default backstop like the old Postgres schema had.

export function requireAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  return request.auth.uid;
}

export function requireAdmin(request) {
  const uid = requireAuth(request);
  if (request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', '관리자만 사용할 수 있습니다.');
  }
  return uid;
}

export function invalid(message) {
  throw new HttpsError('invalid-argument', message);
}
