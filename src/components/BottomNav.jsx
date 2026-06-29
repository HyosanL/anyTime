import { NavLink, useLocation } from 'react-router-dom';

// 주요 화면에서만 보이는 하단 탭바. 세부 화면(글/강의평/관리자 등)에선 숨김.
const TABS = [
  { to: '/', label: '홈', icon: IconHome, match: (p) => p === '/' },
  { to: '/search', label: '강의', icon: IconBook, match: (p) => p.startsWith('/search') || p.startsWith('/reviews') || p.startsWith('/exams') || p.startsWith('/memo') },
  { to: '/boards', label: '게시판', icon: IconBoard, match: (p) => p.startsWith('/boards') || p.startsWith('/board') },
  { to: '/profile', label: '프로필', icon: IconUser, match: (p) => p.startsWith('/profile') },
];

const TOP_LEVEL = ['/', '/search', '/boards', '/profile'];

export function showTabbar(pathname) {
  return TOP_LEVEL.includes(pathname);
}

export default function BottomNav() {
  const { pathname } = useLocation();
  if (!showTabbar(pathname)) return null;
  return (
    <nav className="tabbar" aria-label="주요 메뉴">
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = t.match(pathname);
        return (
          <NavLink key={t.to} to={t.to} className={`tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
            <span className="tab-ic"><Icon filled={active} /></span>
            <span>{t.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function IconHome() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /><path d="M9.5 21v-6h5v6" />
    </svg>
  );
}
function IconBook() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z" /><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
    </svg>
  );
}
function IconBoard() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 21l1.9-4.1A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
    </svg>
  );
}
function IconUser() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}
