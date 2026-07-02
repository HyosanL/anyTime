import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog, buildSections } from '../lib/cache';
import { getReacted, markReacted } from '../lib/reactions';
import TimetableGrid from '../components/TimetableGrid';
import CorrectionModal from '../components/CorrectionModal';
import PullToRefresh from '../components/PullToRefresh';

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

// 교수 상세: 담당 시간표(현재 학기) + 교수별 강의평(과목별 집계 + 개별 후기).
export default function ProfessorDetail() {
  const { code } = useParams();

  const [prof, setProf] = useState(null);         // {code,name,department}
  const [current, setCurrent] = useState(null);   // 현재 학기
  const [sections, setSections] = useState([]);   // 이 교수 담당 분반(현재 학기, 시간 포함)
  const [periods, setPeriods] = useState([]);
  const [courseNames, setCourseNames] = useState({}); // course_code -> name
  const [summary, setSummary] = useState([]);     // course_professor_rating rows
  const [reviews, setReviews] = useState([]);     // review rows (이 교수)
  const [loading, setLoading] = useState(true);
  const [corr, setCorr] = useState(false);

  // silent: 당겨서 새로고침 때는 화면을 '불러오는 중…'으로 갈아치우지 않는다
  async function loadAll(silent = false) {
    if (!silent) setLoading(true);
    const catalog = await getCatalog().catch(() => null);
    if (catalog) {
      const p = (catalog.professor ?? []).find((x) => x.code === code);
      setProf(p || { code, name: code, department: null });
      setCourseNames(Object.fromEntries((catalog.course ?? []).map((c) => [c.code, c.name])));
      const built = buildSections(catalog);
      setCurrent(built.current);
      setSections(built.sections.filter((s) => s.professor_code === code));
      setPeriods([...(catalog.period ?? [])].sort((a, b) => a.no - b.no));
    }

    const [sumRes, revRes] = await Promise.all([
      supabase.from('course_professor_rating').select('*').eq('professor_code', code),
      supabase
        .from('review')
        .select('*')
        .eq('professor_code', code)
        .order('created_at', { ascending: false }),
    ]);
    setSummary(sumRes.data ?? []);
    setReviews(revRes.data ?? []);
    setLoading(false);
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // 전 과목 통합 총평점(후기수 가중평균)
  const overall = useMemo(() => {
    let n = 0;
    let sum = 0;
    for (const s of summary) {
      if (s.avg_overall != null) {
        sum += Number(s.avg_overall) * (s.review_count || 0);
        n += s.review_count || 0;
      }
    }
    return n ? sum / n : null;
  }, [summary]);
  const totalReviews = useMemo(
    () => summary.reduce((a, s) => a + (s.review_count || 0), 0),
    [summary]
  );

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
    if (data === 'DELETED') {
      setReviews((prev) => prev.filter((r) => r.id !== id));
      alert('신고 누적으로 삭제되었습니다.');
    } else alert('신고되었습니다.');
  }

  const profName = prof?.name ?? code;

  return (
    <PullToRefresh className="page" onRefresh={() => loadAll(true)}>
      <header className="page-header row">
        <h2>{profName}</h2>
      </header>

      {/* 교수 개요 */}
      <section className="prof-head card">
        <div className="prof-head-main">
          <p className="prof-head-name">{profName}</p>
          <p className="prof-head-dept">{prof?.department || '학과 미정'}</p>
        </div>
        <div className="prof-head-rating">
          <Stars value={overall} />
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
          <TimetableGrid mine={sections} periods={periods} />
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
              .slice()
              .sort((a, b) => (b.review_count || 0) - (a.review_count || 0))
              .map((s) => (
                <Link
                  key={s.course_code}
                  to={`/reviews/${s.course_code}?prof=${code}`}
                  className="rev-sum-card prof-course-card"
                >
                  <div className="rev-sum-top">
                    <strong>{s.course_name ?? courseNames[s.course_code] ?? s.course_code}</strong>
                    <span className="tag tag-primary">{s.review_count}개</span>
                  </div>
                  <Stars value={s.avg_overall} />
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
                        {Math.round((s.fail_ratio ?? 0) * 100)}%
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
                <strong>{courseNames[r.course_code] ?? r.course_code}</strong>
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
                <Link className="rev-del-btn" to={`/reviews/${r.course_code}?prof=${code}`}>
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
