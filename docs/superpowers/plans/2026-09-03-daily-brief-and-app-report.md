# 오늘 수업 요약 + 앱 문제 리포트 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two independent features: (1) a daily "오늘 수업 요약" push notification fired at a user-chosen time listing that day's classes, alongside the existing per-class "다음 수업 알림"; (2) an anonymous "앱 문제 리포트" channel (🚩 icon on Home) that lets a cadet report app bugs, reviewed by admins in the existing 검열(Moderation) screen.

**Architecture:** Both features reuse the app's established "접근 B" push pattern — content lives only in the device's Cache API, the server (Firestore `pushSubscriptions/{hash}`) only ever learns *when* to ping (weekly-minute integers), and the existing per-minute `nextClassNotify` scheduled function is extended (not duplicated) to also match on a new field. The app-report channel reuses the anonymous-submission + `adminPush` + Moderation-tab pattern already established by `corrections.js`.

**Tech Stack:** React 19 + Vite (frontend), Firebase Cloud Functions v2 (Node 22, Firestore), Cloudflare Pages Functions (`functions/api/push-fanout.js`), no test framework — this repo verifies pure logic with throwaway Node scratch scripts (see `docs/superpowers/specs/2026-09-01-next-class-alert-design.md` §Ⅷ) and verifies integration by building (`npm run build`) plus manual on-device checks after deploy.

## Global Constraints

- No author/uid is ever stored on `appReports` or push-subscription docs — anonymity is a hard project rule ([[board-full-anonymity]] memory). `requireAuth` gates calls; nothing persists `uid`.
- Never re-run `db/schema.sql` against live Supabase — irrelevant here (this plan touches zero Supabase/Postgres objects, only Firebase/Firestore + the Cloudflare Pages frontend and `functions/api/push-fanout.js`).
- `public/push-sw.js` changes are invisible to installed clients unless `vite.config.js`'s `importScripts: ['push-sw.js?v=N']` version is bumped — bump it in the same task that edits `push-sw.js`.
- Firebase deploy (`functions`, `firestore:rules`, `firestore:indexes`) only happens via `.github/workflows/deploy-firebase.yml` on push to `main` — it cannot be run from this sandbox (needs `storage.googleapis.com`, unreachable here). Cloudflare Pages redeploys the frontend on the same push via its Git integration. **"Deploy" in this plan means: commit, then `git push origin main`.**
- Spec: `docs/superpowers/specs/2026-09-03-daily-brief-and-app-report-design.md`.

---

### Task 1: Backend — `setTodaySummaryAlert` + extend `nextClassNotify`

**Files:**
- Modify: `firebase/functions/src/nextClass.js:64-125`
- Modify: `firebase/functions/index.js:80`

**Interfaces:**
- Produces: `setTodaySummaryAlert` (onCall, payload `{ endpoint, fireMinutes }` → `{ status: 'OK' }`), consumed by Task 3's `syncDailyBrief`.
- Produces: `nextClassNotify` now also matches `todaySummaryAlerts.fireMinutes` and sends `pushFanout(..., { kind: 'today_summary', mow, path: '/' }, targets)`, consumed by Task 7's `showTodaySummary` in the SW.

- [ ] **Step 1: Insert `setTodaySummaryAlert` right after `setNextClassAlerts`**

In `firebase/functions/src/nextClass.js`, find this exact text (the end of `setNextClassAlerts`, currently lines 62-64):

```js
  return { status: 'OK' };
});

// 매분 실행. 지금(±1분) 발동할 구독에 '내용 없는' 핑을 보낸다. Cloud Scheduler 지연·누락에
```

Replace it with:

```js
  return { status: 'OK' };
});

// "오늘 수업 요약" 발동 시각 등록 — setNextClassAlerts 의 자매 함수. lead 개념이 없다(사용자가
// 절대 시각을 직접 고른다). 요일당 최대 1개라 fireMinutes 상한을 60이 아니라 7로 좁힌다.
// 설계: docs/superpowers/specs/2026-09-03-daily-brief-and-app-report-design.md.
export const setTodaySummaryAlert = onCall(async (request) => {
  requireAuth(request);
  const { endpoint, fireMinutes } = request.data ?? {};
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1024) {
    invalid('잘못된 구독 정보입니다.');
  }
  const mins = Array.isArray(fireMinutes) ? fireMinutes : [];
  if (mins.length > 7 || mins.some((m) => !Number.isInteger(m) || m < 0 || m >= MINUTES_PER_WEEK)) {
    invalid('잘못된 알림 설정입니다.');
  }

  const ref = db.collection('pushSubscriptions').doc(subscriptionId(endpoint));
  const snap = await ref.get();
  if (!snap.exists) return { status: 'OK' };

  if (mins.length === 0) {
    await ref.update({ todaySummaryAlerts: FieldValue.delete() });
  } else {
    await ref.set(
      {
        todaySummaryAlerts: {
          fireMinutes: [...new Set(mins)].sort((a, b) => a - b),
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );
  }
  return { status: 'OK' };
});

// 매분 실행. 지금(±1분) 발동할 구독에 '내용 없는' 핑을 보낸다. Cloud Scheduler 지연·누락에
```

- [ ] **Step 2: Refactor `nextClassNotify` to also match `todaySummaryAlerts`**

Find this exact text (the rest of the file, from the `DEDUPE_MS` comment to the closing `);` of `nextClassNotify` — currently lines 71-125):

```js
// 중복 억제: 정상 스케줄에서도 발동 분값 F 는 매분 조회에 두 번 걸린다 — F 분엔 mow 로,
// F+1 분엔 직전 1분(back)으로. 방금(≤3분) 같은 분값으로 보낸 구독은 건너뛰어, 스케줄러가
// F 분을 통째로 건너뛴 경우(스탬프 없음)에만 back 조회가 실제 발송으로 이어지게 한다.
// 스케줄러 중복 실행(at-least-once)도 같은 스탬프로 막힌다. 7일 뒤 같은 분값 재사용은
// 타임스탬프 창(3분)이 지나 정상 발송된다.
const DEDUPE_MS = 3 * 60 * 1000;

export const nextClassNotify = onSchedule(
  { schedule: '* * * * *', timeZone: 'Asia/Seoul', secrets: [pushFanoutUrl, pushFanoutSecret] },
  async () => {
    const mow = seoulMinuteOfWeek();
    const back = (mow - 1 + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    const snap = await db
      .collection('pushSubscriptions')
      .where('nextClassAlerts.fireMinutes', 'array-contains-any', [mow, back])
      .get();
    if (snap.empty) return;

    const now = Date.now();
    const byMow = new Map();  // 매칭된 분값 → 대상 구독 목록
    const toStamp = [];       // 발송 후 lastFired 를 찍을 { ref, mow } 목록
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d.endpoint || !d.p256dh || !d.auth) continue;
      const na = d.nextClassAlerts || {};
      const fm = na.fireMinutes || [];
      const hit = fm.includes(mow) ? mow : fm.includes(back) ? back : null;
      if (hit == null) continue;
      const lf = na.lastFired;
      if (lf && lf.mow === hit && typeof lf.at?.toMillis === 'function'
          && now - lf.at.toMillis() < DEDUPE_MS) continue;
      if (!byMow.has(hit)) byMow.set(hit, []);
      byMow.get(hit).push({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
      toStamp.push({ ref: doc.ref, mow: hit });
    }
    if (!byMow.size) return;

    for (const [hit, targets] of byMow) {
      await pushFanout(
        pushFanoutUrl.value(),
        pushFanoutSecret.value(),
        { kind: 'next_class', mow: hit, path: '/' },
        targets
      );
    }

    // 발송한 구독에 lastFired 를 찍는다(다음 분 back 조회의 중복 억제). fire-and-forget
    // 설계라 발송 성패와 무관하게 찍는다 — 스케줄러가 F 분을 통째로 건너뛰면 이 스탬프가
    // 아예 없어 back 조회가 정상적으로 놓친 알림을 잡는다. 개별 실패(그 사이 구독 해지 등)는
    // 서로 영향 없게 allSettled 로 흘린다.
    await Promise.allSettled(toStamp.map(({ ref, mow: hit }) =>
      ref.update({ 'nextClassAlerts.lastFired': { mow: hit, at: FieldValue.serverTimestamp() } })
    ));
  }
);
```

