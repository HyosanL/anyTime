import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuthContext } from '../contexts/AuthContext';
import { getCatalog, buildSections, formatTimes, sectionKey } from '../lib/cache';

// 화면4: 강의 검색 → 시간표 추가. 카탈로그는 IndexedDB 캐시 우선(오프라인 가능).
export default function CourseSearch() {
  const { session } = useAuthContext();
  const uid = session?.user?.id;

  const [current, setCurrent] = useState(null);
  const [sections, setSections] = useState([]);
  const [registered, setRegistered] = useState(new Set()); // 시간표에 담긴 분반키
  const [query, setQuery] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState(null);

  async function loadCatalog(force = false) {
    force ? setRefreshing(true) : setLoading(true);
    setError('');
    try {
      const catalog = await getCatalog({ force });
      const { current, sections } = buildSections(catalog);
      setCurrent(current);
      setSections(sections);
      setFromCache(!!catalog.fromCache);
    } catch (e) {
      setError('카탈로그를 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
    } finally {
      setLoading(false);
      setRefreshing(false);
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter(
      (s) =>
        s.course_name.toLowerCase().includes(q) ||
        s.course_code.toLowerCase().includes(q) ||
        (s.professor_name ?? '').toLowerCase().includes(q)
    );
  }, [sections, query]);

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

  return (
    <div className="page">
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>강의 검색</h2>
        <button className="link-btn" onClick={() => loadCatalog(true)} disabled={refreshing}>
          {refreshing ? '갱신 중…' : '새로고침'}
        </button>
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
        {fromCache && <span className="cache-tag">캐시{navigator.onLine ? '' : ' · 오프라인'}</span>}
      </div>

      {error && <p className="error-msg">{error}</p>}

      {loading ? (
        <p className="muted center">불러오는 중…</p>
      ) : filtered.length === 0 ? (
        <p className="muted center">결과가 없습니다.</p>
      ) : (
        <ul className="section-list">
          {filtered.map((s) => {
            const on = registered.has(s.key);
            return (
              <li key={s.key} className="section-card">
                <div className="section-info">
                  <p className="section-title">
                    {s.course_name} <span className="section-code">{s.course_code}-{s.section_no}</span>
                  </p>
                  <p className="section-sub">
                    {s.professor_name ?? '교수 미정'}
                    {s.credits != null && ` · ${s.credits}학점`}
                  </p>
                  <p className="section-times">{formatTimes(s.times)}</p>
                </div>
                <button
                  className={on ? 'btn-remove' : 'btn-add'}
                  onClick={() => (on ? remove(s) : add(s))}
                  disabled={busyKey === s.key}
                >
                  {busyKey === s.key ? '…' : on ? '제거' : '추가'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
