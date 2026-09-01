import {
  signInWithEmailAndPassword,
  signOut,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth';
import { auth, authFunctions } from '../firebase';
import { callFn } from './functions.js';

// 아이디 → 합성 이메일 매핑. Firebase Auth 는 이메일/비번 로그인만 지원.
export function synthEmail(username) {
  return `${username.trim().toLowerCase()}@anytime.app`;
}

// 위치 권한 요청 → 좌표. 거부/실패 시 null 좌표(게이트는 코드만으로도 허용 가능).
export function getPosition() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({ lat: null, lng: null, error: 'UNSUPPORTED' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, error: null }),
      (err) => resolve({ lat: null, lng: null, error: err.code === 1 ? 'DENIED' : 'UNAVAILABLE' }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
}

// 가입: Cloud Function 으로 가입코드+지오펜싱 서버검증 후 계정 생성.
// 반환: { status, ... }  status='OK' 면 곧바로 로그인 시도 권장.
//
// signup Cloud Function 은 HttpsError.code 로만 실패를 구분한다(already-exists /
// invalid-argument / permission-denied / internal) — 옛 Edge Function 이 주던
// INVALID_CODE/OUT_OF_AREA/USERNAME_TAKEN/WEAK_PASSWORD/BAD_REQUEST 세분화보다
// 얕다. Onboarding.jsx 는 이 세분화된 문자열로 분기하므로(이번 작업 범위 밖이라
// 못 고침), 서버가 고정으로 내려주는 한국어 메시지를 되짚어 옛 상태값으로 복원한다.
export async function signup({ username, password, code, lat, lng }) {
  const r = await callFn('signup', { username: username.trim(), password, code: code.trim(), lat, lng }, authFunctions);
  if (r.ok) return { status: 'OK', username: r.data?.username };
  const msg = r.message || '';
  if (r.status === 'already-exists') return { status: 'USERNAME_TAKEN' };
  if (r.status === 'invalid-argument') return { status: msg.includes('비밀번호') ? 'WEAK_PASSWORD' : 'BAD_REQUEST' };
  if (r.status === 'permission-denied') return { status: msg.includes('코드') ? 'INVALID_CODE' : 'OUT_OF_AREA' };
  return { status: 'ERROR' };
}

// 로그인: 합성 이메일로 Auth 로그인 → 세션(ID 토큰) 발급.
export async function login(username, password) {
  return signInWithEmailAndPassword(auth, synthEmail(username), password);
}

export async function logout() {
  await signOut(auth);
}

// 비밀번호 변경 (로그인 상태에서). Firebase 는 민감한 작업에 "최근 재로그인"을
// 요구한다 — 세션이 오래됐으면 auth/requires-recent-login 을 던진다(Supabase 엔
// 없던 제약). 호출자(Profile.jsx)가 err.code 로 분기해 안내 문구를 낸다.
export async function changePassword(newPassword) {
  await updatePassword(auth.currentUser, newPassword);
}

// 회원 탈퇴: 비번 재확인 후 서버에서 계정 삭제(users 서브트리 + Auth 계정).
// deleteAccount Cloud Function 은 비번을 다시 검증하지 않는다(Admin SDK 로 해시
// 비교할 방법이 없음) — 대신 클라이언트에서 reauthenticateWithCredential 로 먼저
// 재인증해, 옛 'BAD_PASSWORD' 두 갈래 UX 를 그대로 재현한다.
// 반환 status: 'OK' | 'BAD_PASSWORD' | 'UNAUTH' | 'ERROR'
export async function deleteAccount(password) {
  const user = auth.currentUser;
  if (!user) return 'UNAUTH';
  try {
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
  } catch {
    return 'BAD_PASSWORD';
  }
  const r = await callFn('deleteAccount', {}, authFunctions);
  return r.ok ? 'OK' : 'ERROR';
}
