import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuthContext } from './contexts/AuthContext';
import { verifyGeo } from './lib/geo';
import { syncPush, consumePendingNav } from './lib/push';
import { syncNextClassAlerts } from './lib/nextClass';
import Home from './pages/Home';
import Login from './pages/Login';
import ErrorBoundary from './components/ErrorBoundary';
import InstallGate from './components/InstallGate';
import PushPrompt from './components/PushPrompt';
import UpdatePrompt from './components/UpdatePrompt';
import LocationHelp from './components/LocationHelp';

// 홈/로그인만 초기 번들에 두고, 나머지는 지연 로드한다.
// (특히 강의평·게시판 계열은 korcen, 관리자는 pdfjs 를 끌고 오므로 초기 번들에서 반드시 분리)
const Onboarding = lazy(() => import('./pages/Onboarding'));
const CourseSearch = lazy(() => import('./pages/CourseSearch'));
const Wizard = lazy(() => import('./pages/Wizard'));
const ProfessorSearch = lazy(() => import('./pages/ProfessorSearch'));
const EmptyRooms = lazy(() => import('./pages/EmptyRooms'));
const ProfessorDetail = lazy(() => import('./pages/ProfessorDetail'));
const Reviews = lazy(() => import('./pages/Reviews'));
const ReviewWrite = lazy(() => import('./pages/ReviewWrite'));
const Exams = lazy(() => import('./pages/Exams'));
const Memo = lazy(() => import('./pages/Memo'));
const Profile = lazy(() => import('./pages/Profile'));
const Friends = lazy(() => import('./pages/Friends'));
const Calc = lazy(() => import('./pages/Calc'));
const Admin = lazy(() => import('./pages/Admin'));
const AdminCourse = lazy(() => import('./pages/AdminCourse'));
const Moderation = lazy(() => import('./pages/Moderation'));
const Boards = lazy(() => import('./pages/Boards'));
const Board = lazy(() => import('./pages/Board'));
const Post = lazy(() => import('./pages/Post'));
const SharePost = lazy(() => import('./pages/SharePost'));
const About = lazy(() => import('./pages/About'));

// 로그인(세션)한 사용자만. 미로그인 시 로그인 화면으로.
function GeoVerifyButton({ onDone, label }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [geoFailed, setGeoFailed] = useState(false); // 위치 실패 → 권한 안내 링크 노출
  const [showGeoHelp, setShowGeoHelp] = useState(false);
  async function go() {
    setBusy(true); setMsg('📍 위치 확인 중…');
    const r = await verifyGeo();
    setBusy(false);
    setGeoFailed(r === 'NO_LOCATION');
    if (r === 'OK') { setMsg('✅ 인증됨'); onDone?.(); }
    else setMsg(r === 'OUT_OF_AREA' ? '캠퍼스 범위 밖입니다.' : r === 'NO_LOCATION' ? '위치 권한이 필요합니다.' : '인증 실패');
  }
  return (
    <span>
      <button className="btn-add" disabled={busy} onClick={go}>{label || '위치 확인'}</button>
      {msg && <span className="muted" style={{ marginLeft: 8, fontSize: '0.8rem' }}>{msg}</span>}
      {geoFailed && (
        <button type="button" className="link-btn" onClick={() => setShowGeoHelp(true)}>
          켜는 방법
        </button>
      )}
      {showGeoHelp && <LocationHelp onClose={() => setShowGeoHelp(false)} />}
    </span>
  );
}

function GeoBlockScreen() {
  const { refreshCadet, logout } = useAuthContext();
  return (
    <div className="page-center" style={{ flexDirection: 'column', gap: '1rem', padding: '2rem', textAlign: 'center' }}>
      <h2>📍 위치 재인증이 필요합니다</h2>
      <p className="muted">정기 위치 인증이 만료되었습니다.<br />교내에서 위치 확인을 한 번 하면 다시 이용할 수 있습니다.</p>
      <GeoVerifyButton onDone={refreshCadet} label="위치 확인하고 계속" />
      <button className="link-btn" onClick={logout}>로그아웃</button>
    </div>
  );
}

