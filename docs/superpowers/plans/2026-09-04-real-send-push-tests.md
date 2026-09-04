# Real-send push test buttons — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the four Profile push-test buttons send real pushes through the production transport, surface real push-service failures, stop the DND test from mutating settings, and lengthen the `today_summary` push TTL.

**Architecture:** A new Firebase `onCall` (`sendSelfTestPush`) resolves the caller's own subscription doc and calls the existing `pushFanout` helper, which gets a new synchronous mode that returns the per-target push-service HTTP status. `push-sw.js` gains a `kind:'test'` renderer and `test:true` sample-content branches for the next-class / today-summary renderers (SW v16). Profile buttons call the new function and map its result to a generic-success or specific-failure message.

**Tech Stack:** Firebase Cloud Functions v2 (Node 22, `onCall`), Cloudflare Pages Functions (`functions/api/push-fanout.js`, WebCrypto `webpush.js`), React 19 + Vite. No test framework — pure logic is checked with throwaway `node` scripts, integration by `npm run build` + on-device manual (per `docs/superpowers/specs/2026-09-01-next-class-alert-design.md` §Ⅷ).

## Global Constraints

- No uid ↔ subscription linkage anywhere; `pushSubscriptions` docs never get a `uid` field ([[board-full-anonymity]]).
- `public/push-sw.js` edits are invisible to installed clients unless `vite.config.js`'s `importScripts: ['push-sw.js?v=N']` is bumped in the same commit. This change: **v15 → v16**, and `PUSH_SW_VERSION = 16`.
- Firebase deploy happens only via `.github/workflows/deploy-firebase.yml` on push to `main` (local `firebase deploy` is blocked on this machine — [[firebase-deploy-gcs-blocked]]). Cloudflare Pages auto-deploys the frontend + Pages Functions on the same push. **"Deploy" = commit, then `git push origin main`.**
- Every `onCall` handler's first line is `requireAuth(request)` or `requireAdmin(request)` — no REVOKE-by-default backstop (`firebase/functions/src/lib/context.js` governance note).
- Spec: `docs/superpowers/specs/2026-09-04-real-send-push-tests-design.md`.
- Push-service success is any `2xx`; `404`/`410` = dead subscription; `401`/`403` = rejected; `0` = thrown fetch (network).

---

### Task 1: `push-fanout` synchronous mode + `today_summary` TTL + pass-through of `quiet`/`test`

**Files:**
- Modify: `functions/api/push-fanout.js` (Cloudflare Pages Function)
- Modify: `firebase/functions/src/lib/pushFanout.js` (Firebase helper that `nextClass.js` / `board.js` / `push.js` import — NOT `functions/lib/`)

**Interfaces:**
- Produces: `POST /api/push-fanout` accepts `sync: true` in the body → responds `{ status: 'OK', results: [{ endpoint, status }] }` (status = push-service HTTP status, or `0` on a thrown send). Without `sync`, unchanged (`{ status: 'ACCEPTED', targets }`).
- Produces: `pushFanout(fanoutUrl, fanoutSecret, payload, targets, { sync })` — when `sync:true` returns `[{ endpoint, status }]`; otherwise returns `undefined` (unchanged for the 4-arg callers in `nextClass.js` / `board.js`).
- Produces: `push-fanout` now forwards `payload.quiet` and `payload.test` into the SW push `data` (consumed by Task 3).

- [ ] **Step 1: Rewrite `functions/api/push-fanout.js`**

Replace the whole file with:

