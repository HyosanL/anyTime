import { useState, useEffect } from 'react';
import { supabase } from '../supabase';

export function useAuth() {
  const [session, setSession] = useState(null);
  const [cadet, setCadet] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchCadet(session.user.id);
      else setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) fetchCadet(session.user.id);
      else {
        setCadet(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function fetchCadet(uid) {
    const { data } = await supabase
      .from('cadet')
      .select('*')
      .eq('id', uid)
      .single();
    setCadet(data);
    setLoading(false);
  }

  async function signInAnonymously() {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
  }

  async function redeemCode(code, nickname, classYear, department) {
    if (!session) await signInAnonymously();

    const { error } = await supabase.rpc('redeem_invite_code', {
      p_code: code,
      p_nickname: nickname,
      p_entry_class: classYear,
      p_department: department,
    });
    if (error) throw error;

    await fetchCadet((await supabase.auth.getUser()).data.user.id);
  }

  return { session, cadet, loading, signInAnonymously, redeemCode };
}
