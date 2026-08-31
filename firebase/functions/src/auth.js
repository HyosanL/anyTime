// Port of: supabase/functions/signup, supabase/functions/delete-account,
// db/schema.sql's geo_verify/verify_gate/haversine_m/set_signup_code/
// purge_expired_accounts/is_admin (design doc §2, §3).
//
// get_boot_info() has NO Cloud Function equivalent here on purpose: its only
// job was bundling app_setting fields into one response to save a PostgREST
// round trip. The client now reads `/config/app` directly (Firestore rules
// already allow any signed-in user to read it) — that single document read
// already IS the one round trip, so a wrapper function would just add a hop.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { auth, db, FieldValue, requireAuth, requireAdmin, invalid } from './lib/context.js';

const REGION = 'asia-northeast3';

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

// Same formula as haversine_m() — kept local since signup and geoVerify are
// the only two callers and both live in this module.
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// auth.deleteUser + recursiveDelete of the /users/{uid} subtree (gradeEntries,
// rankEntries, follows, favoriteBoards, timetables/*/entries, */customClasses —
// Firestore has no FK cascade, unlike the old `cadet.id REFERENCES auth.users
// ON DELETE CASCADE`). Auth goes first: if the Firestore side later fails
// partway, the account is already unable to log back in, which is the
// security invariant that matters most; a stray Firestore doc can be cleaned
// up by an admin. Shared by deleteAccount and purgeExpiredAccounts.
async function deleteUserFully(uid) {
  await auth.deleteUser(uid).catch((e) => {
    if (e.code !== 'auth/user-not-found') throw e;
  });
  await db.recursiveDelete(db.collection('users').doc(uid));
}

// signup is the ONE deliberately-public function in this codebase — no
// requireAuth()/requireAdmin() call. It's the join-code+geofence gate itself,
// so by definition it must be callable while signed out. App Check is
// recommended at the Firebase project level (design doc §2) since this is
// the only unauthenticated entry point left after the migration.
export const signup = onCall({ region: REGION }, async (request) => {
  const data = request.data ?? {};
  const username = String(data.username ?? '').trim();
  const password = String(data.password ?? '');
  const code = String(data.code ?? '').trim();
  const lat = typeof data.lat === 'number' ? data.lat : null;
  const lng = typeof data.lng === 'number' ? data.lng : null;

  if (!USERNAME_RE.test(username)) invalid('아이디는 영문/숫자/밑줄 3~20자여야 합니다.');
  if (!code) invalid('가입 코드를 입력하세요.');
  if (password.length < 6) invalid('비밀번호는 6자 이상이어야 합니다.');

  // verify_gate: code match is checked before geofencing, both against the
  // one admin-configured row — ported here as /config/secrets since neither
  // the signup code nor the campus coordinates/radius are meant to be
  // client-readable (unlike /config/app's fields, which mirror get_boot_info).
  const secretsSnap = await db.doc('config/secrets').get();
  const secrets = secretsSnap.data() ?? {};
  const configuredCode = String(secrets.signupCode ?? '').trim().toLowerCase();
  if (!configuredCode || code.toLowerCase() !== configuredCode) {
    throw new HttpsError('permission-denied', '가입 코드가 올바르지 않습니다.');
  }
  if (lat === null || lng === null) {
    throw new HttpsError('permission-denied', '위치 정보가 필요합니다.');
  }
  const dist = haversineM(secrets.campusLat, secrets.campusLng, lat, lng);
  if (dist > (secrets.radiusM ?? 0)) {
    throw new HttpsError('permission-denied', '허용된 위치가 아닙니다.');
  }

  const usersCol = db.collection('users');

  // Courtesy pre-check (same two-phase shape as the old Edge Function): skip
  // creating an Auth user for the common case of an obviously-taken username,
  // before paying for the authoritative check inside the transaction below.
  const precheck = await usersCol.where('username', '==', username).limit(1).get();
  if (!precheck.empty) throw new HttpsError('already-exists', '이미 사용 중인 아이디입니다.');

  const email = `${username.toLowerCase()}@anytime.app`;
  let created;
  try {
    created = await auth.createUser({ email, password, emailVerified: true, displayName: username });
  } catch (e) {
    if (e.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', '이미 사용 중인 아이디입니다.');
    }
    if (e.code === 'auth/invalid-password') {
      throw new HttpsError('invalid-argument', '비밀번호가 너무 약합니다.');
    }
    throw new HttpsError('internal', '계정 생성에 실패했습니다.');
  }

  try {
    // Firestore has no UNIQUE constraint, so this is check-then-create inside
    // a transaction — same small TOCTOU race as most Firestore uniqueness
    // patterns (two concurrent signups could both pass the query read before
    // either commits). Accepted tradeoff at this app's scale; a stronger fix
    // (a `/usernames/{username}` reservation doc) is deliberately not built
    // here per the "don't over-engineer" instruction.
    await db.runTransaction(async (tx) => {
      const dupeSnap = await tx.get(usersCol.where('username', '==', username).limit(1));
      if (!dupeSnap.empty) throw new HttpsError('already-exists', '이미 사용 중인 아이디입니다.');
      tx.set(usersCol.doc(created.uid), {
        username,
        isAdmin: false,
        ttPublic: false,
        postCount: 0,
        geoVerifiedAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    await auth.deleteUser(created.uid).catch((rollbackErr) => {
      console.error('[signup] rollback deleteUser failed', created.uid, rollbackErr);
    });
    throw e;
  }

  return { status: 'OK', username };
});

// The old Edge Function re-verified the caller's password (via
// signInWithPassword against GoTrue) before deleting. There is no Admin SDK
// equivalent for verifying a password against Firebase's own hash — doing so
// would mean a second REST call to Identity Toolkit with a Web API key, which
// isn't part of this migration's secret set. request.auth already proves a
// live, unexpired ID token, so that check is dropped here; a client-side
// reauthenticateWithCredential() immediately before this call is the standard
// Firebase-native way to restore the "confirm password" UX if still wanted.
export const deleteAccount = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  await deleteUserFully(uid);
  return { status: 'OK' };
});

// geo_verify: unlike signup, "missing location" and "outside radius" were
// distinct statuses (NO_LOCATION vs OUT_OF_AREA) — kept distinct here too
// since the client already branches on them.
export const geoVerify = onCall({ region: REGION }, async (request) => {
  const uid = requireAuth(request);
  const data = request.data ?? {};
  const lat = typeof data.lat === 'number' ? data.lat : null;
  const lng = typeof data.lng === 'number' ? data.lng : null;
  if (lat === null || lng === null) invalid('위치 정보가 필요합니다.');

  const secretsSnap = await db.doc('config/secrets').get();
  const secrets = secretsSnap.data() ?? {};
  const dist = haversineM(secrets.campusLat, secrets.campusLng, lat, lng);
  if (dist > (secrets.radiusM ?? 0)) {
    throw new HttpsError('permission-denied', '허용된 위치가 아닙니다.');
  }

  // The one write to geoVerifiedAt that isn't "server-only forever" in the
  // naive sense — it's fine because this runs under the Admin SDK, which
  // bypasses Firestore rules entirely; rules only ever govern direct client
  // writes, and there is no rule granting clients write access to this field.
  await db.doc(`users/${uid}`).update({ geoVerifiedAt: FieldValue.serverTimestamp() });
  return { status: 'OK' };
});

// set_signup_code: admin-only, updates the plaintext code admins can see/copy
// in the admin screen (matches app_setting.signup_code being stored in the
// clear, not hashed — it's a shared campus-wide code, not a secret-per-user).
export const setSignupCode = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const code = String(request.data?.code ?? '').trim();
  if (!code) invalid('가입 코드를 입력하세요.');
  await db.doc('config/secrets').set({ signupCode: code }, { merge: true });
  return { status: 'OK' };
});