```js
// 웹푸시 발송 팬아웃 — 호출원은 Supabase pg_net 트리거(새 댓글·HOT 승격)와
// Firebase nextClassNotify / sendSelfTestPush.
// 인증: X-Push-Secret 공유 시크릿(_middleware.js 에서 검증 — 유저 JWT 아님).
// 익명성: 본문 targets 는 구독 endpoint·암호키만 담는다(사용자 식별자·작성자 정보 없음).
// 무료 플랜 한도(호출당 서브요청 50)는 DB 트리거가 30건씩 잘라 호출하는 것으로 지킨다
// (Worker 자기호출 체인 없음). 만료 구독(404/410)은 push_prune RPC 로 정리.
//
// sync:true — 발송 결과(푸시서비스 HTTP 상태)를 응답에 실어 돌려준다. 테스트 버튼
// (sendSelfTestPush)이 "구독 만료/거부/네트워크 실패"를 사용자에게 보여주려고 쓴다.
// 단일 타깃이라 Workers 서브요청 한도와 무관하고, waitUntil 대신 await 한다.
import { sendPush } from '../lib/webpush.js';

const MAX_TARGETS = 45;   // 방어적 상한(트리거는 30씩 보냄): 45 발송 + prune 1 < 서브요청 50

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch { return json({ status: 'BAD_REQUEST' }, 400); }
  const { kind, post_id, title, board, path, body: msgBody, mow, quiet, test, targets, sync } = body || {};
  if (!Array.isArray(targets) || targets.length === 0) return json({ status: 'OK', sent: 0 });
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return json({ status: 'NO_VAPID' }, 500);

  const payload = { kind, post_id, title, board, path, body: msgBody, mow, quiet, test };
  const slice = targets.slice(0, MAX_TARGETS);

  // 동기 모드: 결과를 기다렸다가 그대로 반환(테스트 버튼 전용).
  if (sync === true) {
    const results = await fanout(env, payload, slice);
    return json({ status: 'OK', results });
  }

  // 발송은 응답과 분리해 백그라운드로 — pg_net 타임아웃(5s)과 무관하게 완주한다.
  context.waitUntil(fanout(env, payload, slice));
  return json({ status: 'ACCEPTED', targets: slice.length });
}

// 반환: [{ endpoint, status }] — status 는 푸시서비스 HTTP 상태(201 등) 또는 0(fetch 예외).
async function fanout(env, { kind, post_id, title, board, path, body: msgBody, mow, quiet, test }, targets) {
  const vapid = {
    subject: env.VAPID_SUBJECT || 'mailto:hyosanl0211@gmail.com',
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  };
  // board 는 HOT 알림에서 "어느 게시판" 표시에 쓰인다(댓글 알림엔 없음 → undefined 로 빠짐).
  // path·body 는 관리자 알림(수정제안·신고삭제·자동반영)에서 목적지·본문으로 쓰인다.
  // mow 는 "다음 수업"·"오늘 수업 요약" 알림에서 SW 가 기기 Cache 의 슬롯/요일을 찾는 데 쓴다.
  // quiet·test 는 테스트 푸시 전용(SW 가 강제 무음 / 샘플 내용 렌더링).
  const data = { kind, post_id, title, board, path, body: msgBody, mow, quiet, test };
  // topic: 같은 글의 미전달 알림은 최신 1건으로 대체(오프라인 기기 폭주 방지).
  // 댓글은 즉시성(urgency=high — 도즈 모드 관통), HOT 은 일반 우선순위.
  // 관리자 알림은 post_id 가 없으므로 글 topic 을 붙이지 않는다(서로 덮어쓰지 않게).
  // "다음 수업"은 늦게 오면 무의미 → TTL 5분. "오늘 수업 요약"은 조금 늦어도 유효 →
  //   TTL 1시간(잠긴 아이폰이 5분 안에 못 받아 APNs 가 버리는 문제 대응).
  const opts = kind === 'hot'
    ? { ttl: 43200, urgency: 'normal', topic: `hot-${post_id}` }
    : kind === 'next_class'
      ? { ttl: 300, urgency: 'high', topic: 'next-class' }
      : kind === 'today_summary'
        ? { ttl: 3600, urgency: 'high', topic: 'today-summary' }
        : { ttl: 86400, urgency: 'high', ...(post_id != null ? { topic: `post-${post_id}` } : {}) };

  const jwtCache = new Map();   // VAPID JWT 는 푸시서비스 origin 당 1회만 서명
  const settled = await Promise.allSettled(
    targets.map((t) => sendPush(t, data, opts, vapid, jwtCache)));

  // 404/410 = 만료·해지된 구독 → DB 에서 제거(다음 앱 실행 때 클라이언트가 재등록)
  const dead = [];
  const results = settled.map((r, i) => {
    const status = r.status === 'fulfilled' ? r.value : 0;
    if (status === 404 || status === 410) dead.push(targets[i].endpoint);
    return { endpoint: targets[i].endpoint, status };
  });
  if (dead.length && env.PUSH_SECRET) {
    await fetch('https://asia-northeast3-anytime-rokafa.cloudfunctions.net/pushPrune', {
      method: 'POST',
      headers: {
        'X-Push-Secret': env.PUSH_SECRET,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ endpoints: dead }),
    }).catch(() => { /* 정리 실패는 다음 발송 때 재시도됨 */ });
  }
  return results;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Update `firebase/functions/src/lib/pushFanout.js`**

Replace the whole file with:

```js
// Calls the existing Cloudflare Pages Function `/api/push-fanout` (kept
// unchanged in contract — design doc §5). That endpoint does the actual Web
// Push send; here we only resolve *who* to notify from Firestore and hand it a
// batch of {endpoint, p256dh, auth} targets, gated by the shared X-Push-Secret
// header (same contract the old pg_net trigger used).
const MAX_BATCH = 30; // matches the old trigger's chunking, respects Workers sub-request cap