Replace it with:

```js
// 중복 억제: 정상 스케줄에서도 발동 분값 F 는 매분 조회에 두 번 걸린다 — F 분엔 mow 로,
// F+1 분엔 직전 1분(back)으로. 방금(≤3분) 같은 분값으로 보낸 구독은 건너뛰어, 스케줄러가
// F 분을 통째로 건너뛴 경우(스탬프 없음)에만 back 조회가 실제 발송으로 이어지게 한다.
// 스케줄러 중복 실행(at-least-once)도 같은 스탬프로 막힌다. 7일 뒤 같은 분값 재사용은
// 타임스탬프 창(3분)이 지나 정상 발송된다.
const DEDUPE_MS = 3 * 60 * 1000;

// 구독 목록 중 field(예: 'nextClassAlerts'/'todaySummaryAlerts')가 지금(mow)·직전 1분(back)에
// 걸리는 것만 추려 { byMow: Map<발동분값, 대상[]>, toStamp: [{ref, mow}] } 로 만든다.
// 두 알림 종류가 완전히 같은 매칭·중복억제 규칙을 쓰므로 한 곳에 둔다.
function collectMatches(snap, field, mow, back, now) {
  const byMow = new Map();
  const toStamp = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    if (!d.endpoint || !d.p256dh || !d.auth) continue;
    const na = d[field] || {};
    const fm = na.fireMinutes || [];
    const hit = fm.includes(mow) ? mow : fm.includes(back) ? back : null;
    if (hit == null) continue;
    const lf = na.lastFired;
    if (lf && lf.mow === hit && typeof lf.at?.toMillis === 'function'
        && now - lf.at.toMillis() < DEDUPE_MS) continue;
    if (!byMow.has(hit)) byMow.set(hit, []);
    byMow.get(hit).push({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
    toStamp.push({ ref: doc.ref, mow: hit });
  }
  return { byMow, toStamp };
}

// byMow 를 실제로 보내고, 보낸 구독에 그 알림 종류만의 lastFired 를 찍는다(두 알림 종류가
// 서로 다른 네임스페이스에 독립적으로 중복억제되어야 하므로 stampField 로 구분).
async function sendAndStamp(kind, byMow, toStamp, stampField) {
  if (!byMow.size) return;
  for (const [hit, targets] of byMow) {
    await pushFanout(pushFanoutUrl.value(), pushFanoutSecret.value(), { kind, mow: hit, path: '/' }, targets);
  }
  // 발송 성패와 무관하게 찍는다(fire-and-forget) — 스케줄러가 그 분을 통째로 건너뛰면 이
  // 스탬프가 아예 없어 back 조회가 정상적으로 놓친 알림을 잡는다. 개별 실패는 allSettled 로 흘린다.
  await Promise.allSettled(toStamp.map(({ ref, mow: hit }) =>
    ref.update({ [`${stampField}.lastFired`]: { mow: hit, at: FieldValue.serverTimestamp() } })
  ));
}

export const nextClassNotify = onSchedule(
  { schedule: '* * * * *', timeZone: 'Asia/Seoul', secrets: [pushFanoutUrl, pushFanoutSecret] },
  async () => {
    const mow = seoulMinuteOfWeek();
    const back = (mow - 1 + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    const now = Date.now();

    const [ncSnap, tsSnap] = await Promise.all([
      db.collection('pushSubscriptions').where('nextClassAlerts.fireMinutes', 'array-contains-any', [mow, back]).get(),
      db.collection('pushSubscriptions').where('todaySummaryAlerts.fireMinutes', 'array-contains-any', [mow, back]).get(),
    ]);

    if (!ncSnap.empty) {
      const { byMow, toStamp } = collectMatches(ncSnap, 'nextClassAlerts', mow, back, now);
      await sendAndStamp('next_class', byMow, toStamp, 'nextClassAlerts');
    }
    if (!tsSnap.empty) {
      const { byMow, toStamp } = collectMatches(tsSnap, 'todaySummaryAlerts', mow, back, now);
      await sendAndStamp('today_summary', byMow, toStamp, 'todaySummaryAlerts');
    }
  }
);
```

- [ ] **Step 3: Syntax-check the file**

Run: `node --check firebase/functions/src/nextClass.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Export `setTodaySummaryAlert` from `index.js`**

In `firebase/functions/index.js`, find:

```js
export { setNextClassAlerts, nextClassNotify } from './src/nextClass.js';
```

Replace with:

```js
export { setNextClassAlerts, setTodaySummaryAlert, nextClassNotify } from './src/nextClass.js';
```

- [ ] **Step 5: Syntax-check and commit**

Run: `node --check firebase/functions/index.js`
Expected: no output, exit code 0.

```bash
git add firebase/functions/src/nextClass.js firebase/functions/index.js
git commit -m "feat: add setTodaySummaryAlert + extend nextClassNotify for daily brief"
```

---

### Task 2: Backend — `today_summary` push TTL/topic in `push-fanout.js`

A stale "오늘 수업 요약" is as useless as a stale "다음 수업" ping — it needs the same short TTL/high-urgency treatment as `next_class`, on its own topic so it doesn't collapse with actual next-class pushes.

**Files:**
- Modify: `functions/api/push-fanout.js:37-41`

**Interfaces:**
- Consumes: `kind: 'today_summary'` sent by Task 1's `sendAndStamp`.

- [ ] **Step 1: Add the `today_summary` branch**

Find:

```js
  const opts = kind === 'hot'
    ? { ttl: 43200, urgency: 'normal', topic: `hot-${post_id}` }
    : kind === 'next_class'
      ? { ttl: 300, urgency: 'high', topic: 'next-class' }
      : { ttl: 86400, urgency: 'high', ...(post_id != null ? { topic: `post-${post_id}` } : {}) };
