// =====================================================================
//  "오늘 수업 요약" 푸시 알림 — 사용자가 정한 시각에 그날 수업 전체를 한 번에.
//
//  다음 수업 알림(nextClass.js)과 완전히 같은 접근 B 를 재사용한다: 내용(과목·
//  강의실 목록)은 이 기기의 Cache API 에만 두고, 서버 구독 문서
//  (pushSubscriptions/{hash})에는 '발동 시각'(주간 분값, 요일당 최대 1개) 목록만
//  올린다. computeBlocks() 는 nextClass.js 것을 그대로 재사용한다 — 대상·병합
//  규칙이 다음 수업 알림과 같아야 하므로(같은 시간표를 본다) 따로 만들지 않는다.
//  이 알림은 다음 수업 알림과 독립적으로 켜고 끌 수 있다.
//  설계: docs/superpowers/specs/2026-09-03-daily-brief-and-app-report-design.md
// =====================================================================
import { auth } from '../firebase';
import { callFn } from './functions';
import { getCatalog, currentSemester } from './cache';
import { listTimetables, listEntries } from './timetable';
import { listCustomClasses, minToHM } from './customClass';
import { parseHM } from './timetableLayout';
import { META_CACHE, pushEnabled } from './push';
import { computeBlocks } from './nextClass';

const ON_KEY = 'dailybrief:on';
const TIME_KEY = 'dailybrief:hhmm';
const SIG_KEY = 'dailybrief:sig';
const RAN_KEY = 'dailybrief:ranAt';
const THROTTLE_MS = 3 * 60 * 1000;
const SCHEDULE_URL = '/today-summary-schedule';   // push-sw.js 와 맞출 것
const MINUTES_PER_WEEK = 7 * 24 * 60;
const DEFAULT_TIME = '07:30';
const MAX_LINES = 6;   // 알림 본문 과다 방지 — 초과분은 "외 N개 더"로 축약

export function briefOn() { return localStorage.getItem(ON_KEY) === '1'; }
export function setBriefOn(v) {
  try { v ? localStorage.setItem(ON_KEY, '1') : localStorage.removeItem(ON_KEY); } catch { /* 무시 */ }
}
export function getBriefTime() {
  const v = localStorage.getItem(TIME_KEY);
  return /^\d{1,2}:\d{2}$/.test(v || '') ? v : DEFAULT_TIME;
}
export function setBriefTime(hhmm) {
  try { localStorage.setItem(TIME_KEY, hhmm); } catch { /* 무시 */ }
}

// 요일별 블록 목록 → "09:00 경제원론 · 302\n11:00 물리학 · 401" 형태 문구.
// 6개 초과는 앞 6개만 담고 "외 N개 더"를 덧붙인다(알림 본문 과다 방지).
export function formatDayBrief(dayBlocks) {
  const lines = dayBlocks.map((b) => `${minToHM(b.startMin)} ${[b.subject, b.room].filter(Boolean).join(' · ')}`);
  if (lines.length <= MAX_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_LINES), `외 ${lines.length - MAX_LINES}개 더`].join('\n');
}

// computeBlocks() 결과(요일·시작순 정렬됨) + 브리핑 시각 → 서버에 올릴 발동 시각과
// 기기에 남길 요일별 문구. 수업이 없는 요일은 아예 만들지 않는다(빈 알림 없음).
export function buildBriefSchedule(blocks, hhmm) {
  const t = parseHM(hhmm);
  if (t == null) return { fireMinutes: [], byDay: {} };
  const byDayBlocks = {};
  for (const b of blocks) (byDayBlocks[b.day] ??= []).push(b);
  const byDay = {};
  const fireMinutes = [];
  for (const [day, dayBlocks] of Object.entries(byDayBlocks)) {
    if (!dayBlocks.length) continue;
    byDay[day] = formatDayBrief(dayBlocks);
    fireMinutes.push(((Number(day) - 1) * 1440 + t + MINUTES_PER_WEEK) % MINUTES_PER_WEEK);
  }
  return { fireMinutes: fireMinutes.sort((a, b) => a - b), byDay };
}

async function mirrorSchedule(payload) {
  if (!('caches' in window)) return false;
  try {
    const c = await caches.open(META_CACHE);
    await c.put(SCHEDULE_URL, new Response(JSON.stringify(payload)));
    return true;
  } catch { return false; }
}
async function clearSchedule() {
  try { await (await caches.open(META_CACHE)).delete(SCHEDULE_URL); } catch { /* 무시 */ }
}

function readSig() { try { return localStorage.getItem(SIG_KEY); } catch { return null; } }
function writeSig(s) { try { localStorage.setItem(SIG_KEY, s); } catch { /* 무시 */ } }
export function clearBriefSig() { try { localStorage.removeItem(SIG_KEY); } catch { /* 무시 */ } }

// 앱 시작(App.jsx PushSync)·포그라운드 복귀·설정 변경 때 호출. nextClass.js 의
// syncNextClassAlerts 와 완전히 같은 흐름이되, "다음 수업 알림"의 on/off 와는 무관하게
// 독립적으로 동작한다(이 파일만의 on 플래그를 따로 둔다).
export async function syncDailyBrief({ force = false } = {}) {
  if (!pushEnabled()) return;
  if (!('serviceWorker' in navigator)) return;
  if (!force) {
    const ranAt = Number(localStorage.getItem(RAN_KEY) || 0);
    if (Date.now() - ranAt < THROTTLE_MS) return;
  }

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  const on = briefOn();

  let fireMinutes = [];
  let byDay = {};
  if (on) {
    const catalog = await getCatalog().catch(() => null);
    const sem = catalog ? currentSemester(catalog) : null;
    if (catalog && sem) {
      const list = await listTimetables().catch(() => []);
      const primary = list.find((t) => t.year === sem.year && t.term === sem.term && t.isPrimary);
      if (primary) {
        const uid = auth.currentUser?.uid;
        const [entries, customs] = await Promise.all([
          listEntries(primary.id).catch(() => []),
          listCustomClasses(uid, primary.id).catch(() => []),
        ]);
        ({ fireMinutes, byDay } = buildBriefSchedule(computeBlocks(catalog, entries, customs, sem), getBriefTime()));
      }
    }
  }

  const active = on && fireMinutes.length > 0;
  if (active) {
    // 내용을 기기 캐시에 못 넣었으면 서버에 발동 시각도 올리지 않는다(내용 없는 빈 핑 방지).
    if (!(await mirrorSchedule({ hhmm: getBriefTime(), tz: 'Asia/Seoul', byDay, updatedAt: Date.now() }))) return;
  } else {
    await clearSchedule();
  }
  try { localStorage.setItem(RAN_KEY, String(Date.now())); } catch { /* 무시 */ }

  const sig = `${endpoint}|${active ? 1 : 0}|${fireMinutes.join(',')}`;
  if (sig === readSig()) return;
  const res = await callFn('setTodaySummaryAlert', {
    endpoint,
    fireMinutes: active ? fireMinutes : [],
  });
  if (res.ok) writeSig(sig);
}
