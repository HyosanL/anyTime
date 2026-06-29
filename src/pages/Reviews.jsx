import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog } from '../lib/cache';
import ReviewForm from '../components/ReviewForm';

function Stars({ value }) {
  if (value == null) return <span className="muted">-</span>;
  const v = Number(value);
  return (
    <span className="stars" title={v.toFixed(2)}>
      <span className="stars-on" style={{ width: `${(v / 5) * 100}%` }}>★★★★★</span>
      <span className="stars-off">★★★★★</span>
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
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');

  const profNameByCode = useMemo(
    () => Object.fromEntries(professors.map((p) => [p.code, p.name])),
    [professors]
  );

  async function loadAll() {
    setLoading(true);
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

  const [delTarget, setDelTarget] = useState(null);
  const [delPw, setDelPw] = useState('');
  const [delErr, setDelErr] = useState('');

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
    <div className="page">
      <header className="page-header row">
        <Link to="/search" className="link-btn">← 검색</Link>
        <h2>{courseName} 강의평</h2>
        <span style={{ width: '2.5rem' }} />
      </header>

      {/* 집계 (평점·과락률) */}
      <section className="rev-summary">
        {loading ? (
          <p className="muted center">불러오는 중…</p>
        ) : shownSummary.length === 0 ? (
          <p className="muted center">아직 집계된 평점이 없습니다.</p>
        ) : (
          shownSummary.map((s) => (
            <div key={s.professor_code ?? 'none'} className="rev-sum-card">
              <div className="rev-sum-top">
                <strong>{s.professor_name ?? profNameByCode[s.professor_code] ?? '교수 미정'}</strong>
                <span className="rev-count">{s.review_count}개</span>
              </div>
              <Stars value={s.avg_overall} />
              <div className="rev-metrics">
                {METRICS.map(([k, label]) => (
                  <span key={k}>{label} {s[k] != null ? Number(s[k]).toFixed(1) : '-'}</span>
                ))}
                <span className="rev-fail">과락률 {Math.round((s.fail_ratio ?? 0) * 100)}%</span>
              </div>
            </div>
          ))
        )}
      </section>

      <div className="rev-actions">
        <button className="btn-add" onClick={() => setShowForm((v) => !v)}>
          {showForm ? '닫기' : '강의평 쓰기'}
        </button>
      </div>

      {showForm && (
        <ReviewForm
          courseCode={courseCode}
          professors={professors}
          defaultProf={profFilter}
          onDone={() => {
            setShowForm(false);
            loadAll();
          }}
        />
      )}

      {error && <p className="error-msg">{error}</p>}

      {/* 리뷰 목록 */}
      <ul className="rev-list">
        {!loading && shownReviews.length === 0 && (
          <p className="muted center">첫 강의평을 남겨보세요.</p>
        )}
        {shownReviews.map((r) => (
          <li key={r.id} className="rev-card">
            <div className="rev-card-top">
              <strong>{r.professor_name ?? profNameByCode[r.professor_code] ?? '교수 미정'}</strong>
              <Stars value={r.overall} />
            </div>
            <div className="rev-tags">
              {r.fail && <span className="tag tag-warn">과락</span>}
              {r.teamplay && <span className="tag">팀플</span>}
              {r.presentation && <span className="tag">발표</span>}
            </div>
            {r.prof_comment && <p className="rev-comment">👤 {r.prof_comment}</p>}
            {r.course_comment && <p className="rev-comment">📘 {r.course_comment}</p>}
            <div className="rev-card-bottom">
              <button className="rev-like" onClick={() => like(r.id)}>♥ {r.like_count}</button>
              {delTarget === r.id ? (
                <span className="rev-del">
                  <input
                    type="password"
                    value={delPw}
                    onChange={(e) => setDelPw(e.target.value)}
                    placeholder="게시글 비번"
                  />
                  <button onClick={confirmDelete}>확인</button>
                  <button onClick={() => { setDelTarget(null); setDelPw(''); setDelErr(''); }}>취소</button>
                </span>
              ) : (
                <button className="rev-del-btn" onClick={() => { setDelTarget(r.id); setDelErr(''); }}>삭제</button>
              )}
            </div>
            {delTarget === r.id && delErr && <p className="error-msg">{delErr}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