// opts.sync — ask push-fanout to run synchronously and echo back the
// push-service HTTP status per target ([{ endpoint, status }]). Used by
// sendSelfTestPush so the test button can report a dead/rejected subscription.
// Without it: fire-and-forget, returns undefined (unchanged for the callers in
// nextClass.js / board.js).
export async function pushFanout(fanoutUrl, fanoutSecret, payload, targets, { sync = false } = {}) {
  if (!targets.length) return sync ? [] : undefined;
  const results = [];
  for (let i = 0; i < targets.length; i += MAX_BATCH) {
    const batch = targets.slice(i, i + MAX_BATCH);
    try {
      const res = await fetch(fanoutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Push-Secret': fanoutSecret },
        body: JSON.stringify({ ...payload, targets: batch, ...(sync ? { sync: true } : {}) }),
      });
      if (sync) {
        const data = await res.json().catch(() => null);
        if (data && Array.isArray(data.results)) results.push(...data.results);
        else batch.forEach((t) => results.push({ endpoint: t.endpoint, status: 0 }));
      }
    } catch (e) {
      // Fire-and-forget, same as the old pg_net trigger (errors swallowed —
      // a failed push must never fail the underlying write).
      console.error('[pushFanout] batch failed', e);
      if (sync) batch.forEach((t) => results.push({ endpoint: t.endpoint, status: 0 }));
    }
  }
  return sync ? results : undefined;
}
```

- [ ] **Step 3: Syntax-check both files**

Run: `node --check functions/api/push-fanout.js && node --check functions/lib/pushFanout.js`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add functions/api/push-fanout.js functions/lib/pushFanout.js
git commit -m "feat: push-fanout sync mode (per-target status) + today_summary TTL 300->3600

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `sendSelfTestPush` Cloud Function

**Files:**
- Modify: `firebase/functions/src/push.js`
- Modify: `firebase/functions/index.js`
- Verify: throwaway `scratchpad/verify-selftest-payload.mjs` (gitignored, not committed)

**Interfaces:**
- Consumes: `pushFanout(url, secret, payload, targets, { sync: true })` from Task 1.
- Produces: `sendSelfTestPush` (onCall, payload `{ endpoint, kind }`, `kind ∈ {'plain','quiet','next_class','today_summary'}`) → `{ status: 'OK' | 'GONE' | 'REJECTED' | 'NETWORK' | 'ERROR', code? }`; throws `invalid-argument` (HttpsError) with a user-facing message when the endpoint is malformed, the kind is unknown, or the subscription doc is missing/corrupt. Consumed by Task 4's `sendServerTestPush`.

- [ ] **Step 1: Write the scratch verification script (not committed)**

The real `push.js` transitively imports `firebase-admin` (throws under plain `node` at load), so the scratch script copies just the two pure helpers.

Create `scratchpad/verify-selftest-payload.mjs`:

```js
const MINUTES_PER_WEEK = 7 * 24 * 60;

function seoulMinuteOfWeek(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const isoDay = kst.getUTCDay() === 0 ? 7 : kst.getUTCDay();
  return (isoDay - 1) * 1440 + kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

const TEST_KINDS = ['plain', 'quiet', 'next_class', 'today_summary'];

function testPayload(kind) {
  switch (kind) {
    case 'plain':
      return { kind: 'hot', title: '🔔 테스트 알림', board: '테스트', path: '/' };
    case 'quiet':
      return { kind: 'test', quiet: true, title: '🌙 무음 테스트', body: '소리·진동 없이 왔으면 정상이에요.', path: '/' };
    case 'next_class':
      return { kind: 'next_class', test: true, mow: seoulMinuteOfWeek(), path: '/' };
    case 'today_summary':
      return { kind: 'today_summary', test: true, mow: seoulMinuteOfWeek(), path: '/' };
    default:
      return null;
  }
}

function classifyStatus(status) {
  if (status >= 200 && status < 300) return { status: 'OK' };
  if (status === 404 || status === 410) return { status: 'GONE' };
  if (status === 401 || status === 403) return { status: 'REJECTED', code: status };
  if (status === 0) return { status: 'NETWORK' };
  return { status: 'ERROR', code: status };
}

function eq(a, b, label) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`FAIL ${label}: ${x} !== ${y}`);
  console.log(`OK ${label}`);
}

eq(testPayload('plain'), { kind: 'hot', title: '🔔 테스트 알림', board: '테스트', path: '/' }, 'plain → legacy hot shape');
eq(testPayload('quiet').quiet, true, 'quiet → quiet flag');
eq(testPayload('quiet').kind, 'test', 'quiet → kind test');
eq(testPayload('next_class').test, true, 'next_class → test flag');
eq(testPayload('today_summary').test, true, 'today_summary → test flag');
eq(Number.isInteger(testPayload('next_class').mow), true, 'next_class → integer mow');
eq(testPayload('bogus'), null, 'unknown kind → null');
eq(TEST_KINDS.includes('plain') && !TEST_KINDS.includes('bogus'), true, 'allowlist');

eq(classifyStatus(201), { status: 'OK' }, '201 → OK');
eq(classifyStatus(200), { status: 'OK' }, '200 → OK');
eq(classifyStatus(410), { status: 'GONE' }, '410 → GONE');
eq(classifyStatus(404), { status: 'GONE' }, '404 → GONE');
eq(classifyStatus(403), { status: 'REJECTED', code: 403 }, '403 → REJECTED');
eq(classifyStatus(0), { status: 'NETWORK' }, '0 → NETWORK');
eq(classifyStatus(500), { status: 'ERROR', code: 500 }, '500 → ERROR');

