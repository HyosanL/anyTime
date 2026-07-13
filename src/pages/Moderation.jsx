import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../supabase';
import { flagText, highlightParts } from '../lib/moderation';
import { clearCatalog, kvGet, kvSet } from '../lib/cache';
import { useAuthContext } from '../contexts/AuthContext';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';
import '../styles/admin.css';
import '../styles/correction.css';
import '../styles/course.css';
import '../styles/board.css';

const TYPE_LABEL = { review: '강의평', class_memo: '메모', exam_archive: '족보', board_post: '게시글', board_comment: '댓글' };
const FIELD_LABEL = { time: '요일·교시', room: '강의실', professor: '담당교수', name: '이름/과목명', department: '학과', office: '연구실' };
// 현행 사유는 'threshold'(누적)·'burst'(15분 급증). 기준값은 관리자 설정이라 라벨엔 수치 미표기(정확한 수치는 신고수 배지로 표시).
// burst_10/threshold_30/burst_3/threshold_10 은 구 기준 아카이브 행 표시용으로 유지.
const REASON_LABEL = { threshold: '누적 신고', burst: '단시간 급증(15분)', burst_10: '15분 10건', threshold_30: '누적 30건', burst_3: '30분 3건(구)', threshold_10: '누적 10건(구)' };
// 폴링 주기. 신고·수정제안은 초 단위로 다투는 일이 아니고, 화면이 열려 있는 내내 도는 유일한
// 상시 요청이라 그대로 비용이 된다(15초 → 60초, 게다가 이제 호출은 한 번으로 묶인다).
// 급할 땐 당겨서 새로고침이 있다.
const POLL_MS = 60000;
// 파급이 큰 항목(과목명/교수명/학과)은 자동반영 대상이 아니며, 3건↑ 쌓이면 수동 검토 강조.
const HIGH_RISK = new Set(['course:name', 'professor:name', 'professor:department']);
// 대상 키는 정규화된 단순 속성(professor_code/course_code/year/term/section_no)으로 묶는다.
const groupKey = (c) =>
  `${c.target}|${c.professor_code ?? ''}|${c.course_code ?? ''}|${c.year ?? ''}|${c.term ?? ''}|${c.section_no ?? ''}|${c.field}|${c.suggested ?? ''}`;

async function call(action, payload = {}) {
  const { data, error } = await supabase.functions.invoke('admin-action', { body: { action, payload } });
  let status = data?.status;
  if (error) { try { status = (await error.context?.json?.())?.status; } catch { /* ignore */ } }
  return { ok: status === 'OK', status, data };
}

// 목록 여러 개를 Edge Function 호출 '한 번'으로 받는다. 예전엔 대시보드가 열려 있는 동안
// 15초마다 5번씩 불러 시간당 1,200회를 썼다. 반환은 요청한 순서대로 [{ok, data}, …].
async function callBatch(actions) {
  const { data } = await supabase.functions.invoke('admin-action', {
    body: { action: 'batch', payload: { actions } },
  });
  const results = data?.results ?? [];
  return actions.map((_, i) => ({
    ok: results[i]?.ok === true,
    data: results[i]?.data ?? {},
  }));
}

// 항목 → 실제 콘텐츠 화면 경로(삭제 판단 전 원문·맥락 확인용). 못 만드는 유형은 null.
function contentPath(it) {
  switch (it.type) {
    case 'board_post': return `/board/post/${it.id}`;
    case 'board_comment': return it.meta?.post_id ? `/board/post/${it.meta.post_id}` : null;
    case 'review': return `/reviews/${it.course_code}`;
    case 'exam_archive': return `/exams/${it.course_code}`;
    case 'class_memo': {
      const m = it.meta || {};
      return m.year && m.term && m.section_no != null
        ? `/memo/${it.course_code}/${m.year}/${m.term}/${m.section_no}` : null;
    }
    default: return null;
  }
}

