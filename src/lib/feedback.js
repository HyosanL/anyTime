import { callFn } from './functions';

// 제안·신고 결과 회신 — 익명 유지. 서버는 제출자를 모르고, 이 기기가 자기 제안 ID·신고
// 콘텐츠 참조를 쥐고 결과를 조회한다. 설계:
// docs/superpowers/specs/2026-09-03-feedback-corrections-reports-design.md
const MINE_KEY = 'feedback:mine';   // { appReport: [{id,summary,at}], correction: [{id,summary,at}] }
const SEEN_KEY = 'feedback:seen';   // ["appReport:<id>", "correction:<id>", "content:<type>_<id>"]
const TSEEN_KEY = 'feedback:threadSeen'; // { "<threadKey>": <lastSeenSeq> }
const REACTED_KEY = 'bb-reacted';   // reactions.js 와 공유 — 신고한 콘텐츠 추적
const MAX = 30;

// 스레드별 "여기까지 읽음" seq. 서버 threadId 는 클라가 모르지만 채널+ref 로 안정적인
// 로컬 키를 만든다(이 기기 안에서만 쓴다). item.kind ∈ 'correction'|'appReport'|'content'.
export function threadKeyOf(item) {
  if (item.kind === 'correction') return `correction:${item.id}`;
  if (item.kind === 'appReport') return `appReport:${item.id}`;
  if (item.kind === 'content') return `content:${item.type}_${item.id}`;
  return null;
}
export function readThreadSeen() { return readObj(TSEEN_KEY, {}); }
export function markThreadSeen(key, seq) {
  if (!key || !(seq > 0)) return;
  const all = readThreadSeen();
  if (!(all[key] >= seq)) { all[key] = seq; writeObj(TSEEN_KEY, all); }
}
function lastAdminSeq(thread) {
  if (!thread || !thread.messages) return 0;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    if (thread.messages[i].who === 'admin') return thread.messages[i].seq;
  }
  return 0;
}

function readObj(key, fb) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' ? v : fb; }
  catch { return fb; }
}
function writeObj(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ } }
function readArr(key) { const v = readObj(key, []); return Array.isArray(v) ? v : []; }

function readMineAll() {
  const o = readObj(MINE_KEY, {});
  return { appReport: Array.isArray(o.appReport) ? o.appReport : [], correction: Array.isArray(o.correction) ? o.correction : [] };
}
function recordSubmission(kind, entry) {
  const all = readMineAll();
  all[kind] = [{ ...entry, at: Date.now() }, ...all[kind].filter((x) => x.id !== entry.id)].slice(0, MAX);
  writeObj(MINE_KEY, all);
}
function pruneMine(kind, existingIds) {
  const all = readMineAll();
  const keep = new Set(existingIds);
  all[kind] = all[kind].filter((x) => keep.has(x.id));
  writeObj(MINE_KEY, all);
}

export function readSeen() { return readArr(SEEN_KEY); }
export function markSeen(keys) {
  const set = new Set([...readSeen(), ...keys]);
  writeObj(SEEN_KEY, [...set].slice(-200));
}

// bb-reacted 에서 report:true 인 콘텐츠 → getMyFeedback 이 이해하는 {type,id}.
// reactions.js scope: post|review|memo  →  deletedContent.type: board_post|review|class_memo
const SCOPE_TO_TYPE = { post: 'board_post', review: 'review', memo: 'class_memo' };
function reportedContentRefs() {
  const all = readObj(REACTED_KEY, {});
  const out = [];
  for (const [k, v] of Object.entries(all)) {
    if (!v || v.report !== true) continue;
    const [scope, ...rest] = k.split(':');
    const type = SCOPE_TO_TYPE[scope];
    if (type && rest.length) out.push({ type, id: rest.join(':') });
  }
  return out.slice(0, MAX);
}