```

Replace with:

```js
  const opts = kind === 'hot'
    ? { ttl: 43200, urgency: 'normal', topic: `hot-${post_id}` }
    : kind === 'next_class'
      ? { ttl: 300, urgency: 'high', topic: 'next-class' }
      : kind === 'today_summary'
        ? { ttl: 300, urgency: 'high', topic: 'today-summary' }
        : { ttl: 86400, urgency: 'high', ...(post_id != null ? { topic: `post-${post_id}` } : {}) };
```

- [ ] **Step 2: Syntax-check and commit**

Run: `node --check functions/api/push-fanout.js`
Expected: no output, exit code 0.

```bash
git add functions/api/push-fanout.js
git commit -m "feat: give today_summary pushes the same short-TTL treatment as next_class"
```

---

### Task 3: Frontend — `src/lib/dailyBrief.js` pure logic + orchestration

**Files:**
- Create: `src/lib/dailyBrief.js`
- Verify: throwaway scratch script at `scratchpad/verify-daily-brief.mjs` (gitignored, not committed)

**Interfaces:**
- Consumes: `computeBlocks` from `./nextClass.js` (signature: `computeBlocks(catalog, entries, customClasses, sem) → [{day, startMin, endMin, subject, room}]`, already exported), `parseHM` from `./timetableLayout.js`, `minToHM` from `./customClass.js`, `META_CACHE`/`pushEnabled` from `./push.js`, `callFn` from `./functions.js`, `getCatalog`/`buildMyTimetable`/`currentSemester` from `./cache.js`, `listTimetables`/`listEntries` from `./timetable.js`, `listCustomClasses` from `./customClass.js`, `auth` from `../firebase.js`.
- Produces: `briefOn()`, `setBriefOn(v)`, `getBriefTime()`, `setBriefTime(hhmm)`, `formatDayBrief(dayBlocks)`, `buildBriefSchedule(blocks, hhmm)` (returns `{ fireMinutes: number[], byDay: {[day]: string} }`), `syncDailyBrief({force} = {})`, `clearBriefSig()` — consumed by Task 4 (`App.jsx`) and Task 8 (`Profile.jsx`).

- [ ] **Step 1: Write the scratch verification script (not committed)**

This project has no test framework — pure logic gets verified once with a throwaway Node script, then the verified code is pasted into the real file (see `docs/superpowers/specs/2026-09-01-next-class-alert-design.md` §Ⅷ for precedent). The real `dailyBrief.js` imports `../firebase.js` transitively (via `./cache.js`/`./push.js`/`./timetable.js`), which calls `initializeApp()` using `import.meta.env` at module load — that throws under plain `node`, so the scratch script duplicates just the two pure functions rather than importing the real file.

Create `scratchpad/verify-daily-brief.mjs`:

```js
const MINUTES_PER_WEEK = 7 * 24 * 60;
const MAX_LINES = 6;

function minToHM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function parseHM(t) {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return null;
  return h * 60 + (m || 0);
}

function formatDayBrief(dayBlocks) {
  const lines = dayBlocks.map((b) => `${minToHM(b.startMin)} ${[b.subject, b.room].filter(Boolean).join(' · ')}`);
  if (lines.length <= MAX_LINES) return lines.join('\n');
  return [...lines.slice(0, MAX_LINES), `외 ${lines.length - MAX_LINES}개 더`].join('\n');
}

function buildBriefSchedule(blocks, hhmm) {
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

function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`FAIL ${label}: got ${a}, expected ${e}`);
  console.log(`OK ${label}`);
}

// 월요일 2개(경제 09:00-10:00, 물리 11:00-12:00), 화요일 0개, 수요일 1개(영어 14:00-15:00)
const blocks = [
  { day: 1, startMin: 540, endMin: 600, subject: '경제원론', room: '302' },
  { day: 1, startMin: 660, endMin: 720, subject: '물리학', room: '401' },
  { day: 3, startMin: 840, endMin: 900, subject: '영어회화', room: '' },
];

const { fireMinutes, byDay } = buildBriefSchedule(blocks, '07:30');
// 월요일 mow = 0*1440 + 450(07:30) = 450, 수요일 mow = 2*1440 + 450 = 3330. 화요일은 없음.
assertEqual(fireMinutes, [450, 3330], 'fireMinutes skips empty days');
assertEqual(Object.keys(byDay).sort(), ['1', '3'], 'byDay only has days with classes');
assertEqual(byDay['1'], '09:00 경제원론 · 302\n11:00 물리학 · 401', 'monday brief joins two classes');
assertEqual(byDay['3'], '14:00 영어회화', 'wednesday brief omits empty room');

// 7개 초과 절단
const many = Array.from({ length: 8 }, (_, i) => ({ day: 5, startMin: 480 + i * 60, endMin: 480 + i * 60 + 50, subject: `과목${i}`, room: '' }));
const capped = formatDayBrief(many);
assertEqual(capped.split('\n').length, 7, 'caps at 6 lines + 1 overflow line');
assertEqual(capped.split('\n')[6], '외 2개 더', 'overflow line counts the remainder');

// 빈 시각 문자열
assertEqual(buildBriefSchedule(blocks, ''), { fireMinutes: [], byDay: {} }, 'empty hhmm yields empty schedule');

