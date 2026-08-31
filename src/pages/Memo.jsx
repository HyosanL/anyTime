import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { collection, doc, getDoc, getDocs, query, where, limit } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { callFn } from '../lib/functions';
import { useAuthContext } from '../contexts/AuthContext';
import { getCatalog, formatTimes } from '../lib/cache';
import { maskText, prefetchMask } from '../lib/mask';
import { getReacted, markReacted, hasReviewed } from '../lib/reactions';
import { correctionMeta, sectionCorrectionOptions, sectionSubject } from '../lib/correction';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';
import CorrectionModal from '../components/CorrectionModal';
import '../styles/course.css';

// 화면6: 수업 메모. 확정시간표 등록 생도만 작성/열람(getMemos CF 강제, 설계 §3 예외 — 읽기도 CF).
export default function Memo() {
  const { courseCode, year, term, sectionNo } = useParams();
  const { cadet, settings } = useAuthContext();
  const isAdmin = !!cadet?.isAdmin;
  const y = Number(year);
  const t = Number(term);
  const sn = Number(sectionNo);

  const [header, setHeader] = useState({ name: courseCode, prof: '', profCode: '', times: '', rawTimes: [] });
  // 강의 정보 수정 제안(🚩) 입력 — 강의 검색과 같은 CorrectionModal·항목 빌더를 그대로 쓴다.
  const [corrMeta, setCorrMeta] = useState({ periods: [], professors: [], sections: [] });
  const [corr, setCorr] = useState(null); // { subject, options } | null
  // 자격 기준일(minDays)은 부팅 정보로 이미 와 있다 — 메모 화면마다 따로 부르지 않는다.
  // 보유일수(daysHeld)는 소유 데이터(timetables/entries)를 직접 읽어 이 화면이 판정한다
  // (CONVENTIONS.md: 소유 데이터는 직접 R/W) — createReview CF도 작성 시점에 같은 규칙을 다시 검증한다.
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
    const course = catalog.courses?.find((c) => c.code === courseCode);
    const section = catalog.sections?.find(
      (s) => s.courseCode === courseCode && s.year === y && s.term === t && s.sectionNo === sn
    );
    const prof = catalog.professors?.find((p) => p.code === section?.professorCode);
    const times = section?.sectionTimes ?? [];
    setHeader({
      name: course?.name ?? courseCode,
      prof: prof?.name ?? '',
      profCode: section?.professorCode ?? '',
      times: formatTimes(times),
      rawTimes: times,
    });
    setCorrMeta(correctionMeta(catalog));
  }

  // 보유일수 판정: users/{uid}/timetables 에서 이 학기 확정(isPrimary) 시간표를 찾고,
  // 그 안의 entries/{sectionKey} 문서의 createdAt 으로 계산한다(functions/src/lib/eligibility.js
  // 의 timetableHeldDays() 와 동일 로직 — 소유 데이터라 서버를 거치지 않고 여기서 직접 판정).
  async function loadReviewEligibility() {
    const uid = auth.currentUser?.uid;
    if (!uid) return setDaysHeld(null);
    const ttSnap = await getDocs(query(
      collection(db, 'users', uid, 'timetables'),
      where('year', '==', y), where('term', '==', t), where('isPrimary', '==', true), limit(1)
    ));
    if (ttSnap.empty) return setDaysHeld(null);
    const sectionKey = `${courseCode}_${y}_${t}_${sn}`;
    const entrySnap = await getDoc(doc(db, 'users', uid, 'timetables', ttSnap.docs[0].id, 'entries', sectionKey));
    const createdAt = entrySnap.exists() ? entrySnap.get('createdAt') : null;
    setDaysHeld(createdAt ? Math.floor((Date.now() - createdAt.toMillis()) / 86400000) : null);
  }

  // silent: 당겨서 새로고침 때는 목록을 '불러오는 중…'으로 갈아치우지 않는다
  async function loadMemos(silent = false) {
    if (!silent) setLoading(true);
    setError('');
    const r = await callFn('getMemos', { courseCode, year: y, term: t, sectionNo: sn });
    if (!r.ok) {
      // CF 가 미등록 생도를 막는다(invalid-argument)
      setAllowed(false);
      setMemos([]);
    } else {
      setAllowed(true);
      setMemos(r.data ?? []);
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
    const r = await callFn('createMemo', {
      courseCode, year: y, term: t, sectionNo: sn,
      content: await maskText(content.trim()),
      postPassword: password,
    });
    setSubmitting(false);
    if (!r.ok) {
      setError(r.message || '작성에 실패했습니다.');
      return;
    }
    setContent('');
    setPassword('');
    loadMemos();
  }

  // sectionCorrectionOptions()가 기대하는 모양 — 강의 검색의 분반 카드(s)와 같은 필드만 맞추면 된다.
  const sectionForCorrection = {
    courseCode, year: y, term: t, sectionNo: sn,
    courseName: header.name, professorName: header.prof, times: header.rawTimes,
  };

  const [, reactTick] = useState(0); // 신고 기록 후 버튼 상태 갱신용

  async function report(id) {
    if (getReacted('memo', id).report) return;
    if (!confirm('이 메모를 신고할까요?')) return;
    markReacted('memo', id, 'report'); reactTick((n) => n + 1); // 요청 전에 먼저 기록해 연타 차단
    const r = await callFn('reportMemo', { id });
    const status = r.ok ? r.data.status : 'ERROR';
    if (status === 'DELETED') { setMemos((prev) => prev.filter((m) => m.id !== id)); alert('신고 누적으로 삭제되었습니다.'); }
    else if (status === 'ALREADY') alert('이미 신고한 메모입니다.');
    else alert('신고되었습니다.');
  }

  // 비번 없는(누구나 삭제 가능) 메모: 확인 후 바로 삭제
  async function deleteOpen(id) {
    if (!confirm('이 메모를 삭제할까요?')) return;
    const r = await callFn('deleteMemo', { id, postPassword: '' });
    if (!r.ok || !r.data.deleted) { alert('삭제에 실패했습니다.'); return; }
    setMemos((prev) => prev.filter((m) => m.id !== id));
  }

  async function confirmDelete() {
    setDelErr('');
    const r = await callFn('deleteMemo', { id: delTarget, postPassword: delPw });
    if (!r.ok) return setDelErr(r.message || '삭제 실패');
    if (!r.data.deleted) return setDelErr('이미 삭제되었거나 없는 글입니다.');
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
        <button
          type="button"
          className="cor-flag-btn"
          onClick={() => setCorr({ subject: sectionSubject(sectionForCorrection), options: sectionCorrectionOptions(sectionForCorrection, corrMeta) })}
        >
          🚩 수정 제안
        </button>
      </div>

      {/* 카탈로그는 학교 공지를 옮겨 담은 것이라 실제와 다를 수 있다 — 고치는 길을 함께 알려 준다 */}
      <p className="cor-notice">
        ⚠️ 강의 정보(시간·강의실·교수)가 실제와 다를 수 있습니다.
        틀린 곳이 보이면 강의 카드의 <b>🚩 수정 제안</b>으로 알려 주세요.
      </p>

      {/* 강의평 쓰기 — 확정시간표 minDays일 이상 보유 시 활성화(눌러서 새 화면으로) */}
      <section className="memo-review">
        {(() => {
          // 이미 이 과목·교수에 강의평을 쓴 기기면 재작성 버튼을 감춘다(서버는 익명 다건이라 로컬로만 잠금).
          if (hasReviewed(courseCode, header.profCode)) {
            return (
              <Link to={`/reviews/${courseCode}`} className="btn-ghost btn-block">
                ✍️ 강의평 작성 완료 · 보러 가기
              </Link>
            );
          }
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
                  <span className="memo-date">{memoDate(m.createdAt)?.toLocaleString('ko-KR')}</span>
                  <span className="memo-actions">
                    {getReacted('memo', m.id).report
                      ? <span className="rev-reported">🚨 신고됨</span>
                      : <button className="rev-del-btn rev-report" onClick={() => report(m.id)}>🚨 신고</button>}
                    {m.hasPassword && !isAdmin ? (
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

      {corr && (
        <CorrectionModal subject={corr.subject} options={corr.options} onClose={() => setCorr(null)} />
      )}
    </PullToRefresh>
  );
}

// getMemos CF 응답(JSON 직렬화)의 Firestore Timestamp 는 {_seconds,_nanoseconds} 로 온다
// (board.js의 toIso() 와 동일 규약 — 여기선 문자열이 아니라 Date 로 바로 쓴다).
function memoDate(ts) {
  if (!ts) return null;
  const secs = ts._seconds ?? ts.seconds;
  return typeof secs === 'number' ? new Date(secs * 1000) : new Date(ts);
}
