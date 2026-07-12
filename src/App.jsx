import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuthContext } from './contexts/AuthContext';
import { verifyGeo } from './lib/geo';
import { syncPush, consumePendingNav } from './lib/push';
import Home from './pages/Home';
import Login from './pages/Login';
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
const Admin = lazy(() => import('./pages/Admin'));
const Moderation = lazy(() => import('./pages/Moderation'));
const Boards = lazy(() => import('./pages/Boards'));
const Board = lazy(() => import('./pages/Board'));
const Post = lazy(() => import('./pages/Post'));
const SharePost = lazy(() => import('./pages/SharePost'));

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

// 푸시 구독 자가치유: 로그인 세션이 잡히면 구독을 서버에 재업서트(유실·회전 복구).
function PushSync() {
  const { session } = useAuthContext();
  useEffect(() => { if (session) syncPush(); }, [session]);
  return null;
}

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
          <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="/admin/moderation" element={<ProtectedRoute><Moderation /></ProtectedRoute>} />
          <Route path="/admin/:section" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="/boards" element={<ProtectedRoute><Boards /></ProtectedRoute>} />
          <Route path="/board/:id" element={<ProtectedRoute><Board /></ProtectedRoute>} />
          <Route path="/board/post/:id" element={<ProtectedRoute><Post /></ProtectedRoute>} />
          <Route path="/signup" element={<PublicOnly><Onboarding /></PublicOnly>} />
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          {/* 공유 링크: 유일한 공개 콘텐츠 라우트 — 세션·게이트 없이 그 글 하나만 읽기 전용 */}
          <Route path="/s/:token" element={<SharePost />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
        </InstallGate>
      </div>
    </AuthProvider>
  );
}
