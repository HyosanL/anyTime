import { useState, useEffect, useCallback, useMemo } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { logout as authLogout } from '../lib/auth';
import { fetchBootInfo, BOOT_DEFAULTS } from '../lib/appInfo';
import { noteCatalogVersion } from '../lib/cache';

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

const BOOT_RECHECK_MS = 10 * 60 * 1000;

// 세션(Firebase Auth) + 본인 cadet 프로필(/users/{uid})을 추적한다.
// cadet 문서는 Firestore Rules 로 본인 것만 읽힌다. 가입 직후엔 signup Cloud
// Function 이 만들어 둔다.
//
// 성능: onAuthStateChanged 는 로컬에 캐시된 인증 상태로 즉시(네트워크 왕복 없이)
//       한 번 불리므로, 첫 콜백에서 loading 을 바로 해제해 홈(시간표)을 그린다.
//       프로필/지오 상태는 화면을 막지 않고 백그라운드로 병렬 조회한다.
export function useAuth() {
  // Firebase 의 session 은 Supabase Session 과 달리 auth.currentUser(User) 그
  // 자체다 — .user 로 한 겹 더 감싸여 있지 않다(session.uid, session.email 등).
  const [session, setSession] = useState(null);
  const [cadet, setCadet] = useState(() => readCadetCache()); // 캐시로 헤더 즉시(오프라인) 표시
  const [geo, setGeo] = useState({ expired: false, daysLeft: null }); // 지오펜싱 재인증 상태
  // 서버 설정(게시판 활성화·강의평 자격일수). 부팅 정보 한 번으로 받아 전 화면이 나눠 쓴다
  // → 홈·게시판·메모가 각자 부르던 board_enabled()·get_review_min_days() RPC 가 사라진다.
  const [settings, setSettings] = useState(BOOT_DEFAULTS);
  const [loading, setLoading] = useState(true);

  // fetchCadet 은 setter·db(모두 안정)만 참조 → 정체성 고정([]).
  const fetchCadet = useCallback(async (uid) => {
    // 순차 왕복 → 병렬 1왕복.
    const [snap, boot] = await Promise.all([
      getDoc(doc(db, 'users', uid)),
      fetchBootInfo(),
    ]);
    const data = snap.exists() ? { id: uid, ...snap.data() } : null;
    if (data) { setCadet(data); writeCadetCache(data); } // 문서 없음(오프라인 등)이면 캐시 유지
    setSettings(boot);
    // 같은 응답에 실려 온 카탈로그 버전. 기기 캐시와 다르면 여기서 재동기화가 걸리고
    // 열려 있는 화면은 subscribeCatalog 로 갱신된다(관리자 대규모 수정의 자동 반영).
    noteCatalogVersion(boot.catalogVersion);
    const validDays = boot.geoValidDays;
    const gv = data?.geoVerifiedAt; // Firestore Timestamp(.toMillis()) — ISO 문자열이던 옛 필드와 다름
    if (gv) {
      const expiresAt = gv.toMillis() + validDays * 86400000;
      const daysLeft = Math.ceil((expiresAt - Date.now()) / 86400000);
      setGeo({ expired: daysLeft <= 0, daysLeft });
    } else if (data) {
      setGeo({ expired: false, daysLeft: validDays });
    }
    // data 가 null(오프라인/미가입)이면 geo 는 기본값 유지 → 오프라인 사용자를 잠그지 않는다.
  }, []);

  useEffect(() => {
    let active = true;

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!active) return;
      setSession(user);
      setLoading(false); // 로컬 인증 상태는 즉시 확인 → 화면을 막지 않는다
      if (user) fetchCadet(user.uid);
      else { setCadet(null); writeCadetCache(null); }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [fetchCadet]);

  // 앱 복귀 시 서버 설정·카탈로그 버전 재확인.
  // PWA 는 배경에 며칠씩 살아 있어서, 부팅 때 한 번 받은 값만으로는 관리자가 게시판을 잠그거나
  // 강의 정보를 고쳐도 앱을 완전히 껐다 켜기 전까지 옛 값을 계속 쓴다. 확인 비용은 설정 문서
  // 한 번(수십 바이트)이고, 카탈로그 7개 테이블을 실제로 다시 받는 건 버전이 바뀐 경우뿐이다.
  useEffect(() => {
    if (!session) return undefined;
    let last = Date.now();   // 방금 부팅 정보가 확인했다
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - last < BOOT_RECHECK_MS) return;   // 복귀할 때마다는 과하다 — 10분에 한 번으로 묶는다
      last = Date.now();
      fetchBootInfo().then((boot) => {
        setSettings(boot);
        noteCatalogVersion(boot.catalogVersion);
      }).catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [session]);

  const refreshCadet = useCallback(async () => {
    if (session) await fetchCadet(session.uid);
  }, [session, fetchCadet]);

  const logout = useCallback(async () => {
    await authLogout();
    setCadet(null);
    writeCadetCache(null);
  }, []);

  // 값 정체성을 데이터가 바뀔 때만 갱신 → 배경 geo/cadet 갱신 한 번에 모든 컨텍스트
  // 소비자(현재 페이지 전체)가 리렌더되던 것을 막는다.
  return useMemo(
    () => ({ session, cadet, geo, settings, loading, refreshCadet, logout }),
    [session, cadet, geo, settings, loading, refreshCadet, logout]
  );
}
