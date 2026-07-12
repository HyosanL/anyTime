import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { isIos } from '../components/InstallGate';
import Badge, { badgeOf } from '../components/Badge';
import NoticePopup from '../components/NoticePopup';
import TimetableGrid from '../components/TimetableGrid';
import TimetableSwitcher from '../components/TimetableSwitcher';
import { getCatalog, buildMyTimetable, buildCommonBlocks, currentSemester, semesterList } from '../lib/cache';
import { boardEnabled } from '../lib/board';
import { saveTimetableImage } from '../lib/timetableImage';
import {
  listTimetables, readTimetablesCache, listEntries, readEntriesCache,
  createTimetable, renameTimetable, setPrimaryTimetable, deleteTimetable,
  readSelectedId, writeSelectedId, pickTimetable, isOverlapError,
} from '../lib/timetable';
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

// 홈(화면3): 본인 뱃지 + 시간표(전환 가능, 캐시 우선 즉시 표시) + 직접 추가 + 네비.
// 시간표는 학기마다 여러 개 가질 수 있고(지난 학기·다음 학기 초안), 학기별 1개가 '확정'이다.
// 강의평·메모 자격은 확정 시간표만 인정한다(서버 RPC가 강제).
export default function Home() {
  const { cadet, session, logout } = useAuthContext();
  const navigate = useNavigate();
  const uid = session?.user?.id;
  const count = cadet?.post_count ?? 0;
  const tier = badgeOf(count);
  // 관리자 여부는 이미 cadet 프로필에 실려 온다(useAuth) — 별도 is_admin RPC 왕복 불필요.
  const isAdmin = !!cadet?.is_admin;

  const [catalog, setCatalog] = useState(null);
  const [timetables, setTimetables] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [entries, setEntries] = useState([]);        // 선택한 시간표에 담긴 분반
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);

  const [customClasses, setCustomClasses] = useState([]);
  const [adding, setAdding] = useState(false);
  const [boardOn, setBoardOn] = useState(true);

  const selected = useMemo(
    () => timetables.find((t) => t.id === selectedId) ?? null,
    [timetables, selectedId]
  );
  const semesters = useMemo(() => (catalog ? semesterList(catalog) : []), [catalog]);

  // 선택한 시간표의 학기 기준으로 격자를 조립한다(지난·다음 학기도 그대로 그려진다).
  const { mine, periods } = useMemo(() => {
    if (!catalog) return { mine: [], periods: [] };
    return buildMyTimetable(catalog, entries, selected);
  }, [catalog, entries, selected]);

  // 전 생도 공통 비수업 시간(생도대·군사훈련·자율선택형교과) — 격자에 함께 깐다.
  // 생도마다 DB에 담지 않는다: 모두에게 똑같은 시간이라 저장할 이유가 없고(계정당 쓰기 0),
  // 학기가 바뀌면 카탈로그를 따라 저절로 바뀐다. 관리자가 편람 등록 때 이름을 붙인다.
  const commonBlocks = useMemo(
    () => (catalog && selected ? buildCommonBlocks(catalog, selected) : []),
    [catalog, selected]
  );

  useEffect(() => {
    boardEnabled().then((v) => setBoardOn(v !== false)).catch(() => setBoardOn(true));
  }, []);

  // 시간표 목록 새로 받아 반영(생성·이름변경·확정·삭제 후 공통).
  const refreshList = useCallback(async (preferId = null) => {
    const list = await listTimetables();
    setTimetables(list);
    const cur = catalog ? currentSemester(catalog) : null;
    const pick = pickTimetable(list, cur, preferId ?? readSelectedId());
    setSelectedId(pick?.id ?? null);
    return list;
  }, [catalog]);

  // ── 목록: 캐시 우선(즉시) → 백그라운드 갱신 ──────────────────────────
  useEffect(() => {
    if (!uid) return;
    let active = true;
    (async () => {
      const [cat, cachedList] = await Promise.all([
        getCatalog().catch(() => null),   // cache-first → 대개 즉시
        readTimetablesCache(),
      ]);
      if (!active) return;
      const cur = cat ? currentSemester(cat) : null;
      setCatalog(cat);

      const cachedPick = pickTimetable(cachedList, cur, readSelectedId());
      if (cachedPick) {
        setTimetables(cachedList);
        setSelectedId(cachedPick.id);
        setEntries(await readEntriesCache(cachedPick.id));
        setCustomClasses(readCustomCache(cachedPick.id));
      }
      if (active) setLoading(false);

      try {
        let list = await listTimetables();
        if (!active) return;
        // 시간표가 하나도 없는 계정(신규 가입) → 이번 학기 시간표를 하나 만들어 준다.
        if (list.length === 0 && cur) {
          await createTimetable({ uid, year: cur.year, term: cur.term, name: '내 시간표' });
          list = await listTimetables();
          if (!active) return;
        }
        setOffline(false);
        setTimetables(list);
        setSelectedId(pickTimetable(list, cur, readSelectedId())?.id ?? null);
      } catch {
        setOffline(true);   // 오프라인 → 캐시 스냅샷 유지
      }
    })();
    return () => { active = false; };
  }, [uid]);

  // ── 선택한 시간표의 내용(담긴 분반 + 직접추가) ───────────────────────
  useEffect(() => {
    if (!selectedId) { setEntries([]); setCustomClasses([]); return; }
    let active = true;
    writeSelectedId(selectedId);
    (async () => {
      setEntries(await readEntriesCache(selectedId));      // 즉시: 캐시
      setCustomClasses(readCustomCache(selectedId));
      try {
        const [fresh, customs] = await Promise.all([
          listEntries(selectedId),
          listCustomClasses(uid, selectedId),
        ]);
        if (!active) return;
        setOffline(false);
        setEntries(fresh);
        setCustomClasses(customs);
      } catch {
        if (active) setOffline(true);
      }
    })();
    return () => { active = false; };
  }, [selectedId, uid]);

  const reloadCustom = useCallback(async () => {
    if (!selectedId) return;
    try { setCustomClasses(await listCustomClasses(uid, selectedId)); } catch { /* ignore */ }
  }, [uid, selectedId]);

  const handleAddCustom = useCallback(async (entry) => {
    if (!selectedId) return { error: '시간표를 먼저 만들어 주세요.' };
    try {
      await addCustomClass(selectedId, entry);
      await reloadCustom();
      return { ok: true };
    } catch (e) {
      return {
        error: isOverlapError(e)
          ? '그 시간에 이미 다른 강의가 있습니다 (겹침).'
          : '추가에 실패했습니다. 잠시 후 다시 시도하세요.',
      };
    }
  }, [selectedId, reloadCustom]);

  // ── 시간표 관리(드롭다운에서 호출) ───────────────────────────────────
  const handleSelect = useCallback((id) => { writeSelectedId(id); setSelectedId(id); }, []);

  const handleCreate = useCallback(async ({ year, term, name }) => {
    const made = await createTimetable({ uid, year, term, name });
    writeSelectedId(made.id);
    await refreshList(made.id);
  }, [uid, refreshList]);

  const handleRename = useCallback(async (id, name) => {
    await renameTimetable(id, name);
    await refreshList(id);
  }, [refreshList]);

  const handleSetPrimary = useCallback(async (id) => {
    await setPrimaryTimetable(id);
    await refreshList(id);
  }, [refreshList]);

  const handleDelete = useCallback(async (id) => {
    await deleteTimetable(id);
    await refreshList(id === selectedId ? null : selectedId);
  }, [refreshList, selectedId]);

  // '새 시간표 만들기'를 열 때만 학기 목록을 서버에서 갱신한다
  // (관리자가 방금 연 다음 학기가 24시간 캐시에 막혀 안 보이는 일을 막는다).
  const refreshSemesters = useCallback(async () => {
    const cat = await getCatalog({ force: true });
    setCatalog(cat);
  }, []);

  // iOS 공유 핸드오프: 공유 화면(사파리)이 복사해 둔 글 주소를 붙여넣어 그 글로 이동.
  // iOS 는 사파리↔홈화면앱 저장소 분리 + 앱 실행 API 부재라 Android(pending-nav)처럼
  // 자동 전달이 불가능한 유일한 플랫폼 — 클립보드가 두 세계를 잇는 유일한 통로다.
  const openCopiedLink = useCallback(async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch {
      alert('클립보드를 읽지 못했어요. 공유 화면에서 [앱에서 이어보기]를 다시 눌러주세요.');
      return;
    }
    const m = String(text).match(/\/(board\/post\/\d+|s\/[0-9a-fA-F-]{36})/);
    if (!m) {
      alert('복사된 애타 글 주소가 없어요.\n공유 링크 화면에서 [앱에서 이어보기]를 먼저 눌러주세요.');
      return;
    }
    navigate(`/${m[1]}`);
  }, [navigate]);

  const handleDeleteCustom = useCallback(async (id, title) => {
    if (!confirm(`'${title}' 직접 추가한 강의를 삭제할까요?`)) return;
    try {
      await removeCustomClass(id);
      await reloadCustom();
    } catch {
      alert('삭제에 실패했습니다. 잠시 후 다시 시도하세요.');
    }
  }, [reloadCustom]);

  return (
    <div className="page home">
      <NoticePopup />
      <header className="page-header">
        <Link to="/profile" className="home-ident">
          <strong className="home-ident-name">{cadet?.username}</strong>
          <Badge tier={tier} level={count} size={22} />
        </Link>
        <div className="home-header-actions">
          {/* iOS 전용 공유 핸드오프 진입점 — 클립보드는 몰래 확인이 불가(읽기=시스템 팝업)라
              조건부 표시가 안 되므로, 아이콘 하나로 존재감을 최소화해 상시 배치한다. */}
          {isIos() && <button className="link-btn" onClick={openCopiedLink} title="공유받은 글 붙여넣어 열기" aria-label="공유받은 글 붙여넣어 열기">📋</button>}
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link">🧹 검열</Link>}
          <button className="link-btn" onClick={logout}>로그아웃</button>
        </div>
      </header>

      <div className="home-body">
        <section className="card home-tt">
          <div className="home-tt-head">
            <TimetableSwitcher
              timetables={timetables}
              selected={selected}
              semesters={semesters}
              onSelect={handleSelect}
              onCreate={handleCreate}
              onRename={handleRename}
              onSetPrimary={handleSetPrimary}
              onDelete={handleDelete}
              onOpenCreate={refreshSemesters}
            />
            <div className="home-tt-actions">
              {offline && <span className="cache-tag">오프라인</span>}
              {(mine.length > 0 || customClasses.length > 0) && (
                <button className="btn-ghost btn-sm" title="시간표를 이미지로 저장"
                  onClick={() => saveTimetableImage({
                    mine, periods, customClasses, commonBlocks,
                    title: selected ? `${selected.year}-${selected.term} ${selected.name}` : '시간표',
                  })}>🖼️ 이미지 저장</button>
              )}
              <button className="btn-ghost btn-sm" disabled={!selected} onClick={() => setAdding((v) => !v)}>{adding ? '닫기' : '＋ 직접 추가'}</button>
            </div>
          </div>
          {adding && selected && <CustomClassForm onAdd={handleAddCustom} />}
          <div className="home-tt-body">
            {loading ? (
              <p className="muted center">불러오는 중…</p>
            ) : (
              <TimetableGrid mine={mine} periods={periods} customClasses={customClasses} commonBlocks={commonBlocks} onDeleteCustom={handleDeleteCustom} />
            )}
          </div>
          {selected && !selected.is_primary && (
            <p className="tt-draft-note">
              초안 시간표입니다. 강의평·수업메모는 <strong>확정</strong> 시간표에 담긴 강의만 열립니다.
            </p>
          )}
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

          <Link to="/rooms" className="nav-tile nav-tile-rooms">
            <span className="nav-tile-ic" aria-hidden="true">🚪</span>
            <span className="nav-tile-title">빈 강의실</span>
            <span className="nav-tile-sub">요일·교시로 빈 강의실 찾기</span>
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