console.log('all self-test payload checks passed');
```

- [ ] **Step 2: Run the scratch script**

Run: `node scratchpad/verify-selftest-payload.mjs`
Expected: a series of `OK ...` lines then `all self-test payload checks passed`, exit 0. Fix the logic before pasting into the real file if any `FAIL` prints.

- [ ] **Step 3: Add imports + `seoulMinuteOfWeek` copy to `firebase/functions/src/push.js`**

Find (lines 1-4):

```js
import { createHash } from 'node:crypto';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, requireAdmin, invalid } from './lib/context.js';
import { pushFanoutSecret } from './lib/secrets.js';
```

Replace with:

```js
import { createHash } from 'node:crypto';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, requireAdmin, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { pushFanout } from './lib/pushFanout.js';
```

Find (lines 20-22):

```js
function subscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}
```

Replace with:

```js
function subscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}

// 지금(Asia/Seoul)의 '주간 분값' — 월요일 00:00 = 0 … 일요일 23:59 = 10079.
// nextClass.js 에 같은 함수가 있다(subscriptionId 처럼 이 코드베이스는 이런 소형
// 헬퍼는 파일별 사본으로 둔다). 오늘 수업 요약/다음 수업 테스트 푸시의 mow 계산용.
function seoulMinuteOfWeek(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const isoDay = kst.getUTCDay() === 0 ? 7 : kst.getUTCDay();
  return (isoDay - 1) * 1440 + kst.getUTCHours() * 60 + kst.getUTCMinutes();
}
```

- [ ] **Step 4: Add `sendSelfTestPush` at the end of `firebase/functions/src/push.js`**

Append after the final `adminPushUnsubscribe` export (current last line 178):

```js

// 실기기 푸시 테스트 — 프로필 "알림 테스트" 버튼 4종이 호출한다. 실제 푸시와 100%
// 같은 경로(pushFanout → /api/push-fanout → webpush.js → 푸시서비스)를 타고, sync 로
// 발송 결과(HTTP 상태)를 받아 온다. 성공이면 클라이언트는 예전처럼 담백한 문구만,
// 실패면 "구독 만료/거부/네트워크" 를 사용자에게 보여준다. 익명 유지: endpoint 로만
// 구독 문서를 찾고 uid 는 저장하지 않는다(setNextClassAlerts 와 동일 패턴).
const TEST_KINDS = ['plain', 'quiet', 'next_class', 'today_summary'];

function testPayload(kind) {
  switch (kind) {
    case 'plain':
      // 구버전 SW 도 그대로 그리는 legacy 형태 — "푸시가 물리적으로 도착하는가" 만 확인.
      return { kind: 'hot', title: '🔔 테스트 알림', board: '테스트', path: '/' };
    case 'quiet':
      return { kind: 'test', quiet: true, title: '🌙 무음 테스트', body: '소리·진동 없이 왔으면 정상이에요.', path: '/' };
    case 'next_class':
      return { kind: 'next_class', test: true, mow: seoulMinuteOfWeek(), path: '/' };
    case 'today_summary':
      return { kind: 'today_summary', test: true, mow: seoulMinuteOfWeek(), path: '/' };
    default:
      return null;
  }
}

function classifyStatus(status) {
  if (status >= 200 && status < 300) return { status: 'OK' };
  if (status === 404 || status === 410) return { status: 'GONE' };
  if (status === 401 || status === 403) return { status: 'REJECTED', code: status };
  if (status === 0) return { status: 'NETWORK' };
  return { status: 'ERROR', code: status };
}

export const sendSelfTestPush = onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  requireAuth(request);
  const { endpoint, kind } = request.data ?? {};
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1024) {
    invalid('잘못된 구독 정보입니다.');
  }
  if (!TEST_KINDS.includes(kind)) invalid('알 수 없는 테스트 종류입니다.');

  const snap = await db.collection('pushSubscriptions').doc(subscriptionId(endpoint)).get();
  if (!snap.exists) invalid('이 기기의 푸시 구독을 찾을 수 없어요. 푸시를 껐다 켜 주세요.');
  const d = snap.data();
  if (!d.endpoint || !d.p256dh || !d.auth) invalid('구독 정보가 손상됐어요. 푸시를 껐다 켜 주세요.');

  const results = await pushFanout(
    pushFanoutUrl.value(),
    pushFanoutSecret.value(),
    testPayload(kind),
    [{ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth }],
    { sync: true }
  );
  return classifyStatus(results?.[0]?.status ?? 0);
});
```

- [ ] **Step 5: Export from `firebase/functions/index.js`**

Find:

```js
export {
  pushSubscribe,
  pushUnsubscribe,
  pushSetHot,
  pushWatch,
  pushUnwatch,
  pushPrune,
  adminPushSubscribe,
  adminPushUnsubscribe,
} from './src/push.js';
```

Replace with:

```js
export {
  pushSubscribe,
  pushUnsubscribe,
  pushSetHot,
  pushWatch,
  pushUnwatch,
  pushPrune,
  adminPushSubscribe,
  adminPushUnsubscribe,
  sendSelfTestPush,
} from './src/push.js';
```

- [ ] **Step 6: Syntax-check and commit**

Run: `node --check firebase/functions/src/push.js && node --check firebase/functions/index.js`
Expected: no output, exit 0.

```bash
git add firebase/functions/src/push.js firebase/functions/index.js
git commit -m "feat: sendSelfTestPush — real push through the production transport

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Service worker v16 — `kind:'test'` + sample-content test branches

