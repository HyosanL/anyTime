import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuthContext } from '../contexts/AuthContext';
import Badge, { badgeOf } from '../components/Badge';
import TimetableGrid from '../components/TimetableGrid';
import { getCatalog, buildMyTimetable, saveTimetableCache, readTimetableCache } from '../lib/cache';
import { boardEnabled } from '../lib/board';
import { listCustomClasses, addCustomClass, removeCustomClass, readCustomCache, hmToMin } from '../lib/customClass';

const DAYS = [[1, '월'], [2, '화'], [3, '수'], [4, '목'], [5, '금'], [6, '토'], [7, '일']];

// DB에 없는 강의를 시간표에 직접 추가하는 폼
function CustomClassForm({ onAdd }) {
  const [title, setTitle] = useState('');
  const [day, setDay] = useState(1);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('10:00');
  const [room, setRoom] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!title.trim()) return setErr('강의명을 입력하세요.');
    const sm = hmToMin(start);
    const em = hmToMin(end);
    if (sm == null || em == null) return setErr('시작·끝 시각을 입력하세요.');
    if (em <= sm) return setErr('끝 시각이 시작보다 늦어야 합니다.');
    setBusy(true);
    const res = await onAdd({ title: title.trim(), day: Number(day), startMin: sm, endMin: em, room: room.trim() });
    setBusy(false);
    if (res && res.error) return setErr(res.error);
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
      <button className="btn-add btn-block btn-sm" type="submit" disabled={busy}>{busy ? '추가 중…' : '시간표에 추가'}</button>
    </form>
  );
}

// 홈(화면3): 본인 뱃지 + 확정시간표(시각 기준, 캐시 우선 즉시 표시) + 직접 추가 + 네비.
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
    boardEnabled().then((v) => setBoardOn(v !== false)).catch(() => setBoardOn(true));
  }, []);

  // 캐시 우선(즉시) → 백그라운드 갱신(stale-while-revalidate). 네트워크가 화면을 막지 않는다.
  useEffect(() => {
    let active = true;
    (async () => {
      // ── 즉시: 기기 캐시로 그리기 ──
      const [catalog, cachedRows] = await Promise.all([
        getCatalog().catch(() => null),   // cache-first → 대개 즉시
        readTimetableCache(),             // IndexedDB
      ]);
      if (!active) return;
      let cur = null;
      if (catalog) {
        const built = buildMyTimetable(catalog, cachedRows || []);
        cur = built.current;
        setCurrent(built.current);
        setMine(built.mine);
        setPeriods(built.periods);
        if (uid && cur) setCustomClasses(readCustomCache(uid, cur.year, cur.term));
      }
      setLoading(false);

      // ── 백그라운드: 서버 최신 시간표 ──
      const { data, error } = await supabase.from('timetable').select('*');
      if (!active) return;
      if (error || !data) {
        setOffline(true);
      } else {
        setOffline(false);
        saveTimetableCache(data);
        const cat2 = catalog || (await getCatalog().catch(() => null));
        if (cat2 && active) {
          const built2 = buildMyTimetable(cat2, data);
          setCurrent(built2.current);
          setMine(built2.mine);
          setPeriods(built2.periods);
          cur = built2.current;
        }
      }

      // ── 백그라운드: 직접추가(DB) ──
      if (uid && cur && active) {
        try {
          const fresh = await listCustomClasses(uid, cur.year, cur.term);
          if (active) setCustomClasses(fresh);
        } catch { /* 오프라인 → 캐시 유지 */ }
      }
    })();
    return () => { active = false; };
  }, [uid]);

  async function reloadCustom() {
    if (!uid || !current) return;
    try { setCustomClasses(await listCustomClasses(uid, current.year, current.term)); } catch { /* ignore */ }
  }

  async function handleAddCustom(entry) {
    if (!uid) return { error: '로그인이 필요합니다.' };
    if (!current) return { error: '현재 학기가 설정되지 않아 추가할 수 없습니다.' };
    try {
      await addCustomClass(uid, { ...entry, year: current.year, term: current.term });
      await reloadCustom();
      return { ok: true };
    } catch (e) {
      const s = `${e?.message || ''} ${e?.code || ''}`;
      return {
        error: /overlap|23P01|exclusion/i.test(s)
          ? '그 시간에 이미 다른 강의가 있습니다 (겹침).'
          : '추가에 실패했습니다. 잠시 후 다시 시도하세요.',
      };
    }
  }

  async function handleDeleteCustom(id, title) {
    if (!uid) return;
    if (!confirm(`'${title}' 직접 추가한 강의를 삭제할까요?`)) return;
    try {
      await removeCustomClass(uid, id);
      await reloadCustom();
    } catch {
      alert('삭제에 실패했습니다. 잠시 후 다시 시도하세요.');
    }
  }

  return (
    <div className="page home">
      <header className="page-header">
        <Link to="/profile" className="home-ident">
          <strong className="home-ident-name">{cadet?.username}</strong>
          <Badge tier={tier} level={count} size={22} />
        </Link>
        <div className="home-header-actions">
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link">🧹 검열</Link>}
          <button className="link-btn" onClick={logout}>로그아웃</button>
        </div>
      </header>

      <div className="home-body">
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
            <span className="nav-tile-sub">과목·강의평 찾기</span>
          </Link>

          <Link to="/professors" className="nav-tile nav-tile-prof">
            <span className="nav-tile-ic" aria-hidden="true">🎓</span>
            <span className="nav-tile-title">교수 검색</span>
            <span className="nav-tile-sub">교수별 강의평·시간표</span>
          </Link>

          {boardOn ? (
            <Link to="/boards" className="nav-tile nav-tile-accent nav-tile-wide">
              <span className="nav-tile-ic" aria-hidden="true">💬</span>
              <span className="nav-tile-title">익명게시판</span>
              <span className="nav-tile-sub">자유롭게 이야기 나누기</span>
            </Link>
          ) : (
            <div className="nav-tile nav-tile-accent nav-tile-wide is-disabled" role="link" aria-disabled="true" title="익명게시판이 비활성화되었습니다">
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
