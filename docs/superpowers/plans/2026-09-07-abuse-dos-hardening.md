# 남용·DoS 하드닝 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Firebase App Check + 함수 레이트리밋 + 업로드/규칙 조임 + Cloudflare IaC 로 트래픽 폭주·자원 고갈·검열성 신고 남용을 막고, 안전한 단계적 롤아웃으로 배포한다.

**Architecture:** Firebase 측은 App Check(척추) + 함수별 `enforceAppCheck` 토글 상수 + `maxInstances:10` + uid별 슬라이딩 윈도우 레이트리밋. Cloudflare 측은 `functions/api/*` 업로드 하드닝 + Terraform(`infra/cloudflare/`)으로 1개 rate-limit rule + 5개 WAF custom rule + Turnstile. 콘솔/자격증명이 필요한 단계는 런북으로 분리하고, 코드 변경만 CI(GitHub Actions·Cloudflare Pages)로 배포한다.

**Tech Stack:** firebase-functions v6 (Node 22, ESM), firebase-admin v13, Firebase JS SDK v11 (`firebase/app-check`), Vite 6 + React 19, Cloudflare Pages Functions (Workers), Terraform (`cloudflare/cloudflare ~> 5`), `node --test` (내장, 신규 의존성 없음).

## Global Constraints

- **디자인 원칙**: `CONVENTIONS.md` — 모든 `onCall` 첫 줄은 `requireAuth`/`requireAdmin`. `lib/secrets.js` 편집 금지. 카운터는 항상 `FieldValue.increment()`. 타임스탬프는 항상 `FieldValue.serverTimestamp()`. 코드 주석은 "왜"만(비자명한 이식 불변식·Firestore 제약·보안 이유), "무엇"은 금지.
- **언어**: 대화 한국어, 코드·주석·커밋·문서 영어 (사용자 지시). `HttpsError` 메시지는 한국어.
- **배포 경로**: `firebase/**` 변경 → GitHub Actions `deploy-firebase.yml` (functions + firestore:rules + firestore:indexes, `--force`). `src/**` / `public/**` / `.env.production` 변경 → Cloudflare Pages Git 빌드(`npm run build`). 로컬 `firebase deploy` 는 이 PC 에서 storage.googleapis.com 차단으로 불가.
- **커밋**: 트렁크 기반 — `main` 에 직접 커밋. 커밋 메시지 끝에 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- **App Check 강제 플래그**: `firebase/functions/src/lib/opts.js` 의 `ENFORCE_APP_CHECK` 상수. 이 플랜에서는 **항상 `false`** 로 둔다. `true` 전환은 런북(메트릭 관찰 후).
- **하위호환**: 기존 사용자(비번 6자, `createdAt` 없는 계정, `reportCountStrong` 없는 문서)는 절대 깨지 않는다. 새 검증은 신규 데이터에만.
- **`_headers` CSP**: 인라인 스크립트 `sha256-` 해시 두 개는 **건드리지 않는다**(index.html 인라인 스크립트 미변경). 호스트 소스만 추가.
- **CF 무료 플랜**: rate limiting rule 1개(action=block, period 10/60s, duration 60s/1h), WAF custom rule 5개(Log 제외 전 액션).

**참조 스펙:** `docs/superpowers/specs/2026-09-07-abuse-dos-hardening-design.md`

---

## Phase 0 — 테스트 하네스

### Task 0: `node --test` 하네스

**Files:**
- Modify: `firebase/functions/package.json`
- Create: `firebase/functions/test/smoke.test.js`

**Interfaces:**
- Produces: `npm test` (in `firebase/functions/`) runs `node --test test/`.

- [ ] **Step 1: Add test script**

`firebase/functions/package.json` 의 `"scripts"` 에 추가 (기존 키 유지):

```json
  "scripts": {
    "serve": "firebase emulators:start --only functions,firestore,auth",
    "shell": "firebase functions:shell",
    "deploy": "firebase deploy --only functions",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write a smoke test**

Create `firebase/functions/test/smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('node:test harness runs', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 3: Run it**

Run: `cd firebase/functions && npm test`
Expected: `# pass 1` / exit 0.

- [ ] **Step 4: Commit**

```bash
git add firebase/functions/package.json firebase/functions/test/smoke.test.js
git commit -m "test: add node --test harness for Cloud Functions"
```

---

## Phase 1 — Firebase 함수 남용 한도

### Task 1: `opts.js` — App Check 토글 헬퍼

**Files:**
- Create: `firebase/functions/src/lib/opts.js`
- Create: `firebase/functions/test/opts.test.js`

**Interfaces:**
- Produces: `callable(extra = {}) → { enforceAppCheck: boolean, ...extra }` — every `onCall` in this codebase wraps its options object with this.

- [ ] **Step 1: Write the failing test**

Create `firebase/functions/test/opts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callable } from '../src/lib/opts.js';

test('callable() carries the enforce flag and it is false in the plan baseline', () => {
  assert.equal(callable().enforceAppCheck, false);
});

test('callable() merges extra options and extra wins on conflict', () => {
  const o = callable({ secrets: ['A'], region: 'asia-northeast3' });
  assert.deepEqual(o.secrets, ['A']);
  assert.equal(o.region, 'asia-northeast3');
  assert.equal(o.enforceAppCheck, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd firebase/functions && npm test`
Expected: FAIL — `Cannot find module '../src/lib/opts.js'`.

- [ ] **Step 3: Implement**

Create `firebase/functions/src/lib/opts.js`:

```js
// App Check enforcement toggle for every onCall in this codebase.
//
// enforceAppCheck is deliberately NOT set via setGlobalOptions: firebase-functions
// resolves it from global as a fallback for onRequest too (see
// node_modules/firebase-functions/lib/v2/providers/https.js), which would 401 the
// two secret-gated onRequest endpoints (boardReferencedKeys, pushPrune) that cron
// and the Cloudflare push-fanout call with an X-Push-Secret header and no App
// Check token. So each onCall opts in explicitly through this helper.
//
// ENFORCE_APP_CHECK stays false until App Check console metrics confirm that
// effectively all real traffic carries a valid attestation — then it is flipped
// to true in a one-line commit (git history is the audit trail). See
// docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md.
const ENFORCE_APP_CHECK = false;

export function callable(extra = {}) {
  return { enforceAppCheck: ENFORCE_APP_CHECK, ...extra };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd firebase/functions && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add firebase/functions/src/lib/opts.js firebase/functions/test/opts.test.js
git commit -m "feat(functions): callable() helper for per-onCall App Check toggle"
```

---

### Task 2: `maxInstances` 전역 상한 + 전 `onCall` 에 `callable()` 적용

**Files:**
- Modify: `firebase/functions/src/lib/globalOptions.js`
- Modify: `firebase/functions/src/auth.js` (signup, deleteAccount, geoVerify, setSignupCode)
- Modify: `firebase/functions/src/admin.js` (adminAction)
- Modify: `firebase/functions/src/syncProfessors.js` (syncProfessors)
- Modify: `firebase/functions/src/timetable.js` (createTimetable, setPrimaryTimetable, renameTimetable, deleteTimetable, addTimetableEntry, removeTimetableEntry, addCustomClass, updateCustomClass, deleteCustomClass, searchSharedUsers, getSharedGallery)
- Modify: `firebase/functions/src/reviews.js` (createReview, deleteReview, likeReview, reportReview)
- Modify: `firebase/functions/src/examArchive.js` (createExam, deleteExam)
- Modify: `firebase/functions/src/classMemo.js` (createMemo, getMemos, deleteMemo, reportMemo)
- Modify: `firebase/functions/src/corrections.js` (submitCorrection)
- Modify: `firebase/functions/src/appReport.js` (submitAppReport, getMyAppReports)
- Modify: `firebase/functions/src/feedback.js` (getMyFeedback)
- Modify: `firebase/functions/src/feedbackThreads.js` (replyFeedbackThread)
- Modify: `firebase/functions/src/board.js` (createBoard, createPost, getPost, boardReact, createComment, deletePost, deleteComment)
- Modify: `firebase/functions/src/push.js` (pushSubscribe, pushUnsubscribe, pushSetHot, pushWatch, pushUnwatch, adminPushSubscribe, adminPushUnsubscribe, sendSelfTestPush)
- Modify: `firebase/functions/src/nextClass.js` (setNextClassAlerts, setTodaySummaryAlert)

**Interfaces:**
- Consumes: `callable()` from Task 1.
- Produces: every `onCall(...)` now reads `onCall(callable({...}), handler)`. `onRequest` (`boardReferencedKeys`, `pushPrune`) and all `onSchedule`/`onDocument*`/`onDocumentWritten` are **unchanged**.

- [ ] **Step 1: Add maxInstances to global options**

`firebase/functions/src/lib/globalOptions.js` — replace the `setGlobalOptions` call:

```js
import { setGlobalOptions } from 'firebase-functions/v2';

// region: everything (Firestore + users) is in Korea.
// maxInstances: hard ceiling on runaway cost — an onCall/trigger flood scales to
// at most 10 parallel instances instead of the platform default. nextClassNotify
// (every-minute cron) and the push triggers stay well under this. Raise per
// function later if a genuine fan-out needs it.
setGlobalOptions({ region: 'asia-northeast3', maxInstances: 10 });
```

- [ ] **Step 2: Wrap every onCall with callable()**

In each file above, add the import and wrap. Pattern:

```js
// add near the other lib imports:
import { callable } from './lib/opts.js';        // in src/*.js
// or  '../lib/opts.js'  — N/A here, all onCall live in src/*.js directly
```

Then for each `onCall`:

| Before | After |
|---|---|
| `onCall(async (request) => {` | `onCall(callable(), async (request) => {` |
| `onCall({ secrets: [x] }, async (request) => {` | `onCall(callable({ secrets: [x] }), async (request) => {` |
| `onCall({ region: REGION }, async (request) => {` | `onCall(callable({ region: REGION }), async (request) => {` |
| `onCall({ timeoutSeconds: 180 }, async (request) => {` | `onCall(callable({ timeoutSeconds: 180 }), async (request) => {` |

Concretely, `auth.js` has `import { onCall, HttpsError } from 'firebase-functions/v2/https';` — add `import { callable } from './lib/opts.js';` and change:
- `export const signup = onCall({ region: REGION }, async (request) => {` → `export const signup = onCall(callable({ region: REGION }), async (request) => {`
- `export const deleteAccount = onCall({ region: REGION }, ...` → `onCall(callable({ region: REGION }), ...`
- `export const geoVerify = onCall({ region: REGION }, ...` → `onCall(callable({ region: REGION }), ...`
- `export const setSignupCode = onCall({ region: REGION }, ...` → `onCall(callable({ region: REGION }), ...`
- `syncAdminClaim` (onDocumentUpdated) and `purgeExpiredAccounts` (onSchedule) — **unchanged**.

`board.js`: `boardReferencedKeys` (`onRequest`) and `purgeBoard`/`onCommentCreatedPush`/`onPostHotChangedPush` — **unchanged**. Wrap `createBoard`, `createPost`, `getPost`, `boardReact`, `createComment`, `deletePost`, `deleteComment`.

`push.js`: `pushPrune` (`onRequest`) — **unchanged**. Wrap the 8 `onCall`.

`nextClass.js`: `nextClassNotify` (`onSchedule`) — **unchanged**. Wrap `setNextClassAlerts`, `setTodaySummaryAlert`.

`reviews.js`: `onReviewWritten` (onDocumentWritten) — **unchanged**.

- [ ] **Step 3: Syntax check**

Run: `cd firebase/functions && node --check index.js && node -e "import('./index.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `OK` (all modules load; no reference errors).

- [ ] **Step 4: Verify no onRequest/trigger got wrapped**

Run: `cd firebase/functions && grep -rn "onRequest(callable\|onSchedule(callable\|onDocument.*callable" src/ ; echo "exit: $?"`
Expected: no matches (`exit: 1`).

- [ ] **Step 5: Commit**

```bash
git add firebase/functions/src/
git commit -m "feat(functions): maxInstances:10 cap + enforceAppCheck opt-in on every onCall (flag off)"
```

---

### Task 3: `rateLimit.js` — uid별 고정 윈도우 레이트리밋

**Files:**
- Create: `firebase/functions/src/lib/rateLimit.js`
- Create: `firebase/functions/test/rateLimit.test.js`

**Interfaces:**
- Consumes: `db`, `FieldValue`, `Timestamp` from `./context.js`.
- Produces:
  - `evaluateWindow(doc | null, nowMs, { limit, windowMs }) → { action: 'reset' | 'increment' | 'reject' }` (pure)
  - `LIMITS` — `Record<string, { limit: number, windowSec: number }>`
  - `assertUnderLimit(uid: string, action: keyof LIMITS) → Promise<void>` — throws `HttpsError('resource-exhausted', ...)` when over.

- [ ] **Step 1: Write the failing tests**

Create `firebase/functions/test/rateLimit.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWindow, LIMITS } from '../src/lib/rateLimit.js';

