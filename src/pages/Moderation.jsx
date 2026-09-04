import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import { flagText, highlightParts } from '../lib/moderation';
import { clearCatalog, getCatalog, subscribeCatalog, kvGet, kvSet } from '../lib/cache';
import { syncAdminPush } from '../lib/push';
import { useAuthContext } from '../contexts/AuthContext';
import PullToRefresh from '../components/PullToRefresh';
import BackButton from '../components/BackButton';
import '../styles/admin.css';
import '../styles/correction.css';
import '../styles/course.css';
import '../styles/board.css';

const TYPE_LABEL = { review: '강의평', class_memo: '메모', exam_archive: '족보', board_post: '게시글', board_comment: '댓글' };
const FIELD_LABEL = { time: '요일·교시', room: '강의실', professor: '담당교수', name: '이름/과목명', department: '학과', office: '연구실', section: '분반 추가' };
// 현행 사유는 'threshold'(누적)·'burst'(15분 급증). 기준값은 관리자 설정이라 라벨엔 수치 미표기(정확한 수치는 신고수 배지로 표시).
// burst_10/threshold_30/burst_3/threshold_10 은 구 기준 아카이브 행 표시용으로 유지.
const REASON_LABEL = { threshold: '누적 신고', burst: '단시간 급증(15분)', burst_10: '15분 10건', threshold_30: '누적 30건', burst_3: '30분 3건(구)', threshold_10: '누적 10건(구)' };
// 폴링 주기. 신고·수정제안은 초 단위로 다투는 일이 아니고, 화면이 열려 있는 내내 도는 유일한
// 상시 요청이라 그대로 비용이 된다(15초 → 60초, 게다가 이제 호출은 한 번으로 묶인다).
// 급할 땐 당겨서 새로고침이 있다.
const POLL_MS = 60000;
// 파급이 큰 항목(과목명/교수명/학과)은 자동반영 대상이 아니며, 3건↑ 쌓이면 수동 검토 강조.
const HIGH_RISK = new Set(['course:name', 'professor:name', 'professor:department']);
// 대상 키는 정규화된 단순 속성(professorCode/courseCode/year/term/sectionNo)으로 묶는다.
const groupKey = (c) =>
  `${c.target}|${c.professorCode ?? ''}|${c.courseCode ?? ''}|${c.year ?? ''}|${c.term ?? ''}|${c.sectionNo ?? ''}|${c.field}|${c.suggested ?? ''}`;

async function call(action, payload = {}) {
  try {
    const { data } = await httpsCallable(functions, 'adminAction')({ action, payload });
    return { ok: data?.status === 'OK', status: data?.status, data };
  } catch (e) {
    return { ok: false, status: e.code || 'ERROR', data: null };
  }
}

// 목록 여러 개를 Cloud Function 호출 '한 번'으로 받는다(adminAction 의 'batch' 메타 액션).
// 예전엔 대시보드가 열려 있는 동안 15초마다 5번씩 불러 시간당 1,200회를 썼다.
// 반환은 요청한 순서대로 [{ok, data}, …].
async function callBatch(actions) {
  try {
    const { data } = await httpsCallable(functions, 'adminAction')({ action: 'batch', payload: { actions } });
    const results = data?.results ?? [];
    return actions.map((_, i) => ({
      ok: results[i]?.ok === true,
      data: results[i]?.data ?? {},
    }));
  } catch {
    return actions.map(() => ({ ok: false, data: {} }));
  }
}

// Cloud Function 응답의 Firestore Timestamp 는 {_seconds,_nanoseconds}(또는 {seconds,nanoseconds})로
// 오고, clear_moderation 의 reviewedAt 처럼 순수 Date/ISO 문자열로 오는 필드도 섞여 있다
// (board.js 의 toIso 와 같은 이유) — 정렬·표시 직전에 여기서 한 번에 흡수한다.
function tsMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts === 'string' || typeof ts === 'number') return new Date(ts).getTime() || 0;
  const secs = ts._seconds ?? ts.seconds;
  return typeof secs === 'number' ? secs * 1000 : 0;
}
function fmtDateTime(ts) {
  const ms = tsMillis(ts);
  return ms ? new Date(ms).toLocaleString('ko-KR') : '';
}

