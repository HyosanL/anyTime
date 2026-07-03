import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog } from '../lib/cache';
import { getReacted, markReacted } from '../lib/reactions';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';

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
  ['avg_workload', '과제량'],
  ['avg_progress', '진도'],
  ['avg_difficulty', '난이도'],
  ['avg_class_time', '수업시간'],
];

// 화면5: 강의평 (조회는 누구나 / 작성은 자격자만)
export default function Reviews() {
  const { courseCode } = useParams();
  const [sp] = useSearchParams();
  const profFilter = sp.get('prof') || '';

  const [courseName, setCourseName] = useState(courseCode);
  const [professors, setProfessors] = useState([]); // [{code,name}]
  const [summary, setSummary] = useState([]);
  const [reviews, setReviews] = useState([]);
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
      const course = (catalog.course ?? []).find((c) => c.code === courseCode);
      if (course) setCourseName(course.name);
      const profByCode = Object.fromEntries((catalog.professor ?? []).map((p) => [p.code, p.name]));
      const codes = [
        ...new Set(
          (catalog.section ?? [])
            .filter((s) => s.course_code === courseCode && s.professor_code)
            .map((s) => s.professor_code)
        ),
      ];
      setProfessors(codes.map((code) => ({ code, name: profByCode[code] ?? code })));
    }

    // 집계뷰 + 리뷰 목록
    const [sumRes, revRes] = await Promise.all([
      supabase.from('course_professor_rating').select('*').eq('course_code', courseCode),
      supabase.from('review').select('*').eq('course_code', courseCode).order('created_at', { ascending: false }),
    ]);
    setSummary(sumRes.data ?? []);
    setReviews(revRes.data ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseCode]);

  const shownSummary = profFilter ? summary.filter((s) => s.professor_code === profFilter) : summary;
  const shownReviews = profFilter ? reviews.filter((r) => r.professor_code === profFilter) : reviews;

  async function like(id) {
    const { data } = await supabase.rpc('like_review', { p_id: id });
    if (data != null) {
      setReviews((prev) => prev.map((r) => (r.id === id ? { ...r, like_count: data } : r)));
    }
  }

  const [, reactTick] = useState(0); // 신고 기록 후 버튼 상태 갱신용

  async function report(id) {
    if (getReacted('review', id).report) return;
    if (!confirm('이 강의평을 신고할까요?')) return;
    markReacted('review', id, 'report'); reactTick((n) => n + 1); // 요청 전에 먼저 기록해 연타 차단
    const { data } = await supabase.rpc('report_review', { p_id: id });
    if (data === 'DELETED') { setReviews((prev) => prev.filter((r) => r.id !== id)); alert('신고 누적으로 삭제되었습니다.'); }
    else alert('신고되었습니다.');
  }

  const [delTarget, setDelTarget] = useState(null);
  const [delPw, setDelPw] = useState('');
  const [delErr, setDelErr] = useState('');

  // 비번 없는(누구나 삭제 가능) 강의평: 확인 후 바로 삭제
  async function deleteOpen(id) {
    if (!confirm('이 강의평을 삭제할까요?')) return;
    const { data, error } = await supabase.rpc('delete_review', { p_id: id, p_post_password: '' });
    if (error || data === false) { alert('삭제에 실패했습니다.'); return; }
    setReviews((prev) => prev.filter((r) => r.id !== id));
  }

  async function confirmDelete() {
    setDelErr('');
    const { data, error } = await supabase.rpc('delete_review', {
      p_id: delTarget,
      p_post_password: delPw,
    });
    if (error) {
      setDelErr(error.message || '삭제 실패');
      return;
    }
    if (data === false) {
      setDelErr('이미 삭제되었거나 없는 글입니다.');
      return;
    }
    setReviews((prev) => prev.filter((r) => r.id !== delTarget));
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
            <div key={s.professor_code ?? 'none'} className="rev-sum-card">
              <div className="rev-sum-top">
                <strong>{s.professor_name ?? profNameByCode[s.professor_code] ?? '교수 미정'}</strong>
                <span className="tag tag-primary">{s.review_count}개</span>
              </div>
              <Stars value={s.avg_overall} />
              <div className="rev-metrics">
                {METRICS.map(([k, label]) => (
                  <span key={k} className="rev-metric">
                    <span className="rev-metric-label">{label}</span>
                    <span className="rev-metric-value">{s[k] != null ? Number(s[k]).toFixed(1) : '-'}</span>
                  </span>
                ))}
                <span className="rev-metric rev-fail">
                  <span className="rev-metric-label">과락률</span>
                  <span className="rev-metric-value">{Math.round((s.fail_ratio ?? 0) * 100)}%</span>
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
              <strong>{r.professor_name ?? profNameByCode[r.professor_code] ?? '교수 미정'}</strong>
              <Stars value={r.overall} />
            </div>
            {(r.fail || r.teamplay || r.presentation) && (
              <div className="rev-tags">
                {r.fail && <span className="tag tag-warn">과락</span>}
                {r.teamplay && <span className="tag">팀플</span>}
                {r.presentation && <span className="tag">발표</span>}
              </div>
            )}
            {r.prof_comment && <p className="rev-comment">👤 {r.prof_comment}</p>}
            {r.course_comment && <p className="rev-comment">📘 {r.course_comment}</p>}
            <div className="rev-card-bottom">
              <span className="rev-actions-left">
                <button className="rev-like" onClick={() => like(r.id)}>♥ {r.like_count}</button>
                {getReacted('review', r.id).report
                  ? <span className="rev-reported">🚨 신고됨</span>
                  : <button className="rev-del-btn rev-report" onClick={() => report(r.id)}>🚨 신고</button>}
              </span>
              {r.post_password_hash ? (
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