// 동일(target/key/field/suggested) 제안을 한 카드로 묶고 ids·count 보관.
function groupCorrections(list) {
  const m = new Map();
  for (const c of list) {
    const k = groupKey(c);
    if (!m.has(k)) m.set(k, { ...c, ids: [c.id], count: 1 });
    else { const g = m.get(k); g.ids.push(c.id); g.count++; }
  }
  return [...m.values()];
}

function Highlighted({ text }) {
  return (
    <>
      {highlightParts(text).map((p, i) =>
        p.bad ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>
      )}
    </>
  );
}

// 화면9-2: 실시간 모더레이션 대시보드 — 3탭(게시글·댓글 / 신고 / 수정 제안).
export default function Moderation() {
  const navigate = useNavigate();
  // 관리자 여부는 cadet 프로필에 이미 실려 온다(useAuth) — is_admin RPC 를 따로 부르지 않는다.
  // 프로필이 아직 없으면(null) '확인 중'. 어차피 모든 관리자 액션은 서버(admin-action)가 다시 검증한다.
  const { cadet } = useAuthContext();
  const isAdmin = cadet ? !!cadet.is_admin : null;
  const [tab, setTab] = useState('posts'); // 'posts' | 'reports' | 'corr'
  const [items, setItems] = useState([]);       // 게시글·댓글(list_recent)
  const [reported, setReported] = useState([]);  // 신고 누적 글(list_reported)
  const [corrs, setCorrs] = useState([]);        // 수정 제안(pending)
  const [autos, setAutos] = useState([]);        // 자동반영됨(미확인)
  const [deleted, setDeleted] = useState([]);    // 신고 누적 자동삭제 아카이브
  const [updatedAt, setUpdatedAt] = useState(null);
  const [reviewedAt, setReviewedAt] = useState(null); // 마지막 '모두 확인 처리' 컷오프
  const [edit, setEdit] = useState(null); // { type, id, text }
  const timer = useRef(null);
  const freshRef = useRef(false); // 서버 응답 도착 후 늦게 온 캐시가 덮어쓰지 않도록

  const load = useCallback(async () => {
    const [r, rc, rr, ra, rd] = await callBatch([
      { action: 'list_recent', payload: { limit: 100 } },
      { action: 'list_corrections', payload: { status: 'pending' } },
      { action: 'list_reported' },
      { action: 'list_auto_notices' },
      { action: 'list_deleted' },
    ]);
    freshRef.current = true;
    if (rc.ok) setCorrs(rc.data.items ?? []);
    if (rr.ok) setReported(rr.data.items ?? []);
    if (ra.ok) setAutos(ra.data.items ?? []);
    if (rd.ok) setDeleted(rd.data.items ?? []);
    if (r.ok) {
      const withFlags = (r.data.items ?? []).map((it) => ({ ...it, flags: flagText(it.text) }));
      // 부정어 포함 글을 위로, 그 다음 최신순
      withFlags.sort((a, b) => {
        const fa = a.flags.length > 0, fb = b.flags.length > 0;
        if (fa !== fb) return fa ? -1 : 1;
        return a.created_at < b.created_at ? 1 : -1;
      });
      setItems(withFlags);
      setReviewedAt(r.data.reviewed_at ?? null);
      // 다음 진입 때 즉시 표시할 스냅샷(SWR). 전부 성공했을 때만 저장.
      if (rc.ok && rr.ok && ra.ok && rd.ok) {
        kvSet('mod:snapshot', {
          items: withFlags, corrs: rc.data.items ?? [], reported: rr.data.items ?? [],
          autos: ra.data.items ?? [], deleted: rd.data.items ?? [], reviewedAt: r.data.reviewed_at ?? null,
        });
      }
    }
    setUpdatedAt(new Date());
  }, []);

  useEffect(() => {
    if (!isAdmin) return undefined;
    // 캐시된 마지막 스냅샷 즉시 표시 → edge function 응답으로 교체
    kvGet('mod:snapshot').then((c) => {
      if (freshRef.current || !c) return;
      setItems(c.items ?? []); setCorrs(c.corrs ?? []); setReported(c.reported ?? []);
      setAutos(c.autos ?? []); setDeleted(c.deleted ?? []); setReviewedAt(c.reviewedAt ?? null);
    });

    // 화면이 보일 때만 15초 폴링. 백그라운드 탭/앱에서는 5개 edge function 호출을 멈춘다.
    const startPoll = () => { if (!timer.current) timer.current = setInterval(load, POLL_MS); };
    const stopPoll = () => { clearInterval(timer.current); timer.current = null; };
    const onVis = () => {
      if (document.hidden) stopPoll();
      else { load(); startPoll(); } // 다시 보이면 즉시 1회 갱신 후 폴링 재개
    };

    load();
    if (!document.hidden) startPoll();
    document.addEventListener('visibilitychange', onVis);
    return () => { stopPoll(); document.removeEventListener('visibilitychange', onVis); };
  }, [isAdmin, load]);

  // '모두 확인 처리': 지금까지의 글을 대시보드에서 숨김(데이터는 유지). 이후 새 글만 표시.
  async function clearAll() {
    const flagged = items.filter((i) => i.flags.length).length;
    const warn = flagged > 0 ? `검토필요 ${flagged}건이 아직 남아있습니다.\n` : '';
    if (!confirm(`${warn}지금까지의 글 ${items.length}건을 모두 확인 처리할까요?\n(이후 새로 올라오는 글만 표시됩니다. 글은 삭제되지 않습니다.)`)) return;
    const r = await call('clear_moderation');
    if (r.ok) { setItems([]); setReviewedAt(r.data.reviewed_at ?? null); }
    else alert('처리 실패: ' + (r.status ?? '오류'));
  }

  // ── 게시글·댓글 / 신고 공통: 삭제 ──
  async function remove(it) {
    if (!confirm(`이 ${TYPE_LABEL[it.type]}을(를) 삭제할까요?`)) return;
    const r = await call('delete_post', { table: it.type, id: it.id });
    if (r.ok) {
      setItems((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
      setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
    }
  }

  async function saveEdit() {
    const fields = (edit.type === 'class_memo' || edit.type === 'board_post' || edit.type === 'board_comment')
      ? { content: edit.text }
      : edit.type === 'exam_archive'
        ? { description: edit.text }
        : { course_comment: edit.text };
    const r = await call('edit_post', { table: edit.type, id: edit.id, fields });
    if (r.ok) { setEdit(null); load(); }
  }

  // ── 신고: 무시(정상 처리) — 신고 수 초기화(담합·오신고 폭주 리셋용) ──
  async function dismissReport(it) {
    if (!confirm('이 신고를 무시(정상 처리)할까요? 신고 수가 초기화됩니다.')) return;
    const r = await call('dismiss_report', { table: it.type, id: it.id });
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
  }

  // ── 신고: 확인처리 — 검토했고 삭제할 정돈 아니라 넘어감. 신고 수는 그대로 두고 목록에서만 감춤.
  //    (이후 신고가 더 쌓이면 다시 나타난다. 검열 '모두 확인 처리'와 동일 개념 — 누적은 보존)
  async function ackReport(it) {
    const r = await call('ack_report', { table: it.type, id: it.id });
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
    else alert('확인 처리 실패: ' + (r.status ?? '오류'));
  }
  async function ackAllReports() {
    if (!reported.length) return;
    if (!confirm(`신고 누적 ${reported.length}건을 모두 확인 처리할까요?\n(신고 수는 유지되고 목록에서만 감춰집니다. 이후 신고가 더 쌓이면 다시 표시됩니다.)`)) return;
    for (const it of reported) await call('ack_report', { table: it.type, id: it.id });
    setReported([]);
  }

  // ── 삭제됨(신고 누적 자동삭제 아카이브): 복구 / 확인 ──
  async function restoreDeleted(it) {
    if (!confirm(`이 ${TYPE_LABEL[it.type]}을(를) 복구할까요? (신고 수는 0으로 초기화됩니다)`)) return;
    const r = await call('restore_deleted', { id: it.id });
    if (r.ok) setDeleted((prev) => prev.filter((x) => x.id !== it.id));
    else alert('복구 실패: ' + (r.status === 'PARENT_GONE' ? '소속 과목/게시판이 이미 정리되어 복구할 수 없습니다.'
      : r.status === 'ALREADY_EXISTS' ? '이미 복구된 글입니다.' : (r.status ?? '오류')));
  }
  async function ackDeleted(it) {
    const r = await call('ack_deleted', { id: it.id });
    if (r.ok) setDeleted((prev) => prev.map((x) => (x.id === it.id ? { ...x, reviewed: true } : x)));
  }

  // ── 수정 제안: 그룹 단위 적용/반려 ──
  async function applyGroup(g) {
    for (const id of g.ids) {
      const r = await call('apply_correction', { id });
      if (!r.ok) { alert('적용 실패: ' + (r.status ?? '오류') + (r.status === 'BAD_TIME' ? ' (시간 형식 오류)' : '')); return; }
    }
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
    // 반영값이 카탈로그(교수·과목·시간)에 바로 보이도록 로컬 캐시 무효화(관리자 화면 즉시 확인용).
    clearCatalog().catch(() => {});
  }
  async function rejectGroup(g) {
    if (!confirm('이 수정 제안을 반려할까요?')) return;
    for (const id of g.ids) await call('reject_correction', { id });
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
  }
  // 자동반영 알림 확인 처리
  async function ackGroup(g) {
    for (const id of g.ids) await call('ack_correction', { id });
    setAutos((prev) => prev.filter((c) => !g.ids.includes(c.id)));
  }

  const corrGroups = useMemo(() => groupCorrections(corrs), [corrs]);
  const autoGroups = useMemo(() => groupCorrections(autos), [autos]);

  if (isAdmin === null) return <div className="page-center">확인 중…</div>;
  if (!isAdmin) {
    return (
      <div className="page">
        <header className="page-header">
          <BackButton />
          <h2>검열</h2>
        </header>
        <div className="empty">
          <span className="empty-emoji">🔒</span>
          <p>관리자 권한이 없습니다.</p>
        </div>
      </div>
    );
  }

  const flaggedCount = items.filter((i) => i.flags.length).length;
  const corrCount = corrGroups.length + autoGroups.length;
  const deletedUnread = deleted.filter((d) => !d.reviewed).length;

  return (
    <PullToRefresh className="page" onRefresh={load}>
      <header className="page-header">
        <BackButton />
        <h2>검열</h2>
      </header>

      <p className="mod-status">
        실시간(15초)
        {updatedAt && ` · ${updatedAt.toLocaleTimeString('ko-KR')} 갱신`}
        {reviewedAt && <span className="muted"> · {new Date(reviewedAt).toLocaleString('ko-KR')} 확인처리됨</span>}
      </p>

      {/* 3탭 */}
      <div className="mod-tabs" role="tablist">
        <button className={`mod-tab ${tab === 'posts' ? 'is-active' : ''}`} onClick={() => setTab('posts')}>
          게시글·댓글
          {flaggedCount > 0 && <span className="mod-tab-badge warn">{flaggedCount}</span>}
        </button>
        <button className={`mod-tab ${tab === 'reports' ? 'is-active' : ''}`} onClick={() => setTab('reports')}>
          신고
          {reported.length > 0 && <span className="mod-tab-badge warn">{reported.length}</span>}
        </button>
        <button className={`mod-tab ${tab === 'corr' ? 'is-active' : ''}`} onClick={() => setTab('corr')}>
          수정 제안
          {corrCount > 0 && <span className="mod-tab-badge">{corrCount}</span>}
        </button>
        <button className={`mod-tab ${tab === 'deleted' ? 'is-active' : ''}`} onClick={() => setTab('deleted')}>
          삭제됨
          {deletedUnread > 0 && <span className="mod-tab-badge warn">{deletedUnread}</span>}
        </button>
      </div>

      {/* ① 게시글·댓글 */}
      {tab === 'posts' && (
        <>
          <div className="mod-tab-bar">
            <span className="mod-count">총 {items.length}건 · <span className="mod-flag-n">검토필요 {flaggedCount}건</span></span>
            {items.length > 0 && <button className="link-btn" onClick={clearAll}>모두 확인 처리</button>}
          </div>
          <ul className="mod-list">
            {items.length === 0 && (
              <li className="empty"><span className="empty-emoji">🗂️</span><p>게시글이 없습니다.</p></li>
            )}
            {items.map((it) => (
              <li key={`${it.type}-${it.id}`} className={`card mod-card ${it.flags.length ? 'flagged' : ''}`}>
                <div className="mod-card-top">
                  <span className="tag tag-primary mod-type">{TYPE_LABEL[it.type]}</span>
                  <span className="mod-course">{it.course_code}{it.meta?.section_no ? `·${it.meta.section_no}분반` : ''}</span>
                  {it.flags.length > 0 && <span className="tag tag-warn mod-badge">⚠ {it.flags.join(', ')}</span>}
                  <span className="mod-time">{new Date(it.created_at).toLocaleString('ko-KR')}</span>
                </div>

                {edit && edit.type === it.type && edit.id === it.id ? (
                  <div className="mod-edit">
                    <textarea value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} rows={3} />
                    <div className="mod-edit-actions">
                      <button className="btn-add btn-sm" onClick={saveEdit}>저장</button>
                      <button className="rev-del-btn" onClick={() => setEdit(null)}>취소</button>
                    </div>
                  </div>
                ) : (
                  <p
                    className={`mod-text${contentPath(it) ? ' mod-text-link' : ''}`}
                    onClick={() => { const p = contentPath(it); if (p) navigate(p); }}
                  >
                    <Highlighted text={it.text || '(내용 없음)'} />
                  </p>
                )}

                <div className="mod-actions">
                  {contentPath(it) && <button className="link-btn" onClick={() => navigate(contentPath(it))}>원문 보기</button>}
                  <button className="rev-del-btn" onClick={() => setEdit({ type: it.type, id: it.id, text: editableText(it) })}>수정</button>
                  <button className="btn-remove btn-sm" onClick={() => remove(it)}>삭제</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ② 신고 */}
      {tab === 'reports' && (
        <>
          <div className="mod-tab-bar">
            <span className="mod-count">신고 누적 {reported.length}건</span>
            {reported.length > 0 && <button className="link-btn" onClick={ackAllReports}>모두 확인 처리</button>}
          </div>
          <ul className="mod-list">
          {reported.length === 0 && (
            <li className="empty"><span className="empty-emoji">🚨</span><p>신고 누적 중인 글이 없습니다.</p></li>
          )}
          {reported.map((it) => (
            <li key={`rep-${it.type}-${it.id}`} className="card mod-card flagged">
              <div className="mod-card-top">
                <span className="tag tag-primary mod-type">{TYPE_LABEL[it.type]}</span>
                <span className="mod-course">{it.course_code}{it.meta?.section_no ? `·${it.meta.section_no}분반` : ''}</span>
                <span className="tag tag-warn mod-badge">🚨 신고 {it.report_count}건</span>
                <span className="mod-time">{new Date(it.created_at).toLocaleString('ko-KR')}</span>
              </div>
              <p
                className={`mod-text${contentPath(it) ? ' mod-text-link' : ''}`}
                onClick={() => { const p = contentPath(it); if (p) navigate(p); }}
              >
                <Highlighted text={it.text || '(내용 없음)'} />
              </p>
              <div className="mod-actions">
                {contentPath(it) && <button className="link-btn" onClick={() => navigate(contentPath(it))}>원문 보기</button>}
                <button className="btn-add btn-sm" onClick={() => ackReport(it)}>확인</button>
                <button className="btn-remove btn-sm" onClick={() => remove(it)}>삭제</button>
                <button className="rev-del-btn" onClick={() => dismissReport(it)}>무시(정상)</button>
              </div>
            </li>
          ))}
          </ul>
        </>
      )}

      {/* ③ 수정 제안 */}
      {tab === 'corr' && (
        <>
          {autoGroups.length > 0 && (
            <>
              <h3 className="mod-corr-head">🤖 자동 반영됨 · 확인 필요 {autoGroups.length}건</h3>
              <ul className="mod-list">
                {autoGroups.map((g) => (
                  <li key={`auto-${g.id}`} className="card mod-card mod-auto">
                    <div className="mod-card-top">
                      <span className="tag tag-primary mod-type">자동반영</span>
                      <span className="mod-course">{g.label || g.target} · <span className="mod-corr-field">{FIELD_LABEL[g.field] || g.field}</span></span>
                      {g.count > 1 && <span className="tag mod-badge">동일 {g.count}건</span>}
                      <span className="mod-time">{new Date(g.created_at).toLocaleString('ko-KR')}</span>
                    </div>
                    <p className="mod-text">반영값: <b className="mod-corr-sug">{g.suggested}</b></p>
                    <div className="mod-actions">
                      <button className="btn-add btn-sm" onClick={() => ackGroup(g)}>확인</button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className="mod-corr-head">🚩 검토 대기 {corrGroups.length}건</h3>
          <ul className="mod-list">
            {corrGroups.length === 0 && (
              <li className="empty"><span className="empty-emoji">🚩</span><p>대기 중인 수정 제안이 없습니다.</p></li>
            )}
            {corrGroups.map((g) => {
              const highRisk = HIGH_RISK.has(`${g.target}:${g.field}`) && g.count >= 3;
              return (
                <li key={`corr-${g.id}`} className={`card mod-card ${highRisk ? 'flagged' : ''}`}>
                  <div className="mod-card-top">
                    <span className="tag tag-primary mod-type">수정제안</span>
                    <span className="mod-course">{g.label || g.target} · <span className="mod-corr-field">{FIELD_LABEL[g.field] || g.field}</span></span>
                    {g.count > 1 && <span className="tag mod-badge">동일 {g.count}건</span>}
                    {highRisk && <span className="tag tag-warn mod-badge">⚠ 검토 필요</span>}
                    <span className="mod-time">{new Date(g.created_at).toLocaleString('ko-KR')}</span>
                  </div>
                  <p className="mod-text">
                    {g.suggested ? <>제안값: <b className="mod-corr-sug">{g.suggested}</b></> : <span className="muted">제안값 없음</span>}
                    {g.note ? <><br />설명: {g.note}</> : null}
                  </p>
                  <div className="mod-actions">
                    <button className="btn-add btn-sm" onClick={() => applyGroup(g)}>적용</button>
                    <button className="rev-del-btn" onClick={() => rejectGroup(g)}>반려</button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {/* ④ 삭제됨(신고 누적 자동삭제 아카이브) */}
      {tab === 'deleted' && (
        <>
          <p className="mod-status muted">
            신고 누적·급증(관리자 설정 기준)으로 자동삭제된 글입니다. 담합·오신고로 판단되면 복구하세요. 30일 뒤 자동 파기됩니다.
          </p>
          <ul className="mod-list">
            {deleted.length === 0 && (
              <li className="empty"><span className="empty-emoji">🗑️</span><p>자동삭제된 글이 없습니다.</p></li>
            )}
            {deleted.map((it) => (
              <li key={`del-${it.id}`} className={`card mod-card ${it.reviewed ? '' : 'flagged'}`}>
                <div className="mod-card-top">
                  <span className="tag tag-primary mod-type">{TYPE_LABEL[it.type]}</span>
                  <span className="mod-course">{it.course_code}</span>
                  <span className="tag tag-warn mod-badge">🚨 신고 {it.report_count}건 · {REASON_LABEL[it.reason] || it.reason}</span>
                  {it.reviewed && <span className="tag mod-badge">확인됨</span>}
                  <span className="mod-time">{new Date(it.created_at).toLocaleString('ko-KR')}</span>
                </div>
                <p className="mod-text"><Highlighted text={it.text || '(내용 없음)'} /></p>
                <div className="mod-actions">
                  <button className="btn-add btn-sm" onClick={() => restoreDeleted(it)}>복구</button>
                  {!it.reviewed && <button className="rev-del-btn" onClick={() => ackDeleted(it)}>확인</button>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </PullToRefresh>
  );
}

// 수정 대상 텍스트(편집 가능한 필드)
function editableText(it) {
  return it.text || '';
}