**Files:**
- Modify: `public/push-sw.js`
- Modify: `vite.config.js:64`

**Interfaces:**
- Consumes: push `data` `{ kind:'test', quiet?, title, body, path }`, and `{ kind:'next_class'|'today_summary', test:true, mow, path }` from Tasks 1-2.
- Produces: SW v16. `kind:'test'` always displays (bypasses the "viewing this path" suppression); `msg.quiet===true` forces a silent notification without reading `/dnd-config`; `msg.test` on the next-class / today-summary renderers shows fixed sample content.

- [ ] **Step 1: Bump `PUSH_SW_VERSION`**

Find (line 22):

```js
const PUSH_SW_VERSION = 15;
```

Replace with:

```js
const PUSH_SW_VERSION = 16;
```

- [ ] **Step 2: Add `test:true` sample branch to `showNextClass`**

Find:

```js
async function showNextClass(msg) {
  const sched = await nextClassSchedule();
  const slot = sched && sched.slots ? sched.slots[String(msg.mow)] : null;
```

Replace with:

```js
async function showNextClass(msg) {
  const sched = msg.test ? null : await nextClassSchedule();
  // 테스트 푸시(test:true)는 실제 시간표 대신 고정 샘플로 형식만 보여준다.
  const slot = msg.test
    ? { subject: '선형대수학', room: '202', start: '08:00' }
    : (sched && sched.slots ? sched.slots[String(msg.mow)] : null);
```

- [ ] **Step 3: Add `test:true` sample branch to `showTodaySummary`**

Find:

```js
async function showTodaySummary(msg) {
  const sched = await todaySummarySchedule();
  const day = String(Math.floor(msg.mow / 1440) + 1);   // 1=월…7=일
  const body = (sched && sched.byDay && sched.byDay[day]) || '오늘 수업 정보를 불러오지 못했어요.';
```

Replace with:

```js
async function showTodaySummary(msg) {
  // 테스트 푸시(test:true)는 실제 그날 수업 대신 고정 샘플로 형식만 보여준다.
  const body = msg.test
    ? '09:00 경제원론 · 302\n11:00 물리학 · 401'
    : await (async () => {
        const sched = await todaySummarySchedule();
        const day = String(Math.floor(msg.mow / 1440) + 1);   // 1=월…7=일
        return (sched && sched.byDay && sched.byDay[day]) || '오늘 수업 정보를 불러오지 못했어요.';
      })();
```

- [ ] **Step 4: Add `showTestPush` and route it in `showPush`**

Find:

```js
async function showPush(msg) {
  if (msg.kind === 'next_class') return showNextClass(msg);
  if (msg.kind === 'today_summary') return showTodaySummary(msg);
```

Replace with:

```js
// 실기기 테스트 알림(sendSelfTestPush 의 kind:'test'). "지금 이 경로를 보고 있으면 생략"
// 검사를 건너뛰고 항상 띄운다(테스트니까). msg.quiet 면 /dnd-config 와 무관하게 강제 무음.
async function showTestPush(msg) {
  const opts = {
    body: msg.body || '',
    tag: 'push-self-test',
    icon: '/icons/icon.svg',
    data: { path: (typeof msg.path === 'string' && msg.path.startsWith('/')) ? msg.path : '/' },
  };
  if (msg.quiet === true) {
    opts.silent = true;   // silent 와 vibrate 를 함께 주면 TypeError → vibrate 생략
  } else {
    opts.renotify = true;
    opts.vibrate = [180, 80, 180];
  }
  await self.registration.showNotification(msg.title || '🔔 테스트 알림', opts);
}

async function showPush(msg) {
  if (msg.kind === 'next_class') return showNextClass(msg);
  if (msg.kind === 'today_summary') return showTodaySummary(msg);
  if (msg.kind === 'test') return showTestPush(msg);
```

- [ ] **Step 5: Bump the importScripts version in `vite.config.js`**

Find (line 64):

```js
        importScripts: ['push-sw.js?v=15'],
```

Replace with:

```js
        importScripts: ['push-sw.js?v=16'],
```

- [ ] **Step 6: Syntax-check, build, commit**

Run: `node --check public/push-sw.js`
Expected: no output, exit 0.

Run: `npm run build`
Expected: build succeeds (exit 0). Then manually re-read the edited regions of `public/push-sw.js` to eyeball brace balance (Vite bundles `push-sw.js` as an opaque `importScripts` URL — a syntax error there would NOT fail the build).

