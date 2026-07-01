import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog } from '../lib/cache';

// 교수 검색: 교수명·학과로 찾아 교수 상세(강의평·시간표)로 이동.
// 카탈로그(professor/section)는 IndexedDB 캐시 우선(오프라인 가능),
// 강의평 집계(professor_rating)는 온라인일 때만 병행 로드(실패해도 검색 가능).
export default function ProfessorSearch() {
  const [professors, setProfessors] = useState([]);     // [{code,name,department}]
  const [ratings, setRatings] = useState({});           // code -> {review_count, avg_overall}
  const [query, setQuery] = useState('');
  const [fromCache, setFromCache] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const catalog = await getCatalog();
        setProfessors(catalog.professor ?? []);
        setFromCache(!!catalog.fromCache);
      } catch {
        setError('교수 목록을 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
      }
      // 강의평 집계(있으면 검색 결과에 별점·후기수 표시)
      const { data } = await supabase
        .from('professor_rating')
        .select('professor_code, review_count, avg_overall');
      if (data) setRatings(Object.fromEntries(data.map((r) => [r.professor_code, r])));
      setLoading(false);
    })();
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = professors.map((p) => ({ ...p, ...(ratings[p.code] || {}) }));
    if (!q) {
      // 기본 화면: 강의평이 있는 교수를 후기 많은 순으로 추천
      return list
        .filter((p) => (p.review_count || 0) > 0)
        .sort((a, b) => (b.review_count || 0) - (a.review_count || 0));
    }
    return list
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.department ?? '').toLowerCase().includes(q)
      )
      .sort((a, b) => {
        const rc = (b.review_count || 0) - (a.review_count || 0);
        return rc || a.name.localeCompare(b.name, 'ko');
      });
  }, [professors, ratings, query]);

  return (
    <div className="page">
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>교수 검색</h2>
      </header>

      <div className="search-bar">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="교수명 · 학과 검색"
        />
      </div>

      <div className="search-meta">
        {!query && <span>강의평이 있는 교수</span>}
        {fromCache && <span className="cache-tag">캐시{navigator.onLine ? '' : ' · 오프라인'}</span>}
      </div>

      {error && <p className="error-msg">{error}</p>}

      {loading ? (
        <p className="muted center">불러오는 중…</p>
      ) : results.length === 0 ? (
        <div className="empty">
          <span className="empty-emoji">🔍</span>
          {query
            ? '검색 결과가 없습니다.'
            : '아직 강의평이 있는 교수가 없습니다. 교수명으로 검색해 보세요.'}
        </div>
      ) : (
        <ul className="section-list">
          {results.map((p) => (
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
          ))}
        </ul>
      )}
    </div>
  );
}
