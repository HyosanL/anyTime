import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { getCatalog, buildSections } from '../lib/cache';
import { callFn } from '../lib/functions';
import { getReacted, markReacted } from '../lib/reactions';
import TimetableGrid from '../components/TimetableGrid';
import CorrectionModal from '../components/CorrectionModal';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';
import '../styles/course.css';

function Stars({ value }) {
  if (value == null) return <span className="muted">-</span>;
  const v = Number(value);
  return (
    <span className="stars" title={v.toFixed(2)}>
      <span className="stars-track">
        <span className="stars-off">★★★★★</span>
        <span className="stars-on" style={{ width: `${(v / 5) * 100}%` }}>★★★★★</span>
      </span>
      <em>{v.toFixed(1)}</em>
    </span>
  );
}

const METRICS = [
  ['avgWorkload', '과제량'],
  ['avgProgress', '진도'],
  ['avgDifficulty', '난이도'],
  ['avgClassTime', '수업시간'],
];

// 한 교수의 강의평을 무한정 받지 않는다(인기 교수는 계속 쌓인다) — 최신 N개.
const REVIEW_LIMIT = 200;

// 교수 상세: 담당 시간표(현재 학기) + 교수별 강의평(과목별 집계 + 개별 후기).
export default function ProfessorDetail() {
  const { code } = useParams();

  const [prof, setProf] = useState(null);         // {code,name,department}
  const [current, setCurrent] = useState(null);   // 현재 학기
  const [sections, setSections] = useState([]);   // 이 교수 담당 분반(현재 학기, 시간 포함)
  const [periods, setPeriods] = useState([]);
  const [courseNames, setCourseNames] = useState({}); // courseCode -> name
  const [reviews, setReviews] = useState([]);     // review 문서 (이 교수)
  const [summary, setSummary] = useState([]);     // courseProfessorRatings(이 교수, 과목별)
  const [overall, setOverall] = useState({ avgOverall: null, reviewCount: 0 }); // professorRatings 집계 문서
  const [loading, setLoading] = useState(true);
  const [corr, setCorr] = useState(false);

  // silent: 당겨서 새로고침 때는 화면을 '불러오는 중…'으로 갈아치우지 않는다
  async function loadAll(silent = false) {
    if (!silent) setLoading(true);
    const catalog = await getCatalog().catch(() => null);
    if (catalog) {
      const p = (catalog.professors ?? []).find((x) => x.code === code);
      setProf(p || { code, name: code, department: null });
      setCourseNames(Object.fromEntries((catalog.courses ?? []).map((c) => [c.code, c.name])));
      const built = buildSections(catalog);
      setCurrent(built.current);
      setSections(built.sections.filter((s) => s.professorCode === code));
      setPeriods([...(catalog.periods ?? [])].sort((a, b) => a.no - b.no));
    }

    // 개별 강의평, 과목별 집계(courseProfessorRatings), 전 과목 통합 집계(professorRatings)를
    // 병렬로 direct read — 예전처럼 강의평 행을 받아 클라이언트에서 GROUP BY 하지 않는다
    // (review 쓰기 트리거가 두 집계 문서를 이미 갱신해 두고 있다, design doc §3).
    const [reviewsSnap, ratingsSnap, overallSnap] = await Promise.all([
      getDocs(query(
        collection(db, 'reviews'),
        where('professorCode', '==', code),
        orderBy('createdAt', 'desc'),
        limit(REVIEW_LIMIT)
      )),
      getDocs(query(collection(db, 'courseProfessorRatings'), where('professorCode', '==', code))),
      getDoc(doc(db, 'professorRatings', code)),
    ]);
    setReviews(reviewsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
    setSummary(ratingsSnap.docs.map((d) => d.data()).sort((a, b) => b.reviewCount - a.reviewCount));
    setOverall(overallSnap.exists() ? overallSnap.data() : { avgOverall: null, reviewCount: 0 });
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function like(id) {
    const r = await callFn('likeReview', { id });
    // likeReview 는 새 카운트를 돌려주지 않는다(increment 는 서버측 원자 연산) — 낙관적 +1.
    if (r.ok && r.status !== 'NOT_FOUND') {
      setReviews((prev) => prev.map((rv) => (rv.id === id ? { ...rv, likeCount: (rv.likeCount || 0) + 1 } : rv)));
    }
  }

  const [, reactTick] = useState(0); // 신고 기록 후 버튼 상태 갱신용

  async function report(id) {
    if (getReacted('review', id).report) return;
    if (!confirm('이 강의평을 신고할까요?')) return;
    markReacted('review', id, 'report'); reactTick((n) => n + 1); // 요청 전에 먼저 기록해 연타 차단
    const r = await callFn('reportReview', { id });
    const status = r.ok ? r.status : 'ERROR';
    if (status === 'DELETED') {
      setReviews((prev) => prev.filter((rv) => rv.id !== id));
      alert('신고 누적으로 삭제되었습니다.');
    } else if (status === 'ALREADY') alert('이미 신고한 강의평입니다.');
    else if (status === 'ERROR') alert('신고에 실패했습니다.');
    else alert('신고되었습니다.');
  }

  const profName = prof?.name ?? code;
  const totalReviews = overall.reviewCount ?? 0;

  return (
    <PullToRefresh className="page" onRefresh={() => loadAll(true)}>
      <header className="page-header row">
        <BackButton fallback="/professors" />
        <h2>{profName}</h2>
      </header>

      {/* 교수 개요 */}
      <section className="prof-head card">
        <div className="prof-head-main">
          <p className="prof-head-name">{profName}</p>
          <p className="prof-head-dept">{prof?.department || '학과 미정'}</p>
          {prof?.office && <p className="prof-head-office">📍 {prof.office}</p>}
        </div>
        <div className="prof-head-rating">
          <Stars value={overall.avgOverall} />
          <span className="prof-head-count">강의평 {totalReviews}개</span>
          <button type="button" className="cor-flag-btn" onClick={() => setCorr(true)}>🚩 정보 수정 제안</button>
        </div>
      </section>

      {corr && (
        <CorrectionModal
          subject={`교수 ${profName}`}
          options={[
            { label: '교수명', target: 'professor', targetKey: { code }, field: 'name', current: profName },
            { label: '학과', target: 'professor', targetKey: { code }, field: 'department', current: prof?.department || '', placeholder: '예: 항공우주공학과' },
            { label: '연구실 위치', target: 'professor', targetKey: { code }, field: 'office', current: prof?.office || '', placeholder: '예: 단재관 334호' },
          ]}
          onClose={() => setCorr(false)}
        />
      )}

      {/* 담당 시간표 (현재 학기) */}
      <section className="prof-tt">
        <h3 className="prof-sec-title">
          {current ? `${current.year}-${current.term} ` : ''}담당 시간표
        </h3>
        {loading ? (
          <p className="muted center">불러오는 중…</p>
        ) : sections.length === 0 ? (
          <p className="muted center">이번 학기에 개설된 수업이 없습니다.</p>
        ) : (
          <TimetableGrid mine={sections} periods={periods} showProfessor={false} />
        )}
      </section>

      {/* 과목별 강의평 집계 */}
      <section className="prof-reviews">
        <h3 className="prof-sec-title">교수별 강의평</h3>

        {loading ? (
          <p className="muted center">불러오는 중…</p>
        ) : summary.length === 0 ? (
          <div className="empty">
            <span className="empty-emoji">⭐</span>
            아직 이 교수님의 강의평이 없습니다.
          </div>
        ) : (
          <div className="rev-summary">
            {summary
              .map((s) => (
                <Link
                  key={s.courseCode}
                  to={`/reviews/${s.courseCode}?prof=${code}`}
                  className="rev-sum-card prof-course-card"
                >
                  <div className="rev-sum-top">
                    <strong>{courseNames[s.courseCode] ?? s.courseCode}</strong>
                    <span className="tag tag-primary">{s.reviewCount}개</span>
                  </div>
                  <Stars value={s.avgOverall} />
                  <div className="rev-metrics">
                    {METRICS.map(([k, label]) => (
                      <span key={k} className="rev-metric">
                        <span className="rev-metric-label">{label}</span>
                        <span className="rev-metric-value">
                          {s[k] != null ? Number(s[k]).toFixed(1) : '-'}
                        </span>
                      </span>
                    ))}
                    <span className="rev-metric rev-fail">
                      <span className="rev-metric-label">과락률</span>
                      <span className="rev-metric-value">
                        {Math.round((s.failRatio ?? 0) * 100)}%
                      </span>
                    </span>
                  </div>
                  <span className="prof-course-more">이 과목 강의평 →</span>
                </Link>
              ))}
          </div>
        )}
      </section>

      {/* 개별 강의평 (전 과목 통합) */}
      {!loading && reviews.length > 0 && (
        <ul className="rev-list">
          {reviews.map((r) => (
            <li key={r.id} className="rev-card">
              <div className="rev-card-top">
                <strong>{courseNames[r.courseCode] ?? r.courseCode}</strong>
                <Stars value={r.overall} />
              </div>
              {(r.fail || r.teamplay || r.presentation) && (
                <div className="rev-tags">
                  {r.fail && <span className="tag tag-warn">과락</span>}
                  {r.teamplay && <span className="tag">팀플</span>}
                  {r.presentation && <span className="tag">발표</span>}
                </div>
              )}
              {r.profComment && <p className="rev-comment">👤 {r.profComment}</p>}
              {r.courseComment && <p className="rev-comment">📘 {r.courseComment}</p>}
              <div className="rev-card-bottom">
                <span className="rev-actions-left">
                  <button className="rev-like" onClick={() => like(r.id)}>♥ {r.likeCount}</button>
                  {getReacted('review', r.id).report
                    ? <span className="rev-reported">🚨 신고됨</span>
                    : <button className="rev-del-btn rev-report" onClick={() => report(r.id)}>🚨 신고</button>}
                </span>
                <Link className="rev-del-btn" to={`/reviews/${r.courseCode}?prof=${code}`}>
                  자세히 →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PullToRefresh>
  );
}
