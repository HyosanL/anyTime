# Real-send push test buttons + DND test fix + today_summary TTL — Design

**Date:** 2026-09-04
**Status:** approved (direction), proceeding to plan + deploy

## Problem

The "🌅 오늘 수업 요약" scheduled push is not arriving on an iOS device even though the
server fires it correctly. Verified this session:

- `nextClassNotify` matched the iOS subscription at exactly the scheduled minute
  (`todaySummaryAlerts.lastFired.mow = 6618`, stamped `2026-09-04T05:18:04Z`), no errors.
- Live `push-sw.js?v=15` on `anytime.rokafa.app` is correct (`showTodaySummary`, `today_summary`
  routing, `Cache-Control: no-store`).
- The user's iPhone is on **SW v15** (current) — so a stale service worker is ruled out.

The failure is therefore **downstream of our server**: Cloudflare `push-fanout` → `webpush.js`
→ APNs → device. The two live suspects:

1. **`today_summary` TTL is 300 s.** Copied from `next_class`, where staleness makes the ping
   useless. A locked/idle iPhone routinely does not receive a web push within 5 minutes, after
   which APNs drops it permanently.
2. General APNs / delivery failure (VAPID, subscription state) — currently invisible because
   `push-fanout` fires async and never reports per-target status.

Both existing "test" buttons in Profile are **local-only** (`reg.showNotification` directly, or
a SW `postMessage`) — they never exercise the real server → push-service path, so a real
delivery failure looks identical to success. And the "🌙 무음 테스트" button rewrites the
user's Do-Not-Disturb window to include "now" and never restores it.

## Goals

1. Make all four Profile push-test buttons send a **real** push through the exact production
   path (Firebase CF → `/api/push-fanout` → `webpush.js` → push service → SW).
2. On success, keep the old lightweight UX ("테스트 알림을 보냈어요"). On failure, surface the
   real push-service result (expired / rejected / network).
3. Stop the 🌙 test from mutating DND settings.
4. Bump `today_summary` TTL so a slightly-late daily summary still gets delivered.

## Non-goals

- Changing the scheduled `nextClassNotify` path (it works — proven by `lastFired` stamps).
- Retry / store-and-forward for missed scheduled pings.
- Any uid ↔ subscription linkage (anonymity: [[board-full-anonymity]]).

## Approach

The test must ride the **same transport as every real push** — otherwise it can pass while
production fails. So: a new Firebase onCall function calls the existing `pushFanout` helper →
existing `/api/push-fanout` Pages Function, with a new **synchronous** mode that returns the
per-target push-service HTTP status.

Rejected alternatives:
- Separate `/api/push-test` Pages endpoint — duplicates the fanout/prune/webpush plumbing.
- Firebase CF calls `webpush.js` directly — needs VAPID keys as Firebase secrets and, worse,
  **splits the send path**, so the diagnostic no longer proves the real path.

## Components

### 1. `functions/api/push-fanout.js` — synchronous mode + TTL bump

- Accept `sync: true` in the POST body. When set:
  - `await fanout(...)` instead of `context.waitUntil(fanout(...))`.
  - `fanout()` returns `results: [{ endpoint, status }]` where `status` is the push-service
    HTTP status (`201` accepted, `404`/`410` gone, `403` rejected, …) or `0` for a thrown
    fetch (network). It already builds `Promise.allSettled` results for dead-subscription
    pruning — reuse that array.
  - Response: `{ status: 'OK', results }` (HTTP 200).
- Non-sync path unchanged: `context.waitUntil(...)` + `{ status: 'ACCEPTED', targets }`.
- Dead-subscription pruning (`pushPrune` call for 404/410) runs in both modes.
- **TTL:** `today_summary` branch `ttl: 300` → `ttl: 3600`. `urgency: 'high'` and
  `topic: 'today-summary'` unchanged. `next_class` stays at `300` (freshness matters there).

### 2. `firebase/functions/src/lib/pushFanout.js` — return status when sync