```bash
git add public/push-sw.js vite.config.js
git commit -m "feat: push-sw v16 — kind:test renderer + test:true sample content

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Frontend — `sendServerTestPush` + wire the four Profile buttons

**Files:**
- Modify: `src/lib/push.js`
- Modify: `src/pages/Profile.jsx`

**Interfaces:**
- Consumes: `sendSelfTestPush` onCall from Task 2 (via `callFn`).
- Produces: `sendServerTestPush(kind)` in `src/lib/push.js` → `{ status: 'OK'|'GONE'|'REJECTED'|'NETWORK'|'ERROR'|'NO_SUB'|'FAIL', code?, message? }` (never throws). Consumed by `Profile.jsx`.

- [ ] **Step 1: Replace `sendTestPush` with `sendServerTestPush` in `src/lib/push.js`**

Find (lines 207-215):

```js
// 실기기 테스트: 실제 서버 발송 없이 SW 의 showPush 를 그대로 태워 알림을 띄운다.
// 방해금지 무음 판정과 클릭 딥링크(data.path)가 실제 푸시와 동일하게 검증된다.
// msg 예: { kind:'hot', title:'…', board:'…', path:'/board/hot' }
export async function sendTestPush(msg) {
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active || navigator.serviceWorker.controller;
  if (!sw) throw new Error('SW_NOT_READY');
  sw.postMessage({ type: 'TEST_PUSH', msg });
}
```

Replace with:

```js
// 실기기 푸시 테스트 — 실제 푸시와 100% 같은 경로(sendSelfTestPush CF → /api/push-fanout
// → 푸시서비스 → SW)로 한 건 발송하고, 발송 결과를 돌려받는다. 성공이면 { status:'OK' },
// 실패면 구독 만료/거부/네트워크 등을 그대로 실어 준다(호출부가 문구로 변환).
// kind: 'plain' | 'quiet' | 'next_class' | 'today_summary'
export async function sendServerTestPush(kind) {
  let sub;
  try {
    sub = await getSubscription();
  } catch { /* 아래에서 NO_SUB 처리 */ }
  if (!sub) return { status: 'NO_SUB' };
  const res = await callFn('sendSelfTestPush', { endpoint: sub.endpoint, kind });
  if (res.ok) return res.data || { status: 'OK' };
  // callFn 이 HttpsError('invalid-argument') 등을 { ok:false, status:<code>, message } 로 감싼다.
  return { status: 'FAIL', code: res.status, message: res.message };
}
```

- [ ] **Step 2: Verify `src/lib/push.js` still builds its imports**

`callFn` is already imported at the top of `src/lib/push.js` (line 1: `import { callFn } from './functions';`). `getSubscription` is already defined in the file (line 38). No new imports needed.

Run: `npm run build`
Expected: build succeeds (Vite fails on an unresolved import/name — this catches a missing `callFn`/`getSubscription`).

- [ ] **Step 3: Rewire the four test buttons in `src/pages/Profile.jsx`**

Find (line 5):

```js
import { pushSupported, pushEnabled, enablePush, disablePush, hotAlertsOn, setHotAlerts, getDnd, setDnd, sendTestPush } from '../lib/push';
```

Replace with:

```js
import { pushSupported, pushEnabled, enablePush, disablePush, hotAlertsOn, setHotAlerts, getDnd, setDnd, sendServerTestPush } from '../lib/push';
```

Find (line 31):

```js
  const [testMsg, setTestMsg] = useState('');
```

Replace with:

```js
  const [testMsg, setTestMsg] = useState('');
  const [testBusy, setTestBusy] = useState(false);
```

Find (lines 61-141) — the whole block from `// 분(0~1439, 음수/초과 자동 순환) → 'HH:MM'` through the end of `testDailyBrief` (the closing `}` before `async function toggle()`):

