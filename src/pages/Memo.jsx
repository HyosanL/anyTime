import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { useAuthContext } from '../contexts/AuthContext';
import { getCatalog, formatTimes } from '../lib/cache';
import { maskText, prefetchMask } from '../lib/mask';
import { getReacted, markReacted } from '../lib/reactions';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';
import '../styles/course.css';

// 화면6: 수업 메모. 확정시간표 등록 생도만 작성/열람(RPC 강제).
export default function Memo() {
  const { courseCode, year, term, sectionNo } = useParams();
  const { cadet, settings } = useAuthContext();
  const isAdmin = !!cadet?.is_admin;
  const y = Number(year);
  const t = Number(term);
  const sn = Number(sectionNo);

  const [header, setHeader] = useState({ name: courseCode, prof: '', profCode: '', times: '' });
  // 자격 기준일(minDays)은 부팅 RPC 로 이미 와 있다 — 메모 화면마다 get_review_min_days() 를 부르지 않는다.
  // 보유일수(daysHeld)만 서버가 이 분반에 대해 판정해 준다.
  const minDays = settings.reviewMinDays;
  const [daysHeld, setDaysHeld] = useState(null);
  const [memos, setMemos] = useState([]);
  const [allowed, setAllowed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [delTarget, setDelTarget] = useState(null);
  const [delPw, setDelPw] = useState('');
  const [delErr, setDelErr] = useState('');

  async function loadHeader() {
    const catalog = await getCatalog().catch(() => null);
    if (!catalog) return;
    const course = catalog.course?.find((c) => c.code === courseCode);
    const section = catalog.section?.find(
      (s) => s.course_code === courseCode && s.year === y && s.term === t && s.section_no === sn
    );
    const prof = catalog.professor?.find((p) => p.code === section?.professor_code);
    const times = (catalog.section_time ?? []).filter(
      (x) => x.course_code === courseCode && x.year === y && x.term === t && x.section_no === sn
    );
    setHeader({
      name: course?.name ?? courseCode,
      prof: prof?.name ?? '',
      profCode: section?.professor_code ?? '',
      times: formatTimes(times),
    });
  }

  // 보유일수는 서버가 판정한다 — 확정(is_primary) 시간표에 담긴 것만 인정(초안은 제외).
  async function loadReviewEligibility() {
    const { data: held } = await supabase.rpc('timetable_held_days', {
      p_course_code: courseCode, p_year: y, p_term: t, p_section_no: sn,
    });
    setDaysHeld(held ?? null);
  }

  // silent: 당겨서 새로고침 때는 목록을 '불러오는 중…'으로 갈아치우지 않는다
  async function loadMemos(silent = false) {
    if (!silent) setLoading(true);
    setError('');
    const { data, error } = await supabase.rpc('get_memos', {
      p_course_code: courseCode,
      p_year: y,
      p_term: t,
      p_section_no: sn,
    });
    if (error) {
      // RPC 가 미등록 생도를 막음
      setAllowed(false);
      setMemos([]);
    } else {
      setAllowed(true);
      setMemos(data ?? []);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadHeader();
    loadMemos();
    loadReviewEligibility();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseCode, year, term, sectionNo]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!content.trim()) return setError('내용을 입력하세요.');
    setSubmitting(true);
    const { error } = await supabase.rpc('create_memo', {
      p_post_password: password,
      p_course_code: courseCode,
      p_year: y,
      p_term: t,
      p_section_no: sn,
      p_content: await maskText(content.trim()),
    });
    setSubmitting(false);
    if (error) {
      setError(error.message || '작성에 실패했습니다.');
      return;
    }
    setContent('');
    setPassword('');
    loadMemos();
  }

  const [, reactTick] = useState(0); // 신고 기록 후 버튼 상태 갱신용

  async function report(id) {
    if (getReacted('memo', id).report) return;
    if (!confirm('이 메모를 신고할까요?')) return;
    markReacted('memo', id, 'report'); reactTick((n) => n + 1); // 요청 전에 먼저 기록해 연타 차단
    const { data } = await supabase.rpc('report_memo', { p_id: id });
    if (data === 'DELETED') { setMemos((prev) => prev.filter((m) => m.id !== id)); alert('신고 누적으로 삭제되었습니다.'); }
    else if (data === 'ALREADY') alert('이미 신고한 메모입니다.');
    else alert('신고되었습니다.');
  }

  // 비번 없는(누구나 삭제 가능) 메모: 확인 후 바로 삭제
  async function deleteOpen(id) {
    if (!confirm('이 메모를 삭제할까요?')) return;
    const { data, error } = await supabase.rpc('delete_memo', { p_id: id, p_post_password: '' });
    if (error || data === false) { alert('삭제에 실패했습니다.'); return; }
    setMemos((prev) => prev.filter((m) => m.id !== id));
  }

  async function confirmDelete() {
    setDelErr('');
    const { data, error } = await supabase.rpc('delete_memo', {
      p_id: delTarget,
      p_post_password: delPw,
    });
    if (error) return setDelErr(error.message || '삭제 실패');
    if (data === false) return setDelErr('이미 삭제되었거나 없는 글입니다.');
    setMemos((prev) => prev.filter((m) => m.id !== delTarget));
    setDelTarget(null);
    setDelPw('');
  }

  return (
    <PullToRefresh className="page" onRefresh={() => loadMemos(true)}>
      <header className="page-header">
        <BackButton />
        <h2>{header.name} 메모</h2>
      </header>

      <div className="memo-head">
        <p className="memo-sub">
          {[header.prof, header.times, `${sn}분반`].filter(Boolean).join(' · ')}
        </p>
      </div>

      {/* 강의평 쓰기 — 확정시간표 minDays일 이상 보유 시 활성화(눌러서 새 화면으로) */}
      <section className="memo-review">
        {(() => {
          const eligible = daysHeld != null && daysHeld >= minDays;
          if (eligible) {
            return (
              <Link to={`/review-write/${courseCode}/${y}/${t}/${sn}`} className="btn-add btn-block">
                ✍️ 강의평 쓰기
              </Link>
            );
          }
          return (
            <button
              className="btn-add btn-block"
              disabled
              title={`확정시간표에 ${minDays}일 이상 보유 후 작성 가능`}
            >
              ✍️ 강의평 쓰기{daysHeld == null ? ' (미등록)' : ` (앞으로 ${minDays - daysHeld}일)`}
            </button>
          );
        })()}
        <Link to={`/exams/${courseCode}`} className="btn-ghost btn-block">📄 족보 보기</Link>
      </section>

      {loading ? (
        <p className="muted center">불러오는 중…</p>
      ) : !allowed ? (
        <div className="empty">
          <span className="empty-emoji">🔒</span>
          이 분반을 확정시간표에 등록한 생도만 메모를 볼 수 있습니다.
          <Link to="/search" className="section-review-link">강의 검색에서 추가하기 →</Link>
        </div>
      ) : (
        <>
          <form className="memo-form card" onSubmit={submit}>
            {/* 메모창에 손을 대면 그때 비속어 사전을 미리 받는다 — 읽기만 하는 사람은 받지 않는다. */}
            <textarea
              value={content}
              onFocus={prefetchMask}
              onChange={(e) => setContent(e.target.value)}
              rows={2}
              placeholder="이번 수업 공지·과제·시험범위 등을 공유하세요"
            />
            <div className="memo-form-row">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="삭제용 비번 (선택)"
              />
              <button type="submit" className="btn-add" disabled={submitting}>
                {submitting ? '등록 중…' : '메모 등록'}
              </button>
            </div>
            <p className="account-note">비번을 비우면 누구나 삭제할 수 있어요.</p>
            {error && <p className="error-msg">{error}</p>}
          </form>

          <ul className="memo-list">
            {memos.length === 0 && (
              <li className="empty">
                <span className="empty-emoji">📝</span>
                아직 메모가 없습니다.
              </li>
            )}
            {memos.map((m) => (
              <li key={m.id} className="memo-card">
                <p className="memo-content">{m.content}</p>
                <div className="memo-card-bottom">
                  <span className="memo-date">{new Date(m.created_at).toLocaleString('ko-KR')}</span>
                  <span className="memo-actions">
                    {getReacted('memo', m.id).report
                      ? <span className="rev-reported">🚨 신고됨</span>
                      : <button className="rev-del-btn rev-report" onClick={() => report(m.id)}>🚨 신고</button>}
                    {m.has_password && !isAdmin ? (
                      delTarget === m.id ? (
                        <span className="rev-del">
                          <input
                            type="password"
                            value={delPw}
                            onChange={(e) => setDelPw(e.target.value)}
                            placeholder="비번"
                          />
                          <button className="btn-add btn-sm" onClick={confirmDelete}>확인</button>
                          <button className="btn-remove btn-sm" onClick={() => { setDelTarget(null); setDelPw(''); setDelErr(''); }}>취소</button>
                        </span>
                      ) : (
                        <button className="rev-del-btn" onClick={() => { setDelTarget(m.id); setDelErr(''); }}>삭제</button>
                      )
                    ) : (
                      <button className="rev-del-btn" onClick={() => deleteOpen(m.id)}>삭제</button>
                    )}
                  </span>
                </div>
                {delTarget === m.id && delErr && <p className="error-msg">{delErr}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </PullToRefresh>
  );
}