- Add optional 5th arg `{ sync = false } = {}`.
- When `sync`: after the `fetch`, parse the JSON body and return the `results` array
  (`[{ endpoint, status }]`); on a thrown fetch or unparseable body return
  `[{ endpoint: <first>, status: 0 }]` per target so the caller always gets a shape.
- When not `sync`: unchanged (errors swallowed, returns `undefined`).
- Existing callers (`nextClass.js`, `board.js`) pass 4 args → no behaviour change.

### 3. `firebase/functions/src/push.js` — new `sendSelfTestPush`

- `onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, ...)`.
- Payload `{ endpoint, kind }`, `kind ∈ { 'plain', 'quiet', 'next_class', 'today_summary' }`.
- `requireAuth(request)`. Validate `endpoint` (string, `https://`, ≤ 1024). Validate `kind`
  against the allowlist → else `invalid(...)`.
- Load `pushSubscriptions/{subscriptionId(endpoint)}`. If `!exists` →
  `invalid('이 기기의 푸시 구독을 찾을 수 없어요. 푸시를 껐다 켜 주세요.')`.
- Build the fan-out payload per kind:

  | kind | payload sent to push-fanout |
  |---|---|
  | `plain` | `{ kind: 'hot', title: '🔔 테스트 알림', board: '테스트', path: '/' }` — legacy shape, renders on every SW back to v1 (pure "does a push arrive" probe) |
  | `quiet` | `{ kind: 'test', quiet: true, title: '🌙 무음 테스트', body: '소리·진동 없이 왔으면 정상이에요.', path: '/' }` |
  | `next_class` | `{ kind: 'next_class', test: true, mow: <seoulMinuteOfWeek()>, path: '/' }` |
  | `today_summary` | `{ kind: 'today_summary', test: true, mow: <seoulMinuteOfWeek()>, path: '/' }` |

  `push.js` already has its own local `subscriptionId` (the codebase already duplicates this
  tiny helper between `push.js` and `nextClass.js`). Follow that same convention: add a local
  `seoulMinuteOfWeek` copy to `push.js` rather than coupling `push.js` → `nextClass.js`.

- `pushFanout(pushFanoutUrl.value(), pushFanoutSecret.value(), payload, [target], { sync: true })`.
- Map the single result `status` → return value:

  | status | return | client message |
  |---|---|---|
  | `200`–`299` | `{ status: 'OK' }` | "테스트 알림을 보냈어요." (per-kind wording) |
  | `404` / `410` | `{ status: 'GONE' }` | "구독이 만료됐어요. 푸시를 껐다 켜 주세요." |
  | `401` / `403` | `{ status: 'REJECTED', code }` | "푸시 서비스가 거부했어요 (403)." |
  | `0` | `{ status: 'NETWORK' }` | "푸시 서버에 연결하지 못했어요. 잠시 후 다시." |
  | other | `{ status: 'ERROR', code }` | "전송 실패 (코드 N)." |

- Export from `firebase/functions/index.js`.

### 4. `public/push-sw.js` — v16

- `showPush`: route the new kind **before** the "viewing this path" suppression check
  (a test must always display):
  ```js
  if (msg.kind === 'test') return showTestPush(msg);
  ```
- New `showTestPush(msg)`:
  - `showNotification(msg.title || '🔔 테스트 알림', opts)`.
  - `opts.body = msg.body || ''`, `tag: 'push-self-test'`, `data.path` from `msg.path` (`/` default).
  - `msg.quiet === true` → `opts.silent = true` (no `vibrate`). Else `renotify: true`,
    `vibrate: [180,80,180]`. **Does not read `/dnd-config`.**
- `showNextClass(msg)`: `if (msg.test)` → fixed sample slot
  `{ subject: '선형대수학', room: '202', start: '08:00' }`, skip cache/`mow` lookup.
- `showTodaySummary(msg)`: `if (msg.test)` → fixed sample body
  `'09:00 경제원론 · 302\n11:00 물리학 · 401'`, skip the `mow`→day + cache lookup.