console.log('all daily-brief checks passed');
```

- [ ] **Step 2: Run the scratch script**

Run: `node scratchpad/verify-daily-brief.mjs`
Expected: five `OK ...` lines followed by `all daily-brief checks passed`, exit code 0. If any `FAIL` line prints, fix the logic above before continuing (don't paste unverified logic into the real file).

- [ ] **Step 3: Create the real `src/lib/dailyBrief.js`**

```js
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
```

- [ ] **Step 4: Verify the build picks up the new file with no import errors**

Run: `npm run build`
Expected: build succeeds (exit code 0). This catches wrong import paths/names immediately since Vite resolves every import at build time.

- [ ] **Step 5: Commit (scratch script is gitignored, not added)**

```bash
git add src/lib/dailyBrief.js
git commit -m "feat: add src/lib/dailyBrief.js (daily class summary scheduling)"
```

---

### Task 4: Frontend wiring — `App.jsx` PushSync + `push.js` sig cleanup

**Files:**
- Modify: `src/App.jsx:5-6, 120-132`
- Modify: `src/lib/push.js:76-89`

**Interfaces:**
- Consumes: `syncDailyBrief` from Task 3.

- [ ] **Step 1: Import and call `syncDailyBrief` in `PushSync`**

In `src/App.jsx`, find:

```js
import { syncPush, consumePendingNav } from './lib/push';
import { syncNextClassAlerts } from './lib/nextClass';
```

Replace with:

```js
import { syncPush, consumePendingNav } from './lib/push';
import { syncNextClassAlerts } from './lib/nextClass';
import { syncDailyBrief } from './lib/dailyBrief';
```

Then find:

```js
function PushSync() {
  const { session } = useAuthContext();
  useEffect(() => {
    if (!session) return undefined;
    syncPush();
    const sync = () => syncNextClassAlerts().catch(() => { /* 다음 기회에 재시도 */ });
    sync();
```

Replace with:

```js
function PushSync() {
  const { session } = useAuthContext();
  useEffect(() => {
    if (!session) return undefined;
    syncPush();
    const sync = () => {
      syncNextClassAlerts().catch(() => { /* 다음 기회에 재시도 */ });
      syncDailyBrief().catch(() => { /* 다음 기회에 재시도 */ });
    };
    sync();
```

- [ ] **Step 2: Clear `dailybrief:sig` alongside `nextclass:sig` on disable**

In `src/lib/push.js`, find:

```js
export async function disablePush() {
  try { localStorage.removeItem(ENABLED_KEY); } catch { /* 무시 */ }
  // 구독이 지워지면 서버 nextClassAlerts 필드도 문서와 함께 사라진다 — 재업로드 서명을
  // 비워, 다시 켰을 때(같은 endpoint·같은 설정이어도) nextClass.js 가 재업로드하게 한다.
  try { localStorage.removeItem('nextclass:sig'); } catch { /* 무시 */ }
```

Replace with:

```js
export async function disablePush() {
  try { localStorage.removeItem(ENABLED_KEY); } catch { /* 무시 */ }
  // 구독이 지워지면 서버 nextClassAlerts/todaySummaryAlerts 필드도 문서와 함께 사라진다 —
  // 재업로드 서명을 비워, 다시 켰을 때(같은 endpoint·같은 설정이어도) 재업로드되게 한다.
  try { localStorage.removeItem('nextclass:sig'); } catch { /* 무시 */ }
  try { localStorage.removeItem('dailybrief:sig'); } catch { /* 무시 */ }
```

- [ ] **Step 3: Build and commit**

Run: `npm run build`
Expected: build succeeds.

```bash
git add src/App.jsx src/lib/push.js
git commit -m "feat: wire syncDailyBrief into PushSync and sig cleanup"
```

---

### Task 5: Backend — `submitAppReport` + Firestore rules/indexes

**Files:**
- Create: `firebase/functions/src/appReport.js`
- Modify: `firebase/functions/index.js:50`
- Modify: `firebase/firestore.rules:133-136`
- Modify: `firebase/firestore.indexes.json:88-96`

**Interfaces:**
- Produces: `submitAppReport` (onCall, payload `{ text, path, ua, standalone }` → `{ status: 'OK' }`), consumed by Task 9's `AppReportModal`.
- Produces: `appReports/{id}` documents `{ text, path, ua, standalone, status: 'pending', createdAt }`, consumed by Task 6's `listAppReports`.

- [ ] **Step 1: Create `firebase/functions/src/appReport.js`**

```js
import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';

// 앱 문제 리포트 — 정보 수정 제안(corrections.js, 강의 데이터 오류용)과는 별개 채널.
// 앱 자체의 버그·오류를 익명으로 접수한다(작성자 정보 미저장, corrections.js 와 동일한
// 익명성 원칙). 자유 텍스트라 corrections 처럼 대상·자동반영 로직은 없다.
// 설계: docs/superpowers/specs/2026-09-03-daily-brief-and-app-report-design.md
export const submitAppReport = onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  requireAuth(request);
  const { text, path, ua, standalone } = request.data ?? {};

  const t = String(text ?? '').trim();
  if (t.length < 5 || t.length > 500) invalid('문제 설명은 5자 이상 500자 이하로 입력하세요.');
  const p = path != null ? String(path).slice(0, 200) : null;
  const u = ua != null ? String(ua).slice(0, 300) : null;

  await db.collection('appReports').add({
    text: t,
    path: p,
    ua: u,
    standalone: !!standalone,
    status: 'pending',
    createdAt: FieldValue.serverTimestamp(),
  });

  // admin_push() 는 자체 실패를 삼킨다(pushFanout.js) — 알림 실패가 접수 자체를 막지 않는다.
  await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
    kind: 'app_report',
    title: '🐞 새 앱 문제 리포트',
    body: t.length > 80 ? `${t.slice(0, 80)}…` : t,
  });

  return { status: 'OK' };
});
```

- [ ] **Step 2: Syntax-check**

Run: `node --check firebase/functions/src/appReport.js`
Expected: no output, exit code 0.

- [ ] **Step 3: Export from `index.js`**

In `firebase/functions/index.js`, find:

```js
export { submitCorrection } from './src/corrections.js';
```

Replace with:

```js
export { submitCorrection } from './src/corrections.js';
export { submitAppReport } from './src/appReport.js';
```

- [ ] **Step 4: Lock down `appReports` in `firestore.rules`**

In `firebase/firestore.rules`, find:

```
    // ---- correction suggestions: no client access at all, same as the old
    // schema (no RLS policy — submit_correction()/admin-action only). ----
    match /corrections/{id} {
      allow read, write: if false;
    }
```

Replace with:

```
    // ---- correction suggestions: no client access at all, same as the old
    // schema (no RLS policy — submit_correction()/admin-action only). ----
    match /corrections/{id} {
      allow read, write: if false;
    }

    // ---- app problem reports: no client access, function-gated only (same
    // anonymity model as corrections above). ----
    match /appReports/{id} {
      allow read, write: if false;
    }
```

- [ ] **Step 5: Add the composite index for `list_app_reports`' `status`+`createdAt` query**

Admin's `listAppReports` (Task 6) filters `status == 'pending'` and orders by `createdAt desc` — an equality filter plus an orderBy on a *different* field needs an explicit composite index in Firestore (the exact same reason `corrections` already has one for `status`+`createdAt`, visible right above the insertion point).

In `firebase/firestore.indexes.json`, find:

```json
    {
      "collectionGroup": "corrections",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "corrections",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "autoApplied", "order": "ASCENDING" },
```

Replace with:

```json
    {
      "collectionGroup": "corrections",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "appReports",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "status", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    },
    {
      "collectionGroup": "corrections",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "autoApplied", "order": "ASCENDING" },
```

- [ ] **Step 6: Validate the JSON and commit**

Run: `node --check firebase/functions/index.js` (re-check after the export edit)
Run: `node -e "JSON.parse(require('fs').readFileSync('firebase/firestore.indexes.json','utf8')); console.log('valid json')"`
Expected: both print no errors; the second prints `valid json`.

```bash
git add firebase/functions/src/appReport.js firebase/functions/index.js firebase/firestore.rules firebase/firestore.indexes.json
git commit -m "feat: add submitAppReport, lock down appReports, index status+createdAt"
```

---

### Task 6: Backend — admin actions for app reports

**Files:**
- Modify: `firebase/functions/src/admin/moderationActions.js`

**Interfaces:**
- Consumes: `db`, `invalid` (already imported at the top of the file).
- Produces: `list_app_reports`, `ack_app_report` action keys in the exported `moderationActions` map, consumed by Task 10's `Moderation.jsx`.

- [ ] **Step 1: Add the handlers**

Find:

```js
// =====================================================================
//  신고 확인 (report_count > 0 인 살아있는 글)
// =====================================================================
```

Replace with:

```js
// =====================================================================
//  앱 문제 리포트 — appReports/{id} 필드명(text, path, ua, standalone, status,
//  createdAt)은 ../appReport.js 의 실제 구현과 대조 확인됨.
// =====================================================================

async function listAppReports() {
  const snap = await db.collection('appReports').where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(200).get();
  return { status: 'OK', items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

async function ackAppReport(uid, payload) {
  // 확인 처리 = 즉시 삭제(수정제안 ackCorrection 과 동일 — 익명이라 이력 보관 가치 없음).
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  await db.collection('appReports').doc(id).delete();
  return { status: 'OK' };
}

// =====================================================================
//  신고 확인 (report_count > 0 인 살아있는 글)
// =====================================================================
```

- [ ] **Step 2: Register the actions in the exported map**

Find:

```js
  list_deleted: listDeleted,
  restore_deleted: restoreDeleted,
  ack_deleted: ackDeleted,
```

Replace with:

```js
  list_deleted: listDeleted,
  restore_deleted: restoreDeleted,
  ack_deleted: ackDeleted,
  list_app_reports: listAppReports,
  ack_app_report: ackAppReport,
```

- [ ] **Step 3: Syntax-check and commit**

Run: `node --check firebase/functions/src/admin/moderationActions.js`
Expected: no output, exit code 0.

```bash
git add firebase/functions/src/admin/moderationActions.js
git commit -m "feat: add list_app_reports/ack_app_report admin actions"
```

---

### Task 7: Service worker — `today_summary` + `app_report` handling

Both new push kinds land in `public/push-sw.js`; bundling them into one task avoids two separate edits to the same file.

**Files:**
- Modify: `public/push-sw.js:11-14, 88-122`
- Modify: `vite.config.js:63`

**Interfaces:**
- Consumes: `msg.kind === 'today_summary'` + `msg.mow` (from Task 1), `/today-summary-schedule` Cache entry shaped `{ hhmm, tz, byDay: {[day]: string} }` (from Task 3), `msg.kind === 'app_report'` (from Task 5's `adminPush` call).

- [ ] **Step 1: Document the new Cache key**

Find:

```js
// · /next-class-schedule: { lead, slots:{ [주간분값]: {subject,room,start} } } — "다음 수업"
//   알림 내용. src/lib/nextClass.js 가 미러링. 서버는 발동 시각만 알고 내용은 여기만 있다.
```

Replace with:

```js
// · /next-class-schedule: { lead, slots:{ [주간분값]: {subject,room,start} } } — "다음 수업"
//   알림 내용. src/lib/nextClass.js 가 미러링. 서버는 발동 시각만 알고 내용은 여기만 있다.
// · /today-summary-schedule: { hhmm, tz, byDay:{ [요일1~7]: "09:00 과목 · 강의실\n…" } } —
//   "오늘 수업 요약" 알림 내용. src/lib/dailyBrief.js 가 미러링. 서버는 요일별 발동 시각만 안다.
```

- [ ] **Step 2: Add `showTodaySummary` next to `showNextClass`**

Find:

```js
// "⏰ 다음 수업 / 선형대수학 · 202 · 08:00". 사용자가 직접 정한 시각 알람이므로
// 방해금지 창이어도 소리·진동을 유지하고(설계: 방해금지 무시), 홈을 보고 있어도 띄운다
// (댓글 알림과 달리 '시각 알람'이라 항상 울려야 한다).
async function showNextClass(msg) {
  const sched = await nextClassSchedule();
  const slot = sched && sched.slots ? sched.slots[String(msg.mow)] : null;
  // 내용(과목·강의실·시각)은 기기 Cache 에만 있다 — 서버 핑엔 mow 뿐. 슬롯이 없으면
  // (캐시 증발·낡음) 일반 문구로라도 띄운다.
  const body = slot
    ? [slot.subject, slot.room, slot.start].filter(Boolean).join(' · ')
    : '곧 수업이 시작돼요';
  // renotify 미지정(기본 false): 한 수업 블록은 분값(mow) 하나로 한 번만 울리면 된다 —
  // 서버 중복 억제가 뚫려 같은 mow 핑이 또 와도 같은 tag 로 조용히 교체되게 둔다(이중 방어).
  await self.registration.showNotification('⏰ 다음 수업', {
    body,
    tag: `next-class-${msg.mow}`,
    vibrate: [180, 80, 180],
    icon: '/icons/icon.svg',
    data: { path: '/' },
  });
}
```

Replace with:

```js
// "⏰ 다음 수업 / 선형대수학 · 202 · 08:00". 사용자가 직접 정한 시각 알람이므로
// 방해금지 창이어도 소리·진동을 유지하고(설계: 방해금지 무시), 홈을 보고 있어도 띄운다
// (댓글 알림과 달리 '시각 알람'이라 항상 울려야 한다).
async function showNextClass(msg) {
  const sched = await nextClassSchedule();
  const slot = sched && sched.slots ? sched.slots[String(msg.mow)] : null;
  // 내용(과목·강의실·시각)은 기기 Cache 에만 있다 — 서버 핑엔 mow 뿐. 슬롯이 없으면
  // (캐시 증발·낡음) 일반 문구로라도 띄운다.
  const body = slot
    ? [slot.subject, slot.room, slot.start].filter(Boolean).join(' · ')
    : '곧 수업이 시작돼요';
  // renotify 미지정(기본 false): 한 수업 블록은 분값(mow) 하나로 한 번만 울리면 된다 —
  // 서버 중복 억제가 뚫려 같은 mow 핑이 또 와도 같은 tag 로 조용히 교체되게 둔다(이중 방어).
  await self.registration.showNotification('⏰ 다음 수업', {
    body,
    tag: `next-class-${msg.mow}`,
    vibrate: [180, 80, 180],
    icon: '/icons/icon.svg',
    data: { path: '/' },
  });
}

// "오늘 수업 요약" 스케줄(내용)을 Cache 에서 읽는다. 서버 핑엔 mow(요일을 역산하는 용도)뿐이다.
async function todaySummarySchedule() {
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match('/today-summary-schedule');
    return r ? await r.json() : null;
  } catch { return null; }
}

// "🌅 오늘 수업 / 09:00 경제원론 · 302\n11:00 물리학 · 401". 다음 수업 알림과 같은 이유로
// 방해금지를 무시한다(사용자가 직접 정한 시각 알람).
async function showTodaySummary(msg) {
  const sched = await todaySummarySchedule();
  const day = String(Math.floor(msg.mow / 1440) + 1);   // 1=월…7=일
  const body = (sched && sched.byDay && sched.byDay[day]) || '오늘 수업 정보를 불러오지 못했어요.';
  await self.registration.showNotification('🌅 오늘 수업', {
    body,
    tag: `today-summary-${msg.mow}`,
    vibrate: [180, 80, 180],
    icon: '/icons/icon.svg',
    data: { path: '/' },
  });
}
```

- [ ] **Step 3: Route `today_summary` in `showPush` and add `app_report` to `ADMIN_KINDS`**

Find:

```js
async function showPush(msg) {
  if (msg.kind === 'next_class') return showNextClass(msg);
```

Replace with:

```js
async function showPush(msg) {
  if (msg.kind === 'next_class') return showNextClass(msg);
  if (msg.kind === 'today_summary') return showTodaySummary(msg);
```

Find:

```js
  // 관리자 알림(수정제안·신고삭제·자동반영) — 제목·본문을 서버가 직접 실어 보낸다.
  const ADMIN_KINDS = ['correction', 'auto_correction', 'report_deleted'];
```

Replace with:

```js
  // 관리자 알림(수정제안·신고삭제·자동반영·앱문제리포트) — 제목·본문을 서버가 직접 실어 보낸다.
  const ADMIN_KINDS = ['correction', 'auto_correction', 'report_deleted', 'app_report'];
```

- [ ] **Step 4: Bump the SW cache-busting version**

In `vite.config.js`, find:

```js
        importScripts: ['push-sw.js?v=10'],
```

Replace with:

```js
        importScripts: ['push-sw.js?v=11'],
```

- [ ] **Step 5: Build and commit**

Run: `npm run build`
Expected: build succeeds (Vite bundles `public/push-sw.js` into the generated `sw.js` via the `importScripts` reference — a syntax error here would still not fail `npm run build`, since it's a plain-text `importScripts` URL, not parsed by Vite. Manually re-read the two edited files after Step 3 to eyeball-check the braces balance before committing.)

```bash
git add public/push-sw.js vite.config.js
git commit -m "feat: push-sw.js handles today_summary + app_report kinds (v11)"
```

---

### Task 8: UI — Profile.jsx daily-brief section

**Files:**
- Modify: `src/pages/Profile.jsx:1-30, 88-108, 175-206`

**Interfaces:**
- Consumes: `briefOn`, `setBriefOn`, `getBriefTime`, `setBriefTime`, `syncDailyBrief` from Task 3's `src/lib/dailyBrief.js`.

- [ ] **Step 1: Import the daily-brief helpers**

Find:

```js
import { NEXT_CLASS_LEADS, getLead, setLeadPref, syncNextClassAlerts } from '../lib/nextClass';
```

Replace with:

```js
import { NEXT_CLASS_LEADS, getLead, setLeadPref, syncNextClassAlerts } from '../lib/nextClass';
import { briefOn, setBriefOn, getBriefTime, setBriefTime, syncDailyBrief } from '../lib/dailyBrief';
```

- [ ] **Step 2: Add state and a change handler**

Find:

```js
  const [lead, setLeadState] = useState(() => getLead());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
```

Replace with:

```js
  const [lead, setLeadState] = useState(() => getLead());
  const [brief, setBrief] = useState(() => briefOn());
  const [briefTime, setBriefTimeState] = useState(() => getBriefTime());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [testMsg, setTestMsg] = useState('');
```

Find:

```js
  // 방해금지 설정 변경 — 로컬 저장 + SW(Cache) 미러(설정 반영은 다음 알림부터).
  function updateDnd(patch) {
```

Replace with:

```js
  // "오늘 수업 요약" 켜기/끄기·시각 변경 — 다음 수업 알림과 독립적으로 동작한다.
  function toggleBrief(e) {
    const v = e.target.checked;
    setBrief(v);
    setBriefOn(v);
    syncDailyBrief({ force: true }).catch(() => {});
  }
  function changeBriefTime(v) {
    setBriefTimeState(v);
    setBriefTime(v);
    if (brief) syncDailyBrief({ force: true }).catch(() => {});
  }

  // 방해금지 설정 변경 — 로컬 저장 + SW(Cache) 미러(설정 반영은 다음 알림부터).
  function updateDnd(patch) {
```

- [ ] **Step 3: Add the test-notification function**

Find:

```js
  async function testNextClass() {
    setTestMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('⏰ 다음 수업', {
        body: '선형대수학 · 202 · 08:00',
        tag: 'next-class-preview',
        renotify: true,
        vibrate: [180, 80, 180],
        icon: '/icons/icon.svg',
      });
      setTestMsg('“⏰ 다음 수업 / 선형대수학 · 202 · 08:00” 형식으로 알림이 오면 정상입니다. (실제 알림은 수업 시작 전에 이 형식으로 옵니다.)');
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }
```

Replace with:

```js
  async function testNextClass() {
    setTestMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('⏰ 다음 수업', {
        body: '선형대수학 · 202 · 08:00',
        tag: 'next-class-preview',
        renotify: true,
        vibrate: [180, 80, 180],
        icon: '/icons/icon.svg',
      });
      setTestMsg('“⏰ 다음 수업 / 선형대수학 · 202 · 08:00” 형식으로 알림이 오면 정상입니다. (실제 알림은 수업 시작 전에 이 형식으로 옵니다.)');
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }

  // "오늘 수업 요약" 미리보기 — 실제 알림은 push-sw.js 의 showTodaySummary 가 그날 실제
  // 수업으로 그리며 문구 형식은 여기와 동일하다.
  async function testDailyBrief() {
    setTestMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('🌅 오늘 수업', {
        body: '09:00 경제원론 · 302\n11:00 물리학 · 401',
        tag: 'daily-brief-preview',
        renotify: true,
        vibrate: [180, 80, 180],
        icon: '/icons/icon.svg',
      });
      setTestMsg('“🌅 오늘 수업” 형식으로 알림이 오면 정상입니다. (실제 알림은 설정한 시각에 그날 수업으로 옵니다.)');
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }
```

- [ ] **Step 4: Add the UI section and test button**

Find:

```js
              <div className="account-note" style={{ marginTop: 12 }}>
                <div style={{ marginBottom: 5 }}>⏰ 다음 수업 알림 <span className="muted">(확정 시간표 기준 · 방해금지 무시)</span></div>
```

Replace with:

```js
              <div className="account-note" style={{ marginTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={brief} onChange={toggleBrief} />
                  🌅 오늘 수업 요약 <span className="muted">(다음 수업 알림과 별개 · 방해금지 무시)</span>
                </label>
                {brief && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, marginLeft: 22 }}>
                    발송 시각 <input type="time" step="300" value={briefTime} onChange={(e) => changeBriefTime(e.target.value)} />
                  </div>
                )}
                <p className="account-note" style={{ marginTop: 6 }}>
                  매일 그 시각에 그날 수업 전체를 한 번에 요약해 알려드려요. 수업이 없는 날은 오지 않아요.
                </p>
              </div>

              <div className="account-note" style={{ marginTop: 12 }}>
                <div style={{ marginBottom: 5 }}>⏰ 다음 수업 알림 <span className="muted">(확정 시간표 기준 · 방해금지 무시)</span></div>
```

Find:

```js
                <button className="btn-ghost btn-sm" onClick={testNextClass}>
                  ⏰ 다음 수업 알림 테스트
                </button>
```

Replace with:

```js
                <button className="btn-ghost btn-sm" onClick={testNextClass}>
                  ⏰ 다음 수업 알림 테스트
                </button>
                <button className="btn-ghost btn-sm" onClick={testDailyBrief}>
                  🌅 오늘 수업 요약 테스트
                </button>
```

- [ ] **Step 5: Build and manually smoke-test**

Run: `npm run build`
Expected: build succeeds.

Run: `npm run dev`, open the app, sign in, go to `/profile`, turn push on. Confirm: the "🌅 오늘 수업 요약" checkbox appears under the DND section, checking it reveals a 5-minute-step time input, and clicking "🌅 오늘 수업 요약 테스트" shows a real OS notification with the two-line preview body. Stop the dev server after checking.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Profile.jsx
git commit -m "feat: add daily class summary settings to Profile"
```

---

### Task 9: Frontend — `AppReportModal.jsx` + Home.jsx entry point

**Files:**
- Create: `src/components/AppReportModal.jsx`
- Modify: `src/pages/Home.jsx:1-22, 81-93, 378-385, 503-516`

**Interfaces:**
- Consumes: `callFn` from `../lib/functions`, `isStandalone` from `./InstallGate` (already exported).
- Produces: default export `AppReportModal({ onClose })`, consumed by `Home.jsx`.

- [ ] **Step 1: Create `src/components/AppReportModal.jsx`**

```jsx
import { useState } from 'react';
import { callFn } from '../lib/functions';
import { isStandalone } from './InstallGate';
import '../styles/correction.css';

// 앱 문제 리포트 — 정보 수정 제안(CorrectionModal, 강의 데이터 오류용)과는 별개 채널.
// 앱 자체의 버그·오류를 익명으로 접수한다. 진단 정보(경로·기기환경)는 자동 첨부되고
// 사용자가 편집하지 않는다(제출 시점에 채워 넣을 뿐).
export default function AppReportModal({ onClose }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    const t = text.trim();
    if (t.length < 5) return setErr('무엇이 문제였는지 5자 이상 적어주세요.');
    setBusy(true); setErr('');
    const r = await callFn('submitAppReport', {
      text: t,
      path: location.pathname,
      ua: navigator.userAgent,
      standalone: isStandalone(),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message || '제출에 실패했습니다.');
    setDone(true);
  }

  return (
    <div className="cor-overlay" onClick={onClose}>
      <div className="cor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cor-head">
          <b>🚩 앱 문제 리포트</b>
          <button className="cor-x" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        {done ? (
          <div className="cor-done">
            <p>✅ 접수되었습니다. 검토 후 반영됩니다. 감사합니다!</p>
            <button className="btn-add btn-block" onClick={onClose}>닫기</button>
          </div>
        ) : (
          <>
            <label className="field"><span className="field-label">무엇이 문제였나요?</span>
              <textarea
                rows={4}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="예: 시간표에 강의를 추가했는데 저장이 안 돼요."
                maxLength={500}
              />
            </label>
            {err && <p className="error-msg">{err}</p>}
            <button className="btn-add btn-block" disabled={busy} onClick={submit}>{busy ? '제출 중…' : '제출하기'}</button>
            <p className="cor-hint">익명으로 접수됩니다(작성자 정보 미저장). 진단 정보(현재 화면 경로·기기환경)가 함께 전송돼요.</p>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `Home.jsx`**

Find:

```js
import { buildSeed, seedDraft, readDraft } from '../lib/wizardDraft';
```

Replace with:

```js
import { buildSeed, seedDraft, readDraft } from '../lib/wizardDraft';
import AppReportModal from '../components/AppReportModal';
```

Find:

```js
  const [palOpen, setPalOpen] = useState(false);   // 시간표 색상 테마 시트(⚙️)
```

Replace with:

```js
  const [palOpen, setPalOpen] = useState(false);   // 시간표 색상 테마 시트(⚙️)
  const [appReportOpen, setAppReportOpen] = useState(false);   // 앱 문제 리포트 모달(🚩)
```

Find:

```js
          {isIos() && <button className="link-btn" onClick={openCopiedLink} title="공유받은 글 붙여넣어 열기" aria-label="공유받은 글 붙여넣어 열기">📋</button>}
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link">🧹 검열</Link>}
```

Replace with:

```js
          {isIos() && <button className="link-btn" onClick={openCopiedLink} title="공유받은 글 붙여넣어 열기" aria-label="공유받은 글 붙여넣어 열기">📋</button>}
          <button className="link-btn" onClick={() => setAppReportOpen(true)} title="앱 문제 리포트" aria-label="앱 문제 리포트">🚩</button>
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link">🧹 검열</Link>}
```

Find:

```js
      {palOpen && <PaletteSheet onClose={() => setPalOpen(false)} />}
    </PullToRefresh>
  );
}
```

Replace with:

```js
      {palOpen && <PaletteSheet onClose={() => setPalOpen(false)} />}
      {appReportOpen && <AppReportModal onClose={() => setAppReportOpen(false)} />}
    </PullToRefresh>
  );
}
```

- [ ] **Step 3: Build and manually smoke-test**

Run: `npm run build`
Expected: build succeeds.

Run: `npm run dev`, sign in, on Home click 🚩 next to the header actions. Confirm the modal opens, typing under 5 chars shows the inline error, and submitting a valid report shows the "✅ 접수되었습니다" screen (this call will fail gracefully with a message if the backend isn't deployed yet — that's expected before Task 11's deploy). Stop the dev server after checking.

- [ ] **Step 4: Commit**

```bash
git add src/components/AppReportModal.jsx src/pages/Home.jsx
git commit -m "feat: add app problem report modal and Home entry point"
```

---

### Task 10: Admin UI — Moderation.jsx "앱 문제" tab

**Files:**
- Modify: `src/pages/Moderation.jsx:185-262, 329-333, 397-415, 571-600`

**Interfaces:**
- Consumes: `list_app_reports`/`ack_app_report` actions from Task 6, via the existing `call`/`callBatch` helpers already defined in this file.

- [ ] **Step 1: Add state**

Find:

```js
  const [deleted, setDeleted] = useState([]);    // 신고 누적 자동삭제 아카이브
  const [cat, setCat] = useState(null);          // 카탈로그(대기중 제안의 '수정 전' 현재값 계산용)
```

Replace with:

```js
  const [deleted, setDeleted] = useState([]);    // 신고 누적 자동삭제 아카이브
  const [appReports, setAppReports] = useState([]); // 앱 문제 리포트(pending)
  const [cat, setCat] = useState(null);          // 카탈로그(대기중 제안의 '수정 전' 현재값 계산용)
```

- [ ] **Step 2: Fetch app reports alongside the other lists**

Find:

```js
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
        return tsMillis(b.createdAt) - tsMillis(a.createdAt);
      });
      setItems(withFlags);
      setReviewedAt(r.data.reviewedAt ?? null);
      // 다음 진입 때 즉시 표시할 스냅샷(SWR). 전부 성공했을 때만 저장.
      if (rc.ok && rr.ok && ra.ok && rd.ok) {
        kvSet('mod:snapshot', {
          items: withFlags, corrs: rc.data.items ?? [], reported: rr.data.items ?? [],
          autos: ra.data.items ?? [], deleted: rd.data.items ?? [], reviewedAt: r.data.reviewedAt ?? null,
        });
      }
    }
    setUpdatedAt(new Date());
  }, []);
