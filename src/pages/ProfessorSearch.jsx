import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog, buildSections, sectionKey } from '../lib/cache';

// 교수 검색: 교수명·학과로 찾아 교수 상세(강의평·시간표)로 이동.
// - 내 확정시간표 담당 교수를 상단에 노출(검색 전에도).
// - 검색 결과는 검색어가 있을 때만 표시.
// 카탈로그(professor/section)는 IndexedDB 캐시 우선(오프라인 가능),
// 강의평 집계(professor_rating)는 온라인일 때만 병행 로드(실패해도 검색 가능).
export default function ProfessorSearch() {
  const [professors, setProfessors] = useState([]);     // [{code,name,department}]
  const [ratings, setRatings] = useState({});           // code -> {review_count, avg_overall}
  const [myProfCodes, setMyProfCodes] = useState([]);   // 내 확정시간표 담당 교수 코드
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      let sections = [];
      try {
        const catalog = await getCatalog();
        setProfessors(catalog.professor ?? []);
        sections = buildSections(catalog).sections;
      } catch {
        setError('교수 목록을 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
      }
      // 내 확정시간표 → 담당 교수 코드(현재 학기 분반 기준)
      const { data: tt } = await supabase.from('timetable').select('*');
      if (tt && sections.length) {
        const regKeys = new Set(tt.map(sectionKey));
        const codes = new Set();
        sections.forEach((s) => { if (regKeys.has(s.key) && s.professor_code) codes.add(s.professor_code); });
        setMyProfCodes([...codes]);
      }
      // 강의평 집계(있으면 검색 결과에 별점·후기수 표시)
      const { data } = await supabase
        .from('professor_rating')
        .select('professor_code, review_count, avg_overall');
      if (data) setRatings(Object.fromEntries(data.map((r) => [r.professor_code, r])));
      setLoading(false);
    })();
  }, []);

  const q = query.trim().toLowerCase();
  const withRatings = useMemo(
    () => professors.map((p) => ({ ...p, ...(ratings[p.code] || {}) })),
    [professors, ratings]
  );
  const byCode = useMemo(
    () => Object.fromEntries(withRatings.map((p) => [p.code, p])),
    [withRatings]
  );
  // 내 담당 교수 — 검색 전에도 상단 노출
  const mine = useMemo(
    () =>
      myProfCodes
        .map((c) => byCode[c])
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name, 'ko')),
    [myProfCodes, byCode]
  );
  // 검색 결과 — 검색어가 있을 때만(처음부터 전체를 뿌리지 않음)
  const results = useMemo(() => {
    if (!q) return [];
    return withRatings
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.department ?? '').toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const rc = (b.review_count || 0) - (a.review_count || 0);
        return rc || a.name.localeCompare(b.name, 'ko');
      });
  }, [withRatings, q]);

  const renderCard = (p) => (
    <li key={p.code}>
      <Link to={`/professor/${p.code}`} className="section-card prof-card">
        <div className="section-info">
          <p className="section-title">
            <span className="section-name">{p.name}</span>
            {(p.review_count || 0) > 0 && (
              <span className="tag tag-primary">강의평 {p.review_count}</span>
            )}
          </p>
          <p className="section-sub">
            {p.department || '학과 미정'}
            {p.avg_overall != null && (
              <span className="dot">★ {Number(p.avg_overall).toFixed(1)}</span>
            )}
          </p>
        </div>
        <span className="row-chevron">›</span>
      </Link>
    </li>
  );

  return (
    <div className="page">
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>교수 검색</h2>
      </header>

      <div className="search-bar">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="교수명 · 학과 검색"
        />
      </div>

      {error && <p className="error-msg">{error}</p>}

      {loading ? (
        <p className="muted center">불러오는 중…</p>
      ) : (
        <>
          {mine.length > 0 && (
            <>
              <h3 className="section-label">내 담당 교수</h3>
              <ul className="section-list">{mine.map(renderCard)}</ul>
            </>
          )}

          {q ? (
            <>
              <h3 className="section-label">검색 결과</h3>
              {results.length === 0 ? (
                <div className="empty">
                  <span className="empty-emoji">🔍</span>
                  검색 결과가 없습니다.
                </div>
              ) : (
                <ul className="section-list">{results.map(renderCard)}</ul>
              )}
            </>
          ) : (
            mine.length === 0 && (
              <div className="empty">
                <span className="empty-emoji">🔍</span>
                교수명·학과로 검색해 보세요.
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}
