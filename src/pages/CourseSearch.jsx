import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthContext } from '../contexts/AuthContext';
import { getCatalog, subscribeCatalog, buildSections, formatTimes } from '../lib/cache';
import {
  listTimetables, listEntries, addSection, removeSection,
  readSelectedId, writeSelectedId, pickTimetable, isOverlapError,
} from '../lib/timetable';
import CorrectionModal from '../components/CorrectionModal';
import { correctionMeta, sectionCorrectionOptions, sectionSubject } from '../lib/correction';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';
import '../styles/course.css';

// 화면4: 강의 검색 → 시간표 추가. 카탈로그는 IndexedDB 캐시 우선(오프라인 가능).
// 어느 시간표에 담는지는 홈에서 고른 시간표를 따르고, 여기서도 바꿀 수 있다.
// 검색 대상 학기 = 그 시간표의 학기(지난 학기 기록·다음 학기 초안도 짤 수 있어야 하므로).
export default function CourseSearch() {
  const { session } = useAuthContext();
  const uid = session?.uid;

  const [catalog, setCatalog] = useState(null);
  const [timetables, setTimetables] = useState([]);
  const [targetId, setTargetId] = useState(readSelectedId());
  const [registered, setRegistered] = useState(new Set()); // 이 시간표에 담긴 분반 id
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState(null);
  const [corr, setCorr] = useState(null); // { subject, options }
  // 수정 제안 양식 빌더용: 교시 목록 + 교수 목록
  const [meta, setMeta] = useState({ periods: [], professors: [] });

  const target = useMemo(
    () => timetables.find((t) => t.id === targetId) ?? null,
    [timetables, targetId]
  );

  // 대상 시간표의 학기 분반만 조립한다.
  const sections = useMemo(
    () => (catalog && target ? buildSections(catalog, target).sections : []),
    [catalog, target]
  );

  // force: 당겨서 새로고침 — 서버 우선으로 다시 받되 전체 로딩 화면은 띄우지 않는다
  async function loadCatalog(force = false) {
    if (!force) setLoading(true);
    setError('');
    try {
      const cat = await getCatalog({ force });
      setCatalog(cat);
      setMeta(correctionMeta(cat));
    } catch {
      setError('카탈로그를 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
    } finally {
      setLoading(false);
    }
  }

  async function loadTimetables() {
    if (!uid) return;
    try {
      const list = await listTimetables();
      setTimetables(list);
      // 홈에서 고른 시간표가 사라졌으면 확정으로 되돌린다.
      const pick = pickTimetable(list, null, readSelectedId());
      setTargetId(pick?.id ?? null);
    } catch { /* 오프라인 → 빈 목록 */ }
  }

  useEffect(() => {
    loadCatalog();
    loadTimetables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // 관리자가 강의 정보를 고치면(카탈로그 버전 변경) 재동기화가 걸리고, 그 결과가 여기로 온다 —
  // 이 화면을 켜 둔 채로도 검색 결과가 새 강의 정보로 바뀐다.
  useEffect(() => subscribeCatalog((cat) => { setCatalog(cat); setMeta(correctionMeta(cat)); }), []);

  // 대상 시간표가 바뀌면 담긴 분반을 다시 읽는다.
  useEffect(() => {
    if (!targetId) { setRegistered(new Set()); return; }
    let active = true;
    listEntries(targetId)
      .then((rows) => { if (active) setRegistered(new Set(rows.map((r) => r.sectionId))); })
      .catch(() => { /* 오프라인 */ });
    return () => { active = false; };
  }, [targetId]);

  const q = query.trim().toLowerCase();
  // 이 시간표에 담은 강의 — 검색 전에도 상단에 노출
  const mine = useMemo(
    () => sections.filter((s) => registered.has(s.id)),
    [sections, registered]
  );
  // 검색 결과 — 검색어가 있을 때만 노출(처음부터 전체 목록을 뿌리지 않음)
  const results = useMemo(() => {
    if (!q) return [];
    return sections.filter(
      (s) =>
        s.courseName.toLowerCase().includes(q) ||
        s.courseCode.toLowerCase().includes(q) ||
        (s.professorName ?? '').toLowerCase().includes(q)
    );
  }, [sections, q]);

  function changeTarget(id) {
    writeSelectedId(id);      // 홈과 선택을 공유한다
    setTargetId(id);
  }

  async function add(s) {
    if (!targetId) return;
    setBusyKey(s.key);
    setError('');
    try {
      await addSection(targetId, s);
      setRegistered((prev) => new Set(prev).add(s.id));
    } catch (e) {
      setError(isOverlapError(e)
        ? '그 시간에 이미 다른 강의가 있습니다 (겹침).'
        : (e?.message || '추가하지 못했습니다.'));
    }
    setBusyKey(null);
  }

  async function remove(s) {
    if (!targetId) return;
    setBusyKey(s.key);
    setError('');
    try {
      await removeSection(targetId, s);
      setRegistered((prev) => {
        const next = new Set(prev);
        next.delete(s.id);
        return next;
      });
    } catch (e) {
      setError(e?.message || '제거하지 못했습니다.');
    }
    setBusyKey(null);
  }

  // 분반 카드 — '내 강의'와 '검색 결과' 목록에서 공통 사용
  const renderCard = (s) => {
    const on = registered.has(s.id);
    return (
      <li key={s.key} className={`section-card${on ? ' is-on' : ''}`}>
        <div className="section-info">
          <p className="section-title">
            <span className="section-name">{s.courseName}</span>
            <span className="section-code">{s.courseCode}-{s.sectionNo}</span>
          </p>
          <p className="section-sub">
            {s.professorName ?? '교수 미정'}
          </p>
          <p className="section-times">
            <span className="section-time-ic" aria-hidden="true">🕒</span>
            {formatTimes(s.times)}
          </p>
          <span className="section-links">
            <Link
              className="section-review-link"
              to={`/reviews/${s.courseCode}${s.professorCode ? `?prof=${s.professorCode}` : ''}`}
            >
              강의평 →
            </Link>
            <Link className="section-review-link" to={`/exams/${s.courseCode}`}>
              족보 →
            </Link>
            <button
              type="button"
              className="cor-flag-btn"
              onClick={() => setCorr({ subject: sectionSubject(s), options: sectionCorrectionOptions(s, meta) })}
            >
              🚩 수정 제안
            </button>
          </span>
        </div>
        <button
          className={`section-toggle ${on ? 'btn-remove' : 'btn-add'} btn-sm`}
          onClick={() => (on ? remove(s) : add(s))}
          disabled={busyKey === s.key}
        >
          {busyKey === s.key ? '…' : on ? '제거' : '＋ 추가'}
        </button>
      </li>
    );
  };

  return (
    <PullToRefresh className="page" onRefresh={() => Promise.all([loadCatalog(true), loadTimetables()])}>
      <header className="page-header row">
        <BackButton />
        <h2>강의 검색</h2>
      </header>

      <div className="search-bar">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="과목명 · 과목코드 · 교수명 검색"
        />
      </div>

      {/* 어느 시간표에 담을지 — 홈에서 고른 시간표가 기본값 */}
      <div className="search-meta search-target">
        <span className="search-target-label">담을 시간표</span>
        <select
          value={targetId ?? ''}
          onChange={(e) => changeTarget(e.target.value)}
          disabled={timetables.length === 0}
        >
          {timetables.length === 0 && <option value="">시간표 없음</option>}
          {timetables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.year}-{t.term} {t.name}{t.isPrimary ? ' ★확정' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* 카탈로그는 학교 공지를 옮겨 담은 것이라 실제와 다를 수 있다 — 고치는 길을 함께 알려 준다 */}
      <p className="cor-notice">
        ⚠️ 강의 정보(시간·강의실·교수)가 실제와 다를 수 있습니다.
        틀린 곳이 보이면 강의 카드의 <b>🚩 수정 제안</b>으로 알려 주세요.
      </p>

      {error && <p className="error-msg">{error}</p>}

      {loading ? (
        <p className="muted center">불러오는 중…</p>
      ) : !target ? (
        <div className="empty">
          <span className="empty-emoji">🗓️</span>
          시간표가 없습니다. 홈에서 시간표를 먼저 만들어 주세요.
        </div>
      ) : sections.length === 0 ? (
        <div className="empty">
          <span className="empty-emoji">📭</span>
          {target.year}-{target.term}학기 강의 정보가 아직 등록되지 않았습니다.
          <span className="muted">홈의 ‘＋ 직접 추가’로 직접 넣을 수 있어요.</span>
        </div>
      ) : q ? (
        <>
          {/* 검색 중: 검색 결과가 맨 위 */}
          <h3 className="section-label">검색 결과</h3>
          {results.length === 0 ? (
            <div className="empty">
              <span className="empty-emoji">🔍</span>
              검색 결과가 없습니다.
            </div>
          ) : (
            <ul className="section-list">{results.map(renderCard)}</ul>
          )}
          {mine.length > 0 && (
            <>
              <h3 className="section-label">내 강의</h3>
              <ul className="section-list">{mine.map(renderCard)}</ul>
            </>
          )}
        </>
      ) : (
        <>
          {/* 검색 전: 내 강의가 맨 위 */}
          {mine.length > 0 ? (
            <>
              <h3 className="section-label">내 강의</h3>
              <ul className="section-list">{mine.map(renderCard)}</ul>
            </>
          ) : (
            <div className="empty">
              <span className="empty-emoji">🔍</span>
              과목명·과목코드·교수명으로 검색해 강의를 추가하세요.
            </div>
          )}
        </>
      )}

      {corr && (
        <CorrectionModal subject={corr.subject} options={corr.options} onClose={() => setCorr(null)} />
      )}
    </PullToRefresh>
  );
}
