import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { supabase } from '../supabase';
import { getCatalog, formatTimes } from '../lib/cache';
import { maskProfanity } from '../lib/moderation';
import ReviewForm from '../components/ReviewForm';

// 화면6: 수업 메모 (분반 종속·휘발성). 확정시간표 등록 생도만 작성/열람(RPC 강제).
export default function Memo() {
  const { courseCode, year, term, sectionNo } = useParams();
  const y = Number(year);
  const t = Number(term);
  const sn = Number(sectionNo);

  const [header, setHeader] = useState({ name: courseCode, prof: '', profCode: '', times: '' });
  const [rev, setRev] = useState({ minDays: 30, daysHeld: null }); // 강의평 자격
  const [showReview, setShowReview] = useState(false);
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

  async function loadReviewEligibility() {
    const [{ data: tt }, { data: md }] = await Promise.all([
      supabase.from('timetable').select('created_at')
        .match({ course_code: courseCode, year: y, term: t, section_no: sn }).maybeSingle(),
      supabase.rpc('get_review_min_days'),
    ]);
    const daysHeld = tt?.created_at
      ? Math.floor((Date.now() - new Date(tt.created_at).getTime()) / 86400000)
      : null;
    setRev({ minDays: md ?? 30, daysHeld });
  }

  async function loadMemos() {
    setLoading(true);
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
    if (password.length < 2) return setError('게시글 비밀번호를 입력하세요(삭제용).');
    setSubmitting(true);
    const { error } = await supabase.rpc('create_memo', {
      p_post_password: password,
      p_course_code: courseCode,
      p_year: y,
      p_term: t,
      p_section_no: sn,
      p_content: maskProfanity(content.trim()),
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

  async function report(id) {
    if (!confirm('이 메모를 신고할까요?')) return;
    const { data } = await supabase.rpc('report_memo', { p_id: id });
    if (data === 'DELETED') { setMemos((prev) => prev.filter((m) => m.id !== id)); alert('신고 누적으로 삭제되었습니다.'); }
    else alert('신고되었습니다.');
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
    <div className="page">
      <header className="page-header row">
        <Link to="/" className="link-btn">← 홈</Link>
        <h2>{header.name} 메모</h2>
      </header>

      <div className="memo-head">
        <p className="memo-sub">
          {[header.prof, header.times, `${sn}분반`].filter(Boolean).join(' · ')}
        </p>
        <p className="memo-note note">※ 수업 메모는 학기 종속·휘발성이며, 이 분반을 확정시간표에 등록한 생도만 보고 쓸 수 있습니다.</p>
      </div>

      {/* 강의평 쓰기 — 확정시간표 minDays일 이상 보유 시 활성화 */}
      <section className="memo-review">
        {(() => {
          const eligible = rev.daysHeld != null && rev.daysHeld >= rev.minDays;
          if (showReview && eligible) {
            return (
              <ReviewForm
                courseCode={courseCode}
                professors={header.profCode ? [{ code: header.profCode, name: header.prof }] : []}
                defaultProf={header.profCode}
                onDone={() => setShowReview(false)}
              />
            );
          }
          return (
            <button
              className="btn-add btn-block"
              disabled={!eligible}
              onClick={() => setShowReview(true)}
              title={eligible ? '' : `확정시간표에 ${rev.minDays}일 이상 보유 후 작성 가능`}
            >
              ✍️ 강의평 쓰기{eligible ? '' : rev.daysHeld == null ? ' (미등록)' : ` (앞으로 ${rev.minDays - rev.daysHeld}일)`}
            </button>
          );
        })()}
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
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={2}
              placeholder="이번 수업 공지·과제·시험범위 등을 공유하세요"
            />
            <div className="memo-form-row">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="삭제용 비번"
              />
              <button type="submit" className="btn-add" disabled={submitting}>
                {submitting ? '등록 중…' : '메모 등록'}
              </button>
            </div>
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
                    <button className="rev-del-btn rev-report" onClick={() => report(m.id)}>🚨 신고</button>
                    {delTarget === m.id ? (
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
                    )}
                  </span>
                </div>
                {delTarget === m.id && delErr && <p className="error-msg">{delErr}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