const P = { limit: 3, windowMs: 1000 };

test('no doc -> reset', () => {
  assert.deepEqual(evaluateWindow(null, 5000, P), { action: 'reset' });
});

test('window elapsed -> reset', () => {
  assert.deepEqual(evaluateWindow({ count: 3, windowStartMs: 1000 }, 2000, P), { action: 'reset' });
});

test('inside window, under limit -> increment', () => {
  assert.deepEqual(evaluateWindow({ count: 2, windowStartMs: 1000 }, 1500, P), { action: 'increment' });
});

test('inside window, at limit -> reject', () => {
  assert.deepEqual(evaluateWindow({ count: 3, windowStartMs: 1000 }, 1500, P), { action: 'reject' });
});

test('every known action has a positive limit and window', () => {
  for (const [name, cfg] of Object.entries(LIMITS)) {
    assert.ok(cfg.limit > 0, `${name}.limit`);
    assert.ok(cfg.windowSec > 0, `${name}.windowSec`);
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd firebase/functions && npm test`
Expected: FAIL — `Cannot find module '../src/lib/rateLimit.js'`.

- [ ] **Step 3: Implement**

Create `firebase/functions/src/lib/rateLimit.js`:

```js
import { HttpsError } from 'firebase-functions/v2/https';
import { db, FieldValue, Timestamp } from './context.js';

// Fixed-window per-(uid, action) counter. One transactional write per call —
// writes are ~free at this app's scale ([[capacity-cost-800dau]]). Docs live in
// `rateLimits/{uid}_{action}` (Rules: Admin SDK only) and are swept by a
// Firestore TTL policy on `rateLimits.expireAt` (console one-time setup).

const HOUR = 3600;
const DAY = 86400;

export const LIMITS = {
  createPost: { limit: 10, windowSec: HOUR },
  createReview: { limit: 10, windowSec: HOUR },
  createExam: { limit: 10, windowSec: HOUR },
  createMemo: { limit: 10, windowSec: HOUR },
  createComment: { limit: 30, windowSec: HOUR },
  createBoard: { limit: 5, windowSec: DAY },
  boardReact: { limit: 60, windowSec: HOUR },
  likeReview: { limit: 60, windowSec: HOUR },
  getPostView: { limit: 120, windowSec: HOUR },
  submitCorrection: { limit: 20, windowSec: DAY },
  submitAppReport: { limit: 20, windowSec: DAY },
  replyFeedbackThread: { limit: 30, windowSec: HOUR },
  sendSelfTestPush: { limit: 5, windowSec: HOUR },
};

// Pure decision — no Firestore. `doc` is { count, windowStartMs } or null.
export function evaluateWindow(doc, nowMs, { limit, windowMs }) {
  const startMs = doc?.windowStartMs ?? 0;
  if (!doc || nowMs - startMs >= windowMs) return { action: 'reset' };
  if ((doc.count ?? 0) >= limit) return { action: 'reject' };
  return { action: 'increment' };
}

export async function assertUnderLimit(uid, action) {
  const cfg = LIMITS[action];
  if (!cfg) throw new Error(`rateLimit: unknown action "${action}"`);
  const windowMs = cfg.windowSec * 1000;
  const ref = db.collection('rateLimits').doc(`${uid}_${action}`);
  const now = Date.now();

  const rejected = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const doc = snap.exists
      ? { count: snap.get('count') ?? 0, windowStartMs: snap.get('windowStart')?.toMillis?.() ?? 0 }
      : null;
    const { action: decision } = evaluateWindow(doc, now, { limit: cfg.limit, windowMs });
    if (decision === 'reject') return true;
    if (decision === 'reset') {
      tx.set(ref, {
        count: 1,
        windowStart: Timestamp.fromMillis(now),
        expireAt: new Date(now + windowMs + DAY * 1000),
      });
    } else {
      tx.update(ref, { count: FieldValue.increment(1) });
    }
    return false;
  });

  if (rejected) {
    throw new HttpsError('resource-exhausted', '요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.');
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd firebase/functions && npm test`
Expected: PASS (all rateLimit + opts + smoke tests).

- [ ] **Step 5: Commit**

```bash
git add firebase/functions/src/lib/rateLimit.js firebase/functions/test/rateLimit.test.js
git commit -m "feat(functions): per-uid fixed-window rate limiter (rateLimits collection)"
```

---

### Task 4: 레이트리밋 적용 — board.js

**Files:**
- Modify: `firebase/functions/src/board.js` (createPost, createComment, createBoard, boardReact, getPost)

**Interfaces:**
- Consumes: `assertUnderLimit` from `./lib/rateLimit.js`.

- [ ] **Step 1: Import**

`board.js` top imports — add:

```js
import { assertUnderLimit } from './lib/rateLimit.js';
```

- [ ] **Step 2: createBoard**

After `requireAuth(request);` in `createBoard`:

```js
export const createBoard = onCall(callable(), async (request) => {
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'createBoard');
  const { name } = request.data ?? {};
```

(`requireAuth` currently isn't assigned to `uid` in `createBoard` — capture it.)

- [ ] **Step 3: createPost**

`createPost` first line is `const uid = requireAuth(request);` — add right after:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'createPost');
```

- [ ] **Step 4: createComment**

Same, after `const uid = requireAuth(request);`:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'createComment');
```

- [ ] **Step 5: boardReact**

After `const uid = requireAuth(request);` (before the `kind` validation):

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'boardReact');
```

- [ ] **Step 6: getPost — view increment only, non-fatal**

`getPost` already calls `requireAuth(request)` at its top — capture it as `uid`, and wrap the view-count increment so a rate-limit hit still serves the post:

```js
export const getPost = onCall(callable(), async (request) => {
  const uid = requireAuth(request);
  const { postId, view } = request.data ?? {};
  if (!postId) invalid('잘못된 요청입니다.');

  const postRef = db.collection('boardPosts').doc(postId);
  let snap = await postRef.get();
  if (!snap.exists) return null;
  if (view === true) {
    try {
      await assertUnderLimit(uid, 'getPostView');
      await postRef.update({ viewCount: FieldValue.increment(1) });
      snap = await postRef.get();
    } catch (e) {
      if (e.code !== 'resource-exhausted') throw e;
    }
  }
  return { id: snap.id, ...snap.data() };
});
```

- [ ] **Step 7: Syntax check**

Run: `cd firebase/functions && node --check src/board.js && node -e "import('./src/board.js').then(()=>console.log('OK'))"`
Expected: `OK`.

- [ ] **Step 8: Commit**

```bash
git add firebase/functions/src/board.js
git commit -m "feat(functions): rate-limit createPost/Comment/Board/boardReact + getPost view"
```

---

### Task 5: 레이트리밋 + likeReview dedup — reviews.js

**Files:**
- Modify: `firebase/functions/src/reviews.js` (createReview, likeReview, reportReview)
- Modify: `firebase/firestore.rules` (add `reviews/{id}/likes/{doc}` deny match)
- Modify: `firebase/functions/src/admin/moderationActions.js` (`dismissReport` — scope review reaction delete)

**Interfaces:**
- Consumes: `assertUnderLimit` from `./lib/rateLimit.js`, `actorHash` from `./lib/hash.js` (already imported), `actorHashSalt` (already imported).
- Produces: review likes now live in `reviews/{id}/likes/{actorHash}` (was: unbounded `likeCount` increment with no dedup). `likeReview` payload gains optional `on: boolean` (default true = like, false = unlike).

- [ ] **Step 1: Import**

`reviews.js` — add:

```js
import { assertUnderLimit } from './lib/rateLimit.js';
```

- [ ] **Step 2: createReview rate limit**

After `const uid = requireAuth(request);`:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'createReview');
```

- [ ] **Step 3: Replace likeReview with dedup version**

```js
export const likeReview = onCall(callable({ secrets: [actorHashSalt] }), async (request) => {
  const uid = requireAuth(request);
  const { id, on } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');
  await assertUnderLimit(uid, 'likeReview');

  // 1 like per person, mirroring board_post — but review `reactions` stays
  // report-only (dismissReport / feedback.js reason about it), so likes get
  // their own isolated subcollection instead of a kind-prefixed reaction doc.
  const reviewRef = db.collection('reviews').doc(id);
  const likeRef = reviewRef.collection('likes').doc(actorHash(actorHashSalt.value(), uid, 'review-like', id));
  const want = on !== false;

  const result = await db.runTransaction(async (tx) => {
    const [reviewSnap, likeSnap] = await Promise.all([tx.get(reviewRef), tx.get(likeRef)]);
    if (!reviewSnap.exists) return 'NOT_FOUND';
    if (want === likeSnap.exists) return 'NOOP'; // already liked / already not liked
    if (want) {
      tx.set(likeRef, { createdAt: FieldValue.serverTimestamp() });
      tx.update(reviewRef, { likeCount: FieldValue.increment(1) });
    } else {
      tx.delete(likeRef);
      tx.update(reviewRef, { likeCount: FieldValue.increment(-1) });
    }
    return 'OK';
  });

  if (result === 'NOT_FOUND') return { status: 'NOT_FOUND' };
  return { status: 'OK' };
});
```

- [ ] **Step 4: Add `reportContent` limit key, then rate-limit reportReview**

First amend `firebase/functions/src/lib/rateLimit.js` `LIMITS` — add one entry (shared by `reportReview`, `reportMemo`, and `boardReact`'s report path):

```js
  boardReact: { limit: 60, windowSec: HOUR },
  reportContent: { limit: 20, windowSec: HOUR },
  likeReview: { limit: 60, windowSec: HOUR },
```

Then in `reportReview`, after `const uid = requireAuth(request);`:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'reportContent');
```

- [ ] **Step 5: firestore.rules — likes subcollection**

In `firebase/firestore.rules`, inside `match /reviews/{id} {`, next to the existing `_private` / `reactions` matches:

```
    match /reviews/{id} {
      allow read: if isSignedIn();
      allow write: if false;

      match /_private/{doc} { allow read, write: if false; }
      match /reactions/{doc} { allow read, write: if false; }
      match /likes/{doc} { allow read, write: if false; }
    }
```

- [ ] **Step 6: dismissReport — don't wipe review likes**

`firebase/functions/src/admin/moderationActions.js`, function `dismissReport`, the `else` branch (review/class_memo). Currently:

```js
  } else {
    await db.recursiveDelete(ref.collection('reactions'));
    await db.recursiveDelete(ref.collection('events'));
    await ref.update({ reportCount: 0, reportReviewedCount: 0, ...dismissMark });
  }
```

`reactions` for a review is still report-only after Task 5 (likes moved to `likes/`), so this stays correct — **no change needed**. Add a one-line comment so a future reader knows likes are elsewhere:

```js
  } else {
    // review/class_memo: `reactions` is report-only (review likes live in
    // `likes/`, memos have no likes) — safe to drop wholesale.
    await db.recursiveDelete(ref.collection('reactions'));
    await db.recursiveDelete(ref.collection('events'));
    await ref.update({ reportCount: 0, reportReviewedCount: 0, ...dismissMark });
  }
```

- [ ] **Step 7: Update the reviews.js design comment**

`reviews.js` `likeReview` had a comment "Do not add actor-hash dedup here." — replace it (it's now superseded):

```js
// Port of like_review(): the original RPC had no dedup. Superseded 2026-09-07
// (docs/superpowers/specs/2026-09-07-abuse-dos-hardening-design.md §B.3) — 1
// like per person via reviews/{id}/likes/{actorHash}, plus a per-uid rate limit.
```

- [ ] **Step 8: Client — likeReview call unchanged**

Verify `src/pages/Reviews.jsx` / `ProfessorDetail.jsx` call `likeReview` with `{ id }` — the new `on` param is optional (default like), so no client change is required for the like path. (An unlike button is out of scope — YAGNI; the old RPC had no unlike either.)

Run: `grep -rn "likeReview\|'likeReview'" src/`
Expected: calls pass only `{ id }` — confirm, no edit.

- [ ] **Step 9: Test + syntax check**

Run: `cd firebase/functions && npm test && node -e "import('./src/reviews.js').then(()=>console.log('OK'))"`
Expected: PASS + `OK`.

- [ ] **Step 10: Commit**

```bash
git add firebase/functions/src/reviews.js firebase/functions/src/lib/rateLimit.js firebase/functions/src/admin/moderationActions.js firebase/firestore.rules
git commit -m "feat(functions): rate-limit review writes + 1-like-per-person dedup (reviews/likes)"
```

---

### Task 6: 레이트리밋 적용 — 나머지 함수

**Files:**
- Modify: `firebase/functions/src/classMemo.js` (createMemo, reportMemo)
- Modify: `firebase/functions/src/examArchive.js` (createExam)
- Modify: `firebase/functions/src/corrections.js` (submitCorrection)
- Modify: `firebase/functions/src/appReport.js` (submitAppReport)
- Modify: `firebase/functions/src/feedbackThreads.js` (replyFeedbackThread)
- Modify: `firebase/functions/src/push.js` (sendSelfTestPush)

**Interfaces:**
- Consumes: `assertUnderLimit`, `LIMITS` keys `createMemo`, `reportContent`, `createExam`, `submitCorrection`, `submitAppReport`, `replyFeedbackThread`, `sendSelfTestPush`.

- [ ] **Step 1: classMemo.js**

Add `import { assertUnderLimit } from './lib/rateLimit.js';`. In `createMemo` after `const uid = requireAuth(request);`:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'createMemo');
```

In `reportMemo` after `const uid = requireAuth(request);`:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'reportContent');
```

- [ ] **Step 2: examArchive.js**

Add import. In `createExam` after `const uid = requireAuth(request);`:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'createExam');
```

- [ ] **Step 3: corrections.js**

Add import. `submitCorrection` starts `requireAuth(request);` (no uid capture) — change to:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'submitCorrection');
```

- [ ] **Step 4: appReport.js**

Add import. `submitAppReport` starts `requireAuth(request);` — change to:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'submitAppReport');
```

- [ ] **Step 5: feedbackThreads.js**

Add import. `replyFeedbackThread` first line `const uid = requireAuth(request);` — add:

```js
    const uid = requireAuth(request);
    await assertUnderLimit(uid, 'replyFeedbackThread');