```

Replace with:

```js
  const load = useCallback(async () => {
    const [r, rc, rr, ra, rd, rap] = await callBatch([
      { action: 'list_recent', payload: { limit: 100 } },
      { action: 'list_corrections', payload: { status: 'pending' } },
      { action: 'list_reported' },
      { action: 'list_auto_notices' },
      { action: 'list_deleted' },
      { action: 'list_app_reports' },
    ]);
    freshRef.current = true;
    if (rc.ok) setCorrs(rc.data.items ?? []);
    if (rr.ok) setReported(rr.data.items ?? []);
    if (ra.ok) setAutos(ra.data.items ?? []);
    if (rd.ok) setDeleted(rd.data.items ?? []);
    if (rap.ok) setAppReports(rap.data.items ?? []);
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
      if (rc.ok && rr.ok && ra.ok && rd.ok && rap.ok) {
        kvSet('mod:snapshot', {
          items: withFlags, corrs: rc.data.items ?? [], reported: rr.data.items ?? [],
          autos: ra.data.items ?? [], deleted: rd.data.items ?? [], appReports: rap.data.items ?? [],
          reviewedAt: r.data.reviewedAt ?? null,
        });
      }
    }
    setUpdatedAt(new Date());
  }, []);
```

- [ ] **Step 3: Restore the snapshot into the new state too**

Find:

```js
    kvGet('mod:snapshot').then((c) => {
      if (freshRef.current || !c) return;
      setItems(c.items ?? []); setCorrs(c.corrs ?? []); setReported(c.reported ?? []);
      setAutos(c.autos ?? []); setDeleted(c.deleted ?? []); setReviewedAt(c.reviewedAt ?? null);
    });
