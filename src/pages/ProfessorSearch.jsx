import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { getCatalog, buildSections, kvGet, kvSet } from '../lib/cache';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';
import '../styles/course.css';

// 확정시간표들(모든 학기)에 담긴 분반 id — '내가 듣는 강의' 표시용.
// lib/timetable.js 는 아직 Supabase 그대로라(이관 범위 밖) 여기서 직접 Firestore 로 읽는다:
// users/{uid}/timetables 중 isPrimary 인 것들의 entries 서브컬렉션을 모아 sectionId 를 모은다.
async function myPrimarySectionIds() {
  const uid = auth.currentUser?.uid;
  if (!uid) return new Set();
  const ttSnap = await getDocs(query(collection(db, 'users', uid, 'timetables'), where('isPrimary', '==', true)));
  const entrySnaps = await Promise.all(
    ttSnap.docs.map((t) => getDocs(collection(db, 'users', uid, 'timetables', t.id, 'entries')))
  );
  const ids = new Set();
  entrySnaps.forEach((snap) => snap.docs.forEach((e) => {
    const sectionId = e.data().sectionId;
    if (sectionId) ids.add(sectionId);
  }));
  return ids;
}

// 교수 검색: 교수명·학과로 찾아 교수 상세(강의평·시간표)로 이동.
// - 내 확정시간표 담당 교수를 상단에 노출(검색 전에도).
// - 검색 결과는 검색어가 있을 때만 표시.
// 카탈로그(professors/sections)는 IndexedDB 캐시 우선(오프라인 가능),
// 강의평 집계(professorRatings)는 온라인일 때만 병행 로드(실패해도 검색 가능).
export default function ProfessorSearch() {
  const [professors, setProfessors] = useState([]);     // [{code,name,department}]
  const [ratings, setRatings] = useState({});           // code -> {reviewCount, avgOverall}
  const [myProfCodes, setMyProfCodes] = useState([]);   // 내 확정시간표 담당 교수 코드
  const [query_, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 교수 평점 집계(professorRatings)는 review 쓰기 트리거가 갱신하는 문서라 그 자체는 가볍지만,
  // 검색 화면을 열 때마다 컬렉션 전체를 다시 받을 필요는 없다. 별점은 '검색 결과에 곁들이는 정보'라
  // 조금 낡아도 무방하므로 SWR: 캐시가 있으면 즉시 쓰고, 하루가 지났을 때만 뒤에서 다시 받는다.
  const RATINGS_KEY = 'prof:ratings';
  const RATINGS_TTL = 24 * 60 * 60 * 1000;

  async function loadRatings(force = false) {
    const cached = await kvGet(RATINGS_KEY);
    const fresh = cached && Date.now() - cached.at < RATINGS_TTL;
    if (cached) setRatings(cached.byCode);
    if (fresh && !force) return;
    let byCode;
    try {
      const snap = await getDocs(collection(db, 'professorRatings'));
      byCode = Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
    } catch {
      return; // 오프라인 → 캐시 유지
    }
    setRatings(byCode);
    kvSet(RATINGS_KEY, { at: Date.now(), byCode });
  }

  // silent: 당겨서 새로고침 때는 화면을 '불러오는 중…'으로 갈아치우지 않는다
  async function load(force = false) {
    if (!force) setLoading(true);
    setError('');
    let sections = [];
    try {
      const catalog = await getCatalog();
      setProfessors(catalog.professors ?? []);
      sections = buildSections(catalog).sections;
    } catch {
      setError('교수 목록을 불러오지 못했습니다. (오프라인이고 캐시도 없음)');
    }
    // 내 확정시간표(담당 교수 코드용)와 강의평 집계는 서로 독립 → 병렬.
    // 초안 시간표는 세지 않는다(확정에 담은 강의 = 내가 듣는 강의).
    const [regIds] = await Promise.all([
      myPrimarySectionIds().catch(() => new Set()),
      loadRatings(force),   // 당겨서 새로고침이면 캐시를 무시하고 다시 받는다
    ]);
    if (regIds.size && sections.length) {
      const codes = new Set();
      sections.forEach((s) => { if (regIds.has(s.id) && s.professorCode) codes.add(s.professorCode); });
      setMyProfCodes([...codes]);
    }
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = query_.trim().toLowerCase();
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
        const rc = (b.reviewCount || 0) - (a.reviewCount || 0);
        return rc || a.name.localeCompare(b.name, 'ko');
      });
  }, [withRatings, q]);

  const renderCard = (p) => (
    <li key={p.code}>
      <Link to={`/professor/${p.code}`} className="section-card prof-card">
        <div className="section-info">
          <p className="section-title">
            <span className="section-name">{p.name}</span>
            {(p.reviewCount || 0) > 0 && (
              <span className="tag tag-primary">강의평 {p.reviewCount}</span>
            )}
          </p>
          <p className="section-sub">
            {p.department || '학과 미정'}
            {p.avgOverall != null && (
              <span className="dot">★ {Number(p.avgOverall).toFixed(1)}</span>
            )}
          </p>
          {p.office && <p className="section-sub prof-office-sub">📍 {p.office}</p>}
        </div>
        <span className="row-chevron">›</span>
      </Link>
    </li>
  );

  return (
    <PullToRefresh className="page" onRefresh={() => load(true)}>
      <header className="page-header row">
        <BackButton />
        <h2>교수 검색</h2>
      </header>

      <div className="search-bar">
        <input
          type="search"
          value={query_}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="교수명 · 학과 검색"
        />
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
              <h3 className="section-label">내 담당 교수</h3>
              <ul className="section-list">{mine.map(renderCard)}</ul>
            </>
          )}
        </>
      ) : (
        <>
          {/* 검색 전: 내 담당 교수가 맨 위 */}
          {mine.length > 0 ? (
            <>
              <h3 className="section-label">내 담당 교수</h3>
              <ul className="section-list">{mine.map(renderCard)}</ul>
            </>
          ) : (
            <div className="empty">
              <span className="empty-emoji">🔍</span>
              교수명·학과로 검색해 보세요.
            </div>
          )}
        </>
      )}
    </PullToRefresh>
  );
}