```

- [ ] **Step 6: push.js — sendSelfTestPush**

Add import. `sendSelfTestPush` starts `requireAuth(request);` — change to:

```js
  const uid = requireAuth(request);
  await assertUnderLimit(uid, 'sendSelfTestPush');
```

- [ ] **Step 7: Syntax check**

Run: `cd firebase/functions && node -e "import('./index.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `OK`.

- [ ] **Step 8: Commit**

```bash
git add firebase/functions/src/
git commit -m "feat(functions): rate-limit memo/exam/correction/appReport/feedbackReply/selfTestPush"
```

---

## Phase 2 — 신고·검열 내성

### Task 7: 계정 연령 + 신고 게이트

**Files:**
- Create: `firebase/functions/src/lib/accountAge.js`
- Create: `firebase/functions/test/accountAge.test.js`
- Modify: `firebase/functions/src/auth.js` (`signup` — write `createdAt`)
- Modify: `firebase/functions/src/board.js` (`boardReact` report path, `createPost` seed `reportCountStrong`)
- Modify: `firebase/functions/src/reviews.js` (`reportReview`, `createReview` seed)
- Modify: `firebase/functions/src/classMemo.js` (`reportMemo`, `createMemo` seed)

**Interfaces:**
- Produces:
  - `isYoung(createdAtMs: number, nowMs: number) → boolean` (pure; `0`/falsy createdAt → `false`)
  - `isYoungAccount(uid: string) → Promise<boolean>`
  - content docs gain `reportCountStrong` (number). Report event docs gain `young: boolean`.
  - `signup` writes `createdAt: serverTimestamp()` on the user doc.

- [ ] **Step 1: Write the failing test**

Create `firebase/functions/test/accountAge.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isYoung } from '../src/lib/accountAge.js';

const DAY = 24 * 60 * 60 * 1000;

test('legacy account (no createdAt) is not young', () => {
  assert.equal(isYoung(0, 1_000_000), false);
  assert.equal(isYoung(undefined, 1_000_000), false);
});

test('account created 1h ago is young', () => {
  const now = 100 * DAY;
  assert.equal(isYoung(now - 3600_000, now), true);
});

test('account created 25h ago is not young', () => {
  const now = 100 * DAY;
  assert.equal(isYoung(now - 25 * 3600_000, now), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd firebase/functions && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement accountAge.js**

Create `firebase/functions/src/lib/accountAge.js`:

```js
import { db } from './context.js';

const YOUNG_MS = 24 * 60 * 60 * 1000;

// Accounts created before signup started stamping `createdAt` return false —
// they predate this control and must not be treated as "young".
export function isYoung(createdAtMs, nowMs) {
  if (!createdAtMs) return false;
  return nowMs - createdAtMs < YOUNG_MS;
}

