import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { isIos } from '../components/InstallGate';
import Badge, { badgeOf } from '../components/Badge';
import NoticePopup from '../components/NoticePopup';
import FeedbackPopup from '../components/FeedbackPopup';
import PullToRefresh from '../components/PullToRefresh';
import TimetableGrid from '../components/TimetableGrid';
import TimetableSummary from '../components/TimetableSummary';
import TimetableSwitcher from '../components/TimetableSwitcher';
import { PaletteSheet } from '../components/PalettePicker';
import { getCatalog, subscribeCatalog, buildMyTimetable, currentSemester, semesterList } from '../lib/cache';
import { buildCommonBlocks, blockKey, readHidden, hideBlock, unhideAll } from '../lib/commonBlock';
import {
  listTimetables, readTimetablesCache, listEntries, readEntriesCache,
  createTimetable, renameTimetable, setPrimaryTimetable, deleteTimetable,
  readSelectedId, writeSelectedId, selectTimetable, readSelectedAt, pickTimetable, isOverlapError,
} from '../lib/timetable';
import { listCustomClasses, addCustomClass, removeCustomClass, readCustomCache, hmToMin } from '../lib/customClass';
import { detectConflicts } from '../lib/conflict';
import { buildSeed, seedDraft, readDraft, clearDraft } from '../lib/wizardDraft';
import AppReportModal from '../components/AppReportModal';

