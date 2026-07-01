import { useState, lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuthContext } from './contexts/AuthContext';
import { verifyGeo } from './lib/geo';
import Home from './pages/Home';
import Login from './pages/Login';
import InstallPrompt from './components/InstallPrompt';

// 홈/로그인만 초기 번들에 두고, 나머지는 지연 로드한다.
// (특히 강의평·게시판 계열은 korcen, 관리자는 pdfjs 를 끌고 오므로 초기 번들에서 반드시 분리)
const Onboarding = lazy(() => import('./pages/Onboarding'));
const CourseSearch = lazy(() => import('./pages/CourseSearch'));
const ProfessorSearch = lazy(() => import('./pages/ProfessorSearch'));
const ProfessorDetail = lazy(() => import('./pages/ProfessorDetail'));
const Reviews = lazy(() => import('./pages/Reviews'));
const Exams = lazy(() => import('./pages/Exams'));
const Memo = lazy(() => import('./pages/Memo'));
const Profile = lazy(() => import('./pages/Profile'));
const Admin = lazy(() => import('./pages/Admin'));
const Moderation = lazy(() => import('./pages/Moderation'));
const Boards = lazy(() => import('./pages/Boards'));
const Board = lazy(() => import('./pages/Board'));
const Post = lazy(() => import('./pages/Post'));

// 로그인(세션)한 사용자만. 미로그인 시 로그인 화면으로.
function BlockedScreen({ until }) {
  const { logout } = useAuthContext();
  return (
    <div className="page-center" style={{ flexDirection: 'column', gap: '1rem', padding: '2rem', textAlign: 'center' }}>
      <h2>🚫 이용이 제한되었습니다</h2>
      <p className="muted">{new Date(until).toLocaleString('ko-KR')} 까지 차단됨.<br />관리자에게 문의하세요.</p>
      <button className="link-btn" onClick={logout}>로그아웃</button>
    </div>
  );
}

function GeoVerifyButton({ onDone, label }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function go() {
    setBusy(true); setMsg('📍 위치 확인 중…');
    const r = await verifyGeo();
    setBusy(false);
    if (r === 'OK') { setMsg('✅ 인증됨'); onDone?.(); }
    else setMsg(r === 'OUT_OF_AREA' ? '캠퍼스 범위 밖입니다.' : r === 'NO_LOCATION' ? '위치 권한이 필요합니다.' : '인증 실패');
  }
  return (
    <span>
      <button className="btn-add" disabled={busy} onClick={go}>{label || '위치 확인'}</button>
      {msg && <span className="muted" style={{ marginLeft: 8, fontSize: '0.8rem' }}>{msg}</span>}
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
  const { session, loading, blockedUntil, geo } = useAuthContext();
  if (loading) return <div className="page-center">로딩 중...</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (blockedUntil) return <BlockedScreen until={blockedUntil} />;
  if (geo?.expired) return <GeoBlockScreen />;
  return children;
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
        <InstallPrompt />
        <GeoBanner />
        <Suspense fallback={<div className="page-center">로딩 중...</div>}>
        <Routes>
          <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          <Route path="/search" element={<ProtectedRoute><CourseSearch /></ProtectedRoute>} />
          <Route path="/professors" element={<ProtectedRoute><ProfessorSearch /></ProtectedRoute>} />
          <Route path="/professor/:code" element={<ProtectedRoute><ProfessorDetail /></ProtectedRoute>} />
          <Route path="/reviews/:courseCode" element={<ProtectedRoute><Reviews /></ProtectedRoute>} />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </div>
    </AuthProvider>
  );
}