function GeoBanner() {
  const { geo, refreshCadet } = useAuthContext();
  if (!geo || geo.expired || geo.daysLeft == null || geo.daysLeft > 10) return null;
  return (
    <div className="banner-warn">
      <span>위치 인증 만료 {geo.daysLeft}일 전 — 교내에서 갱신하세요.</span>
      <GeoVerifyButton onDone={refreshCadet} label="위치 확인" />
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { session, loading, geo } = useAuthContext();
  if (loading) return <div className="page-center">로딩 중...</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (geo?.expired) return <GeoBlockScreen />;
  return children;
}

// 익명게시판이 닫혀 있으면(관리자 비활성화) 목록·게시판·글 어디로도 못 들어간다(완전 차단).
// 링크를 직접 알아도 '준비중' 안내만 보인다 — 예전엔 라우트에 아무 가드가 없어 URL 로 들어가졌다.
// (관리자 모더레이션은 service_role Edge(admin-action)라 이 가드·RLS 와 무관하게 계속 동작한다.)
function BoardRoute({ children }) {
  const { settings } = useAuthContext();
  if (settings && settings.boardEnabled === false) {
    return (
      <div className="page-center" style={{ flexDirection: 'column', gap: '0.55rem', textAlign: 'center', padding: '2rem 1.25rem' }}>
        <span aria-hidden="true" style={{ fontSize: '2.6rem' }}>🚧</span>
        <p style={{ margin: 0, fontWeight: 700, fontSize: '1.05rem' }}>익명게시판 준비중</p>
        <p className="muted" style={{ margin: 0 }}>지금은 익명게시판을 열 수 없어요. 준비되면 다시 열게요.</p>
        <Link to="/" className="btn btn-primary" style={{ marginTop: '0.5rem' }}>홈으로</Link>
      </div>
    );
  }
  return children;
}

// 푸시 구독 자가치유: 로그인 세션이 잡히면 구독을 서버에 재업서트(유실·회전 복구).
// "다음 수업" 알림 스케줄도 이때 + 앱이 포그라운드로 돌아올 때마다 재계산해 올린다
// (시간표를 고치고 앱으로 돌아오면 다음 수업 알림도 곧 최신이 되도록). 바뀐 게 없으면
// syncNextClassAlerts 내부 서명 대조로 네트워크 호출은 건너뛴다.
function PushSync() {
  const { session } = useAuthContext();
  useEffect(() => {
    if (!session) return undefined;
    syncPush();
    const sync = () => syncNextClassAlerts().catch(() => { /* 다음 기회에 재시도 */ });
    sync();
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [session]);
  return null;
}

// (앱 복귀 시 서버 설정·카탈로그 버전 재확인은 useAuth 가 맡는다 — 부팅 RPC 와 같은 자리라 한 곳에 둔다)

// 알림 클릭 딥링크: 앱이 떠 있으면 SW 의 postMessage 로, 콜드스타트면 SW 가 캐시에
// 남긴 목적지(consumePendingNav)로 해당 글로 이동한다. SW 의 client.navigate()/
// openWindow(경로)가 플랫폼(WebAPK·iOS PWA)에 따라 경로를 무시하는 문제의 우회로.
function PushNavigator() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    // 공유 링크 화면(/s/*)에서는 소비·이동 금지 — 그 화면이 방금 stashPendingNav 로
    // 남긴 목적지(앱을 열면 그 글로)를 자기 자신이 삼켜 버리거나, 브라우저 탭을
    // 앱 내부 경로로 끌고 가 설치 게이트에 부딪히는 것을 막는다.
    const inShare = () => window.location.pathname.startsWith('/s/');
    const go = (path) => {
      if (path && window.location.pathname !== path) navigate(path);
    };
    const onMsg = (e) => {
      if (inShare()) return;
      const d = e.data;
      if (d?.type !== 'PUSH_NAV' || typeof d.path !== 'string' || !d.path.startsWith('/')) return;
      consumePendingNav();  // 캐시 보험 소비(다음 부팅 때 이중 이동 방지)
      go(d.path);
    };
    // 백그라운드에 있던 앱이 알림 탭으로 다시 앞으로 나올 때: postMessage 가 유실됐어도
    // SW 가 남긴 목적지를 회수해 이동한다(가장 흔한 실패 경로의 안전망 — 콜드/웜 모두 커버).
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !inShare()) consumePendingNav().then(go);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    document.addEventListener('visibilitychange', onVisible);
    if (!inShare()) consumePendingNav().then(go);  // 콜드스타트(openWindow 가 경로를 무시한 경우)
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [navigate]);
  return null;
}