// 캔버스 렌더러(lib/timetableImage)는 버튼을 누른 사람만 쓴다 → 첫 화면 번들에서 빼고 그때 받는다.
const TimetableImageSheet = lazy(() => import('../components/TimetableImageSheet'));

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
  const { cadet, session, settings, logout } = useAuthContext();
  const navigate = useNavigate();
  const uid = session?.uid;
  const count = cadet?.postCount ?? 0;
  const tier = badgeOf(count);
  // 관리자 여부는 이미 cadet 프로필에 실려 온다(useAuth) — 별도 is_admin RPC 왕복 불필요.
  const isAdmin = !!cadet?.isAdmin;

  const [catalog, setCatalog] = useState(null);
  const [timetables, setTimetables] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [entries, setEntries] = useState([]);        // 선택한 시간표에 담긴 분반
  const [offline, setOffline] = useState(false);
  const [loading, setLoading] = useState(true);

  const [customClasses, setCustomClasses] = useState([]);
  const [adding, setAdding] = useState(false);
  const [palOpen, setPalOpen] = useState(false);   // 시간표 색상 테마 시트(⚙️)
  const [imgSheetOpen, setImgSheetOpen] = useState(false);   // 시간표 이미지 저장 시트(🖼️)
  const [appReportOpen, setAppReportOpen] = useState(false);   // 앱 문제 리포트 모달(🚩)
  // 수강신청용 요약표(어느 시간표든 목록에서 바로) — { tt, entries, customs, loading }
  const [summary, setSummary] = useState(null);
  // 게시판 활성 여부는 부팅 RPC 로 이미 와 있다 — 홈 진입마다 board_enabled() 를 따로 부르지 않는다.
  const boardOn = settings.boardEnabled;

  const selected = useMemo(
    () => timetables.find((t) => t.id === selectedId) ?? null,
    [timetables, selectedId]
  );
  const semesters = useMemo(() => (catalog ? semesterList(catalog) : []), [catalog]);

  const current = useMemo(() => (catalog ? currentSemester(catalog) : null), [catalog]);
  const curKey = current ? current.year * 10 + current.term : 0;
  // 선택한 시간표가 현재보다 지난 학기인가 → 앞으로 유도 배너
  const isStale = !!(selected && curKey && (selected.year * 10 + selected.term) < curKey);
  // 현재 학기 확정본이 이미 있나(있으면 배너는 '전환'만, 없으면 '만들기')
  const currentPrimary = useMemo(
    () => (current ? timetables.find((t) => t.year === current.year && t.term === current.term && t.isPrimary) : null),
    [timetables, current]
  );
  // 수강계획(공개된 미래) 학기 중 내 시간표가 하나도 없는 것 — 약한 넛지
  const planningSem = useMemo(() => {
    if (!catalog || !curKey) return null;
    return semesterList(catalog)
      .filter((s) => s.year * 10 + s.term > curKey)
      .find((s) => !timetables.some((t) => t.year === s.year && t.term === s.term)) ?? null;
  }, [catalog, curKey, timetables]);

  // 선택한 시간표의 학기 기준으로 격자를 조립한다(지난·다음 학기도 그대로 그려진다).
  const { mine, periods } = useMemo(() => {
    if (!catalog) return { mine: [], periods: [] };
    return buildMyTimetable(catalog, entries, selected);
  }, [catalog, entries, selected]);

  // 저장한 뒤 관리자가 분반 시간을 고치면 담아 둔 시간표가 겹치게 된다 — 격자는 겹친 칸을
  // 말없이 덮어써 경고가 없으니, 여기서 직접 찾아 배너로 알리고 겹친 칸을 강조한다.
  const conflicts = useMemo(
    () => detectConflicts({ mine, customClasses, periods }),
    [mine, customClasses, periods]
  );

  // 겹치게 된 시간표를 마법사로 넘겨 고친다 — 그 과목들로 초안을 심어 4단계(후보)로 보낸다.
  const openWizardFix = useCallback(() => {
    if (!selected) return;
    const seed = buildSeed(mine, `${selected.year}-${selected.term}`);
    if (!seed.picked.length) return;
    if (readDraft(uid) && !confirm('마법사에 짜던 초안이 있습니다.\n이 시간표의 과목으로 덮어쓰고 다시 짤까요?')) return;
    seedDraft(uid, seed);
    navigate('/wizard');
  }, [selected, mine, uid, navigate]);

  // 지난 학기에 있을 때 새 학기 시간표를 마법사로 짜러 간다.
  // 마법사는 초안이 없으면 currentSemester(날짜 인식)로 열리므로 시드 불필요 — 스테일 초안만 정리.
  const startNewSemesterWizard = useCallback(() => {
    if (readDraft(uid) && !confirm('마법사에 짜던 초안이 있습니다.\n새 학기로 새로 시작할까요?')) return;
    clearDraft();
    navigate('/wizard');
  }, [uid, navigate]);

  // 전 생도 공통 비수업 시간(생도대·군사훈련·공통연구) — 격자에 함께 깐다.
  // 생도마다 DB에 담지 않는다: 모두에게 똑같은 시간이라 저장할 이유가 없고(계정당 쓰기 0),
  // 학기가 바뀌면 카탈로그를 따라 저절로 바뀐다. 이름은 편람 격자에서 자동으로 온다.
  // 탭하면 숨길 수 있고, 숨김은 기기(localStorage)에만 남는다 — 서버 쓰기 0.
  const [hiddenBlocks, setHiddenBlocks] = useState(() => new Set());
  useEffect(() => { setHiddenBlocks(readHidden(selected)); }, [selected]);

  // 한 번만 조립하고, 숨김은 그 위에서 걸러 센다(같은 계산을 두 번 돌리지 않는다).
  const allBlocks = useMemo(
    () => (catalog && selected ? buildCommonBlocks(catalog, selected) : []),
    [catalog, selected]
  );
  const commonBlocks = useMemo(
    () => allBlocks.filter((b) => !hiddenBlocks.has(blockKey(b))),
    [allBlocks, hiddenBlocks]
  );
  const hiddenCount = allBlocks.length - commonBlocks.length;

  const handleHideBlock = useCallback((b) => {
    if (!selected) return;
    if (!confirm(`'${b.label}' 은(는) 전 생도 공통 공강 시간입니다.\n이 시간표에서 숨길까요? (이 기기에서만 숨겨집니다)`)) return;
    setHiddenBlocks(new Set(hideBlock(selected, b)));
  }, [selected]);

  const handleUnhideBlocks = useCallback(() => {
    if (!selected) return;
    setHiddenBlocks(unhideAll(selected));
  }, [selected]);

  // 시간표 목록 새로 받아 반영(생성·이름변경·확정·삭제 후 공통).
  const refreshList = useCallback(async (preferId = null) => {
    const list = await listTimetables();
    setTimetables(list);
    const cur = catalog ? currentSemester(catalog) : null;
    const pick = pickTimetable(list, cur, preferId ?? readSelectedId(), readSelectedAt());
    setSelectedId(pick?.id ?? null);
    return list;
  }, [catalog]);

  // ── 목록: 캐시 우선(즉시) → 백그라운드 갱신 ──────────────────────────
  useEffect(() => {
    if (!uid) return;
    let active = true;
    (async () => {
      const [cat, cachedList] = await Promise.all([
        // cache-first → 대개 즉시. 관리자가 강의 정보를 고쳤으면 뒤에서 다시 받고,
        // 끝나면 아래 subscribeCatalog 가 격자에 밀어 넣는다.
        getCatalog().catch(() => null),
        readTimetablesCache(),
      ]);
      if (!active) return;
      const cur = cat ? currentSemester(cat) : null;
      setCatalog(cat);

      const cachedPick = pickTimetable(cachedList, cur, readSelectedId(), readSelectedAt());
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
        setSelectedId(pickTimetable(list, cur, readSelectedId(), readSelectedAt())?.id ?? null);
      } catch {
        setOffline(true);   // 오프라인 → 캐시 스냅샷 유지
      }
    })();
    return () => { active = false; };
  }, [uid]);

  // 관리자가 강의 정보를 고치면(카탈로그 버전 변경) 재동기화가 걸리고, 그 결과가 여기로 온다.
  // 홈을 켜 둔 채로도 격자가 새 강의 정보로 다시 그려진다 — 사용자가 새로고침할 필요가 없다.
  useEffect(() => subscribeCatalog(setCatalog), []);

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

  // 당겨서 새로고침 — 카탈로그를 무조건 다시 받는다(버전 대조를 건너뛰는 수동 경로).
  // 관리자 수정은 이제 버전 대조로 알아서 반영되므로 이건 보험이고, 시간표 목록·내용까지
  // 한 번에 서버 기준으로 맞추는 것이 본래 값어치다.
  const handleRefresh = useCallback(async () => {
    try {
      const cat = await getCatalog({ force: true });
      setCatalog(cat);
      const list = await listTimetables();
      setTimetables(list);
      const pick = pickTimetable(list, currentSemester(cat), readSelectedId(), readSelectedAt());
      setSelectedId(pick?.id ?? null);
      if (pick) {
        const [fresh, customs] = await Promise.all([
          listEntries(pick.id),
          listCustomClasses(uid, pick.id),
        ]);
        setEntries(fresh);
        setCustomClasses(customs);
      }
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [uid]);

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
  const handleSelect = useCallback((id) => { selectTimetable(id); setSelectedId(id); }, []);

  const handleCreate = useCallback(async ({ year, term, name }) => {
    const made = await createTimetable({ uid, year, term, name });
    selectTimetable(made.id);
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

  // 요약표: 지금 보고 있는 시간표면 이미 손에 있는 것을 그대로 쓴다(요청 0회).
  // 다른 시간표는 캐시 스냅샷을 먼저 띄우고(즉시) 서버 값이 오면 갈아끼운다 — 화면의 다른 경로와 같다.
  // 네트워크를 기다렸다 그리면, 전파가 약할 때 손에 있는 답을 두고도 몇 초씩 빈 화면을 본다.
  const handleSummary = useCallback(async (t) => {
    if (t.id === selectedId) {
      setSummary({ tt: t, entries, customs: customClasses, loading: false });
      return;
    }
    const mine = (s) => s?.tt.id === t.id;   // 그 사이에 닫았거나 다른 시간표를 열었으면 덮어쓰지 않는다
    setSummary({ tt: t, entries: [], customs: readCustomCache(t.id), loading: true });
    // 캐시를 읽은 순간 그것이 답이다 — 여기서 로딩을 끝낸다.
    // (네트워크 실패는 몇 초씩 걸릴 수 있다. 그때까지 '불러오는 중'을 붙들면 담긴 강의가 없는
    //  시간표는 오프라인에서 영영 로딩처럼 보인다.) 서버 응답이 오면 조용히 갈아끼운다.
    const cached = await readEntriesCache(t.id);
    setSummary((s) => (mine(s) ? { ...s, entries: cached, loading: false, syncing: true } : s));
    try {
      const [fresh, customs] = await Promise.all([listEntries(t.id), listCustomClasses(uid, t.id)]);
      setSummary((s) => (mine(s) ? { tt: t, entries: fresh, customs, loading: false } : s));
    } catch {
      setSummary((s) => (mine(s) ? { ...s, syncing: false } : s));   // 오프라인 → 캐시 스냅샷 그대로
    }
  }, [selectedId, entries, customClasses, uid]);

  // '새 시간표 만들기'를 열 때만 학기 목록을 서버에서 갱신한다
  // (관리자가 방금 연 다음 학기를, 다음 버전 확인을 기다리지 않고 그 자리에서 보여 준다).
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
      await removeCustomClass(selectedId, id);
      await reloadCustom();
    } catch {
      alert('삭제에 실패했습니다. 잠시 후 다시 시도하세요.');
    }
  }, [selectedId, reloadCustom]);

  return (
    <PullToRefresh className="page home" onRefresh={handleRefresh}>
      <NoticePopup />
      <FeedbackPopup />
      <header className="page-header">
        <Link to="/profile" className="home-ident">
          <strong className="home-ident-name">{cadet?.username}</strong>
          <Badge tier={tier} level={count} size={22} />
        </Link>
        <div className="home-header-actions">
          {/* iOS 전용 공유 핸드오프 진입점 — 클립보드는 몰래 확인이 불가(읽기=시스템 팝업)라
              조건부 표시가 안 되므로, 아이콘 하나로 존재감을 최소화해 상시 배치한다. */}
          {isIos() && <button className="link-btn" onClick={openCopiedLink} title="공유받은 글 붙여넣어 열기" aria-label="공유받은 글 붙여넣어 열기">📋</button>}
          <button className="link-btn" onClick={() => setAppReportOpen(true)} title="앱 문제 리포트" aria-label="앱 문제 리포트">🚩</button>
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link" title="검열" aria-label="검열">🧹</Link>}
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
              onSummary={handleSummary}
              onOpenCreate={refreshSemesters}
            />
            <div className="home-tt-actions">
              {offline && <span className="cache-tag">오프라인</span>}
              {(mine.length > 0 || customClasses.length > 0) && (
                <button className="btn-ghost btn-sm tt-icon-btn" title="시간표를 이미지로 저장" aria-label="시간표를 이미지로 저장"
                  onClick={() => setImgSheetOpen(true)}>🖼️</button>
              )}
              <button className="btn-ghost btn-sm tt-icon-btn" title="친구 시간표 공유" aria-label="친구 시간표 공유"
                onClick={() => navigate('/friends')}>👥</button>
              <button className="btn-ghost btn-sm tt-icon-btn" title="시간표 색상 테마" aria-label="시간표 색상 테마"
                onClick={() => setPalOpen(true)}>⚙️</button>
              <button className="btn-ghost btn-sm tt-icon-btn" disabled={!selected}
                title={adding ? '직접 추가 닫기' : '직접 추가한 강의'} aria-label={adding ? '직접 추가 닫기' : '직접 추가한 강의'}
                onClick={() => setAdding((v) => !v)}>{adding ? '✕' : '＋'}</button>
            </div>
          </div>
          {adding && selected && <CustomClassForm onAdd={handleAddCustom} />}
          {isStale && (
            <div className="tt-sem-banner" role="status">
              <p className="tt-sem-banner-t">
                📅 지금은 <strong>{current.year}-{current.term}학기</strong>입니다.
                {selected.name ? ` ‘${selected.name}’은(는) ` : ' 지금 보는 건 '}지난 학기 시간표예요.
              </p>
              <div className="tt-sem-banner-actions">
                {currentPrimary ? (
                  <button className="btn-add btn-sm" onClick={() => handleSelect(currentPrimary.id)}>
                    {current.year}-{current.term} 시간표로
                  </button>
                ) : (
                  <>
                    <button className="btn-add btn-sm" onClick={startNewSemesterWizard}>🪄 마법사로 짜기</button>
                    <button className="btn-ghost btn-sm"
                      onClick={() => handleCreate({ year: current.year, term: current.term, name: '내 시간표' })}>
                      빈 시간표
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {conflicts.pairs.length > 0 && (
            <div className="tt-conflict-warn" role="alert">
              <p className="tt-conflict-t">⚠️ 시간이 겹치는 강의가 있습니다 — 저장한 뒤 수업정보가 바뀐 것 같아요.</p>
              <ul className="tt-conflict-list">
                {conflicts.pairs.map((p) => (
                  <li key={`${p.a} ${p.b}`}>‘{p.a}’ 와 ‘{p.b}’ 가 겹칩니다.</li>
                ))}
              </ul>
              <button className="btn-add btn-sm" onClick={openWizardFix}>🪄 마법사로 고치기</button>
            </div>
          )}
          <div className="home-tt-body">
            {loading ? (
              <p className="muted center">불러오는 중…</p>
            ) : (
              <TimetableGrid
                mine={mine}
                periods={periods}
                customClasses={customClasses}
                commonBlocks={commonBlocks}
                conflictCells={conflicts.cells}
                onDeleteCustom={handleDeleteCustom}
                onHideBlock={handleHideBlock}
              />
            )}
          </div>
          {/* 숨긴 공통 비수업 시간은 되돌릴 길이 있어야 한다 — 안 그러면 실수로 지우고 영영 못 찾는다 */}
          {hiddenCount > 0 && (
            <p className="tt-draft-note">
              공통 공강 시간 {hiddenCount}개를 숨겼습니다(이 기기에서만).
              {' '}
              <button type="button" className="link-btn" onClick={handleUnhideBlocks}>되돌리기</button>
            </p>
          )}
          {selected && !selected.isPrimary && (
            <p className="tt-draft-note">
              초안 시간표입니다. 강의평·수업메모는 <strong>확정</strong> 시간표에 담긴 강의만 열립니다.
            </p>
          )}
          {planningSem && !isStale && (
            <p className="tt-draft-note">
              📖 {planningSem.year}-{planningSem.term}학기 수강 계획을 미리 시작할 수 있어요.
              {' '}
              <button type="button" className="link-btn"
                onClick={() => handleCreate({ year: planningSem.year, term: planningSem.term, name: '수강 계획' })}>
                {planningSem.year}-{planningSem.term} 시간표 만들기
              </button>
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

          <Link to="/calc" className="nav-tile nav-tile-accent">
            <span className="nav-tile-ic" aria-hidden="true">🧮</span>
            <span className="nav-tile-title">학점·과락 계산</span>
            <span className="nav-tile-sub">평점·기말 필요점수 계산</span>
          </Link>

          {/* 익명게시판: 활성화되면 관리자처럼 통칸 버튼으로 등장. 비활성이면 아예 숨김. */}
          {boardOn && (
            <Link to="/boards" className="nav-tile nav-tile-accent nav-tile-wide">
              <span className="nav-tile-ic" aria-hidden="true">💬</span>
              <span className="nav-tile-title">익명게시판</span>
              <span className="nav-tile-sub">자유롭게 이야기 나누기</span>
            </Link>
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

      {summary && (
        <TimetableSummary
          catalog={catalog}
          timetable={summary.tt}
          entries={summary.entries}
          customClasses={summary.customs}
          loading={summary.loading}
          syncing={summary.syncing}
          onClose={() => setSummary(null)}
        />
      )}

      {palOpen && <PaletteSheet onClose={() => setPalOpen(false)} />}
      {imgSheetOpen && (
        <Suspense fallback={null}>
          <TimetableImageSheet
            mine={mine}
            periods={periods}
            customClasses={customClasses}
            commonBlocks={commonBlocks}
            title={selected ? `${selected.year}-${selected.term} ${selected.name}` : '시간표'}
            onClose={() => setImgSheetOpen(false)}
          />
        </Suspense>
      )}
      {appReportOpen && <AppReportModal onClose={() => setAppReportOpen(false)} />}
    </PullToRefresh>
  );
}