```

Replace with:

```js
    kvGet('mod:snapshot').then((c) => {
      if (freshRef.current || !c) return;
      setItems(c.items ?? []); setCorrs(c.corrs ?? []); setReported(c.reported ?? []);
      setAutos(c.autos ?? []); setDeleted(c.deleted ?? []); setAppReports(c.appReports ?? []);
      setReviewedAt(c.reviewedAt ?? null);
    });
```

- [ ] **Step 4: Add the ack handler**

Find:

```js
  async function ackDeleted(it) {
    const r = await call('ack_deleted', { id: it.id });
    if (r.ok) setDeleted((prev) => prev.map((x) => (x.id === it.id ? { ...x, reviewed: true } : x)));
  }
```

Replace with:

```js
  async function ackDeleted(it) {
    const r = await call('ack_deleted', { id: it.id });
    if (r.ok) setDeleted((prev) => prev.map((x) => (x.id === it.id ? { ...x, reviewed: true } : x)));
  }

  // ── 앱 문제 리포트: 확인 처리(즉시 삭제, 익명이라 이력 보관 가치 없음) ──
  async function ackAppReport(it) {
    const r = await call('ack_app_report', { id: it.id });
    if (r.ok) setAppReports((prev) => prev.filter((x) => x.id !== it.id));
  }
