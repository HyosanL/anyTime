import { supabase } from '../supabase';

// 아이디 → 합성 이메일 매핑. RLS/세션은 auth.uid() 기반으로 동작.
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

// 가입: Edge Function 으로 가입코드+지오펜싱 서버검증 후 계정 생성.
// 반환: { status, ... }  status='OK' 면 곧바로 로그인 시도 권장.
export async function signup({ username, password, code, lat, lng }) {
  const { data, error } = await supabase.functions.invoke('signup', {
    body: { username: username.trim(), password, code: code.trim(), lat, lng },
  });
  // Edge Function 이 4xx/5xx 로 응답하면 supabase-js 가 error 를 채우고 data 는 비어 있을 수 있음.
  if (error) {
    // FunctionsHttpError 의 경우 본문에서 status 를 꺼낸다.
    try {
      const body = await error.context?.json?.();
      if (body?.status) return body;
    } catch {
      /* ignore */
    }
    return { status: 'ERROR', detail: error.message };
  }
  return data ?? { status: 'ERROR' };
}

// 로그인: 합성 이메일로 Auth 로그인 → 세션(JWT) 발급.
export async function login(username, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: synthEmail(username),
    password,
  });
  if (error) throw error;
  return data;
}

export async function logout() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}