export async function isYoungAccount(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return isYoung(snap.get('createdAt')?.toMillis?.() ?? 0, Date.now());
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd firebase/functions && npm test`
Expected: PASS.

- [ ] **Step 5: signup writes createdAt**

`firebase/functions/src/auth.js`, in `signup`'s transaction `tx.set(usersCol.doc(created.uid), { ... })`:

```js
      tx.set(usersCol.doc(created.uid), {
        username,
        isAdmin: false,
        ttPublic: false,
        postCount: 0,
        createdAt: FieldValue.serverTimestamp(),
        geoVerifiedAt: FieldValue.serverTimestamp(),
      });
```

(`FieldValue` is already imported in auth.js.)

- [ ] **Step 6: Seed reportCountStrong on new content**

`board.js` `createPost` — `batch.set(postRef, { ... reportCount: 0, ... })`, add `reportCountStrong: 0,` next to `reportCount: 0,`.

`reviews.js` `createReview` — `batch.set(reviewRef, { ... reportCount: 0, reportReviewedCount: 0, ... })`, add `reportCountStrong: 0,`.

`classMemo.js` `createMemo` — same, add `reportCountStrong: 0,` next to `reportCount: 0,`.

- [ ] **Step 7: reviews.js reportReview — young gate**

Import: `import { isYoungAccount } from './lib/accountAge.js';`

In `reportReview`, after `await assertUnderLimit(uid, 'reportContent');` and before the transaction:

```js
  const young = await isYoungAccount(uid);
```

In the transaction, change the reaction/events/counter writes:

```js
    tx.set(reactionRef, { kind: 'report', subId, young, createdAt: FieldValue.serverTimestamp() });
    tx.set(eventsRef.doc(), { kind: 'report', young, createdAt: FieldValue.serverTimestamp() });
    tx.update(reviewRef, {
      reportCount: FieldValue.increment(1),
      ...(young ? {} : { reportCountStrong: FieldValue.increment(1) }),
    });
    return { status: 'OK', reportCountBefore: reviewSnap.get('reportCount') ?? 0, strongBefore: reviewSnap.get('reportCountStrong') ?? 0 };
```

After the transaction, replace the threshold/burst logic:

```js
  const strong = outcome.strongBefore + (young ? 0 : 1);
  const configSnap = await db.collection('config').doc('secrets').get();
  const deleteThreshold = Math.max(1, configSnap.get('reportDeleteCount') ?? 30);
  const burstThreshold = Math.max(1, configSnap.get('reportBurstCount') ?? 10);

  const fifteenMinAgo = Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
  const burstSnap = await eventsRef.where('kind', '==', 'report').where('createdAt', '>', fifteenMinAgo).get();
  // Young-account reports still show to admins (reportCount) but don't drive
  // auto-deletion — mass-account censorship needs established accounts now.
  const strongBurst = burstSnap.docs.filter((d) => d.get('young') !== true).length;

  if (strong < deleteThreshold && strongBurst < burstThreshold) return { status: 'OK' };

  const reason = strong >= deleteThreshold ? 'threshold' : 'burst';
  const reportCount = outcome.reportCountBefore + 1; // archive metadata: real total
```

(The archive `archiveDeleted({ ..., reportCount, ... })` call keeps using `reportCount` = true total. Keep the rest of the delete/archive block unchanged.)

- [ ] **Step 8: classMemo.js reportMemo — young gate**

Identical shape to Step 7. Import `isYoungAccount`. Add `const young = await isYoungAccount(uid);` before the transaction. In the transaction: `young` on reaction + events docs, conditional `reportCountStrong` increment, return `strongBefore`. After: `strong` + `strongBurst` filter, decision uses `strong`/`strongBurst`.

- [ ] **Step 9: board.js boardReact — young gate (report path)**

Import `isYoungAccount`. In `boardReact`, the report branch. After `await boardEnabledGuard();` (report path) add `const young = await isYoungAccount(uid);` — but note `boardReact` computes `young` only when `kind === 'report'`, so guard it:

```js
  const young = kind === 'report' ? await isYoungAccount(uid) : false;
```

In the transaction, the report branch:

```js
    const reactExtra = (kind === 'report' && typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024)
      ? { subId: createHash('sha256').update(endpoint).digest('hex') } : {};
    tx.set(reactionRef, { kind, ...reactExtra, ...(kind === 'report' ? { young } : {}), createdAt: FieldValue.serverTimestamp() });
    tx.set(eventsRef.doc(), { kind, actorHash: hash, ...(kind === 'report' ? { young } : {}), createdAt: FieldValue.serverTimestamp() });
    if (kind === 'like') tx.update(postRef, { likeCount: FieldValue.increment(1) });
    else if (kind === 'dislike') tx.update(postRef, { dislikeCount: FieldValue.increment(1) });
    else tx.update(postRef, {
      reportCount: FieldValue.increment(1),
      ...(young ? {} : { reportCountStrong: FieldValue.increment(1) }),
    });
    return { status: 'OK', reportCountBefore: freshPostSnap.get('reportCount') ?? 0, strongBefore: freshPostSnap.get('reportCountStrong') ?? 0 };
```

After the transaction (report path):

```js
  const strong = outcome.strongBefore + (young ? 0 : 1);
  const deleteThreshold = Math.max(1, secretsConfigSnap.get('reportDeleteCount') ?? 30);
  const burstThreshold = Math.max(1, secretsConfigSnap.get('reportBurstCount') ?? 10);
  const fifteenMinAgo = Timestamp.fromMillis(Date.now() - 15 * 60 * 1000);
  const burstSnap = await eventsRef.where('kind', '==', 'report').where('createdAt', '>', fifteenMinAgo).get();
  const strongBurst = burstSnap.docs.filter((d) => d.get('young') !== true).length;

  if (strong < deleteThreshold && strongBurst < burstThreshold) {
    await db.collection('boards').doc(boardId).update({ lastActivityAt: FieldValue.serverTimestamp() });
    return { status: 'OK' };
  }

  const reason = strong >= deleteThreshold ? 'threshold' : 'burst';
  const reportCount = outcome.reportCountBefore + 1; // archive metadata
```

Note the existing `boardReact` report burst used `.count()`; switching to `.get()` + in-memory filter. The burst window is 15 min on one post — doc count is tiny by design.

- [ ] **Step 10: Test + syntax check**

Run: `cd firebase/functions && npm test && node -e "import('./index.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: PASS + `OK`.

- [ ] **Step 11: Commit**

```bash
git add firebase/functions/src/ firebase/functions/test/accountAge.test.js
git commit -m "feat(functions): 24h account-age gate on report auto-deletion (reportCountStrong)"
```

---

## Phase 3 — Firestore 규칙

### Task 8: 리스트 쿼리 상한 + `rateLimits` 규칙 + 클라이언트 `limit()`

**Files:**
- Modify: `firebase/firestore.rules`
- Modify: `src/lib/board.js` (`listComments` — add `limit`)

**Interfaces:**
- Produces: `boardPosts` / `reviews` / `examArchive` list reads capped by `request.query.limit`; `boardPosts/*/comments` list capped; `rateLimits` fully denied to clients.

- [ ] **Step 1: Audit client list queries**

Run: `grep -rn "getDocs(query(collection(db, 'boardPosts'\|'reviews'\|'examArchive'" src/`
Expected: every hit already ends with `limit(...)` — `board.js` (`listPosts`/`listHot` → `limit(PAGE_SIZE)` = 15), `Reviews.jsx`/`ProfessorDetail.jsx` (`limit(REVIEW_LIMIT)` = 200), `Exams.jsx` (`limit(100)`). Confirm before writing rules.

Run: `grep -rn "collection(db, 'boardPosts', .*'comments')" src/`
Expected: `src/lib/board.js:186` `listComments` — **no limit**. Fix in Step 3.

- [ ] **Step 2: firestore.rules — list limits + rateLimits**

`firebase/firestore.rules`. Change the three collection matches and the comments match; add `rateLimits`.

`reviews`:

```
    match /reviews/{id} {
      allow get: if isSignedIn();
      allow list: if isSignedIn() && request.query.limit <= 250;
      allow write: if false;
```

`examArchive`:

```
    match /examArchive/{id} {
      allow get: if isSignedIn();
      allow list: if isSignedIn() && request.query.limit <= 120;
      allow write: if false;
```

`boardPosts`:

```
    match /boardPosts/{id} {
      allow get: if isSignedIn();
      allow list: if isSignedIn() && request.query.limit <= 30;
      allow write: if false;
```

`boardPosts/{id}/comments`:

```
      match /comments/{cid} {
        allow get: if isSignedIn();
        allow list: if isSignedIn() && request.query.limit <= 500;
        allow write: if false;
```

Add near the other server-only collections (e.g. after `pushSubscriptions`):

```
    // ---- per-uid rate limit counters (Admin SDK only) ----
    match /rateLimits/{id} { allow read, write: if false; }
```

And next to `match /config/app` (the `capBilling` function in Task 14 writes this;
harmless to land the rule now so Task 14 doesn't re-touch this file):

```
    match /config/ops {
      allow read: if isAdmin();
      allow write: if false; // capBilling (Admin SDK) only
    }
```

Note: `allow read` splits into `get` + `list`. Existing `allow read: if isSignedIn();` becomes the two lines above per collection. **Only** these three collections + comments change; leave `boards`, `professors`, `courseProfessorRatings`, etc. as `allow read: if isSignedIn();` (full download is legitimate; App Check is their guard).

- [ ] **Step 3: Client — listComments limit**

`src/lib/board.js`, `listComments`:

```js
export async function listComments(postId) {
  const snap = await getDocs(query(
    collection(db, 'boardPosts', postId, 'comments'),
    orderBy('createdAt'),
    limit(500),
  ));
  return snap.docs.map((d) => { const data = d.data(); return { id: d.id, ...data, createdAt: toIso(data.createdAt) }; });
}
```

(`limit` is already imported in `board.js` line 3.)

- [ ] **Step 4: Verify rules parse**

Run: `cd firebase && npx -y firebase-tools firestore:rules:canary --help >/dev/null 2>&1; node -e "const s=require('fs').readFileSync('firestore.rules','utf8'); if(!/allow list: if isSignedIn\(\) && request\.query\.limit <= 30/.test(s)) throw new Error('boardPosts rule missing'); console.log('rules text OK')"`
Expected: `rules text OK`. (Full rules compile happens in CI via `firebase deploy --only firestore:rules`.)

- [ ] **Step 5: Commit**

```bash
git add firebase/firestore.rules src/lib/board.js
git commit -m "feat(rules): cap list-query limits on boardPosts/reviews/examArchive/comments; deny rateLimits"
```

---

## Phase 4 — Cloudflare Pages Functions

### Task 9: 업로드 하드닝

**Files:**
- Modify: `functions/api/exam-upload.js`
- Modify: `functions/api/board-upload.js`

- [ ] **Step 1: exam-upload — extension allowlist + 25MB**

Replace `functions/api/exam-upload.js`:

```js
// 족보 파일 업로드 → Cloudflare R2 (바인딩 EXAM_FILES). 메타데이터 반환.
// 요청: multipart/form-data { courseCode, file }
// 보안: 확장자 allowlist(1차 게이트 — .hwp 등은 브라우저가 MIME 를 빈 값으로 주는 일이
//       잦아 MIME 만으론 부족). exam-download 는 항상 attachment + nosniff 로 내려주므로
//       위장 파일이 인라인 실행되지는 않지만, R2 를 임의 파일 호스트로 쓰는 남용을 막는다.
const OK_EXT = /\.(pdf|hwp|hwpx|docx?|xlsx?|pptx?|jpe?g|png|webp|gif|heic|heif|avif|zip|txt|md)$/i;
const MAX_BYTES = 25 * 1024 * 1024;

function safeExt(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i).toLowerCase().replace(/[^.a-z0-9]/g, '');
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const form = await request.formData();
  const file = form.get('file');
  const courseCode = String(form.get('courseCode') || 'etc').replace(/[^A-Za-z0-9_-]/g, '');
  if (!file || typeof file === 'string') {
    return Response.json({ status: 'BAD_REQUEST' }, { status: 400 });
  }
  if (!OK_EXT.test(file.name || '')) {
    return Response.json({ status: 'BAD_TYPE' }, { status: 415 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ status: 'TOO_LARGE' }, { status: 413 });
  }

  const key = `${courseCode}/${crypto.randomUUID()}${safeExt(file.name)}`;
  await env.EXAM_FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
  });

  return Response.json({
    status: 'OK',
    key,
    file_name: file.name,
    file_size: file.size,
    mime_type: file.type || 'application/octet-stream',
  });
}
```

- [ ] **Step 2: board-upload — 8MB / 2MB**

`functions/api/board-upload.js` — change two size checks:

```js
  if (file.size > 8 * 1024 * 1024) return Response.json({ status: 'TOO_LARGE' }, { status: 413 });
```

```js
  if (thumb && typeof thumb !== 'string' && OK_IMAGE.test(thumb.type || '') && thumb.size <= 2 * 1024 * 1024) {
```

- [ ] **Step 3: Syntax check**

Run: `node --check functions/api/exam-upload.js && node --check functions/api/board-upload.js`
Expected: no output, exit 0.

- [ ] **Step 4: Client sanity — resizeImage output fits 8MB**

`src/lib/board.js` `uploadBoardImage` resizes to 1080px/0.85 jpeg (≪ 8MB) and thumb 480px/0.5 (≪ 2MB). Non-image files go through raw — `ExamForm`/`SyllabusUpload` are the exam path (100→25MB); confirm no board path sends non-images.

Run: `grep -rn "board-upload" src/`
Expected: only `src/lib/board.js` (images only). No edit.

- [ ] **Step 5: Commit**

```bash
git add functions/api/exam-upload.js functions/api/board-upload.js
git commit -m "feat(api): exam-upload extension allowlist + 25MB cap; board-upload 8MB/2MB"
```

---

## Phase 5 — 클라이언트 App Check + CSP

### Task 10: App Check 클라이언트 초기화 (키 없으면 no-op)

**Files:**
- Create: `src/lib/appCheck.js`
- Modify: `src/firebase.js`
- Modify: `.env.production` (add empty `VITE_APPCHECK_RECAPTCHA_V3_KEY`, `VITE_TURNSTILE_SITE_KEY`)

**Interfaces:**
- Produces: `initAppCheck(app) → AppCheck | null` — returns `null` (no-op) when `VITE_APPCHECK_RECAPTCHA_V3_KEY` is empty/unset.

- [ ] **Step 1: appCheck.js**

Create `src/lib/appCheck.js`:

```js
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

// App Check attests that a Firebase call comes from the real app, not a script
// wielding the (public) API key. reCAPTCHA v3 runs invisibly, $0 unlimited.
//
// No key configured → no-op: the code ships before the key exists, and the app
// keeps working (enforcement is off until the key is set AND the console toggle
// is flipped — see the hardening runbook).
export function initAppCheck(app) {
  const siteKey = import.meta.env.VITE_APPCHECK_RECAPTCHA_V3_KEY;
  if (!siteKey) return null;
  if (import.meta.env.DEV) {
    // Prints a debug token to the console on first run — register it under
    // Firebase console → App Check → Apps → Manage debug tokens.
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    return initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (e) {
    console.warn('[appCheck] init failed — continuing without attestation', e);
    return null;
  }
}
```

- [ ] **Step 2: Wire into firebase.js**

`src/firebase.js` — call `initAppCheck` right after `initializeApp`, before `getAuth`/`getFirestore`/`getFunctions`:

```js
import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getFunctions } from 'firebase/functions';
import { initAppCheck } from './lib/appCheck';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
initAppCheck(app);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, 'asia-northeast3');
export const authFunctions = functions;
```

- [ ] **Step 3: .env.production placeholders**

Append to `.env.production`:

```
# App Check (reCAPTCHA v3) — 비어 있으면 App Check 초기화를 건너뛴다(no-op).
# 발급: Google Cloud console → reCAPTCHA → v3 사이트 키 → Firebase App Check 콘솔 등록.
VITE_APPCHECK_RECAPTCHA_V3_KEY=

# Cloudflare Turnstile 사이트 키(공개) — 가입 폼 위젯. 비어 있으면 위젯 미표시.
VITE_TURNSTILE_SITE_KEY=
```

- [ ] **Step 4: Build check**

Run: `npm run build`
Expected: build succeeds. `firebase/app-check` resolves (part of `firebase` v11). Bundle includes app-check in the `firebase` manual chunk (add it — see Step 5).

- [ ] **Step 5: vite.config.js manualChunks**

`vite.config.js` — add `firebase/app-check` to the firebase chunk:

```js
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          firebase: ['firebase/app', 'firebase/app-check', 'firebase/auth', 'firebase/firestore', 'firebase/functions'],
        },
```

Run: `npm run build`
Expected: succeeds; `dist/assets/e2/firebase-*.js` present.

- [ ] **Step 6: Commit**

```bash
git add src/lib/appCheck.js src/firebase.js .env.production vite.config.js
git commit -m "feat(client): App Check (reCAPTCHA v3) init, no-op until site key is set"
```

---

### Task 11: CSP — reCAPTCHA + Turnstile + App Check 호스트

**Files:**
- Modify: `public/_headers`

- [ ] **Step 1: Update the CSP line**

`public/_headers` — the `/*` block's `Content-Security-Policy`. Add hosts to `script-src`, `connect-src`, `img-src`; add a `frame-src` directive (currently absent → falls back to `default-src 'self'` which blocks the reCAPTCHA/Turnstile iframes). Keep the two `sha256-` hashes verbatim.

New value (single line):

```
  Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'sha256-7OcdZiX5A5ldfjEKTIOJqSCT+WCNSY9uTT9o9CK7t5M=' 'sha256-WFsFz9RRrzyB0lrGzsurnPkRdq4H+NhmCgyUxuj2gDM=' https://www.google.com https://www.gstatic.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://www.gstatic.com; font-src 'self' data:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://asia-northeast3-anytime-rokafa.cloudfunctions.net https://firebaseappcheck.googleapis.com https://content-firebaseappcheck.googleapis.com https://www.google.com; frame-src https://www.google.com https://challenges.cloudflare.com; worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests
```

- [ ] **Step 2: Sanity — hashes untouched**

Run: `grep -c "sha256-7OcdZiX5A5ldfjEKTIOJqSCT+WCNSY9uTT9o9CK7t5M=" public/_headers && grep -c "sha256-WFsFz9RRrzyB0lrGzsurnPkRdq4H+NhmCgyUxuj2gDM=" public/_headers`
Expected: `1` and `1`.

- [ ] **Step 3: Sanity — new directives present**

Run: `grep -o "frame-src https://www.google.com https://challenges.cloudflare.com" public/_headers && grep -o "firebaseappcheck.googleapis.com" public/_headers | head -1`
Expected: both match.

- [ ] **Step 4: Commit**

```bash
git add public/_headers
git commit -m "feat(csp): allow reCAPTCHA v3, Turnstile, and App Check hosts"
```

Note: verify no CSP violations in the browser console after the Pages deploy (Phase 9). If reCAPTCHA reports a blocked subresource, the exact host is in the violation report — add it and redeploy.

---

## Phase 6 — Auth 하드닝 (코드)

> **배포 주의:** Task 12 는 `main` 에 바로. Task 13(Turnstile) 은 `TURNSTILE_SECRET`
> Secret 이 존재해야 CI 배포가 통과하므로 **브랜치 `hardening/phase67`** 에 커밋하고
> 푸시만(머지 X). 런북 §0 완료 후 사용자가 머지.

### Task 12: 비밀번호 8자 + 로그인 오류 단일화

**Files:**
- Modify: `firebase/functions/src/auth.js` (`signup`)
- Modify: `src/pages/Onboarding.jsx`
- Modify: `src/lib/auth.js` (`login` error handling is in callers — see Step 3)
- Modify: `src/pages/Login.jsx`

- [ ] **Step 1: signup — 8 chars**

`firebase/functions/src/auth.js` `signup`:

```js
  if (password.length < 8) invalid('비밀번호는 8자 이상이어야 합니다.');
```

- [ ] **Step 2: Onboarding.jsx — minLength + copy**

`src/pages/Onboarding.jsx`:
- `STATUS_MSG.WEAK_PASSWORD`: `'비밀번호는 8자 이상이어야 합니다.'`
- password `<input ... minLength={8} />` and `placeholder="8자 이상"`

- [ ] **Step 3: Login.jsx — unify failure copy**

Read `src/pages/Login.jsx` first. Firebase Auth with **Email Enumeration Protection** on returns `auth/invalid-credential` for both "no such user" and "wrong password". Change any branch that distinguishes user-not-found vs wrong-password into one message:

```js
// 로그인 실패는 사유를 구분하지 않는다 — 아이디 존재 여부를 노출하지 않기 위해(이메일 열거 보호).
const LOGIN_FAIL = '아이디 또는 비밀번호가 올바르지 않습니다.';
```

Map `auth/invalid-credential`, `auth/wrong-password`, `auth/user-not-found`, `auth/invalid-login-credentials` → `LOGIN_FAIL`. Keep `auth/too-many-requests` and `auth/network-request-failed` distinct.

- [ ] **Step 4: Build + function syntax**

Run: `npm run build && cd firebase/functions && node --check src/auth.js`
Expected: build OK, no syntax error.

- [ ] **Step 5: Commit**

```bash
git add firebase/functions/src/auth.js src/pages/Onboarding.jsx src/pages/Login.jsx
git commit -m "feat(auth): 8-char password floor for new signups; unify login failure message"
```

---

### Task 13: signup — 선택적 Turnstile 검증 (soft)

**Files:**
- Modify: `firebase/functions/src/auth.js` (`signup`)
- Create: `firebase/functions/src/lib/turnstile.js`
- Modify: `firebase/functions/src/lib/secrets.js` — **FORBIDDEN by CONVENTIONS.md.** Use `defineSecret` inline in `turnstile.js` instead.
- Create: `firebase/functions/test/turnstile.test.js`

**Interfaces:**
- Produces: `verifyTurnstile(token: string | null, remoteIp?: string) → Promise<boolean>` — returns `true` (pass) when the secret is unset OR no token given (soft mode); returns the real siteverify result when both are present.
- `signup` accepts optional `request.data.turnstileToken`; on a definitive `false` it throws `permission-denied`.

- [ ] **Step 1: Write the failing test**

Create `firebase/functions/test/turnstile.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipTurnstile } from '../src/lib/turnstile.js';

test('skip when no secret configured', () => {
  assert.equal(shouldSkipTurnstile('', 'tok'), true);
});

test('skip when secret set but no token (client widget not deployed yet)', () => {
  assert.equal(shouldSkipTurnstile('secret', ''), true);
  assert.equal(shouldSkipTurnstile('secret', null), true);
});

test('do not skip when both present', () => {
  assert.equal(shouldSkipTurnstile('secret', 'tok'), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd firebase/functions && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement turnstile.js**

Create `firebase/functions/src/lib/turnstile.js`:

```js
import { defineSecret } from 'firebase-functions/params';

// Own secret param (CONVENTIONS.md forbids editing lib/secrets.js). Bind via
// `secrets: [turnstileSecret]` on signup; read with `.value()` in the handler.
export const turnstileSecret = defineSecret('TURNSTILE_SECRET');

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Soft mode: skip verification unless BOTH the secret is configured AND the
// client actually sent a token. Lets the server-side check ship before the
// client widget exists, then tighten automatically once both are in place.
export function shouldSkipTurnstile(secret, token) {
  return !secret || !token;
}

export async function verifyTurnstile(secret, token, remoteIp) {
  if (shouldSkipTurnstile(secret, token)) return true;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch(SITEVERIFY, { method: 'POST', body });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.error('[turnstile] siteverify failed — allowing (fail-open on infra error)', e);
    return true;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd firebase/functions && npm test`
Expected: PASS.

- [ ] **Step 5: Wire into signup**

`firebase/functions/src/auth.js`:

```js
import { turnstileSecret, verifyTurnstile } from './lib/turnstile.js';
```

```js
export const signup = onCall(callable({ region: REGION, secrets: [turnstileSecret] }), async (request) => {
  const data = request.data ?? {};
  const username = String(data.username ?? '').trim();
  const password = String(data.password ?? '');
  const code = String(data.code ?? '').trim();
  const lat = typeof data.lat === 'number' ? data.lat : null;
  const lng = typeof data.lng === 'number' ? data.lng : null;

  if (!USERNAME_RE.test(username)) invalid('아이디는 영문/숫자/밑줄 3~20자여야 합니다.');
  if (!code) invalid('가입 코드를 입력하세요.');
  if (password.length < 8) invalid('비밀번호는 8자 이상이어야 합니다.');

  const turnstileOk = await verifyTurnstile(
    turnstileSecret.value(), data.turnstileToken ?? null, request.rawRequest?.ip,
  );
  if (!turnstileOk) throw new HttpsError('permission-denied', '자동가입 방지 확인에 실패했습니다. 다시 시도해 주세요.');
```

- [ ] **Step 6: Test + syntax**

Run: `cd firebase/functions && npm test && node --check src/auth.js`
Expected: PASS.

- [ ] **Step 7: Commit on a branch (not main)**

```bash
git checkout -b hardening/phase67
git add firebase/functions/src/lib/turnstile.js firebase/functions/src/auth.js firebase/functions/test/turnstile.test.js
git commit -m "feat(auth): optional Turnstile verification in signup (soft until secret+token present)"
```

`firebase deploy` requires `TURNSTILE_SECRET` to **exist** in Secret Manager because `signup` binds it. Stay on `hardening/phase67` for Task 14 too. The runbook (§0) creates the secret; the user merges this branch after.

---

## Phase 7 — 비용 방어

### Task 14: `capBilling` — 예산 알림 수신 (알림 전용)

**Files:**
- Create: `firebase/functions/src/ops.js`
- Modify: `firebase/functions/index.js` (export `capBilling`)
- Create: `firebase/functions/test/ops.test.js`

**Interfaces:**
- Produces:
  - `parseBudgetAlert(pubsubData: string) → { costAmount, budgetAmount, ratio, thresholds } | null` (pure; `pubsubData` is base64 JSON)
  - `capBilling` — `onMessagePublished({ topic: 'billing-alerts' })`, writes `config/ops` + admin push at ratio ≥ 0.9. Does **not** modify function config.

- [ ] **Step 1: Write the failing test**

Create `firebase/functions/test/ops.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBudgetAlert } from '../src/ops.js';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

test('parses a Cloud Billing budget notification', () => {
  const r = parseBudgetAlert(enc({ costAmount: 4.5, budgetAmount: 5, alertThresholdExceeded: 0.9 }));
  assert.equal(r.costAmount, 4.5);
  assert.equal(r.budgetAmount, 5);
  assert.ok(Math.abs(r.ratio - 0.9) < 1e-9);
});

test('null on garbage', () => {
  assert.equal(parseBudgetAlert('not base64 json!!!'), null);
});

test('null when budgetAmount is 0 or missing', () => {
  assert.equal(parseBudgetAlert(enc({ costAmount: 1 })), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd firebase/functions && npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ops.js**

Create `firebase/functions/src/ops.js`:

```js
import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { db, FieldValue } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';

// Alert-only budget watchdog. A Cloud Billing budget publishes to the
// `billing-alerts` Pub/Sub topic at each threshold; this records the breach and
// pings admins. It deliberately does NOT touch function config — maxInstances:10
// (globalOptions.js) already bounds runaway cost, and auto-patching every
// function needs extra IAM/API surface for little gain. Manual response: set
// maxInstances to 1 in globalOptions.js and redeploy (see the hardening runbook).

export function parseBudgetAlert(pubsubData) {
  try {
    const json = JSON.parse(Buffer.from(pubsubData, 'base64').toString('utf8'));
    const costAmount = Number(json.costAmount);
    const budgetAmount = Number(json.budgetAmount);
    if (!Number.isFinite(costAmount) || !Number.isFinite(budgetAmount) || budgetAmount <= 0) return null;
    return {
      costAmount,
      budgetAmount,
      ratio: costAmount / budgetAmount,
      thresholds: json.alertThresholdExceeded ?? null,
    };
  } catch {
    return null;
  }
}

export const capBilling = onMessagePublished(
  { topic: 'billing-alerts', secrets: [pushFanoutUrl, pushFanoutSecret] },
  async (event) => {
    const alert = parseBudgetAlert(event.data?.message?.data ?? '');
    if (!alert) return;

    const opsRef = db.doc('config/ops');
    const prev = (await opsRef.get()).get('budgetRatio') ?? 0;
    await opsRef.set({
      budgetBreachedAt: FieldValue.serverTimestamp(),
      costAmount: alert.costAmount,
      budgetAmount: alert.budgetAmount,
      budgetRatio: alert.ratio,
    }, { merge: true });

    // Only push when crossing 0.9 upward — avoids spamming on every re-alert.
    if (alert.ratio >= 0.9 && prev < 0.9) {
      await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
        kind: 'budget_alert',
        title: '⚠️ 클라우드 예산 경보',
        body: `사용액이 예산의 ${Math.round(alert.ratio * 100)}%에 도달했어요. 이상 트래픽인지 확인하세요.`,
      });
    }
  },
);
```

- [ ] **Step 4: Export from index.js**

`firebase/functions/index.js` — add at the end:

```js
export { capBilling } from './src/ops.js';
```

- [ ] **Step 5: Test + load check**

Run: `cd firebase/functions && npm test && node -e "import('./index.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: PASS + `OK`. (`firebase-functions/v2/pubsub` resolves in v6.)

- [ ] **Step 6: Commit on `hardening/phase67` (still not main)**

```bash
# already on hardening/phase67 from Task 13
git add firebase/functions/src/ops.js firebase/functions/index.js firebase/functions/test/ops.test.js
git commit -m "feat(functions): capBilling — alert-only budget watchdog on billing-alerts topic"
git push -u origin hardening/phase67
```

`capBilling` binds the `billing-alerts` Pub/Sub topic — CI deploy fails if it's absent. Runbook §0/§3 creates it, then the user merges `hardening/phase67`.

---

## Phase 8 — Infra as Code + 런북

### Task 15: `infra/cloudflare/` Terraform

**Files:**
- Create: `infra/cloudflare/main.tf`
- Create: `infra/cloudflare/variables.tf`
- Create: `infra/cloudflare/terraform.tfvars.example`
- Create: `infra/cloudflare/README.md`
- Modify: `.gitignore` (terraform state/vars)

- [ ] **Step 1: .gitignore**

Append to `.gitignore`:

```
# Terraform (infra/cloudflare) — local state + real tfvars never committed
**/.terraform/
*.tfstate
*.tfstate.*
*.tfvars
!*.tfvars.example
.terraform.lock.hcl
```

- [ ] **Step 2: variables.tf**

Create `infra/cloudflare/variables.tf`:

```hcl
terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

variable "cloudflare_api_token" {
  type      = string
  sensitive = true
}

variable "cloudflare_account_id" {
  type = string
}

variable "cloudflare_zone_id" {
  description = "Zone ID for anytime.rokafa.app"
  type        = string
}

variable "turnstile_domains" {
  type    = list(string)
  default = ["anytime.rokafa.app", "anytime-dzi.pages.dev", "localhost"]
}
```

- [ ] **Step 3: main.tf**

Create `infra/cloudflare/main.tf`:

```hcl
# =============================================================================
#  Cloudflare zone hardening for anytime.rokafa.app  (Pages app + /api/*)
#  Firestore / Cloud Functions / Auth traffic does NOT pass through this zone —
#  it is defended by Firebase App Check, not here.
#
#  Free plan limits (verified 2026-09): 1 rate-limiting rule (block only,
#  period 10/60s, duration 60s/1h), 5 WAF custom rules (all actions but Log).
#
#  `terraform plan` is the syntax gate — the cloudflare provider's `rules`
#  object shape shifts between patch releases. If plan errors on a rule field,
#  cross-check the resource docs for your resolved provider version.
# =============================================================================

# --- 1. Rate limiting: the single free-plan rule, on write-ish /api POSTs ---
resource "cloudflare_ruleset" "ratelimit" {
  zone_id     = var.cloudflare_zone_id
  name        = "anytime rate limiting"
  description = "Free-plan single rule: cap /api/* POST per IP"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [{
    ref         = "api_post_per_ip"
    description = "Block IPs doing >20 POST /api/* per minute for 1 minute"
    expression  = "(starts_with(http.request.uri.path, \"/api/\") and http.request.method eq \"POST\")"
    action      = "block"
    ratelimit = {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 20
      mitigation_timeout  = 60
    }
  }]
}

# --- 2. WAF custom rules (<=5 on free) ---
resource "cloudflare_ruleset" "custom_fw" {
  zone_id     = var.cloudflare_zone_id
  name        = "anytime custom firewall"
  description = "Abuse-surface hardening for /api/*"
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "api_requires_auth"
      description = "Block /api/* POST with no Authorization header (except the secret-gated webhooks)"
      expression  = "(starts_with(http.request.uri.path, \"/api/\") and http.request.method eq \"POST\" and not any(http.request.headers.names[*] eq \"authorization\") and not http.request.uri.path in {\"/api/board-sweep\" \"/api/push-fanout\"})"
      action      = "block"
    },
    {
      ref         = "block_weird_methods"
      description = "Only GET/POST/HEAD/OPTIONS"
      expression  = "(not http.request.method in {\"GET\" \"POST\" \"HEAD\" \"OPTIONS\"})"
      action      = "block"
    },
    {
      ref         = "challenge_high_threat"
      description = "Managed challenge for high threat score on /api/*"
      expression  = "(starts_with(http.request.uri.path, \"/api/\") and cf.threat_score gt 20)"
      action      = "managed_challenge"
    },
    {
      ref         = "challenge_non_kr_api"
      description = "Managed challenge for non-KR traffic to /api/* (overseas cadets / VPN pass the challenge)"
      expression  = "(starts_with(http.request.uri.path, \"/api/\") and ip.geoip.country ne \"KR\")"
      action      = "managed_challenge"
    },
  ]
}

# --- 3. Bot Fight Mode (free) ---
# Resource name for a single zone setting shifts across provider versions
# (cloudflare_zone_setting). If `terraform plan` rejects this block, enable
# "Bot Fight Mode" by hand: dash > zone > Security > Bots. See README.
resource "cloudflare_zone_setting" "bot_fight_mode" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "bot_fight_mode"
  value      = "on"
}

# --- 4. Turnstile widget for the signup form ---
resource "cloudflare_turnstile_widget" "signup" {
  account_id = var.cloudflare_account_id
  name       = "anytime signup"
  domains    = var.turnstile_domains
  mode       = "managed"
}

output "turnstile_site_key" {
  value       = cloudflare_turnstile_widget.signup.id
  description = "Public — put in .env.production as VITE_TURNSTILE_SITE_KEY"
}

output "turnstile_secret" {
  value       = cloudflare_turnstile_widget.signup.secret
  sensitive   = true
  description = "firebase functions:secrets:set TURNSTILE_SECRET"
}
```

- [ ] **Step 4: terraform.tfvars.example**

Create `infra/cloudflare/terraform.tfvars.example`:

```hcl
# cp terraform.tfvars.example terraform.tfvars  and fill in.
cloudflare_api_token  = "..."   # scopes: Zone.WAF, Zone.Rate Limiting, Zone Settings, Account.Turnstile (Edit)
cloudflare_account_id = "..."
cloudflare_zone_id    = "..."   # zone for anytime.rokafa.app
```

- [ ] **Step 5: README.md**

Create `infra/cloudflare/README.md`:

```markdown
# Cloudflare zone hardening (Terraform)

Protects the Pages app + `/api/*` only. Firestore / Functions / Auth are
protected by Firebase App Check, not here.

## Apply

1. Create an API token: dash → My Profile → API Tokens → Create.
   Permissions: **Zone → WAF → Edit**, **Zone → Rate Limiting → Edit**,
   **Zone → Zone Settings → Edit**, **Account → Turnstile → Edit**.
   Zone resources: the `anytime.rokafa.app` zone. Account resources: your account.
2. `cp terraform.tfvars.example terraform.tfvars` and fill in
   (`cloudflare_zone_id` = Overview page of the zone; `cloudflare_account_id`
   = same page, right sidebar).
3. `terraform init`
4. `terraform plan` — **this is the gate.** The provider's `rules = [{...}]`
   object shape can drift between v5 patch releases. If plan errors on a field,
   open the resolved provider version's docs for `cloudflare_ruleset` /
   `cloudflare_zone_setting` / `cloudflare_turnstile_widget` and adjust.
5. `terraform apply`
6. `terraform output turnstile_site_key` → paste into `.env.production` as
   `VITE_TURNSTILE_SITE_KEY`, commit (Pages rebuilds).
   `terraform output -raw turnstile_secret` →
   `firebase functions:secrets:set TURNSTILE_SECRET` (paste when prompted).

## Verify in the dashboard

- Security → WAF → Rate limiting rules: 1 rule, "Block", `/api/*` POST, 20/min.
- Security → WAF → Custom rules: 4 rules enabled.
- Security → Bots: Bot Fight Mode = On.
- Turnstile: one "anytime signup" widget, Managed.

## If Terraform is blocked (no token, provider drift you can't resolve)

Everything above is doable by hand in the dashboard — same expressions,
same thresholds. The rate-limit expression is
`(starts_with(http.request.uri.path, "/api/") and http.request.method eq "POST")`,
block, 20 requests / 60s, mitigation 60s.
```

- [ ] **Step 6: fmt check**

Run: `cd infra/cloudflare && terraform fmt -check -diff` (if terraform installed) — else `grep -c "resource \"cloudflare_" main.tf`
Expected: `terraform fmt` clean, or grep returns `4`.

- [ ] **Step 7: Commit**

```bash
git add infra/cloudflare/ .gitignore
git commit -m "infra(cloudflare): Terraform for rate limiting, WAF custom rules, Bot Fight Mode, Turnstile"
```

---

### Task 16: `infra/gcp/` 예산 스크립트 + 런북

**Files:**
- Create: `infra/gcp/budget.sh`
- Create: `infra/gcp/README.md`
- Create: `docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md`

- [ ] **Step 1: budget.sh**

Create `infra/gcp/budget.sh`:

```bash
#!/usr/bin/env bash
# Cloud Billing budget + Pub/Sub alert wiring for anytime-rokafa.
# Prereqs: gcloud auth login; billing account admin; project = anytime-rokafa.
set -euo pipefail

PROJECT="anytime-rokafa"
TOPIC="billing-alerts"
BUDGET_AMOUNT="${1:-10}"   # USD/month; override: ./budget.sh 20
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"

echo "Billing account: $BILLING_ACCOUNT   Budget: \$$BUDGET_AMOUNT/mo"

gcloud pubsub topics create "$TOPIC" --project "$PROJECT" 2>/dev/null || echo "topic exists"

gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT" \
  --display-name="anytime monthly cap" \
  --budget-amount="${BUDGET_AMOUNT}USD" \
  --filter-projects="projects/$PROJECT" \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 \
  --all-updates-rule-pubsub-topic="projects/$PROJECT/topics/$TOPIC"

echo "Done. capBilling (Cloud Function) consumes projects/$PROJECT/topics/$TOPIC."
```

- [ ] **Step 2: infra/gcp/README.md**

```markdown
# GCP cost controls for anytime-rokafa

`budget.sh [USD]` — creates the `billing-alerts` Pub/Sub topic and a monthly
budget ($10 default) with alerts at 50/90/100%, published to that topic.
The `capBilling` Cloud Function (firebase/functions/src/ops.js) consumes it:
it records the breach in `config/ops` and pushes admins at ≥90%.

**There is no hard spend cap on Blaze.** If `capBilling` fires, the manual
response is in the hardening runbook: set `maxInstances` to 1 in
`firebase/functions/src/lib/globalOptions.js`, commit, let CI redeploy.

Run `budget.sh` BEFORE the commit that adds `capBilling` reaches CI, or that
deploy fails (the function binds the topic).
```

- [ ] **Step 3: The runbook**

Create `docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md`:

```markdown
# 남용·DoS 하드닝 — 콘솔/자격증명 런북

스펙: `docs/superpowers/specs/2026-09-07-abuse-dos-hardening-design.md`
코드는 이미 배포됨(App Check monitor 모드, enforce 플래그 off). 아래는 사람이
콘솔·CLI 로 해야 하는 나머지. **순서 중요.**

## 0. 사전: Turnstile 시크릿 자리 만들기 (capBilling·signup 배포 전)

`signup` 이 `TURNSTILE_SECRET` 을, `capBilling` 이 Pub/Sub 토픽을 바인딩한다 —
그 커밋이 CI 에 닿기 전에 존재해야 배포가 안 깨진다.

```
firebase functions:secrets:set TURNSTILE_SECRET   # 아직 위젯 없으면 아무 값이나(예: "pending")
```
```
gcloud pubsub topics create billing-alerts --project anytime-rokafa
```

## 1. reCAPTCHA v3 → App Check (monitor)

1. Google Cloud console → 보안 → reCAPTCHA → 키 만들기 → **점수 기반(v3)**,
   도메인 `anytime.rokafa.app`, `anytime-dzi.pages.dev`, `localhost`. **사이트 키** 복사.
2. Firebase console → App Check → 앱(웹) → reCAPTCHA v3 → 사이트 키 등록.
3. `.env.production` 의 `VITE_APPCHECK_RECAPTCHA_V3_KEY=` 에 붙여넣고 커밋 → Pages 재빌드.
4. App Check → 측정항목. **enforce 하지 말 것.** 며칠 관찰:
   "확인된 요청" 비율이 정상 트래픽에서 충분히 높은지(≈100%) 확인.

## 2. Cloudflare (Terraform)

`infra/cloudflare/README.md` 대로. apply 후:
- `terraform output turnstile_site_key` → `.env.production` `VITE_TURNSTILE_SITE_KEY=` 커밋.
- `terraform output -raw turnstile_secret` → `firebase functions:secrets:set TURNSTILE_SECRET` (재설정).
- 클라이언트 가입 폼에 Turnstile 위젯 붙이는 커밋은 **별도 작업**(스펙 Ⅲ Turnstile 2단계) —
  위젯 사이트키가 배포된 뒤에 진행.

## 3. Cloud Billing 예산

`gcloud auth login` (결제 관리자) → `infra/gcp/budget.sh 10` (또는 원하는 USD).
이미 토픽이 있으면 재사용. 이후 `firebase/**` 배포 때 `capBilling` 포함됨.

## 4. Cloud Scheduler — 고아 이미지 스윕

```
wrangler pages secret put SWEEP_SECRET --project-name anytime   # 새 랜덤값
gcloud scheduler jobs create http board-sweep \
  --schedule "17 3 * * *" --time-zone "Asia/Seoul" --uri "https://anytime.rokafa.app/api/board-sweep" \
  --http-method POST --headers "X-Sweep-Secret=<그 값>" --project anytime-rokafa
```

## 5. Firestore TTL 정책 (신규 컬렉션)

Firebase console → Firestore → TTL:
- `rateLimits` 필드 `expireAt`
- (기존) `deletedContent` 필드 `expireAt` 확인

## 6. Firebase Auth

Firebase console → Authentication → 설정 →
**사용자 계정 열거 보호(Email enumeration protection)** 켜기.

## 7. App Check ENFORCE (1 관찰 통과 후)

순서대로, 각 단계 후 본인 기기 + 관리자 계정으로 실사용 확인:
1. Firebase console → App Check → Firestore → 적용(Enforce).
2. `firebase/functions/src/lib/opts.js` 의 `ENFORCE_APP_CHECK = true` 한 줄 커밋 →
   CI 가 전 함수 재배포. (몇 분 뒤) 확인.
3. Firebase console → App Check → Authentication → 적용.
문제 시: 2는 되돌려 커밋, 1·3은 콘솔에서 "모니터링"으로 복귀.

## 8. (선택) Turnstile 필수화

클라이언트 위젯이 배포되어 모든 가입이 토큰을 보내게 되면, 서버는 자동으로
검증을 강제한다(`shouldSkipTurnstile` 이 false 가 됨). 추가 커밋 불필요.

## 비상: 비용 폭주

`capBilling` 이 관리자 푸시("예산 경보")를 보냈거나 청구가 튀면:
1. `firebase/functions/src/lib/globalOptions.js` → `maxInstances: 1` 커밋 → CI 재배포.
2. Cloudflare 대시보드 → 해당 존 → "I'm Under Attack" 모드(임시).
3. App Check enforce 확인(7). 아직이면 즉시 적용.
4. 진정되면 `maxInstances` 되돌리기.
```

- [ ] **Step 4: chmod + commit**

```bash
chmod +x infra/gcp/budget.sh
git add infra/gcp/ docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md
git commit -m "infra(gcp): budget script + console/credential runbook"
```

---

## Phase 9 — 배포

### Task 17: 배포 전 사전조건 + 푸시

**Files:** none (ops)

- [ ] **Step 1: Full test pass**

Run: `cd firebase/functions && npm ci && npm test`
Expected: all tests PASS.

- [ ] **Step 2: Full client build**

Run: `npm ci && npm run build`
Expected: build succeeds, `dist/` produced.

- [ ] **Step 3: Module load check**

Run: `cd firebase/functions && node -e "import('./index.js').then(()=>console.log('OK')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `OK`.

- [ ] **Step 4: HOLD — verify prerequisites exist**

Do NOT push Phase 6–7 commits until the runbook §0 is done:
- `firebase functions:secrets:set TURNSTILE_SECRET` (any value) — else `signup` deploy fails.
- `gcloud pubsub topics create billing-alerts` — else `capBilling` deploy fails.

If those aren't done yet: push Phases 0–5 + 8 now (all safe, no new secret/topic bindings), and hold Tasks 12–14 commits on a branch until §0 is confirmed. Otherwise push everything.

Check: `git log --oneline main..HEAD` shows the phase commits in order.

- [ ] **Step 5: Push**

```bash
git push origin main
```

- [ ] **Step 6: Watch CI**

```bash
gh run watch "$(gh run list --workflow=deploy-firebase.yml --limit=1 --json databaseId --jq '.[0].databaseId')" --exit-status
```
Expected: green. Also check Cloudflare Pages dashboard → latest deployment → Success.

- [ ] **Step 7: Smoke-test production**

- Open the app, sign in. Post to a board, comment, react — all succeed.
- Open a review page, like a review — succeeds; like again → no double count (check `likeCount` steady).
- Profile → 알림 테스트 → 4 buttons work (≤5/hour).
- Browser devtools console → **no CSP violations** on load and on the signup page.
- `firebase functions:log --only createPost --lines 20` — no `enforceAppCheck` errors (flag is off).

- [ ] **Step 8: Record**

Update memory: create `security-hardening-2026-09-07.md` noting App Check is in monitor mode, `ENFORCE_APP_CHECK` flag location, rate-limit table, and that the runbook has the remaining console steps. Add the MEMORY.md pointer line.

- [ ] **Step 9: Report to user**

Summarize: what deployed, what's in monitor mode, the exact runbook steps that need their console access (reCAPTCHA key, Terraform apply, budget, scheduler, Auth toggle, App Check enforce), and the ordering.

---

## Self-Review

**1. Spec coverage:**

| Spec § | Task |
|---|---|
| A. App Check client | Task 10 |
| A. `callable()` + enforce flag | Tasks 1, 2 |
| A. rollout (monitor → enforce) | Task 17 §7, runbook §1/§7 |
| B. maxInstances | Task 2 |
| B. rateLimit.js + apply | Tasks 3, 4, 5, 6 |
| B. likeReview dedup | Task 5 |
| B. getPost view limit | Task 4 |
| C. createdAt + young-account report gate | Task 7 |
| D. exam-upload / board-upload | Task 9 |
| D. sweep cron | Runbook §4 |
| E. CF Terraform (RL, WAF, bot, Turnstile) | Task 15 |
| F. email enumeration protection | Runbook §6 |
| F. App Check on Auth | Runbook §7 |
| F. password 8 + login copy | Task 12 |
| G. budget + capBilling | Tasks 14, 16 |
| H. Firestore list limits + listComments | Task 8 |
| Turnstile in signup (soft) | Task 13 |
| CSP for reCAPTCHA/Turnstile/App Check | Task 11 |

All spec sections mapped.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Task 4 Step 6 had a convoluted `requireAuth(request) && request.auth.uid` — replaced with the clean `const uid = requireAuth(request)` version in the same step.

**3. Type consistency:**
- `callable(extra)` — used identically in Tasks 1, 2, 5, 13.
- `assertUnderLimit(uid, action)` — Tasks 3–6 all pass `(uid: string, action: string)`; every `action` string is a key added to `LIMITS` (Task 3 + the `reportContent` amendment in Task 5 Step 4).
- `isYoungAccount(uid)` / `isYoung(ms, ms)` — Task 7, consistent.
- `reportCountStrong` — seeded in Task 7 Step 6, read/written in Steps 7–9, consistently `?? 0` fallback.
- `evaluateWindow` return `{ action: 'reset'|'increment'|'reject' }` — test (Task 3 Step 1) and impl (Step 3) match.
- `parseBudgetAlert` → `{ costAmount, budgetAmount, ratio, thresholds } | null` — test and impl match.

Fix applied inline: Task 5 Step 4 originally referenced a non-existent `'reportReview'` LIMITS key; corrected to add `reportContent` to `LIMITS` and use that in `reportReview`/`reportMemo`/`boardReact` report path (Tasks 5, 6, 7).
```
