import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuthContext } from '../contexts/AuthContext';
import { getCatalog, buildSections, formatTimes, sectionKey } from '../lib/cache';
import CorrectionModal from '../components/CorrectionModal';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';

// 분반 하나에 대한 '수정 제안' 항목들(시간/강의실/교수/과목명).
// meta: { periods:number[], professors:[{code,name,department}] } — 양식 빌더에 전달.
function sectionCorrectionOptions(s, meta) {
  const secKey = { course_code: s.course_code, year: s.year, term: s.term, section_no: s.section_no };
  return [
    { label: '요일·교시(시간)', target: 'section_time', targetKey: secKey, field: 'time', kind: 'time', periods: meta.periods, current: formatTimes(s.times) },
    { label: '강의실', target: 'section_time', targetKey: secKey, field: 'room', placeholder: '예: 302' },
    { label: '담당교수', target: 'section', targetKey: secKey, field: 'professor', kind: 'professor', professors: meta.professors, current: s.professor_name || '' },
    { label: '과목명', target: 'course', targetKey: { code: s.course_code }, field: 'name', current: s.course_name },
  ];
}

// 화면4: 강의 검색 → 시간표 추가. 카탈로그는 IndexedDB 캐시 우선(오프라인 가능).
export default function CourseSearch() {
  const { session } = useAuthContext();
  const uid = session?.user?.id;

  const [current, setCurrent] = useState(null);
  const [sections, setSections] = useState([]);
  const [registered, setRegistered] = useState(new Set()); // 시간표에 담긴 분반키
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState(null);
  const [corr, setCorr] = useState(null); // { subject, options }
  // 수정 제안 양식 빌더용: 교시 목록 + 교수 목록
  const [meta, setMeta] = useState({ periods: [], professors: [] });

  // force: 당겨서 새로고침 — 서버 우선으로 다시 받되 전체 로딩 화면은 띄우지 않는다
  async function loadCatalog(force = false) {
    if (!force) setLoading(true);
    setError('');
    try {
      const catalog = await getCatalog({ force });
      const { current, sections } = buildSections(catalog);
      setCurrent(current);
      setSections(sections);
      setMeta({
        periods: [...(catalog.period ?? [])].map((p) => p.no).sort((a, b) => a - b),
        professors: catalog.professor ?? [],
      });
    } catch (e) {
      setError('카탈로그를 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
    } finally {
      setLoading(false);
    }
  }

  async function loadTimetable() {
    if (!uid) return;
    const { data } = await supabase.from('timetable').select('*');
    if (data) setRegistered(new Set(data.map(sectionKey)));
  }

  useEffect(() => {
    loadCatalog();
    loadTimetable();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const q = query.trim().toLowerCase();
  // 내가 확정시간표에 담은 강의 — 검색 전에도 상단에 노출
  const mine = useMemo(
    () => sections.filter((s) => registered.has(s.key)),
    [sections, registered]
  );
  // 검색 결과 — 검색어가 있을 때만 노출(처음부터 전체 목록을 뿌리지 않음)
  const results = useMemo(() => {
    if (!q) return [];
    return sections.filter(
      (s) =>
        s.course_name.toLowerCase().includes(q) ||
        s.course_code.toLowerCase().includes(q) ||
        (s.professor_name ?? '').toLowerCase().includes(q)
    );
  }, [sections, q]);

  async function add(s) {
    if (!uid) return;
    setBusyKey(s.key);
    setError('');
    const { error } = await supabase.from('timetable').insert({
      cadet_id: uid,
      course_code: s.course_code,
      year: s.year,
      term: s.term,
      section_no: s.section_no,
    });
    if (error) {
      setError(error.message || '추가하지 못했습니다.');
    } else {
      setRegistered((prev) => new Set(prev).add(s.key));
    }
    setBusyKey(null);
  }

  async function remove(s) {
    if (!uid) return;
    setBusyKey(s.key);
    setError('');
    const { error } = await supabase.from('timetable').delete().match({
      cadet_id: uid,
      course_code: s.course_code,
      year: s.year,
      term: s.term,
      section_no: s.section_no,
    });
    if (error) {
      setError(error.message || '제거하지 못했습니다.');
    } else {
      setRegistered((prev) => {
        const next = new Set(prev);
        next.delete(s.key);
        return next;
      });
    }
    setBusyKey(null);
  }

  // 분반 카드 — '내 강의'와 '검색 결과' 목록에서 공통 사용
  const renderCard = (s) => {
    const on = registered.has(s.key);
    return (
      <li key={s.key} className={`section-card${on ? ' is-on' : ''}`}>
        <div className="section-info">
          <p className="section-title">
            <span className="section-name">{s.course_name}</span>
            <span className="section-code">{s.course_code}-{s.section_no}</span>
          </p>
          <p className="section-sub">
            {s.professor_name ?? '교수 미정'}
          </p>
          <p className="section-times">
            <span className="section-time-ic" aria-hidden="true">🕒</span>
            {formatTimes(s.times)}
          </p>
          <span className="section-links">
            <Link
              className="section-review-link"
              to={`/reviews/${s.course_code}${s.professor_code ? `?prof=${s.professor_code}` : ''}`}
            >
              강의평 →
            </Link>
            <Link className="section-review-link" to={`/exams/${s.course_code}`}>
              족보 →
            </Link>
            <button
              type="button"
              className="cor-flag-btn"
              onClick={() => setCorr({ subject: `${s.course_name} ${s.section_no}분반`, options: sectionCorrectionOptions(s, meta) })}
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
    <PullToRefresh className="page" onRefresh={() => Promise.all([loadCatalog(true), loadTimetable()])}>
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

      <div className="search-meta">
        {current && <span>{current.year}-{current.term}학기</span>}
      </div>

      {error && <p className="error-msg">{error}</p>}

      {loading ? (
        <p className="muted center">불러오는 중…</p>
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