// 항목 → 실제 콘텐츠 화면 경로(삭제 판단 전 원문·맥락 확인용). 못 만드는 유형은 null.
function contentPath(it) {
  switch (it.type) {
    case 'board_post': return `/board/post/${it.id}`;
    case 'board_comment': return it.meta?.postId ? `/board/post/${it.meta.postId}` : null;
    case 'review': return `/reviews/${it.courseCode}`;
    case 'exam_archive': return `/exams/${it.courseCode}`;
    case 'class_memo': {
      const m = it.meta || {};
      return m.year && m.term && m.sectionNo != null
        ? `/memo/${it.courseCode}/${m.year}/${m.term}/${m.sectionNo}` : null;
    }
    default: return null;
  }
}

const DAY_KO = { 1: '월', 2: '화', 3: '수', 4: '목', 5: '금', 6: '토', 7: '일' };
// section.sectionTimes 임베드 배열 → "수3-4 금1"
function fmtSecTimes(times) {
  return (times || [])
    .slice()
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startPeriod - b.startPeriod)
    .map((t) => (t.startPeriod === t.endPeriod
      ? `${DAY_KO[t.dayOfWeek]}${t.startPeriod}`
      : `${DAY_KO[t.dayOfWeek]}${t.startPeriod}-${t.endPeriod}`))
    .join(' ');
}
// 대기중 제안의 '수정 전' = 지금 카탈로그의 현재값. (자동반영된 건은 이미 바뀌었으므로 correction.prevValue 를 쓴다.)
function currentValue(catalog, g) {
  if (!catalog) return null;
  if (g.target === 'section_add') return '없음 (새 분반)';
  if (g.target === 'course' && g.field === 'name') {
    return (catalog.courses || []).find((c) => c.code === g.courseCode)?.name ?? null;
  }
  if (g.target === 'professor') {
    const p = (catalog.professors || []).find((x) => x.code === g.professorCode);
    if (!p) return null;
    return g.field === 'name' ? p.name : g.field === 'department' ? p.department : p.office;
  }
  if (g.target === 'section' && g.field === 'professor') {
    const s = (catalog.sections || []).find((x) => x.courseCode === g.courseCode && x.year === g.year && x.term === g.term && x.sectionNo === g.sectionNo);
    if (!s) return null;
    return (catalog.professors || []).find((x) => x.code === s.professorCode)?.name ?? '교수 미정';
  }
  if (g.target === 'section_time') {
    // section_time 은 더 이상 별도 컬렉션이 아니다 — 분반 문서의 sectionTimes 배열에 임베드된다(설계 §3).
    const s = (catalog.sections || []).find((x) => x.courseCode === g.courseCode && x.year === g.year && x.term === g.term && x.sectionNo === g.sectionNo);
    const times = s?.sectionTimes ?? [];
    if (g.field === 'room') return times[0]?.room ?? null;
    if (g.field === 'time') return fmtSecTimes(times) || null;
  }
  return null;
}
// 제안값(수정 후) 표시용 — 교수 재배정은 "이름 (코드)"에서 이름만, 분반추가는 요약.
function fmtCorrAfter(g) {
  if (g.target === 'section_add') return fmtCorrSuggested(g);
  if (!g.suggested) return g.suggested;
  if (g.target === 'section' && g.field === 'professor') return g.suggested.replace(/\s*\([^()]*\)\s*$/, '');
  return g.suggested;
}