async function currentEndpoint() {
  try {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch { return null; }
}

export async function submitAppReport({ text, path, ua, standalone, sw }) {
  const endpoint = await currentEndpoint();
  const r = await callFn('submitAppReport', { text, path, ua, standalone, sw, ...(endpoint ? { endpoint } : {}) });
  if (r.ok && r.data?.id) recordSubmission('appReport', { id: r.data.id, summary: String(text).slice(0, 200) });
  return { ok: r.ok, id: r.data?.id, message: r.message };
}

export async function submitCorrection(payload) {
  const endpoint = await currentEndpoint();
  const r = await callFn('submitCorrection', { ...payload, ...(endpoint ? { endpoint } : {}) });
  if (r.ok && r.data?.id) recordSubmission('correction', { id: r.data.id, summary: payload.label || '수정 제안' });
  return { ok: r.ok, id: r.data?.id, applied: r.data?.applied, message: r.message };
}

// 앱 리포트 모달의 '내가 보낸 리포트' 용 — 앱 리포트만.
export async function fetchMyAppReports() {
  return (await fetchFeedback()).appReports;
}

// 콘텐츠 신고 CF 호출 시 현재 푸시 endpoint 를 함께 실어 스레드 알림을 받게 한다.
export async function pushEndpoint() { return currentEndpoint(); }

// 스레드 답장 — 익명. ref: {correctionId} | {appReportId} | {contentRef:{type,id}}
export async function replyToThread(channel, ref, text) {
  const endpoint = await currentEndpoint();
  const r = await callFn('replyFeedbackThread', {
    channel, text, ...ref, ...(endpoint ? { endpoint } : {}),
  });
  return { ok: r.ok, status: r.status };
}

// 🚩 배지 수 — 스레드에 안 읽은 관리자 메시지가 있거나, 처리 완료인데 결과를 아직 안 본 항목 수.
export function unreadCount(feedback) {
  const seenT = readThreadSeen();
  const seen = new Set(readSeen());
  let n = 0;
  const scan = (item) => {
    const key = threadKeyOf(item);
    const t = item.thread;
    const newAdmin = t && lastAdminSeq(t) > (seenT[key] ?? 0);
    const newOutcome = (t && t.status === 'closed' && !seen.has(key))
      || (item.kind === 'correction' && !t && ['applied', 'rejected', 'resolved'].includes(item.status) && !seen.has(key))
      || (item.kind === 'content' && !t && item.outcome && !seen.has(key));
    if (newAdmin || newOutcome) n += 1;
  };
  (feedback.corrections || []).forEach((c) => scan({ ...c, kind: 'correction' }));
  (feedback.appReports || []).forEach((a) => scan({ ...a, kind: 'appReport' }));
  (feedback.contentReports || []).forEach((c) => scan({ ...c, kind: 'content' }));
  return n;
}

export async function fetchFeedback() {
  const mine = readMineAll();
  const contentReports = reportedContentRefs();
  const empty = { appReports: [], corrections: [], contentReports: [] };
  if (!mine.appReport.length && !mine.correction.length && !contentReports.length) return empty;

  const r = await callFn('getMyFeedback', {
    appReportIds: mine.appReport.map((m) => m.id),
    correctionIds: mine.correction.map((m) => m.id),
    contentReports,
  });
  if (!r.ok) return empty;

  const appReports = r.data?.appReports ?? [];
  const corrections = r.data?.corrections ?? [];
  pruneMine('appReport', appReports.map((i) => i.id));
  pruneMine('correction', corrections.map((i) => i.id));

  // 제출 순서 유지 + 로컬 summary 보강
  const after = readMineAll();
  const sumOf = (kind, id) => after[kind].find((m) => m.id === id)?.summary ?? '';
  return {
    appReports: appReports.map((i) => ({ ...i, summary: i.text || sumOf('appReport', i.id) })),
    corrections: corrections.map((i) => ({ ...i, summary: sumOf('correction', i.id) || i.label || '수정 제안' })),
    contentReports: r.data?.contentReports ?? [],
  };
}