```js
  // 분(0~1439, 음수/초과 자동 순환) → 'HH:MM'
  function hhmmFromMin(m) {
    const x = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
  }

  // 실기기 테스트: 지금 시각을 포함하도록 방해금지 창을 임시 조정한 뒤(입력칸도 즉시 반영),
  // 실제 푸시와 같은 SW 경로로 테스트 알림을 띄운다 → 무음으로 와야 정상.
  // setDnd 를 await 해 Cache 미러 완료 후 발송(레이스 없음). 창은 눈에 보이니 뒤에 직접 되돌리면 된다.
  async function testQuietNow() {
    setTestMsg('');
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const win = { on: true, start: hhmmFromMin(cur - 1), end: hhmmFromMin(cur + 60) };
    setDndState(win);
    try {
      await setDnd(win);   // 로컬+Cache 미러 완료 보장
      await sendTestPush({ kind: 'hot', title: '방해금지 조용히 테스트', board: '테스트', path: '/board/hot' });
      setTestMsg(`방해금지 창을 ${win.start}~${win.end} 로 임시 조정하고 무음 테스트 알림을 보냈어요. 소리·진동 없이 오면 정상이고, 알림을 탭하면 HOT 게시판으로 이동합니다. (테스트 후 위 시간은 원하는 값으로 되돌려 주세요.)`);
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }

  // 로컬 테스트 알림 — 알림이 실제로 도착하는지(권한·구독·전송) 확인용.
  // 헤드업(팝업)으로 뜨는지는 기기 설정 소관이라 코드로 못 바꾸므로 판단하지 않는다.
  async function sendTest() {
    setTestMsg('');
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('🔔 테스트 알림', {
        body: '테스트 알림이 도착했어요.',
        tag: 'push-test',
        renotify: true,
        vibrate: [180, 80, 180],
        icon: '/icons/icon.svg',
      });
      setTestMsg('테스트 알림을 보냈어요.');
    } catch {
      setTestMsg('테스트 알림을 보내지 못했어요. 알림이 켜져 있는지 확인해주세요.');
    }
  }

  // "다음 수업" 알림 미리보기 — SW 버전(업데이트 지연)에 안 기대도록, 실제 서버 핑 경로
  // (sendTestPush→SW showNextClass) 대신 페이지에서 직접 같은 형식으로 알림을 띄운다.
  // 실제 알림은 push-sw.js 의 showNextClass 가 그리며 문구는 여기와 동일하다.
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

Replace with:

```js
  // 실기기 푸시 테스트 4종 — 모두 실제 푸시와 같은 경로(서버 발송 → 푸시서비스 → SW)를 탄다.
  // 성공이면 예전처럼 담백한 문구, 실패면 구독 만료/거부/네트워크를 그대로 안내한다.
  const TEST_LABEL = {
    plain: '테스트 알림을 보냈어요.',
    quiet: '무음 테스트를 보냈어요. 소리·진동 없이 오면 정상이에요.',
    next_class: '“⏰ 다음 수업” 형식으로 알림이 오면 정상이에요. (실제 알림은 수업 시작 전에 옵니다.)',
    today_summary: '“🌅 오늘 수업” 형식으로 알림이 오면 정상이에요. (실제 알림은 설정한 시각에 그날 수업으로 옵니다.)',
  };

  function testResultMessage(kind, r) {
    if (r.status === 'OK') return TEST_LABEL[kind];
    if (r.status === 'NO_SUB') return '이 기기의 푸시 구독을 찾을 수 없어요. 푸시를 껐다 켜 주세요.';
    if (r.status === 'GONE') return '푸시 구독이 만료됐어요. 푸시를 껐다 켠 뒤 다시 시도해 주세요.';
    if (r.status === 'REJECTED') return `푸시 서비스가 요청을 거부했어요 (코드 ${r.code}).`;
    if (r.status === 'NETWORK') return '푸시 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';
    if (r.status === 'FAIL' && r.message) return r.message;
    return `테스트 알림을 보내지 못했어요${r.code ? ` (코드 ${r.code})` : ''}.`;
  }

  async function runTest(kind) {
    setTestMsg('');
    setTestBusy(true);
    try {
      const r = await sendServerTestPush(kind);
      setTestMsg(testResultMessage(kind, r));
    } finally {
      setTestBusy(false);
    }
  }
```

Find (lines 241-248) — the test-button row and message:

```js
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  <button className="btn-ghost btn-sm" onClick={sendTest}>🔔 테스트 알림</button>
                  <button className="btn-ghost btn-sm" onClick={testQuietNow}>🌙 무음 테스트</button>
                  <button className="btn-ghost btn-sm" onClick={testNextClass}>⏰ 다음 수업</button>
                  <button className="btn-ghost btn-sm" onClick={testDailyBrief}>🌅 오늘 수업</button>
                </div>
                {testMsg && <p className="account-note" style={{ marginTop: 6 }}>{testMsg}</p>}
```

Replace with:

```js
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  <button className="btn-ghost btn-sm" disabled={testBusy} onClick={() => runTest('plain')}>🔔 테스트 알림</button>
                  <button className="btn-ghost btn-sm" disabled={testBusy} onClick={() => runTest('quiet')}>🌙 무음 테스트</button>
                  <button className="btn-ghost btn-sm" disabled={testBusy} onClick={() => runTest('next_class')}>⏰ 다음 수업</button>
                  <button className="btn-ghost btn-sm" disabled={testBusy} onClick={() => runTest('today_summary')}>🌅 오늘 수업</button>
                </div>
                {testMsg && <p className="account-note" style={{ marginTop: 6 }}>{testMsg}</p>}
```

- [ ] **Step 4: Check for now-unused symbols**

`setDndState` is still used by the DND on/off + start/end inputs (`updateDnd`) — keep it. `hhmmFromMin` is now removed. Confirm nothing else references `hhmmFromMin` or `sendTestPush`:

Run: `grep -rn "hhmmFromMin\|sendTestPush" src/`
Expected: no matches.

- [ ] **Step 5: Build and commit**

Run: `npm run build`
Expected: build succeeds (exit 0).

```bash
git add src/lib/push.js src/pages/Profile.jsx
git commit -m "feat: Profile push tests do real server sends; DND test no longer edits settings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Deploy + on-device verification

**Files:** none (deploy + manual).

- [ ] **Step 1: Push to main**

