import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuthContext } from '../contexts/AuthContext';
import Badge, { badgeOf } from '../components/Badge';
import TimetableGrid from '../components/TimetableGrid';
import { getCatalog, buildMyTimetable, saveTimetableCache, readTimetableCache } from '../lib/cache';

// 홈(화면3): 본인 뱃지 + 확정시간표 주간 그리드 + 네비.
export default function Home() {
  const { cadet, session, logout } = useAuthContext();
  const count = cadet?.post_count ?? 0;
  const tier = badgeOf(count);

  const [current, setCurrent] = useState(null);
  const [mine, setMine] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    supabase.rpc('is_admin').then(({ data }) => setIsAdmin(!!data));
  }, [session?.user?.id]);

  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const catalog = await getCatalog().catch(() => null);

      // 확정시간표: 서버(RLS 본인) 우선, 실패 시 캐시(오프라인)
      let rows;
      const { data, error } = await supabase.from('timetable').select('*');
      if (error || !data) {
        rows = await readTimetableCache();
        if (active) setOffline(true);
      } else {
        rows = data;
        saveTimetableCache(rows);
      }

      if (!active || !catalog) {
        if (active) setLoading(false);
        return;
      }
      const built = buildMyTimetable(catalog, rows);
      if (!active) return;
      setCurrent(built.current);
      setMine(built.mine);
      setPeriods(built.periods);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [session?.user?.id]);

  return (
    <div className="home">
      <header className="home-header">
        <h1>애타</h1>
        <button className="link-btn" onClick={logout}>로그아웃</button>
      </header>

      <Link to="/profile" className="home-card">
        <Badge tier={tier} level={count} size={26} />
        <div className="home-card-text">
          <p className="home-hello">
            <strong>{cadet?.username}</strong> 님, 환영합니다
          </p>
        </div>
        <span className="home-card-arrow">›</span>
      </Link>

      <section className="home-tt">
        <div className="home-tt-head">
          <h2>확정시간표{current && ` · ${current.year}-${current.term}`}</h2>
          {offline && <span className="cache-tag">오프라인</span>}
        </div>
        {loading ? (
          <p className="muted center">불러오는 중…</p>
        ) : (
          <TimetableGrid mine={mine} periods={periods} />
        )}
      </section>

      <nav className="home-nav">
        <Link to="/search" className="nav-tile">
          <span className="nav-tile-title">강의 검색</span>
          <span className="nav-tile-sub">과목·교수 검색 → 시간표 추가</span>
        </Link>
        <Link to="/boards" className="nav-tile" style={{ background: '#0f766e' }}>
          <span className="nav-tile-title">익명게시판</span>
          <span className="nav-tile-sub">게시판 검색·신설 · 글/댓글/반응 · 🔥HOT</span>
        </Link>
        {isAdmin && (
          <Link to="/admin" className="nav-tile nav-tile-admin">
            <span className="nav-tile-title">관리자</span>
            <span className="nav-tile-sub">카탈로그·가입코드·게시글 관리</span>
          </Link>
        )}
      </nav>
    </div>
  );
}
