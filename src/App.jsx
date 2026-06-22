import { Routes, Route } from 'react-router-dom';
import Onboarding from './pages/Onboarding';
import CourseList from './pages/CourseList';
import CourseDetail from './pages/CourseDetail';
import Timetable from './pages/Timetable';
import MyTimetable from './pages/MyTimetable';
import Memo from './pages/Memo';

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route path="/courses" element={<CourseList />} />
        <Route path="/courses/:id" element={<CourseDetail />} />
        <Route path="/timetable" element={<Timetable />} />
        <Route path="/my-timetable" element={<MyTimetable />} />
        <Route path="/memo" element={<Memo />} />
      </Routes>
    </div>
  );
}
