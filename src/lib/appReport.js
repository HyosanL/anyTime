import { callFn } from './functions';

// 앱 문제 리포트 — 익명 유지. 서버는 작성자를 모르고, 이 기기가 자기 리포트 ID 를
// localStorage 에 쥐고 있다가 답변을 조회한다. 설계:
// docs/superpowers/specs/2026-09-03-app-report-reply-design.md
const MINE_KEY = 'appReport:mine';
const SEEN_KEY = 'appReport:seenReplies';
const MAX_MINE = 20;

function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return Array.isArray(v) ? v : fallback; }
  catch { return fallback; }
}
function writeJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignore */ }
}

export function readMyReports() {
  return readJSON(MINE_KEY, []);
}
function recordMyReport(id, text) {
  const next = [{ id, text: String(text).slice(0, 200), at: Date.now() }, ...readMyReports().filter((r) => r.id !== id)]
    .slice(0, MAX_MINE);
  writeJSON(MINE_KEY, next);
}
// 서버에 존재하는 ID 만 로컬에 남긴다(purge 된 리포트 정리).
function pruneMyReports(existingIds) {
  const keep = new Set(existingIds);
  writeJSON(MINE_KEY, readMyReports().filter((r) => keep.has(r.id)));
}

export function readSeenReplies() {
  return readJSON(SEEN_KEY, []);
}
export function markReplySeen(ids) {
  const set = new Set([...readSeenReplies(), ...ids]);
  writeJSON(SEEN_KEY, [...set].slice(-100));
}

// 현재 푸시 구독 endpoint(있으면) — 답변을 그 기기에 푸시하기 위해서만 서버에 넘긴다.
async function currentEndpoint() {
  try {
    if (!('serviceWorker' in navigator)) return null;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch { return null; }
}

export async function submitReport({ text, path, ua, standalone }) {
  const endpoint = await currentEndpoint();
  const r = await callFn('submitAppReport', { text, path, ua, standalone, ...(endpoint ? { endpoint } : {}) });
  if (r.ok && r.data?.id) recordMyReport(r.data.id, text);
  return { ok: r.ok, id: r.data?.id, message: r.message };
}

// 내 리포트들의 최신 상태·답변. 서버에 없는 로컬 항목은 정리한다.
export async function fetchMyReports() {
  const mine = readMyReports();
  if (!mine.length) return [];
  const r = await callFn('getMyAppReports', { ids: mine.map((m) => m.id) });
  if (!r.ok) return mine.map((m) => ({ id: m.id, text: m.text, status: 'pending', reply: null, replyStatus: null, repliedAt: null }));
  const items = r.data?.items ?? [];
  pruneMyReports(items.map((i) => i.id));
  // 최신 제출 순서 유지
  const order = new Map(mine.map((m, i) => [m.id, i]));
  return [...items].sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}
