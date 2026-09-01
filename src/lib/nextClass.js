// =====================================================================
//  "다음 수업" 푸시 알림 — 수업 시작 N분 전(5/10/15) 알림, 또는 끄기.
//
//  익명성(접근 B): 과목·강의실 같은 '내용'은 이 기기의 Cache API 에만 두고,
//  서버 구독 문서(pushSubscriptions/{hash})에는 '발동 시각'(주간 분값) 목록만 올린다.
//  서버가 매분 도는 onSchedule(nextClassNotify)로 지금 시각에 걸리는 구독에 내용 없는
//  핑을 쏘면, SW(public/push-sw.js)가 이 Cache 에서 해당 슬롯의 과목·강의실을 꺼내
//  알림을 그린다. push.js 의 /dnd-config 미러와 완전히 같은 패턴.
//
//  대상: 현재 학기 '확정(primary)' 시간표에 담긴 분반 + 직접추가 강의.
//  공통 공강(commonBlocks)은 애초에 저장되지 않으므로 자연히 제외된다.
//  설계: docs/superpowers/specs/2026-09-01-next-class-alert-design.md
// =====================================================================
import { auth } from '../firebase';
import { callFn } from './functions';
import { getCatalog, buildMyTimetable, currentSemester } from './cache';
import { listTimetables, listEntries } from './timetable';
import { listCustomClasses, minToHM } from './customClass';
import { parseHM } from './timetableLayout';
import { META_CACHE, pushEnabled } from './push';

export const NEXT_CLASS_LEADS = [0, 5, 10, 15];
const LEAD_KEY = 'nextclass:lead';
const SIG_KEY = 'nextclass:sig';
const RAN_KEY = 'nextclass:ranAt';             // 마지막 성공 동기화 시각 — 포그라운드 복귀마다 재조회 방지
const THROTTLE_MS = 3 * 60 * 1000;
const SCHEDULE_URL = '/next-class-schedule';   // push-sw.js 와 맞출 것
const MINUTES_PER_WEEK = 7 * 24 * 60;
// 같은 과목이 붙어 이어지면(교시 사이 쉬는시간 포함) 한 블록으로 본다 — "다음 교시가
// 같은 수업이면 알림 생략"(요구사항). 20분이면 사관학교 교시 쉬는시간(10분)을 덮는다.
const MERGE_GAP_MIN = 20;

export function getLead() {
  const v = Number(localStorage.getItem(LEAD_KEY));
  return NEXT_CLASS_LEADS.includes(v) ? v : 0;
}
export function setLeadPref(n) {
  try { localStorage.setItem(LEAD_KEY, String(n)); } catch { /* 무시 */ }
}

// 확정 시간표(mine) + 직접추가 강의 → 요일별 "수업 블록"
//   [{ day(1~7), startMin, endMin, subject, room }]  (같은 과목 연속 교시는 1개로 병합)
export function computeBlocks(catalog, entries, customClasses, sem) {
  const { mine, periods } = buildMyTimetable(catalog, entries, sem);
  const periodByNo = Object.fromEntries((periods || []).map((p) => [p.no, p]));
  const raw = [];
  for (const s of mine) {
    for (const t of s.times || []) {
      const startMin = parseHM(periodByNo[t.startPeriod]?.startTime);
      const endMin = parseHM(periodByNo[t.endPeriod]?.endTime);
      if (startMin == null || endMin == null || endMin <= startMin) continue;
      raw.push({ day: t.dayOfWeek, startMin, endMin, subject: s.courseName, room: t.room || '' });
    }
  }
  for (const c of customClasses || []) {
    if (c.startMin == null || c.endMin == null || c.endMin <= c.startMin) continue;
    raw.push({ day: c.day, startMin: c.startMin, endMin: c.endMin, subject: c.title, room: c.room || '' });
  }
  raw.sort((a, b) => a.day - b.day || a.startMin - b.startMin);
  const out = [];
  for (const b of raw) {
    const last = out[out.length - 1];
    if (last && last.day === b.day && last.subject === b.subject && b.startMin - last.endMin <= MERGE_GAP_MIN) {
      last.endMin = Math.max(last.endMin, b.endMin);
      if (!last.room && b.room) last.room = b.room;
      continue;
    }
    out.push({ ...b });
  }
  return out;
}

// 블록 목록 + lead → { fireMinutes:[주간분값], slots:{ [주간분값]: {subject,room,start} } }
// 주간 분값: 월요일 00:00 = 0 … 일요일 23:59 = 10079 (서버 nextClassNotify 와 동일 규약).
export function blocksToSchedule(blocks, lead) {
  const slots = {};
  for (const b of blocks) {
    let fire = b.startMin - lead;
    let day = b.day;
    if (fire < 0) { fire += 1440; day = day === 1 ? 7 : day - 1; }   // 자정 넘어 앞당겨진 경우
    const mow = ((day - 1) * 1440 + fire + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    slots[mow] = { subject: b.subject, room: b.room || '', start: minToHM(b.startMin) };
  }
  const fireMinutes = Object.keys(slots).map(Number).sort((a, b) => a - b);
  return { fireMinutes, slots };
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
export function clearSig() { try { localStorage.removeItem(SIG_KEY); } catch { /* 무시 */ } }

// 앱 시작(App.jsx PushSync)·포그라운드 복귀·설정 변경 때 호출. lead 0 이면 서버 필드·기기
// 캐시를 비운다. 낡음(다른 기기에서 시간표를 고쳐도 이 기기는 다음 실행에나 반영)은
// 감수 — 학기 중 시간표는 거의 안 바뀐다. force=true 는 설정 변경처럼 즉시 반영이 필요할 때.
export async function syncNextClassAlerts({ force = false } = {}) {
  if (!pushEnabled()) return;
  if (!('serviceWorker' in navigator)) return;
  if (!force) {
    const ranAt = Number(localStorage.getItem(RAN_KEY) || 0);
    if (Date.now() - ranAt < THROTTLE_MS) return;   // 포그라운드 복귀마다 카탈로그·시간표 재조회 방지
  }

  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  const lead = getLead();

  let fireMinutes = [];
  let slots = {};
  if (lead > 0) {
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
        ({ fireMinutes, slots } = blocksToSchedule(computeBlocks(catalog, entries, customs, sem), lead));
      }
    }
  }

  const active = lead > 0 && fireMinutes.length > 0;
  if (active) {
    // 내용을 기기 캐시에 못 넣었으면 서버에 발동 시각도 올리지 않는다(내용 없는 빈 핑 방지).
    if (!(await mirrorSchedule({ lead, tz: 'Asia/Seoul', slots, updatedAt: Date.now() }))) return;
  } else {
    await clearSchedule();
  }
  try { localStorage.setItem(RAN_KEY, String(Date.now())); } catch { /* 무시 */ }

  const sig = `${endpoint}|${active ? lead : 0}|${fireMinutes.join(',')}`;
  if (sig === readSig()) return;
  const res = await callFn('setNextClassAlerts', {
    endpoint,
    lead: active ? lead : 0,
    fireMinutes: active ? fireMinutes : [],
  });
  if (res.ok) writeSig(sig);
}