```

- [ ] **Step 5: Add the tab button**

Find:

```js
        <button className={`mod-tab ${tab === 'deleted' ? 'is-active' : ''}`} onClick={() => setTab('deleted')}>
          삭제됨
          {deletedUnread > 0 && <span className="mod-tab-badge warn">{deletedUnread}</span>}
        </button>
      </div>
```

Replace with:

```js
        <button className={`mod-tab ${tab === 'deleted' ? 'is-active' : ''}`} onClick={() => setTab('deleted')}>
          삭제됨
          {deletedUnread > 0 && <span className="mod-tab-badge warn">{deletedUnread}</span>}
        </button>
        <button className={`mod-tab ${tab === 'appreports' ? 'is-active' : ''}`} onClick={() => setTab('appreports')}>
          앱 문제
          {appReports.length > 0 && <span className="mod-tab-badge warn">{appReports.length}</span>}
        </button>
      </div>
```

- [ ] **Step 6: Add the tab content, right before the closing `</PullToRefresh>`**

Find:

```js
            ))}
          </ul>
        </>
      )}
    </PullToRefresh>
  );
}
```

Replace with:

```js
            ))}
          </ul>
        </>
      )}

      {/* ⑤ 앱 문제 리포트 */}
      {tab === 'appreports' && (
        <>
          <p className="mod-status muted">
            사용자가 접수한 앱 문제 리포트입니다. 확인하면 목록에서 삭제됩니다(익명이라 이력을 남기지 않습니다).
          </p>
          <ul className="mod-list">
            {appReports.length === 0 && (
              <li className="empty"><span className="empty-emoji">🐞</span><p>접수된 앱 문제가 없습니다.</p></li>
            )}
            {appReports.map((it) => (
              <li key={`ar-${it.id}`} className="card mod-card flagged">
                <div className="mod-card-top">
                  <span className="tag tag-primary mod-type">앱 문제</span>
                  <span className="mod-course">{it.path || '경로 없음'}</span>
                  <span className="mod-time">{fmtDateTime(it.createdAt)}</span>
                </div>
                <p className="mod-text">{it.text}</p>
                <p className="mod-corr-note">{it.standalone ? '설치된 앱' : '브라우저'} · {it.ua || 'UA 없음'}</p>
                <div className="mod-actions">
                  <button className="btn-add btn-sm" onClick={() => ackAppReport(it)}>확인</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </PullToRefresh>
  );
}
```

- [ ] **Step 7: Build and manually smoke-test**

Run: `npm run build`
Expected: build succeeds.

Run: `npm run dev`, sign in as an admin, go to `/admin/moderation`, confirm the "앱 문제" tab renders (empty state is fine pre-deploy since no reports exist yet). Stop the dev server after checking.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Moderation.jsx
git commit -m "feat: add app-report review tab to Moderation"
```

---

### Task 11: Final build check, push to deploy, verify on live

**Files:** none (verification + deploy only)

- [ ] **Step 1: Full build from a clean state**

Run: `npm run build`
Expected: exit code 0, no errors.

- [ ] **Step 2: Review everything about to ship**

Run: `git status --short` and `git log --oneline main..HEAD` (or equivalent) to confirm only the 10 feature commits from Tasks 1-10 are staged for push, nothing stray.

- [ ] **Step 3: Push to `main`**

```bash
git push origin main
```

Expected: push succeeds. This triggers `.github/workflows/deploy-firebase.yml` (functions + Firestore rules/indexes) and Cloudflare Pages' Git integration (frontend) at the same time.

- [ ] **Step 4: Watch the Firebase deploy**

Run: `gh run watch --repo HyosanL/anyTime $(gh run list --repo HyosanL/anyTime --workflow=deploy-firebase.yml --limit 1 --json databaseId --jq '.[0].databaseId')`
Expected: the run finishes with `completed success`. If it fails, read the log with `gh run view --repo HyosanL/anyTime --log-failed` and fix forward (new commit + push), never force-push.

- [ ] **Step 5: On-device verification (manual, cannot be scripted from here)**

On a real device with the app installed and push enabled:
- Profile → turn on "🌅 오늘 수업 요약", set a time a couple minutes in the future, confirm the real push arrives with that day's actual classes (or confirm nothing arrives if today has none).
- Home → tap 🚩, submit a test report, confirm it shows up under Moderation → "앱 문제" and that "확인" removes it.
- Check the `nextClassNotify` Cloud Function logs (Firebase console) for the next few minutes for any "needs an index" errors on the new `todaySummaryAlerts.fireMinutes` query — none are expected (same auto-indexing as `nextClassAlerts`), but confirm.

- [ ] **Step 6: Report back to the user**

Summarize what shipped (both features, where to find them) now that build + push + CI have all succeeded.
