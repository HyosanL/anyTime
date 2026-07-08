import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../supabase';
import { logout as authLogout } from '../lib/auth';

// 본인 cadet 프로필 캐시(오프라인·즉시 표시용). 세션 유무와 무관하게 마지막 프로필을 보관.
const CADET_CACHE = 'anytime:cadetCache';

function readCadetCache() {
  try {
    const raw = localStorage.getItem(CADET_CACHE);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCadetCache(c) {
  try {
    if (c) localStorage.setItem(CADET_CACHE, JSON.stringify(c));
    else localStorage.removeItem(CADET_CACHE);
  } catch {
    /* ignore */
  }
}

// 세션(Supabase Auth) + 본인 cadet 프로필을 추적한다.
// cadet 행은 RLS 로 본인 것만 조회된다. 가입 직후엔 Edge Function 이 만들어 둔다.
//
// 성능: 세션은 로컬(localStorage)에서 즉시 확인되므로, 세션이 잡히는 즉시 loading 을 해제해
//       홈(시간표)을 바로 그린다. 프로필/지오 상태는 화면을 막지 않고 백그라운드로 병렬 조회한다.
export function useAuth() {
  const [session, setSession] = useState(null);
  const [cadet, setCadet] = useState(() => readCadetCache()); // 캐시로 헤더 즉시(오프라인) 표시
  const [geo, setGeo] = useState({ expired: false, daysLeft: null }); // 지오펜싱 재인증 상태
  const [loading, setLoading] = useState(true);

  // fetchCadet 은 setter·supabase(모두 안정)만 참조 → 정체성 고정([]).
  const fetchCadet = useCallback(async (uid) => {
    // 순차 왕복 → 병렬 1왕복. supabase-js 는 네트워크 실패 시 throw 대신 { data:null } 을 준다(오프라인 안전).
    const [{ data }, { data: vd }] = await Promise.all([
      supabase.from('cadet').select('id, username, post_count, geo_verified_at, is_admin').eq('id', uid).maybeSingle(),
      supabase.rpc('get_geo_valid_days'),
    ]);
    if (data) { setCadet(data); writeCadetCache(data); } // 오프라인이면 data=null → 캐시 유지
    const validDays = vd ?? 90;
    const gv = data?.geo_verified_at;
    if (gv) {
      const expiresAt = new Date(gv).getTime() + validDays * 86400000;
      const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
      setGeo({ expired: daysLeft <= 0, daysLeft });
    } else if (data) {
      setGeo({ expired: false, daysLeft: validDays });
    }
    // data 가 null(오프라인)이면 geo 는 기본값 유지 → 오프라인 사용자를 잠그지 않는다.
  }, []);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      setSession(session);
      setLoading(false); // 세션은 로컬에서 즉시 확인 → 화면을 막지 않는다
      if (session) fetchCadet(session.user.id);
      else { setCadet(null); writeCadetCache(null); }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setSession(session);
      setLoading(false);
      if (session) fetchCadet(session.user.id);
      else { setCadet(null); writeCadetCache(null); }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [fetchCadet]);

  const refreshCadet = useCallback(async () => {
    if (session) await fetchCadet(session.user.id);
  }, [session, fetchCadet]);

  const logout = useCallback(async () => {
    await authLogout();
    setCadet(null);
    writeCadetCache(null);
  }, []);

  // 값 정체성을 데이터가 바뀔 때만 갱신 → 배경 geo/cadet 갱신 한 번에 모든 컨텍스트
  // 소비자(현재 페이지 전체)가 리렌더되던 것을 막는다.
  return useMemo(
    () => ({ session, cadet, geo, loading, refreshCadet, logout }),
    [session, cadet, geo, loading, refreshCadet, logout]
  );
}
