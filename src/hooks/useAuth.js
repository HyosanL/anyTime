import { useState, useEffect } from 'react';
import { supabase } from '../supabase';
import { logout as authLogout } from '../lib/auth';

// 세션(Supabase Auth) + 본인 cadet 프로필을 추적한다.
// cadet 행은 RLS 로 본인 것만 조회된다. 가입 직후엔 Edge Function 이 만들어 둔다.
export function useAuth() {
  const [session, setSession] = useState(null);
  const [cadet, setCadet] = useState(null);
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
      .select('id, username, post_count')
      .eq('id', uid)
      .maybeSingle();
    setCadet(data ?? null);
    setLoading(false);
  }

  async function refreshCadet() {
    if (session) await fetchCadet(session.user.id);
  }

  async function logout() {
    await authLogout();
    setCadet(null);
  }

  return { session, cadet, loading, refreshCadet, logout };
}