// 수정제안 제안값을 사람이 읽게 — 분반추가(section_add)는 JSON 이라 요약 문자열로 편다.
function fmtCorrSuggested(g) {
  if (g.target === 'section_add' && g.suggested) {
    try {
      const j = JSON.parse(g.suggested);
      const parts = [`${j.no}분반`];
      if (j.prof) parts.push(j.prof);
      if (j.times) parts.push(j.times);
      if (j.room) parts.push(`강의실 ${j.room}`);
      return parts.join(' · ');
    } catch { return g.suggested; }
  }
  return g.suggested;
}
// 편집 페이지 딥링크(수정 페이지로 바로 이동). 과목 단위 대상만 만든다(교수 대상은 과목 편집 페이지가 없다).
//   section_add → NewSectionCard 를 펼치고, 그 외 → 해당 분반(sec)을 펼친다. corr 로 제안 배너를 띄운다.
function editPath(g) {
  if (!g.courseCode) return null;
  const params = new URLSearchParams();
  if (g.target === 'section_add') params.set('add', '1');
  else if (g.year && g.term && g.sectionNo != null) params.set('sec', `${g.year}-${g.term}-${g.sectionNo}`);
  params.set('corr', String(g.id));
  return `/admin/courses/${encodeURIComponent(g.courseCode)}?${params.toString()}`;
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
  // 관리자 여부는 cadet 프로필에 이미 실려 온다(useAuth) — isAdmin 을 별도로 조회하지 않는다.
  // 프로필이 아직 없으면(null) '확인 중'. 어차피 모든 관리자 액션은 서버(adminAction)가 다시 검증한다.
  const { cadet } = useAuthContext();
  const isAdmin = cadet ? !!cadet.isAdmin : null;
  const [tab, setTab] = useState('posts'); // 'posts' | 'reports' | 'corr'
  const [items, setItems] = useState([]);       // 게시글·댓글(list_recent)
  const [reported, setReported] = useState([]);  // 신고 누적 글(list_reported)
  const [corrs, setCorrs] = useState([]);        // 수정 제안(pending)
  const [processedCorrs, setProcessedCorrs] = useState([]); // 처리함(반려·적용·정리, 최신순)
  const [autos, setAutos] = useState([]);        // 자동반영됨(미확인)
  const [deleted, setDeleted] = useState([]);    // 신고 누적 자동삭제 아카이브
  const [appReports, setAppReports] = useState([]); // 앱 문제 리포트(pending)
  const [repliedReports, setRepliedReports] = useState([]); // 답변한 리포트
  const [cat, setCat] = useState(null);          // 카탈로그(대기중 제안의 '수정 전' 현재값 계산용)
  const [updatedAt, setUpdatedAt] = useState(null);
  const [reviewedAt, setReviewedAt] = useState(null); // 마지막 '모두 확인 처리' 컷오프
  const [edit, setEdit] = useState(null); // { type, id, text }
  const timer = useRef(null);
  const freshRef = useRef(false); // 서버 응답 도착 후 늦게 온 캐시가 덮어쓰지 않도록

  const load = useCallback(async () => {
    const [r, rc, rr, ra, rd, rap, rrep, rpc] = await callBatch([
      { action: 'list_recent', payload: { limit: 100 } },
      { action: 'list_corrections', payload: { status: 'pending' } },
      { action: 'list_reported' },
      { action: 'list_auto_notices' },
      { action: 'list_deleted' },
      { action: 'list_app_reports' },
      { action: 'list_replied_app_reports' },
      { action: 'list_processed_corrections' },
    ]);
    freshRef.current = true;
    if (rc.ok) setCorrs(rc.data.items ?? []);
    if (rr.ok) setReported(rr.data.items ?? []);
    if (ra.ok) setAutos(ra.data.items ?? []);
    if (rd.ok) setDeleted(rd.data.items ?? []);
    if (rap.ok) setAppReports(rap.data.items ?? []);
    if (rrep.ok) setRepliedReports(rrep.data.items ?? []);
    if (rpc.ok) setProcessedCorrs(rpc.data.items ?? []);
    if (r.ok) {
      const withFlags = (r.data.items ?? []).map((it) => ({ ...it, flags: flagText(it.text) }));
      // 부정어 포함 글을 위로, 그 다음 최신순
      withFlags.sort((a, b) => {
        const fa = a.flags.length > 0, fb = b.flags.length > 0;
        if (fa !== fb) return fa ? -1 : 1;
        return tsMillis(b.createdAt) - tsMillis(a.createdAt);
      });
      setItems(withFlags);
      setReviewedAt(r.data.reviewedAt ?? null);
      // 다음 진입 때 즉시 표시할 스냅샷(SWR). 전부 성공했을 때만 저장.
      if (rc.ok && rr.ok && ra.ok && rd.ok && rap.ok && rrep.ok && rpc.ok) {
        kvSet('mod:snapshot', {
          items: withFlags, corrs: rc.data.items ?? [], reported: rr.data.items ?? [],
          autos: ra.data.items ?? [], deleted: rd.data.items ?? [], appReports: rap.data.items ?? [],
          repliedReports: rrep.data.items ?? [], processedCorrs: rpc.data.items ?? [],
          reviewedAt: r.data.reviewedAt ?? null,
        });
      }
    }
    setUpdatedAt(new Date());
  }, []);

  // 카탈로그(대기중 제안의 현재값 표시용) — 캐시 우선, 관리자가 값을 바꾸면 재동기화로 갱신.
  useEffect(() => {
    if (!isAdmin) return undefined;
    getCatalog().then(setCat).catch(() => {});
    // 관리자 기기를 관리자 푸시 대상으로 등록(푸시 켜져 있을 때만; 서버가 is_admin 재확인).
    syncAdminPush().catch(() => {});
    return subscribeCatalog(setCat);
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return undefined;
    // 캐시된 마지막 스냅샷 즉시 표시 → edge function 응답으로 교체
    kvGet('mod:snapshot').then((c) => {
      if (freshRef.current || !c) return;
      setItems(c.items ?? []); setCorrs(c.corrs ?? []); setReported(c.reported ?? []);
      setAutos(c.autos ?? []); setDeleted(c.deleted ?? []); setAppReports(c.appReports ?? []);
      setRepliedReports(c.repliedReports ?? []); setProcessedCorrs(c.processedCorrs ?? []);
      setReviewedAt(c.reviewedAt ?? null);
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
    if (r.ok) { setItems([]); setReviewedAt(r.data.reviewedAt ?? null); }
    else alert('처리 실패: ' + (r.status ?? '오류'));
  }

  // ── 게시글·댓글 / 신고 공통: 삭제 ──
  // board_comment 는 boardPosts/{postId}/comments/{id} 서브컬렉션이라 postId 가 있어야
  // 위치를 특정할 수 있다(옛 낱개 테이블 삭감이 아니라 Firestore 구조 차이에서 온 계약 확장).
  // note = 신고자에게 표시될 메모(선택). 신고 맥락 삭제는 서버가 복구 가능하게 아카이브한다.
  async function remove(it, note) {
    if (!confirm(`이 ${TYPE_LABEL[it.type]}을(를) 삭제할까요?`)) return;
    const payload = { table: it.type, id: it.id };
    if (it.type === 'board_comment') payload.postId = it.meta?.postId;
    if (note && note.trim()) payload.reason = note.trim();
    const r = await call('delete_post', payload);
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
        : { courseComment: edit.text };
    const payload = { table: edit.type, id: edit.id, fields };
    if (edit.type === 'board_comment') payload.postId = edit.postId;
    if (edit.note && edit.note.trim()) payload.reason = edit.note.trim();
    const r = await call('edit_post', payload);
    if (r.ok) {
      setEdit(null);
      setReported((prev) => prev.filter((x) => !(x.type === edit.type && x.id === edit.id)));
      load();
    }
  }

  // ── 신고: 무시(정상 처리) — 신고 수 초기화(담합·오신고 폭주 리셋용) ──
  async function dismissReport(it, note) {
    if (!confirm('이 신고를 무시(정상 처리)할까요? 신고 수가 0으로 초기화됩니다.')) return;
    const payload = { table: it.type, id: it.id };
    if (note && note.trim()) payload.reason = note.trim();
    const r = await call('dismiss_report', payload);
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
  }

  // ── 신고: 확인처리 — 검토했고 삭제할 정돈 아니라 넘어감. 신고 수는 그대로 두고 목록에서만 감춤.
  //    (이후 신고가 더 쌓이면 다시 나타난다. 검열 '모두 확인 처리'와 동일 개념 — 누적은 보존)
  async function ackReport(it) {
    const r = await call('ack_report', { table: it.type, id: it.id });
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
    else alert('확인 처리 실패: ' + (r.status ?? '오류'));
  }

  // 신고 카드에서 바로 내용 수정 → 서버가 '수정 조치' 로 신고자에게 통보하고 큐에서 뺀다.
  async function saveEditFrom(it, text, note) {
    const fields = (it.type === 'class_memo' || it.type === 'board_post') ? { content: text } : { courseComment: text };
    const payload = { table: it.type, id: it.id, fields };
    if (note && note.trim()) payload.reason = note.trim();
    const r = await call('edit_post', payload);
    if (r.ok) {
      setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
      setItems((prev) => prev.map((x) => (x.type === it.type && x.id === it.id ? { ...x, text } : x)));
    } else alert('수정 실패: ' + (r.status ?? '오류'));
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

  // ── 앱 문제 리포트: 확인 처리(즉시 삭제, 익명이라 이력 보관 가치 없음) ──
  async function ackAppReport(it) {
    const r = await call('ack_app_report', { id: it.id });
    if (r.ok) setAppReports((prev) => prev.filter((x) => x.id !== it.id));
  }

  async function replyToAppReport(it, reply, replyStatus) {
    const r = await call('reply_app_report', { id: it.id, reply, replyStatus });
    if (r.ok) {
      setAppReports((prev) => prev.filter((x) => x.id !== it.id));
      setRepliedReports((prev) => [
        { ...it, reply, replyStatus, repliedAt: { toMillis: () => Date.now() } },
        ...prev.filter((x) => x.id !== it.id),
      ]);
    }
    return r;
  }

  // ── 수정 제안: 그룹 단위 적용/반려 (note = 제출자에게 표시될 관리자 메모, 선택) ──
  async function applyGroup(g, note) {
    for (const id of g.ids) {
      const r = await call('apply_correction', { id, reason: note });
      // ALREADY_DONE(예: 분반추가인데 그 사이 이미 생성됨)은 정리된 것으로 보고 넘어간다.
      if (!r.ok && r.status !== 'ALREADY_DONE') { alert('적용 실패: ' + (r.status ?? '오류') + (r.status === 'BAD_TIME' ? ' (시간 형식 오류)' : '')); return; }
    }
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
    // 반영값이 카탈로그(교수·과목·시간)에 바로 보이도록 로컬 캐시 무효화(관리자 화면 즉시 확인용).
    clearCatalog().catch(() => {});
  }
  // 편집 페이지로 이동(제안 내용을 라우터 state 로 함께 넘겨 배너에 그린다).
  function openEdit(g) {
    const path = editPath(g);
    if (path) navigate(path, { state: { corr: { ...g } } });
  }
  async function rejectGroup(g, note) {
    if (!confirm('이 제안을 반려할까요?')) return;
    for (const id of g.ids) await call('reject_correction', { id, reason: note });
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
  }
  // 처리함: 이미 적용/반려한 제안에 사후 메모를 남긴다(제출자에게 다시 뜬다).
  async function annotateCorr(id, note) {
    const r = await call('annotate_correction', { id, reason: note });
    if (r.status === 'GONE') { alert('30일이 지나 정리된 제안입니다.'); return false; }
    if (!r.ok) { alert('메모 저장 실패: ' + (r.status ?? '오류')); return false; }
    setProcessedCorrs((prev) => {
      const hit = prev.find((c) => c.id === id);
      const rest = prev.filter((c) => c.id !== id);
      return hit ? [{ ...hit, reply: note || null }, ...rest] : prev;
    });
    return true;
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
        {reviewedAt && <span className="muted"> · {fmtDateTime(reviewedAt)} 확인처리됨</span>}
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
        <button className={`mod-tab ${tab === 'appreports' ? 'is-active' : ''}`} onClick={() => setTab('appreports')}>
          앱 문제
          {appReports.length > 0 && <span className="mod-tab-badge warn">{appReports.length}</span>}
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
                  <span className="mod-course">{it.courseCode}{it.meta?.sectionNo ? `·${it.meta.sectionNo}분반` : ''}</span>
                  {it.flags.length > 0 && <span className="tag tag-warn mod-badge">⚠ {it.flags.join(', ')}</span>}
                  <span className="mod-time">{fmtDateTime(it.createdAt)}</span>
                </div>

                {edit && edit.type === it.type && edit.id === it.id ? (
                  <div className="mod-edit">
                    <textarea value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} rows={3} />
                    <textarea className="ar-reply-ta" rows={2} value={edit.note ?? ''} maxLength={300}
                      placeholder="신고자에게 표시될 메모 (선택 — 신고 누적 중인 글에만 전달됩니다)"
                      onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
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
                  <button className="rev-del-btn" onClick={() => setEdit({ type: it.type, id: it.id, text: editableText(it), postId: it.meta?.postId, note: '' })}>수정</button>
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
            <ReportCard key={`rep-${it.type}-${it.id}`} it={it} fmtDateTime={fmtDateTime} navigate={navigate}
              onAck={ackReport} onDismiss={dismissReport} onDelete={remove}
              onEdit={(t, note) => saveEditFrom(it, t, note)} />
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
                  <li key={`auto-${g.id}`} className="card mod-card mod-auto flagged">
                    <div className="mod-card-top">
                      <span className="tag tag-primary mod-type">{g.target === 'section_add' ? '분반추가·자동' : '자동반영'}</span>
                      <span className="mod-course">{g.label || g.target} · <span className="mod-corr-field">{FIELD_LABEL[g.field] || g.field}</span></span>
                      {g.count > 1 && <span className="tag mod-badge">동일 {g.count}건</span>}
                      <span className="mod-time">{fmtDateTime(g.createdAt)}</span>
                    </div>
                    <p className="mod-corr-diff">
                      <span className="mod-diff-label">수정 전</span>
                      <span className="mod-diff-before">{g.prevValue ?? '—'}</span>
                      <span className="mod-diff-arrow">→</span>
                      <span className="mod-diff-label">수정 후</span>
                      <b className="mod-diff-after">{fmtCorrAfter(g)}</b>
                    </p>
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
            {corrGroups.map((g) => (
              <CorrectionCard key={`corr-${g.id}`} g={g} cat={cat} fmtDateTime={fmtDateTime}
                onApply={applyGroup} onReject={rejectGroup} onEdit={openEdit} />
            ))}
          </ul>

          {processedCorrs.length > 0 && (
            <>
              <h3 className="mod-subhead">처리함 <span className="mod-count">(처리 후 30일 보관 · 메모를 남기면 제출자에게 다시 표시됩니다)</span></h3>
              <ul className="mod-list">
                {processedCorrs.map((c) => (
                  <ProcessedCorrectionCard key={`pc-${c.id}`} c={c} fmtDateTime={fmtDateTime} onAnnotate={annotateCorr} />
                ))}
              </ul>
            </>
          )}
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
                  <span className="mod-course">{it.courseCode}</span>
                  <span className="tag tag-warn mod-badge">🚨 신고 {it.reportCount}건 · {REASON_LABEL[it.reason] || it.reason}</span>
                  {it.reviewed && <span className="tag mod-badge">확인됨</span>}
                  <span className="mod-time">{fmtDateTime(it.createdAt)}</span>
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

      {/* ⑤ 앱 문제 리포트 */}
      {tab === 'appreports' && (
        <>
          <p className="mod-status muted">
            사용자가 접수한 앱 문제 리포트입니다. 답변하면 그 사용자에게 앱 접속 시 공지처럼 뜨고(익명 유지),
            푸시 구독 중이면 알림도 갑니다. ‘확인’은 답변 없이 삭제(스팸용).
          </p>
          <ul className="mod-list">
            {appReports.length === 0 && (
              <li className="empty"><span className="empty-emoji">🐞</span><p>접수된 앱 문제가 없습니다.</p></li>
            )}
            {appReports.map((it) => (
              <AppReportCard key={`ar-${it.id}`} it={it} onReply={replyToAppReport} onAck={ackAppReport} fmtDateTime={fmtDateTime} />
            ))}
          </ul>

          {repliedReports.length > 0 && (
            <>
              <h3 className="mod-subhead">답변함</h3>
              <ul className="mod-list">
                {repliedReports.map((it) => (
                  <li key={`arr-${it.id}`} className="card mod-card">
                    <div className="mod-card-top">
                      <span className="tag mod-type">답변함</span>
                      <span className="mod-course">{it.path || '경로 없음'}</span>
                    </div>
                    <p className="mod-text">{it.text}</p>
                    <p className="mod-corr-note">↳ {REPLY_STATUS_LABEL[it.replyStatus] || '답변'} · {it.reply}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </PullToRefresh>
  );
}

const REPLY_STATUS_LABEL = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

// 제출자에게 그대로 전달되는 선택 메모. 적용/반려/삭제 어느 버튼을 눌러도 이 값이 실린다.
function ModMemo({ value, onChange }) {
  const [open, setOpen] = useState(!!value);
  if (!open) {
    return <button type="button" className="link-btn mod-memo-toggle" onClick={() => setOpen(true)}>↳ 제출자에게 메모</button>;
  }
  return (
    <textarea className="ar-reply-ta" rows={2} value={value} maxLength={300}
      placeholder="제출자에게 표시될 메모 (선택 — 예: '요일만 수정, 강의실은 그대로 두었어요')"
      onChange={(e) => onChange(e.target.value)} />
  );
}

function CorrectionCard({ g, cat, fmtDateTime, onApply, onReject, onEdit }) {
  const [note, setNote] = useState('');
  const highRisk = HIGH_RISK.has(`${g.target}:${g.field}`) && g.count >= 3;
  const memo = note.trim() || undefined;
  return (
    <li className={`card mod-card ${highRisk ? 'flagged' : ''}`}>
      <div className="mod-card-top">
        <span className="tag tag-primary mod-type">{g.target === 'section_add' ? '분반추가' : '수정제안'}</span>
        <span className="mod-course">{g.label || g.target} · <span className="mod-corr-field">{FIELD_LABEL[g.field] || g.field}</span></span>
        {g.count > 1 && <span className="tag mod-badge">동일 {g.count}건</span>}
        {highRisk && <span className="tag tag-warn mod-badge">⚠ 검토 필요</span>}
        <span className="mod-time">{fmtDateTime(g.createdAt)}</span>
      </div>
      <div className="mod-text">
        <p className="mod-corr-diff">
          <span className="mod-diff-label">현재</span>
          <span className="mod-diff-before">{currentValue(cat, g) ?? '—'}</span>
          <span className="mod-diff-arrow">→</span>
          <span className="mod-diff-label">제안</span>
          <b className="mod-diff-after">{g.suggested ? fmtCorrAfter(g) : '(제안값 없음)'}</b>
        </p>
        {g.note ? <p className="mod-corr-note">설명: {g.note}</p> : null}
      </div>
      <ModMemo value={note} onChange={setNote} />
      <div className="mod-actions">
        <button className="btn-add btn-sm" onClick={() => onApply(g, memo)}>{g.target === 'section_add' ? '분반 생성' : '적용'}</button>
        {editPath(g) && <button className="link-btn" onClick={() => onEdit(g)}>✏️ 편집에서 열기</button>}
        <button className="rev-del-btn" onClick={() => onReject(g, memo)}>반려</button>
      </div>
    </li>
  );
}

const CORR_STATUS_LABEL = { applied: '반영됨', rejected: '반려', resolved: '직접 수정' };

// 처리함 카드: 이미 적용/반려한 제안. 사후 메모를 남기거나 고칠 수 있다.
function ProcessedCorrectionCard({ c, fmtDateTime, onAnnotate }) {
  const [note, setNote] = useState(c.reply || '');
  const [busy, setBusy] = useState(false);
  const dirty = (note.trim() || '') !== (c.reply || '');
  const statusLabel = c.autoApplied ? '자동 반영' : (CORR_STATUS_LABEL[c.status] || c.status);

  async function save() {
    setBusy(true);
    await onAnnotate(c.id, note.trim() || undefined);
    setBusy(false);
  }

  return (
    <li className="card mod-card">
      <div className="mod-card-top">
        <span className={`tag mod-type ${c.status === 'rejected' ? 'tag-warn' : 'tag-primary'}`}>{statusLabel}</span>
        <span className="mod-course">{c.label || c.target} · <span className="mod-corr-field">{FIELD_LABEL[c.field] || c.field}</span></span>
        <span className="mod-time">{fmtDateTime(c.repliedAt)}</span>
      </div>
      {(c.prevValue || c.suggested) && (
        <p className="mod-corr-diff">
          <span className="mod-diff-label">이전</span>
          <span className="mod-diff-before">{c.prevValue ?? '—'}</span>
          <span className="mod-diff-arrow">→</span>
          <span className="mod-diff-label">제안</span>
          <b className="mod-diff-after">{c.suggested ? fmtCorrAfter(c) : '—'}</b>
        </p>
      )}
      {c.note ? <p className="mod-corr-note">설명: {c.note}</p> : null}
      <textarea className="ar-reply-ta" rows={2} value={note} maxLength={300}
        placeholder="제출자에게 남길 메모 (저장하면 앱에 다시 표시됩니다)"
        onChange={(e) => setNote(e.target.value)} />
      <div className="mod-actions">
        <button className="btn-add btn-sm" disabled={busy || !dirty} onClick={save}>
          {c.reply ? '메모 수정' : '메모 남기기'}
        </button>
      </div>
    </li>
  );
}

function ReportCard({ it, fmtDateTime, navigate, onAck, onDismiss, onDelete, onEdit }) {
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(it.text || '');
  const memo = note.trim() || undefined;
  const canEdit = it.type === 'review' || it.type === 'class_memo' || it.type === 'board_post';

  return (
    <li className="card mod-card flagged">
      <div className="mod-card-top">
        <span className="tag tag-primary mod-type">{TYPE_LABEL[it.type]}</span>
        <span className="mod-course">{it.courseCode}{it.meta?.sectionNo ? `·${it.meta.sectionNo}분반` : ''}</span>
        <span className="tag tag-warn mod-badge">🚨 신고 {it.reportCount}건</span>
        <span className="mod-time">{fmtDateTime(it.createdAt)}</span>
      </div>

      {editing ? (
        <textarea className="ar-reply-ta" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className={`mod-text${contentPath(it) ? ' mod-text-link' : ''}`}
          onClick={() => { const p = contentPath(it); if (p) navigate(p); }}>
          <Highlighted text={it.text || '(내용 없음)'} />
        </p>
      )}

      <ModMemo value={note} onChange={setNote} />

      <div className="mod-actions">
        {editing ? (
          <>
            <button className="btn-add btn-sm" onClick={() => { onEdit(text, memo); setEditing(false); }}>저장(수정 조치)</button>
            <button className="rev-del-btn" onClick={() => { setText(it.text || ''); setEditing(false); }}>취소</button>
          </>
        ) : (
          <>
            {contentPath(it) && <button className="link-btn" onClick={() => navigate(contentPath(it))}>원문 보기</button>}
            <button className="btn-add btn-sm" onClick={() => onAck(it)}>확인</button>
            {canEdit && <button className="link-btn" onClick={() => setEditing(true)}>수정</button>}
            <button className="btn-remove btn-sm" onClick={() => onDelete(it, memo)}>삭제</button>
            <button className="rev-del-btn" onClick={() => onDismiss(it, memo)}>무시(정상)</button>
          </>
        )}
      </div>
    </li>
  );
}

function AppReportCard({ it, onReply, onAck, fmtDateTime }) {
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState('resolved');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function send() {
    const t = reply.trim();
    if (t.length < 1) { setErr('답변을 입력하세요.'); return; }
    setBusy(true); setErr('');
    const r = await onReply(it, t, status);
    setBusy(false);
    if (!r.ok) setErr(r.status || '전송 실패');
  }

  return (
    <li className="card mod-card flagged">
      <div className="mod-card-top">
        <span className="tag tag-primary mod-type">앱 문제</span>
        <span className="mod-course">{it.path || '경로 없음'}</span>
        <span className="mod-time">{fmtDateTime(it.createdAt)}</span>
      </div>
      <p className="mod-text">{it.text}</p>
      <p className="mod-corr-note">
        {it.standalone ? '설치된 앱' : '브라우저'} · {it.ua || 'UA 없음'}
        {it.subId ? ' · 푸시 가능' : ' · 푸시 없음'}
        {it.sw ? ` · SW[${it.sw}]` : ''}
      </p>
      <textarea className="ar-reply-ta" rows={2} value={reply} placeholder="답변 (사용자에게 그대로 전달됩니다)"
        onChange={(e) => setReply(e.target.value)} maxLength={1000} />
      {err && <p className="error-msg">{err}</p>}
      <div className="mod-actions">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="reviewing">검토중</option>
          <option value="resolved">해결됨</option>
          <option value="planned">반영예정</option>
        </select>
        <button className="btn-add btn-sm" disabled={busy} onClick={send}>답변 보내기</button>
        <button className="btn-ghost btn-sm" disabled={busy} onClick={() => onAck(it)}>확인(삭제)</button>
      </div>
    </li>
  );
}

// 수정 대상 텍스트(편집 가능한 필드)
function editableText(it) {
  return it.text || '';
}