// New mechanism (design doc §2): Firestore has cadet.is_admin as a plain
// field, but requireAdmin() and Firestore rules both key off the Auth custom
// claim, not the Firestore field — Postgres RLS could join against `cadet`
// live on every check, Firestore rules cannot cheaply do a cross-document
// read on every request. This trigger is what keeps the two in sync whenever
// an admin toggles isAdmin from the admin screen.
export const syncAdminClaim = onDocumentUpdated({ document: 'users/{uid}', region: REGION }, async (event) => {
  const before = event.data?.before?.data();
  const after = event.data?.after?.data();
  if (!before || !after) return;
  if (before.isAdmin === after.isAdmin) return;
  await auth.setCustomUserClaims(event.params.uid, { admin: after.isAdmin === true });
});

// purge_expired_accounts, run monthly. Old schedule was pg_cron
// '0 18 1 * *' with no explicit timezone set anywhere in schema.sql, which
// means it ran in pg_cron's default (UTC) — confirmed by the neighboring
// purge-board job's own comment ('0 15 * * *' UTC = KST midnight). Kept as
// the same cron string + Etc/UTC here to fire at the identical wall-clock
// moment rather than reinterpreting it as KST.
export const purgeExpiredAccounts = onSchedule(
  { schedule: '0 18 1 * *', timeZone: 'Etc/UTC', region: REGION },
  async () => {
    const [appSnap, secretsSnap] = await Promise.all([
      db.doc('config/app').get(),
      db.doc('config/secrets').get(),
    ]);
    const geoValidDays = appSnap.get('geoValidDays') ?? 90;
    const accountDeleteDays = secretsSnap.get('accountDeleteDays') ?? 90;
    const cutoff = new Date(Date.now() - (geoValidDays + accountDeleteDays) * 86400000);

    // A range filter on geoVerifiedAt naturally excludes docs where the field
    // is absent — the same effect as the old query's explicit
    // `geo_verified_at IS NOT NULL` guard (never-verified accounts are never
    // auto-purged).
    const expiredSnap = await db.collection('users').where('geoVerifiedAt', '<', cutoff).get();

    const results = await Promise.allSettled(expiredSnap.docs.map((doc) => deleteUserFully(doc.id)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error('[purgeExpiredAccounts] failed uid=', expiredSnap.docs[i].id, r.reason);
      }
    });
  }
);
