import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { collection, getDocs, query, where, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuthContext } from '../contexts/AuthContext';
import { getCatalog } from '../lib/cache';
import { callFn } from '../lib/functions';
import { getReacted, markReacted } from '../lib/reactions';
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

// 한 과목의 강의평을 무한정 받지 않는다(인기 과목은 계속 쌓인다) — 최신 N개.
const REVIEW_LIMIT = 200;

// 화면5: 강의평 (조회는 누구나 / 작성은 자격자만)
export default function Reviews() {
  const { courseCode } = useParams();
  const [sp] = useSearchParams();
  const profFilter = sp.get('prof') || '';
  const { cadet } = useAuthContext();
  const isAdmin = !!cadet?.isAdmin;

  const [courseName, setCourseName] = useState(courseCode);
  const [professors, setProfessors] = useState([]); // [{code,name}]
  const [reviews, setReviews] = useState([]);
  const [summary, setSummary] = useState([]); // courseProfessorRatings 집계 문서(이 과목의 교수별)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const profNameByCode = useMemo(
    () => Object.fromEntries(professors.map((p) => [p.code, p.name])),
    [professors]
  );

  // silent: 당겨서 새로고침 때는 목록을 '불러오는 중…'으로 갈아치우지 않는다
  async function loadAll(silent = false) {
    if (!silent) setLoading(true);
    setError('');
    // 과목명·교수 목록은 카탈로그 캐시에서
    const catalog = await getCatalog().catch(() => null);
    if (catalog) {
      const course = (catalog.courses ?? []).find((c) => c.code === courseCode);
      if (course) setCourseName(course.name);
      const profByCode = Object.fromEntries((catalog.professors ?? []).map((p) => [p.code, p.name]));
      const codes = [
        ...new Set(
          (catalog.sections ?? [])
            .filter((s) => s.courseCode === courseCode && s.professorCode)
            .map((s) => s.professorCode)
        ),
      ];
      setProfessors(codes.map((code) => ({ code, name: profByCode[code] ?? code })));
    }

    // 강의평 목록과 교수별 집계(courseProfessorRatings — review 쓰기 트리거가 갱신)를 병렬로.
    // 예전엔 강의평 행을 받아 클라이언트에서 GROUP BY 했지만, 이제 그 집계가 서버 문서로
    // 이미 마련돼 있어(design doc §3) 왕복 1회로 둘 다 direct read 로 끝난다.
    const [reviewsSnap, ratingsSnap] = await Promise.all([
      getDocs(query(
        collection(db, 'reviews'),
        where('courseCode', '==', courseCode),
        orderBy('createdAt', 'desc'),
        limit(REVIEW_LIMIT)
      )),
      getDocs(query(collection(db, 'courseProfessorRatings'), where('courseCode', '==', courseCode))),
    ]);
    setReviews(reviewsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
    setSummary(ratingsSnap.docs.map((d) => d.data()).sort((a, b) => b.reviewCount - a.reviewCount));
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseCode]);

  // profFilter/데이터가 바뀔 때만 필터(삭제 비번 입력 등 무관한 키 입력마다 재필터하지 않도록).
  const shownReviews = useMemo(
    () => (profFilter ? reviews.filter((r) => r.professorCode === profFilter) : reviews),
    [reviews, profFilter]
  );
  const shownSummary = useMemo(
    () => (profFilter ? summary.filter((s) => s.professorCode === profFilter) : summary),
    [summary, profFilter]
  );

  async function like(id) {
    const r = await callFn('likeReview', { id });
    // likeReview 는 새 카운트를 돌려주지 않는다(Firestore increment 는 서버측 원자 연산이라
    // 응답에 결과 값을 싣지 않음) — 낙관적으로 +1 만 반영한다.
    if (r.ok && r.status !== 'NOT_FOUND') {
      setReviews((prev) => prev.map((r2) => (r2.id === id ? { ...r2, likeCount: (r2.likeCount || 0) + 1 } : r2)));
    }
  }

  const [, reactTick] = useState(0); // 신고 기록 후 버튼 상태 갱신용

  async function report(id) {
    if (getReacted('review', id).report) return;
    if (!confirm('이 강의평을 신고할까요?')) return;
    markReacted('review', id, 'report'); reactTick((n) => n + 1); // 요청 전에 먼저 기록해 연타 차단
    const r = await callFn('reportReview', { id });
    const status = r.ok ? r.status : 'ERROR';
    if (status === 'DELETED') { setReviews((prev) => prev.filter((rv) => rv.id !== id)); alert('신고 누적으로 삭제되었습니다.'); }
    else if (status === 'ALREADY') alert('이미 신고한 강의평입니다.');
    else if (status === 'ERROR') alert('신고에 실패했습니다.');
    else alert('신고되었습니다.');
  }

  const [delTarget, setDelTarget] = useState(null);
  const [delPw, setDelPw] = useState('');
  const [delErr, setDelErr] = useState('');

  // 비번 없는(누구나 삭제 가능) 강의평: 확인 후 바로 삭제
  async function deleteOpen(id) {
    if (!confirm('이 강의평을 삭제할까요?')) return;
    const r = await callFn('deleteReview', { id, postPassword: '' });
    if (!r.ok || !r.data?.deleted) { alert('삭제에 실패했습니다.'); return; }
    setReviews((prev) => prev.filter((rv) => rv.id !== id));
  }

  async function confirmDelete() {
    setDelErr('');
    const r = await callFn('deleteReview', { id: delTarget, postPassword: delPw });
    if (!r.ok) {
      setDelErr(r.message || '삭제 실패');
      return;
    }
    if (!r.data?.deleted) {
      setDelErr('이미 삭제되었거나 없는 글입니다.');
      return;
    }
    setReviews((prev) => prev.filter((rv) => rv.id !== delTarget));
    setDelTarget(null);
    setDelPw('');
  }

  return (
    <PullToRefresh className="page" onRefresh={() => loadAll(true)}>
      <header className="page-header">
        <BackButton fallback="/search" />
        <h2>{courseName} 강의평</h2>
      </header>

      {/* 집계 (평점·과락률) */}
      <section className="rev-summary">
        {loading ? (
          <p className="muted center">불러오는 중…</p>
        ) : shownSummary.length === 0 ? (
          <div className="empty">
            <span className="empty-emoji">⭐</span>
            아직 집계된 평점이 없습니다.
          </div>
        ) : (
          shownSummary.map((s) => (
            <div key={s.professorCode ?? 'none'} className="rev-sum-card">
              <div className="rev-sum-top">
                <strong>{profNameByCode[s.professorCode] ?? '교수 미정'}</strong>
                <span className="tag tag-primary">{s.reviewCount}개</span>
              </div>
              <Stars value={s.avgOverall} />
              <div className="rev-metrics">
                {METRICS.map(([k, label]) => (
                  <span key={k} className="rev-metric">
                    <span className="rev-metric-label">{label}</span>
                    <span className="rev-metric-value">{s[k] != null ? Number(s[k]).toFixed(1) : '-'}</span>
                  </span>
                ))}
                <span className="rev-metric rev-fail">
                  <span className="rev-metric-label">과락률</span>
                  <span className="rev-metric-value">{Math.round((s.failRatio ?? 0) * 100)}%</span>
                </span>
              </div>
            </div>
          ))
        )}
      </section>

      <p className="account-note rev-hint">
        강의평 작성은 <b>확정시간표에서 해당 수업을 눌러</b> 들어가서 할 수 있습니다(일정 기간 수강 후).
      </p>

      {error && <p className="error-msg">{error}</p>}

      {/* 리뷰 목록 */}
      <ul className="rev-list">
        {!loading && shownReviews.length === 0 && (
          <li className="empty">
            <span className="empty-emoji">✍️</span>
            첫 강의평을 남겨보세요.
          </li>
        )}
        {shownReviews.map((r) => (
          <li key={r.id} className="rev-card">
            <div className="rev-card-top">
              <strong>{profNameByCode[r.professorCode] ?? '교수 미정'}</strong>
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
              {r.hasPassword && !isAdmin ? (
                delTarget === r.id ? (
                  <span className="rev-del">
                    <input
                      type="password"
                      value={delPw}
                      onChange={(e) => setDelPw(e.target.value)}
                      placeholder="게시글 비번"
                    />
                    <button className="btn-add btn-sm" onClick={confirmDelete}>확인</button>
                    <button className="btn-remove btn-sm" onClick={() => { setDelTarget(null); setDelPw(''); setDelErr(''); }}>취소</button>
                  </span>
                ) : (
                  <button className="rev-del-btn" onClick={() => { setDelTarget(r.id); setDelErr(''); }}>삭제</button>
                )
              ) : (
                <button className="rev-del-btn" onClick={() => deleteOpen(r.id)}>삭제</button>
              )}
            </div>
            {delTarget === r.id && delErr && <p className="error-msg">{delErr}</p>}
          </li>
        ))}
      </ul>
    </PullToRefresh>
  );
}