// 경로가 바뀌면 경계를 새로 세운다(key) — 한 화면이 죽었다고 다른 화면까지 못 열면 안 된다.
function RouteBoundary({ children }) {
  const { pathname } = useLocation();
  return <ErrorBoundary key={pathname}>{children}</ErrorBoundary>;
}

// 이미 로그인했으면 홈으로 (가입/로그인 화면 가드).
function PublicOnly({ children }) {
  const { session, loading } = useAuthContext();
  if (loading) return <div className="page-center">로딩 중...</div>;
  if (session) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <div className="app">
        <UpdatePrompt />
        <InstallGate>
        <PushSync />
        <PushNavigator />
        <PushPrompt />
        <GeoBanner />
        {/* 청크 로딩 실패(배포·캐시·네트워크)를 여기서 잡는다 — 없으면 그대로 검은 화면 */}
        <RouteBoundary>
        <Suspense fallback={<div className="page-center">로딩 중...</div>}>
        <Routes>
          <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          <Route path="/search" element={<ProtectedRoute><CourseSearch /></ProtectedRoute>} />
          <Route path="/wizard" element={<ProtectedRoute><Wizard /></ProtectedRoute>} />
          <Route path="/professors" element={<ProtectedRoute><ProfessorSearch /></ProtectedRoute>} />
          <Route path="/rooms" element={<ProtectedRoute><EmptyRooms /></ProtectedRoute>} />
          <Route path="/professor/:code" element={<ProtectedRoute><ProfessorDetail /></ProtectedRoute>} />
          <Route path="/reviews/:courseCode" element={<ProtectedRoute><Reviews /></ProtectedRoute>} />
          <Route path="/review-write/:courseCode/:year/:term/:sectionNo" element={<ProtectedRoute><ReviewWrite /></ProtectedRoute>} />
          <Route path="/exams/:courseCode" element={<ProtectedRoute><Exams /></ProtectedRoute>} />
          <Route path="/memo/:courseCode/:year/:term/:sectionNo" element={<ProtectedRoute><Memo /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
          <Route path="/friends" element={<ProtectedRoute><Friends /></ProtectedRoute>} />
          <Route path="/calc" element={<ProtectedRoute><Calc /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="/admin/moderation" element={<ProtectedRoute><Moderation /></ProtectedRoute>} />
          {/* 과목 하나만 다루는 화면 — 관리자 허브의 과목 검색에서 새 탭으로 연다 */}
          <Route path="/admin/courses/:code" element={<ProtectedRoute><AdminCourse /></ProtectedRoute>} />
          <Route path="/admin/:section" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="/boards" element={<ProtectedRoute><BoardRoute><Boards /></BoardRoute></ProtectedRoute>} />
          <Route path="/board/:id" element={<ProtectedRoute><BoardRoute><Board /></BoardRoute></ProtectedRoute>} />
          <Route path="/board/post/:id" element={<ProtectedRoute><BoardRoute><Post /></BoardRoute></ProtectedRoute>} />
          <Route path="/signup" element={<PublicOnly><Onboarding /></PublicOnly>} />
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          {/* 공유 링크: 유일한 공개 콘텐츠 라우트 — 세션·게이트 없이 그 글 하나만 읽기 전용 */}
          <Route path="/s/:token" element={<SharePost />} />
          {/* 앱 소개: 가드 없음(PublicOnly 도 아님) — 로그인 여부와 무관하게 열려야 한다.
              로그인한 사람도 '이 앱이 뭘 하는지' 보러 올 수 있고, 아직 가입 안 한 사람에게
              링크로 보낼 수도 있어야 하므로. 데이터를 부르지 않아 세션이 필요 없다. */}
          <Route path="/about" element={<About />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </RouteBoundary>
        </InstallGate>
      </div>
    </AuthProvider>
  );
}
