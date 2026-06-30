import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuthContext } from '../contexts/AuthContext';
import Badge, { badgeOf } from '../components/Badge';
import ThemeToggle from '../components/ThemeToggle';
import TimetableGrid from '../components/TimetableGrid';
import { getCatalog, buildMyTimetable, saveTimetableCache, readTimetableCache } from '../lib/cache';
import { boardEnabled } from '../lib/board';
import { listCustomClasses, addCustomClass, removeCustomClass, hmToMin } from '../lib/customClass';

const DAYS = [[1, '월'], [2, '화'], [3, '수'], [4, '목'], [5, '금'], [6, '토'], [7, '일']];

// DB에 없는 강의를 시간표에 직접 추가하는 폼
function CustomClassForm({ onAdd }) {
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(1);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [room, setRoom] = useState('');
  const [err, setErr] = useState('');

  function submit(e) {
    e.preventDefault();
    setErr('');
    if (!title.trim()) return setErr('강의명을 입력하세요.');
    const sm = hmToMin(start);
    const em = hmToMin(end);
    if (sm == null || em == null) return setErr('시작·끝 시각을 입력하세요.');
    if (em <= sm) return setErr('끝 시각이 시작보다 늦어야 합니다.');
    onAdd({ title: title.trim(), day: Number(day), startMin: sm, endMin: em, room: room.trim() });
    setTitle('');
    setRoom('');
  }

  return (
    <form className="tt-add-form" onSubmit={submit}>
      <input className="tt-add-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="강의명 (예: 자율학습)" />
      <div className="tt-add-row">
        <select value={day} onChange={(e) => setDay(e.target.value)}>
          {DAYS.map(([v, l]) => <option key={v} value={v}>{l}요일</option>)}
        </select>
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="tt-add-tilde">~</span>
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="강의실 (선택)" />
      {err && <p className="error-msg">{err}</p>}
      <button className="btn-add btn-block btn-sm" type="submit">시간표에 추가</button>
    </form>
  );
}

// 홈(화면3): 본인 뱃지 + 확정시간표(시간 기준) + 직접 추가 + 네비.
export default function Home() {
  const { cadet, session, logout } = useAuthContext();
  const uid = session?.user?.id;
  const count = cadet?.post_count ?? 0;
  const tier = badgeOf(count);

  const [current, setCurrent] = useState(null);
  const [mine, setMine] = useState([]);
  const [periods, setPeriods] = useState([]);
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);

  const [customClasses, setCustomClasses] = useState([]);
  const [adding, setAdding] = useState(false);
  const [boardOn, setBoardOn] = useState(true);

  useEffect(() => {
    supabase.rpc('is_admin').then(({ data }) => setIsAdmin(!!data));
  }, [session?.user?.id]);

  useEffect(() => {
    setCustomClasses(listCustomClasses(uid));
  }, [uid]);

  useEffect(() => {
    boardEnabled().then((v) => setBoardOn(v !== false)).catch(() => setBoardOn(true));
  }, []);

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

  function handleAddCustom(entry) {
    if (!uid) return;
    addCustomClass(uid, entry);
    setCustomClasses(listCustomClasses(uid));
  }
  function handleDeleteCustom(id, title) {
    if (!uid) return;
    if (!confirm(`'${title}' 직접 추가한 강의를 삭제할까요?`)) return;
    removeCustomClass(uid, id);
    setCustomClasses(listCustomClasses(uid));
  }

  return (
    <div className="page home">
      <header className="page-header">
        <span className="home-brand">애타</span>
        <div className="home-header-actions">
          <ThemeToggle />
          <button className="link-btn" onClick={logout}>로그아웃</button>
        </div>
      </header>

      <div className="home-body">
        <Link to="/profile" className="card home-profile">
          <Badge tier={tier} level={count} size={48} />
          <div className="home-profile-text">
            <p className="home-hello">
              <strong>{cadet?.username}</strong> 님, 환영합니다
            </p>
            <p className="home-tier">{tier === 'rainbow' ? '레인보우' : tier === 'gold' ? '골드' : tier === 'silver' ? '실버' : '그레이'} · Lv.{count}</p>
          </div>
          <span className="home-profile-arrow row-chevron">›</span>
        </Link>

        <section className="card home-tt">
          <div className="home-tt-head">
            <h2 className="card-title">{current ? `${current.year}-${current.term} ` : ''}시간표</h2>
            <div className="home-tt-actions">
              {offline && <span className="cache-tag">오프라인</span>}
              <button className="btn-ghost btn-sm" onClick={() => setAdding((v) => !v)}>{adding ? '닫기' : '＋ 직접 추가'}</button>
            </div>
          </div>
          {adding && <CustomClassForm onAdd={handleAddCustom} />}
          <div className="home-tt-body">
            {loading ? (
              <p className="muted center">불러오는 중…</p>
            ) : (
              <TimetableGrid mine={mine} periods={periods} customClasses={customClasses} onDeleteCustom={handleDeleteCustom} />
            )}
          </div>
        </section>

        <nav className="home-nav">
          <Link to="/search" className="nav-tile">
            <span className="nav-tile-ic" aria-hidden="true">🔍</span>
            <span className="nav-tile-title">강의 검색</span>
            <span className="nav-tile-sub">과목·교수 평가 찾기</span>
          </Link>

          {boardOn ? (
            <Link to="/boards" className="nav-tile nav-tile-accent">
              <span className="nav-tile-ic" aria-hidden="true">💬</span>
              <span className="nav-tile-title">익명게시판</span>
              <span className="nav-tile-sub">자유롭게 이야기 나누기</span>
            </Link>
          ) : (
            <div className="nav-tile nav-tile-accent is-disabled" role="link" aria-disabled="true" title="익명게시판이 비활성화되었습니다">
              <span className="nav-tile-ic" aria-hidden="true">💬</span>
              <span className="nav-tile-title">익명게시판</span>
              <span className="nav-tile-sub">현재 비활성화됨</span>
            </div>
          )}

          {isAdmin && (
            <Link to="/admin" className="nav-tile nav-tile-admin nav-tile-wide">
              <span className="nav-tile-ic" aria-hidden="true">🛠️</span>
              <span className="nav-tile-title">관리자</span>
              <span className="nav-tile-sub">카탈로그·가입코드·게시글 관리</span>
            </Link>
          )}
        </nav>
      </div>
    </div>
  );
}
