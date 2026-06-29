import { useState, useEffect } from 'react';
import { supabase } from '../supabase';
import { logout as authLogout } from '../lib/auth';

// 세션(Supabase Auth) + 본인 cadet 프로필을 추적한다.
// cadet 행은 RLS 로 본인 것만 조회된다. 가입 직후엔 Edge Function 이 만들어 둔다.
export function useAuth() {
  const [session, setSession] = useState(null);
  const [cadet, setCadet] = useState(null);
  const [blockedUntil, setBlockedUntil] = useState(null);
  const [geo, setGeo] = useState({ expired: false, daysLeft: null }); // 지오펜싱 재인증 상태
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!active) return;
      setSession(session);
      if (session) fetchCadet(session.user.id);
      else setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setSession(session);
      if (session) fetchCadet(session.user.id);
      else {
        setCadet(null);
        setLoading(false);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  async function fetchCadet(uid) {
    const { data } = await supabase
      .from('cadet')
      .select('id, username, post_count, geo_verified_at')
      .eq('id', uid)
      .maybeSingle();
    setCadet(data ?? null);
    const { data: blk } = await supabase.rpc('get_my_block');
    setBlockedUntil(blk || null);
    const { data: vd } = await supabase.rpc('get_geo_valid_days');
    const validDays = vd ?? 90;
    if (data?.geo_verified_at) {
      const expiresAt = new Date(data.geo_verified_at).getTime() + validDays * 86400000;
      const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
      setGeo({ expired: daysLeft <= 0, daysLeft });
    } else {
      setGeo({ expired: false, daysLeft: validDays });
    }
    setLoading(false);
  }

  async function refreshCadet() {
    if (session) await fetchCadet(session.user.id);
  }

  async function logout() {
    await authLogout();
    setCadet(null);
  }

  return { session, cadet, blockedUntil, geo, loading, refreshCadet, logout };
}
