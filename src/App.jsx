import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuthContext } from './contexts/AuthContext';
import Onboarding from './pages/Onboarding';
import Login from './pages/Login';
import Home from './pages/Home';
import CourseSearch from './pages/CourseSearch';
import Reviews from './pages/Reviews';
import Exams from './pages/Exams';
import Memo from './pages/Memo';
import Profile from './pages/Profile';
import Admin from './pages/Admin';
import Moderation from './pages/Moderation';
import InstallPrompt from './components/InstallPrompt';

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

function ProtectedRoute({ children }) {
  const { session, loading, blockedUntil } = useAuthContext();
  if (loading) return <div className="page-center">로딩 중...</div>;
  if (!session) return <Navigate to="/login" replace />;
  if (blockedUntil) return <BlockedScreen until={blockedUntil} />;
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
        <Routes>
          <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          <Route path="/search" element={<ProtectedRoute><CourseSearch /></ProtectedRoute>} />
          <Route path="/reviews/:courseCode" element={<ProtectedRoute><Reviews /></ProtectedRoute>} />
          <Route path="/exams/:courseCode" element={<ProtectedRoute><Exams /></ProtectedRoute>} />
          <Route path="/memo/:courseCode/:year/:term/:sectionNo" element={<ProtectedRoute><Memo /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><Profile /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
          <Route path="/admin/moderation" element={<ProtectedRoute><Moderation /></ProtectedRoute>} />
          <Route path="/signup" element={<PublicOnly><Onboarding /></PublicOnly>} />
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </AuthProvider>
  );
}
