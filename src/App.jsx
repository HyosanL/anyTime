import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuthContext } from './contexts/AuthContext';
import Onboarding from './pages/Onboarding';
import CourseList from './pages/CourseList';
import CourseDetail from './pages/CourseDetail';
import Timetable from './pages/Timetable';
import MyTimetable from './pages/MyTimetable';
import Memo from './pages/Memo';

function ProtectedRoute({ children }) {
  const { cadet, loading } = useAuthContext();
  if (loading) return <div className="page-center">로딩 중...</div>;
  if (!cadet) return <Navigate to="/" replace />;
  return children;
}

export default function App() {
  return (
    <AuthProvider>
      <div className="app">
        <Routes>
          <Route path="/" element={<Onboarding />} />
          <Route path="/courses" element={<ProtectedRoute><CourseList /></ProtectedRoute>} />
          <Route path="/courses/:id" element={<ProtectedRoute><CourseDetail /></ProtectedRoute>} />
          <Route path="/timetable" element={<ProtectedRoute><Timetable /></ProtectedRoute>} />
          <Route path="/my-timetable" element={<ProtectedRoute><MyTimetable /></ProtectedRoute>} />
          <Route path="/memo" element={<ProtectedRoute><Memo /></ProtectedRoute>} />
        </Routes>
      </div>
    </AuthProvider>
  );
}