- `PUSH_SW_VERSION = 16`; `vite.config.js` `importScripts: ['push-sw.js?v=16']`.
- Degradation on the (rare) pre-v16 SW: `plain` renders fully (`hot`); `next_class` /
  `today_summary` ignore `test` but still use `mow` → real-or-fallback content, still a
  notification; `quiet` falls to the comment branch → an oddly-titled but visible notification.
  All still confirm delivery.

### 5. `src/lib/push.js` — `sendServerTestPush(kind)`

- Gets the browser subscription endpoint (`getSubscription()`); if none → return
  `{ status: 'NO_SUB' }`.
- `callFn('sendSelfTestPush', { endpoint, kind })`; normalize `{ ok, status, data }` →
  `{ status, code }`.
- Remove the now-unused `sendTestPush` JS export (postMessage TEST_PUSH) — nothing else uses
  it after this change. **Leave** the SW `message` handler's `TEST_PUSH` branch in place
  (harmless, and not worth a v16 diff).

### 6. `src/pages/Profile.jsx` — wire the four buttons

- One `testBusy` state; disable all four buttons while a send is in flight.
- `sendTest` (🔔) → `sendServerTestPush('plain')`.
- `testQuietNow` (🌙) → `sendServerTestPush('quiet')`. **Delete** `hhmmFromMin`, the `win`
  construction, the `setDnd(win)` call, the `setDndState(win)` call, and the "되돌려 주세요"
  copy. New success text: "무음 테스트를 보냈어요. 소리·진동 없이 오면 정상이에요."
- `testNextClass` (⏰) → `sendServerTestPush('next_class')`.
- `testDailyBrief` (🌅) → `sendServerTestPush('today_summary')`.
- Shared result→message mapper (table in §3). Keep messages in the existing `testMsg` line.

## Data flow

```
Profile button → sendServerTestPush(kind) → callFn('sendSelfTestPush', {endpoint, kind})
  → [Firebase CF] validate + load subscription doc + build payload
  → pushFanout(..., {sync:true})  →  POST /api/push-fanout {sync:true, targets:[1]}
  → [Pages Fn] await fanout() → webpush.sendPush() → push service (APNs/FCM)
  → results:[{endpoint, status}] ─────────────────────────────────────────────┐
  ← { status:'OK' | 'GONE' | 'REJECTED' | 'NETWORK' | 'ERROR', code } ────────┘
  → Profile shows generic success OR specific failure
  (asynchronously) device SW `push` event → showTestPush / showNextClass / showTodaySummary
```

## Testing

Repo has no test framework — pure logic gets a throwaway `node` script, integration is
`npm run build` + on-device manual (per `2026-09-01-next-class-alert-design.md` §Ⅷ).

- `node --check` on every edited `firebase/functions/**` and `functions/api/push-fanout.js` file.
- Scratch script: `sendSelfTestPush`'s payload builder (extract the pure `kind → payload`
  map) — assert each kind's shape.
- `npm run build` (Vite resolves every import; catches wrong paths/names).
- Manual after deploy, on the iPhone (SW updates v15→v16 first):
  1. Each of the four buttons → real OS notification, correct format, correct title.
  2. 🌙 → silent (no sound/vibration); confirm DND settings in Profile are **unchanged**.
  3. Force a failure: temporarily disable push server-side / use a stale endpoint → button
     shows the specific error ("구독이 만료됐어요 …"), not a false success.
  4. Re-run the real 🌅 "오늘 수업 요약" schedule test (time = now+3) and confirm the TTL
     bump lets it land on a locked phone.

## Deploy

Commit per task; `git push origin main`:
- GitHub Actions (`deploy-firebase.yml`) deploys `functions` (`sendSelfTestPush` + edits).
- Cloudflare Pages auto-deploys the frontend + `sw.js`/`push-sw.js?v=16` + the
  `functions/api/push-fanout.js` Pages Function.
- Local `firebase deploy` is blocked on this machine ([[firebase-deploy-gcs-blocked]]).