```bash
git push origin main
```

This triggers `deploy-firebase.yml` (deploys `functions`, including `sendSelfTestPush`) and Cloudflare Pages (frontend + `push-sw.js?v=16` + `functions/api/push-fanout.js`).

- [ ] **Step 2: Confirm the Firebase deploy succeeded**

Run: `gh run list --workflow=deploy-firebase.yml --limit 1`
Expected: latest run `completed  success`. If it is still running, wait and re-check; if it failed, open the log (`gh run view --log-failed`) and fix before proceeding.

- [ ] **Step 3: Confirm the live SW is v16**

Run: `curl -sS -A "Mozilla/5.0" "https://anytime.rokafa.app/push-sw.js?v=16" | grep -oE "PUSH_SW_VERSION = [0-9]+|showTestPush"`
Expected: `PUSH_SW_VERSION = 16` and `showTestPush` both print. (Cloudflare Pages usually deploys within ~1-2 min of the push.)

- [ ] **Step 4: On-device manual checks (iPhone, then optionally Android)**

Open the PWA, let the SW update to v16 (the in-app `UpdatePrompt` polls every 60 s; accept it, then fully close and reopen the PWA once). Go to Profile → 푸시 알림 → 알림 테스트, and for each button:

1. **🔔 테스트 알림** → a real OS notification "🔔 테스트 알림 / 테스트 알림이 도착했어요" arrives. (This is the pure "does a push physically reach this device" probe.)
2. **🌙 무음 테스트** → a notification arrives with **no sound/vibration**. Then check Profile: the 방해금지 시작/종료 times are **unchanged** (this was the bug).
3. **⏰ 다음 수업** → "⏰ 다음 수업 / 선형대수학 · 202 · 08:00".
4. **🌅 오늘 수업** → "🌅 오늘 수업 / 09:00 경제원론 · 302 …".

- [ ] **Step 5: Verify failure reporting**

In the Firebase console (or via MCP), temporarily delete this device's `pushSubscriptions/{hash}` doc, then tap 🔔 테스트 알림.
Expected: the message reads "이 기기의 푸시 구독을 찾을 수 없어요. 푸시를 껐다 켜 주세요." (not a false "보냈어요"). Re-enable push afterwards (toggle off/on in Profile) to recreate the doc.

- [ ] **Step 6: Re-test the real daily-summary schedule with the new TTL**

In Profile, set 🌅 오늘 수업 요약 발송 시각 to `현재시각 + 3분`, lock the phone, and wait. Expected: the summary notification arrives within a few minutes (the TTL is now 1 h, so a briefly-idle phone still receives it). Set the time back afterwards.

- [ ] **Step 7: Update the memory note**

Append to `next-class-alert-arch.md` (or the daily-brief section): SW is now v16; the four Profile test buttons do real server sends via `sendSelfTestPush` → `pushFanout({sync:true})`; `today_summary` push TTL is 3600 s (was 300); the 🌙 test uses a `quiet:true` payload flag and never edits DND settings.

---

## Self-Review

**1. Spec coverage**
- Sync `push-fanout` + per-target status → Task 1 ✓
- `today_summary` TTL 300→3600 → Task 1 Step 1 ✓
- `pushFanout` helper sync return → Task 1 Step 2 ✓
- `sendSelfTestPush` CF + per-kind payload table + status classification → Task 2 ✓
- `index.js` export → Task 2 Step 5 ✓
- SW `kind:'test'` renderer (always shows, honors `quiet`) → Task 3 Step 4 ✓
- SW `test:true` sample content for next_class / today_summary → Task 3 Steps 2-3 ✓
- SW version bump v16 + vite importScripts → Task 3 Steps 1, 5 ✓
- `sendServerTestPush` client helper, remove `sendTestPush` → Task 4 Step 1 ✓
- Four Profile buttons wired, `testBusy` disable, 🌙 no DND mutation, message mapper → Task 4 Step 3 ✓
- Deploy via push to main; on-device verification incl. failure path + TTL retest → Task 5 ✓

**2. Placeholder scan** — no TBD/TODO; every code step has complete code; commands have expected output. ✓

**3. Type consistency**
- `pushFanout(..., { sync })` returns `[{ endpoint, status }]` (Task 1) — consumed as `results?.[0]?.status` (Task 2 Step 4) ✓
- `sendSelfTestPush` returns `{ status, code? }` with `status ∈ {OK,GONE,REJECTED,NETWORK,ERROR}` (Task 2) — `sendServerTestPush` passes `res.data` straight through, adds `NO_SUB` / `FAIL` (Task 4 Step 1) — `testResultMessage` handles all seven (Task 4 Step 3) ✓
- push payload `data` carries `quiet` + `test` (Task 1) — SW reads `msg.quiet` / `msg.test` (Task 3) ✓
- `kind` vocabulary `'plain'|'quiet'|'next_class'|'today_summary'` consistent across Task 2 `TEST_KINDS`, Task 4 `sendServerTestPush` calls, Task 4 `runTest` args ✓

No issues found.
