import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuthContext } from './contexts/AuthContext';
import Onboarding from './pages/Onboarding';
import Login from './pages/Login';
import Home from './pages/Home';

// 로그인(세션)한 사용자만. 미로그인 시 로그인 화면으로.
function ProtectedRoute({ children }) {
  const { session, loading } = useAuthContext();
  if (loading) return <div className="page-center">로딩 중...</div>;
  if (!session) return <Navigate to="/login" replace />;
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
        <Routes>
          <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
          <Route path="/signup" element={<PublicOnly><Onboarding /></PublicOnly>} />
          <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </AuthProvider>
  );
}
