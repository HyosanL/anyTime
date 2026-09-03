# 제안·신고 회신 확장 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱 리포트 회신을 강의 수정 제안(관리자 자유 결과 + 반려 사유)과 콘텐츠 신고(자동 결과 통보 + 유지 사유)로 확장하고, 홈 팝업을 세 종류 통합 `FeedbackPopup` 으로 일반화한다.

**Architecture:** 익명 유지 — 서버는 제출자를 모른다. 기기가 `localStorage` 에 자기 제안 ID·신고 콘텐츠 참조(기존 `bb-reacted` 재사용)를 쥐고, 단일 CF `getMyFeedback` 으로 결과를 조회한다. 수정 제안은 삭제 대신 상태 전환(applied/rejected/resolved)으로 보존하고 `subId`(제출 시점 푸시 해시)로 그 기기에 푸시. 신고는 푸시 없이 앱 접속 시 팝업만.

**Tech Stack:** React 19 + Vite, Firebase Cloud Functions v2 (Node 22), Cloudflare Pages. 테스트 프레임워크 없음 — `node --check` + `npm run build` + 배포 후 실기기.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-09-03-feedback-corrections-reports-design.md`.
- 이전 스펙 `2026-09-03-app-report-reply-design.md` 위에 얹는다 — `subId`(sha256 endpoint), `getMyAppReports`, `AppReportReplyPopup`, `src/lib/appReport.js` 가 이미 배포돼 있다.
- 익명성 하드룰 [[board-full-anonymity]] — `corrections`/`appReports` 에 uid 저장 금지. 신고는 개별 문서 만들지 않는다.
- `db/schema.sql` 미변경. `functions/api/push-fanout.js` 미변경.
- 대화 한국어, 코드·주석·커밋 영어. 커밋 끝 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- "배포" = `git push origin main`.
- `public/push-sw.js` 변경 시 `vite.config.js` `push-sw.js?v=12` → `v=13`.
- Firestore Rules·색인 변경 없음 — 모든 신규 조회는 단일필드 쿼리 또는 `db.getAll`/컬렉션 스캔.

---

### Task 1: 백엔드 — `submitCorrection` id 반환 + subId, `getMyFeedback` 신규

**Files:**
- Modify: `firebase/functions/src/corrections.js`
- Create: `firebase/functions/src/feedback.js`
- Modify: `firebase/functions/index.js`

**Interfaces:**
- Produces: `submitCorrection(...payload, endpoint?)` → 반환에 `id` 포함. 문서에 `subId`/`reply`/`repliedAt`.
- Produces: `getMyFeedback({ appReportIds, correctionIds, contentReports })` (onCall, requireAuth) → `{ status, appReports, corrections, contentReports }`.

- [ ] **Step 1: `corrections.js` — crypto import + subscriptionId 헬퍼**

Find [corrections.js:1-5](../../../firebase/functions/src/corrections.js#L1):

```js
import { randomBytes } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';
```

Replace with:

```js
import { createHash, randomBytes } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';

// push.js·appReport.js 와 동일: sha256(endpoint) hex. 관리자 검토 시 pushSubscriptions/{subId} 를 찾는다.
function subscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}
```

- [ ] **Step 2: `corrections.js` — 문서 생성에 필드 추가 + id 반환**

Find [corrections.js:343-360](../../../firebase/functions/src/corrections.js#L343):

```js
  const sug = suggested || null;
  const correctionRef = db.collection('corrections').doc();
  await correctionRef.set({
    target,
    professorCode,
    courseCode,
    year,
    term,
    sectionNo,
    label: label || null,
    field,
    suggested: sug,
    note: note || null,
    status: 'pending',
    autoApplied: false,
    prevValue: null,
    createdAt: FieldValue.serverTimestamp(),
  });
```

Replace with:

```js
  const sug = suggested || null;
  const { endpoint } = request.data ?? {};
  const subId = (typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024)
    ? subscriptionId(endpoint)
    : null;
  const correctionRef = db.collection('corrections').doc();
  await correctionRef.set({
    target,
    professorCode,
    courseCode,
    year,
    term,
    sectionNo,
    label: label || null,
    field,
    suggested: sug,
    note: note || null,
    status: 'pending',
    autoApplied: false,
    prevValue: null,
    subId,
    reply: null,
    repliedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });
```

- [ ] **Step 3: `corrections.js` — 반환값에 status·applied**

`submitCorrection` 의 마지막 줄(현재 [corrections.js:460](../../../firebase/functions/src/corrections.js#L460)) — 이미 `id` 는 반환한다:

```js
  return { id: correctionRef.id };
```

Replace with:

```js
  return { status: 'OK', applied, id: correctionRef.id };
```

(`applied` 는 이 함수 스코프의 `let applied` — 자동반영 시 true.)

- [ ] **Step 4: `firebase/functions/src/feedback.js` 작성**

```js
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, requireAuth } from './lib/context.js';

// 내가 낸 제안·신고의 결과 조회 — 익명 유지. 기기가 쥔 로컬 ID/참조로만 조회하고 uid 는
// 검증하지 않는다(Firestore auto-ID ≈ 119비트, 열거 불가 — 앱 리포트 회신 설계와 같은
// 위협 모델). 설계: docs/superpowers/specs/2026-09-03-feedback-corrections-reports-design.md
const CONTENT_COLLECTION = { board_post: 'boardPosts', review: 'reviews', class_memo: 'classMemos' };

function cleanIds(arr) {
  return [...new Set(Array.isArray(arr) ? arr : [])]
    .filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 64)
    .slice(0, 30);
}

async function lookupAppReports(ids) {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.collection('appReports').doc(id)));
  return snaps.filter((s) => s.exists).map((s) => {
    const d = s.data();
    return { id: s.id, text: d.text ?? '', status: d.status ?? 'pending',
      reply: d.reply ?? null, replyStatus: d.replyStatus ?? null, repliedAt: d.repliedAt ?? null };
  });
}

async function lookupCorrections(ids) {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.collection('corrections').doc(id)));
  return snaps.filter((s) => s.exists).map((s) => {
    const d = s.data();
    return { id: s.id, label: d.label ?? null, field: d.field ?? null,
      status: d.status ?? 'pending', autoApplied: d.autoApplied === true,
      reply: d.reply ?? null, repliedAt: d.repliedAt ?? null };
  });
}

async function lookupContentReports(refs) {
  const list = (Array.isArray(refs) ? refs : [])
    .filter((r) => r && CONTENT_COLLECTION[r.type] && typeof r.id === 'string' && r.id.length <= 64)
    .slice(0, 30);
  if (!list.length) return [];

  const out = [];
  for (const { type, id } of list) {
    const [delSnap, docSnap] = await Promise.all([
      db.collection('deletedContent').where('origId', '==', id).limit(1).get(),
      db.collection(CONTENT_COLLECTION[type]).doc(id).get(),
    ]);
    if (!delSnap.empty) {
      out.push({ type, id, outcome: 'removed', reason: delSnap.docs[0].get('reason') ?? null });
    } else if (!docSnap.exists) {
      out.push({ type, id, outcome: 'removed', reason: null }); // 작성자 자삭 — 신고자엔 '사라짐'으로 동일
    } else if (docSnap.get('reportDismissedAt')) {
      out.push({ type, id, outcome: 'kept', reason: docSnap.get('reportDismissReason') ?? null });
    }
    // else: pending — 알리지 않으므로 넣지 않는다
  }
  return out;
}

export const getMyFeedback = onCall(async (request) => {
  requireAuth(request);
  const d = request.data ?? {};
  const [appReports, corrections, contentReports] = await Promise.all([
    lookupAppReports(cleanIds(d.appReportIds)),
    lookupCorrections(cleanIds(d.correctionIds)),
    lookupContentReports(d.contentReports),
  ]);
  return { status: 'OK', appReports, corrections, contentReports };
});
```

- [ ] **Step 5: `index.js` export**

Find:

```js
export { submitCorrection } from './src/corrections.js';
```

Replace with:

```js
export { submitCorrection } from './src/corrections.js';
export { getMyFeedback } from './src/feedback.js';
```

- [ ] **Step 6: 문법 + 커밋**

```bash
node --check firebase/functions/src/corrections.js
node --check firebase/functions/src/feedback.js
node --check firebase/functions/index.js
git add firebase/functions/src/corrections.js firebase/functions/src/feedback.js firebase/functions/index.js
git commit -m "feat: submitCorrection returns id + stores subId; getMyFeedback unified outcome lookup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: 백엔드 — 수정 제안 관리자 액션을 '보존 + 회신'으로

**Files:**
- Modify: `firebase/functions/src/admin/moderationActions.js`

**Interfaces:**
- Consumes: `pushFanout`, `pushFanoutUrl`, `pushFanoutSecret` (이미 import 됨 — 앱 리포트 회신 Task 2).
- Produces: `reject_correction({ id, reason? })` / `apply_correction({ id })` / `resolve_correction({ ids })` — 삭제 대신 상태 전환 + `repliedAt` + `subId` 있으면 푸시.
- Produces: `dismiss_report({ table, id, reason? })` — 콘텐츠 문서에 `reportDismissReason`/`reportDismissedAt`.

- [ ] **Step 1: 공용 헬퍼 — 수정 제안 회신 푸시**

Find `ackAppReport` 함수 (앱 리포트 회신 Task 3 에서 그 근처에 `replyAppReport` 를 넣었다). `replyAppReport` 함수 **뒤에** 추가:

```js
// 수정 제안 결과를 제출 기기에 알린다(subId 있을 때). 실패는 삼킨다.
async function pushCorrectionOutcome(snap) {
  const subId = snap.get('subId');
  if (!subId) return;
  try {
    const subSnap = await db.collection('pushSubscriptions').doc(subId).get();
    if (!subSnap.exists) return;
    await pushFanout(pushFanoutUrl.value(), pushFanoutSecret.value(),
      { kind: 'feedback_reply', title: '📬 제안 결과', body: '보내주신 수정 제안이 검토됐어요.', path: '/' },
      [{ endpoint: subSnap.get('endpoint'), p256dh: subSnap.get('p256dh'), auth: subSnap.get('auth') }]);
  } catch (e) {
    console.error('[pushCorrectionOutcome] push failed', e);
  }
}
```

- [ ] **Step 2: `rejectCorrection` — 삭제 대신 rejected**

Find [moderationActions.js:160-166](../../../firebase/functions/src/admin/moderationActions.js#L160):

```js
async function rejectCorrection(uid, payload) {
  // 반려는 기록 불필요 → 즉시 삭제(익명이라 이력 가치도 없음).
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  await db.collection('corrections').doc(id).delete();
  return { status: 'OK' };
}
```

Replace with:

```js
async function rejectCorrection(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  const reason = payload.reason != null ? String(payload.reason).trim().slice(0, 300) : null;
  const ref = db.collection('corrections').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'OK' };
  await ref.update({ status: 'rejected', reply: reason || null, repliedAt: FieldValue.serverTimestamp() });
  await pushCorrectionOutcome(snap);
  return { status: 'OK' };
}
```

- [ ] **Step 3: `applyCorrection` — 반영 후 보존**

Find [moderationActions.js:168-182](../../../firebase/functions/src/admin/moderationActions.js#L168):

```js
async function applyCorrection(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  // 실제 반영 로직은 corrections.js(applyCorrectionRowInternal) 에 단일화 —
  // 관리자 수동적용과 자동반영(submitCorrection 경로)이 같은 코드를 쓴다.
  // catalogVersion 증가는 applyCorrectionRowInternal 내부 markApplied() 가 이미
  // 처리한다(확인됨) — 이 함수는 반영 후 큐(correction 문서) 정리만 담당한다.
  const status = await db.runTransaction(async (tx) => {
    const st = await applyCorrectionRowInternal(tx, db, id);
    // 반영 성공(OK) 또는 '이미 있음'(ALREADY_DONE)은 큐에 남길 이유가 없어 삭제한다.
    if (st === 'OK' || st === 'ALREADY_DONE') tx.delete(db.collection('corrections').doc(id));
    return st;
  });
  return { status };
}
```

Replace with:

```js
async function applyCorrection(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  // 실제 반영 로직은 corrections.js(applyCorrectionRowInternal) 에 단일화 —
  // catalogVersion 증가는 그 내부 markApplied() 가 처리한다. 여기선 반영 후 제안 문서를
  // 삭제 대신 'applied' 로 남겨 제출자에게 결과를 보여준다(purgeCorrections 가 30일 후 정리).
  const status = await db.runTransaction(async (tx) => {
    const st = await applyCorrectionRowInternal(tx, db, id);
    if (st === 'OK' || st === 'ALREADY_DONE') {
      tx.update(db.collection('corrections').doc(id),
        { status: 'applied', repliedAt: FieldValue.serverTimestamp() });
    }
    return st;
  });
  if (status === 'OK' || status === 'ALREADY_DONE') {
    const snap = await db.collection('corrections').doc(id).get();
    if (snap.exists) await pushCorrectionOutcome(snap);
  }
  return { status };
}
```

- [ ] **Step 4: `resolveCorrection` — 삭제 대신 resolved**

Find [moderationActions.js:186-193](../../../firebase/functions/src/admin/moderationActions.js#L186):

```js
async function resolveCorrection(uid, payload) {
  const ids = Array.isArray(payload.ids) ? payload.ids : (payload.id != null ? [payload.id] : []);
  if (!ids.length) return { status: 'OK' };
  const batch = db.batch();
  for (const id of ids) batch.delete(db.collection('corrections').doc(String(id)));
  await batch.commit();
  return { status: 'OK' };
}
```

Replace with:

```js
async function resolveCorrection(uid, payload) {
  const ids = Array.isArray(payload.ids) ? payload.ids : (payload.id != null ? [payload.id] : []);
  if (!ids.length) return { status: 'OK' };
  const refs = ids.map((id) => db.collection('corrections').doc(String(id)));
  const snaps = await db.getAll(...refs);
  const batch = db.batch();
  for (const s of snaps) {
    if (s.exists) batch.update(s.ref, { status: 'resolved', repliedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  for (const s of snaps) if (s.exists) await pushCorrectionOutcome(s);
  return { status: 'OK' };
}
```

- [ ] **Step 5: `dismissReport` — 사유 브레드크럼**

Find [moderationActions.js:338-368](../../../firebase/functions/src/admin/moderationActions.js#L338) — the whole `dismissReport`. The two `batch.update(ref, { reportCount: 0, reportReviewedCount: 0 })` / `await ref.update({ reportCount: 0, reportReviewedCount: 0 })` calls: add the two breadcrumb fields.

At the top of `dismissReport`, after `const id = String(payload.id ?? '');` line, add:

```js
  const reason = payload.reason != null ? String(payload.reason).trim().slice(0, 300) : null;
  const dismissMark = { reportDismissReason: reason || null, reportDismissedAt: FieldValue.serverTimestamp() };
```

Then change `batch.update(ref, { reportCount: 0, reportReviewedCount: 0 });` → `batch.update(ref, { reportCount: 0, reportReviewedCount: 0, ...dismissMark });`
and `await ref.update({ reportCount: 0, reportReviewedCount: 0 });` → `await ref.update({ reportCount: 0, reportReviewedCount: 0, ...dismissMark });`

- [ ] **Step 6: `purgeCorrections` — 신규 월간 정리**

Append to `firebase/functions/src/feedback.js` (Task 1 이 만든 파일, `onSchedule` 이미 import 됨):

```js
// 결과 통보가 끝난 수정 제안 정리(월간) — applied/rejected/resolved 이고 repliedAt 30일 경과.
// autoApplied 미확인 건은 ackCorrection 이 따로 정리하므로 여기선 건드리지 않는다.
// 컬렉션이 작아 전체 스캔(purgeAppReports 패턴, 복합색인 불필요).
export const purgeCorrections = onSchedule({ schedule: '0 18 1 * *', timeZone: 'UTC' }, async () => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const ms = (ts) => (typeof ts?.toMillis === 'function' ? ts.toMillis() : 0);
  const snap = await db.collection('corrections').get();
  const stale = snap.docs.filter((d) => {
    const st = d.get('status');
    return (st === 'applied' || st === 'rejected' || st === 'resolved')
      && d.get('autoApplied') !== true
      && ms(d.get('repliedAt')) > 0 && ms(d.get('repliedAt')) < cutoff;
  });
  if (!stale.length) return;
  for (let i = 0; i < stale.length; i += 400) {
    const batch = db.batch();
    for (const d of stale.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
});
```

And `index.js` — change the Task 1 export line:

```js
export { getMyFeedback } from './src/feedback.js';
```

→

```js
export { getMyFeedback, purgeCorrections } from './src/feedback.js';
```

- [ ] **Step 7: 문법 + 커밋**

```bash
node --check firebase/functions/src/admin/moderationActions.js
node --check firebase/functions/src/feedback.js
node --check firebase/functions/index.js
git add firebase/functions/src/admin/moderationActions.js firebase/functions/src/feedback.js firebase/functions/index.js
git commit -m "feat: correction moderation preserves + notifies; dismissReport records reason; purgeCorrections

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: 프론트 — `src/lib/feedback.js` (appReport.js 흡수·확장)

**Files:**
- Create: `src/lib/feedback.js`
- Delete: `src/lib/appReport.js` (Task 4·5 에서 참조를 옮긴 뒤)

**Interfaces:**
- Produces: `submitAppReport({text,path,ua,standalone})`, `submitCorrection(payload)` — 제출 + 로컬 기록. 각각 `{ ok, id, message }`.
- Produces: `fetchFeedback()` → `{ appReports:[], corrections:[], contentReports:[] }` (각 항목 outcome 포함, 로컬 mine 정리).
- Produces: `readSeen()`, `markSeen(keys)`.

- [ ] **Step 1: 파일 작성**

Create `src/lib/feedback.js`:

```js
import { callFn } from './functions';

// 제안·신고 결과 회신 — 익명 유지. 서버는 제출자를 모르고, 이 기기가 자기 제안 ID·신고
// 콘텐츠 참조를 쥐고 결과를 조회한다. 설계:
// docs/superpowers/specs/2026-09-03-feedback-corrections-reports-design.md
const MINE_KEY = 'feedback:mine';   // { appReport: [{id,summary,at}], correction: [{id,summary,at}] }
const SEEN_KEY = 'feedback:seen';   // ["appReport:<id>", "correction:<id>", "content:<type>_<id>"]
const REACTED_KEY = 'bb-reacted';   // reactions.js 와 공유 — 신고한 콘텐츠 추적
const MAX = 30;

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

export async function submitAppReport({ text, path, ua, standalone }) {
  const endpoint = await currentEndpoint();
  const r = await callFn('submitAppReport', { text, path, ua, standalone, ...(endpoint ? { endpoint } : {}) });
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
  const sumOf = (kind, id) => readMineAll()[kind].find((m) => m.id === id)?.summary ?? '';
  return {
    appReports: appReports.map((i) => ({ ...i, summary: i.text || sumOf('appReport', i.id) })),
    corrections: corrections.map((i) => ({ ...i, summary: sumOf('correction', i.id) || i.label || '수정 제안' })),
    contentReports: r.data?.contentReports ?? [],
  };
}
```

- [ ] **Step 2: 빌드 (아직 참조 없음) + 커밋**

```bash
npm run build
git add src/lib/feedback.js
git commit -m "feat: unified feedback lib (app reports + corrections + content report outcomes)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: 프론트 — `FeedbackPopup` (AppReportReplyPopup 개명·확장)

**Files:**
- Create: `src/components/FeedbackPopup.jsx`
- Delete: `src/components/AppReportReplyPopup.jsx`
- Modify: `src/pages/Home.jsx`
- Modify: `src/styles/home.css`

- [ ] **Step 1: `FeedbackPopup.jsx` 작성**

Create `src/components/FeedbackPopup.jsx`:

```js
import { useEffect, useState } from 'react';
import { fetchFeedback, readSeen, markSeen } from '../lib/feedback';

// ntc-* 클래스는 home.css(전역). 앱 접속 시, 안 본 제안·신고 결과를 공지처럼 한 번 띄운다.
const APP_STATUS = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

function appReportLine(it) {
  return { key: `appReport:${it.id}`, badge: APP_STATUS[it.replyStatus] || '답변',
    q: it.summary, a: it.reply };
}
function correctionLine(it) {
  const a = it.status === 'applied' && it.autoApplied ? '📌 여러 명이 같은 제안을 해서 자동 반영됐어요.'
    : it.status === 'applied' ? '✅ 제안이 반영됐어요.'
    : it.status === 'rejected' ? (it.reply ? `❌ 반려됐어요: ${it.reply}` : '❌ 이번엔 반영하지 않았어요.')
    : it.status === 'resolved' ? '✅ 확인 후 직접 수정했어요.'
    : null;
  return a ? { key: `correction:${it.id}`, badge: '수정 제안', q: it.summary, a } : null;
}
function contentLine(it) {
  const a = it.outcome === 'removed' ? '🗑️ 신고하신 내용이 삭제 조치됐어요.'
    : it.outcome === 'kept' ? (it.reason ? `검토 결과 유지됩니다: ${it.reason}` : '검토 결과 규정 위반이 아니라 유지됩니다.')
    : null;
  return a ? { key: `content:${it.type}_${it.id}`, badge: '신고', q: '', a } : null;
}

export default function FeedbackPopup() {
  const [lines, setLines] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const f = await fetchFeedback();
        if (!active) return;
        const seen = new Set(readSeen());
        const all = [
          ...f.appReports.filter((i) => i.reply).map(appReportLine),
          ...f.corrections.map(correctionLine).filter(Boolean),
          ...f.contentReports.map(contentLine).filter(Boolean),
        ].filter((l) => l && !seen.has(l.key));
        setLines(all);
      } catch { /* 오프라인 등 */ }
    })();
    return () => { active = false; };
  }, []);

  if (lines.length === 0) return null;

  function close() {
    markSeen(lines.map((l) => l.key));
    setLines([]);
  }

  return (
    <div className="ntc-overlay" onClick={close}>
      <div className="ntc-modal" role="dialog" aria-modal="true" aria-label="제안·신고 결과" onClick={(e) => e.stopPropagation()}>
        <div className="ntc-head">
          <h3 className="ntc-title">📬 보내주신 의견에 결과가 있어요</h3>
          <button className="ntc-x" onClick={close} aria-label="닫기">✕</button>
        </div>
        <div className="ntc-list">
          {lines.map((l) => (
            <article key={l.key} className="ntc-item">
              <div className="ntc-item-head">
                <strong className="ntc-item-title">{l.badge}</strong>
              </div>
              {l.q && <p className="ntc-content ar-pop-q">“{l.q}”</p>}
              <p className="ntc-content">{l.a}</p>
            </article>
          ))}
        </div>
        <button className="btn-add btn-block" onClick={close}>확인</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Home.jsx — 참조 교체**

Find:

```js
import AppReportReplyPopup from '../components/AppReportReplyPopup';
```

Replace with:

```js
import FeedbackPopup from '../components/FeedbackPopup';
```

Find:

```jsx
      <AppReportReplyPopup />
```

Replace with:

```jsx
      <FeedbackPopup />
```

- [ ] **Step 3: 옛 컴포넌트 삭제 + CSS 는 그대로**

```bash
rm src/components/AppReportReplyPopup.jsx
```

`src/styles/home.css` 의 `.ar-pop-q` 는 그대로 재사용(변경 없음).

- [ ] **Step 4: 빌드 + 커밋**

```bash
npm run build
git add src/components/FeedbackPopup.jsx src/pages/Home.jsx
git rm src/components/AppReportReplyPopup.jsx
git commit -m "feat: FeedbackPopup replaces AppReportReplyPopup — shows all 3 feedback kinds

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: 프론트 — 모달들을 `feedback.js` 로

**Files:**
- Modify: `src/components/AppReportModal.jsx`
- Modify: `src/components/CorrectionModal.jsx`
- Delete: `src/lib/appReport.js`

- [ ] **Step 1: `AppReportModal.jsx` — import 교체**

Find:

```js
import { submitReport, fetchMyReports } from '../lib/appReport';
```

Replace with:

```js
import { submitAppReport as submitReport, fetchMyAppReports as fetchMyReports } from '../lib/feedback';
```

(`AppReportModal` 내부에서 `submitReport(...)` 은 `{ok,id,message}`, `fetchMyReports()` 는 `[{id,text,status,reply,replyStatus}]` 를 그대로 받으므로 본문 수정 불필요. `submitReport` 반환 shape 확인: `feedback.submitAppReport` 는 `{ ok, id, message }` 반환 — `AppReportModal` 의 `if (!r.ok) return setErr(r.message ...)` 및 `setMine((prev) => [{ id: r.id, ... }])` 와 일치.)

- [ ] **Step 2: `CorrectionModal.jsx` — 제출 경로 교체 + 안내**

Find [CorrectionModal.jsx:2](../../../src/components/CorrectionModal.jsx#L2):

```js
import { callFn } from '../lib/functions';
```

Replace with:

```js
import { submitCorrection } from '../lib/feedback';
```

Find [CorrectionModal.jsx:140-151](../../../src/components/CorrectionModal.jsx#L140):

```js
    setBusy(true); setErr('');
    const r = await callFn('submitCorrection', {
      target: opt.target,
      targetKey: opt.targetKey,
      label: subject,
      field: opt.field,
      suggested,
      note: note.trim(),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message || '제출에 실패했습니다.');
    setDone(true);
```

Replace with:

```js
    setBusy(true); setErr('');
    const r = await submitCorrection({
      target: opt.target,
      targetKey: opt.targetKey,
      label: subject,
      field: opt.field,
      suggested,
      note: note.trim(),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message || '제출에 실패했습니다.');
    setDone(true);
```

Find the done 블록 [CorrectionModal.jsx:217-220](../../../src/components/CorrectionModal.jsx#L217):

```jsx
          <div className="cor-done">
            <p>✅ 제안이 접수되었습니다. 관리자 검토 후 반영됩니다. 감사합니다!</p>
            <button className="btn-add btn-block" onClick={onClose}>닫기</button>
          </div>
```

Replace with:

```jsx
          <div className="cor-done">
            <p>✅ 제안이 접수되었습니다. 관리자 검토 후 반영됩니다. 감사합니다!</p>
            <p className="cor-hint">결과는 앱을 다시 열 때 알려드려요.</p>
            <button className="btn-add btn-block" onClick={onClose}>닫기</button>
          </div>
```

- [ ] **Step 3: `appReport.js` 삭제 + 참조 없음 확인**

```bash
grep -rn "lib/appReport" src/   # 결과 없어야 함
git rm src/lib/appReport.js
```

- [ ] **Step 4: 빌드 + 커밋**

```bash
npm run build
git add src/components/AppReportModal.jsx src/components/CorrectionModal.jsx
git rm src/lib/appReport.js
git commit -m "feat: AppReportModal + CorrectionModal use unified feedback lib; drop appReport.js

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: 프론트 — 관리자 화면: 수정 제안 반려 사유 + 신고 무시 사유

**Files:**
- Modify: `src/pages/Moderation.jsx`

- [ ] **Step 1: `rejectGroup` — 반려 사유 프롬프트**

Find [Moderation.jsx:378-382](../../../src/pages/Moderation.jsx#L378):

```js
  async function rejectGroup(g) {
    if (!confirm('이 수정 제안을 반려할까요?')) return;
    for (const id of g.ids) await call('reject_correction', { id });
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
  }
```

Replace with:

```js
  async function rejectGroup(g) {
    const reason = prompt('반려 사유 (선택 — 제안자에게 그대로 표시됩니다. 비워도 반려됩니다)');
    if (reason === null) return;   // 취소
    for (const id of g.ids) await call('reject_correction', { id, reason: reason.trim() });
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
  }
```

- [ ] **Step 2: `dismissReport` — 유지 사유 프롬프트**

Find [Moderation.jsx:311-315](../../../src/pages/Moderation.jsx#L311):

```js
  async function dismissReport(it) {
    if (!confirm('이 신고를 무시(정상 처리)할까요? 신고 수가 초기화됩니다.')) return;
    const r = await call('dismiss_report', { table: it.type, id: it.id });
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
  }
```

Replace with:

```js
  async function dismissReport(it) {
    const reason = prompt('이 신고를 무시(정상 처리)합니다. 유지 사유 (선택 — 신고자에게 표시됩니다):');
    if (reason === null) return;   // 취소
    const r = await call('dismiss_report', { table: it.type, id: it.id, reason: reason.trim() });
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
  }
```

- [ ] **Step 3: 빌드 + 커밋**

```bash
npm run build
git add src/pages/Moderation.jsx
git commit -m "feat: moderation — reject correction / dismiss report can carry a reason for the submitter

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: SW — `feedback_reply` kind + 버전 범프

**Files:**
- Modify: `public/push-sw.js`
- Modify: `vite.config.js`

- [ ] **Step 1: `feedback_reply` 를 서버-텍스트 kind 로**

Find (앱 리포트 회신 Task 8 이 남긴 상태):

```js
  const ADMIN_KINDS = ['correction', 'auto_correction', 'report_deleted', 'app_report', 'app_report_reply'];
```

Replace with:

```js
  const ADMIN_KINDS = ['correction', 'auto_correction', 'report_deleted', 'app_report', 'app_report_reply', 'feedback_reply'];
```

Find:

```js
  const title = admin ? (msg.title || (msg.kind === 'app_report_reply' ? '📬 문의 답변' : '🔔 관리자 알림'))
```

Replace with:

```js
  const title = admin ? (msg.title || ((msg.kind === 'app_report_reply' || msg.kind === 'feedback_reply') ? '📬 결과 알림' : '🔔 관리자 알림'))
```

- [ ] **Step 2: `vite.config.js`**

```js
        importScripts: ['push-sw.js?v=12'],
```

→

```js
        importScripts: ['push-sw.js?v=13'],
```

- [ ] **Step 3: 빌드 + 커밋**

```bash
npm run build
git add public/push-sw.js vite.config.js
git commit -m "feat: SW handles feedback_reply push kind; bump sw v13

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: 통합 검증 + 배포

- [ ] **Step 1: 전체 빌드 + functions 문법**

```bash
npm run build
node --check firebase/functions/index.js
node --check firebase/functions/src/corrections.js
node --check firebase/functions/src/feedback.js
node --check firebase/functions/src/admin/moderationActions.js
grep -rn "lib/appReport\|AppReportReplyPopup" src/    # 결과 없어야 함
```

- [ ] **Step 2: 배포**

```bash
git status
git push origin main
```

- Firebase Actions 성공 + `getMyFeedback`·`purgeCorrections` 생성 로그 확인.
- Cloudflare Pages 자동 재빌드(push-sw v13).

- [ ] **Step 3: 배포 후 실기기 확인**

1. 강의 수정 제안 제출 → 관리자 검열에서 반려(사유 입력) → 앱 재진입 → "❌ 반려됐어요: {사유}" 팝업 → 확인 후 안 뜸.
2. 같은 제안 3번(자동반영 대상: section_time time/room) → 3번째 후 앱 재진입 → "📌 자동 반영" 팝업.
3. 게시글 신고 → 관리자가 삭제(또는 신고 30건) → 신고 기기 앱 재진입 → "🗑️ 삭제 조치" 팝업.
4. 게시글 신고 → 관리자 무시(사유 입력) → 신고 기기 → "검토 결과 유지됩니다: {사유}" 팝업.
5. 앱 리포트 회신(기존) → `FeedbackPopup` 으로도 정상 표시(회귀 없음).
6. 푸시 구독 상태로 제안 제출 → 관리자 처리 시 "📬 결과 알림" 푸시 1건.

- [ ] **Step 4: 스펙 갱신 + 커밋 + 푸시**

`docs/superpowers/specs/2026-09-03-feedback-corrections-reports-design.md` 하단에:

```markdown
## 구현

2026-09-03 구현·배포 완료. 계획: `docs/superpowers/plans/2026-09-03-feedback-corrections-reports.md`.
```

```bash
git add docs/superpowers/specs/2026-09-03-feedback-corrections-reports-design.md
git commit -m "docs: mark feedback-corrections-reports spec implemented

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| 스펙 | Task |
|---|---|
| Ⅰ submitCorrection id+subId | 1 |
| Ⅰ reject/apply/resolve 보존+푸시 | 2 |
| Ⅰ purgeCorrections | 2 |
| Ⅰ 사용자 결과 문구 | 4 (correctionLine) |
| Ⅱ dismissReport 사유 브레드크럼 | 2 |
| Ⅱ 결과 판정(removed/kept/pending) | 1 (lookupContentReports) |
| Ⅱ 관리자 무시 사유 입력 | 6 |
| Ⅲ feedback.js | 3 |
| Ⅲ getMyFeedback | 1 |
| Ⅲ FeedbackPopup | 4 |
| Ⅲ CorrectionModal / AppReportModal | 5 |
| Ⅳ SW feedback_reply + v13 | 7 |
| Ⅴ 색인 추가 없음 | 전체 (스캔/단일필드) |
| Ⅵ Rules 변경 없음 | — |

**Placeholder scan:** Task 5 Step 2 (CorrectionModal done 블록), Task 6 (Moderation 핸들러 이름) 은 파일 확인 후 맞추라고 명시 — 나머지 코드는 완전.

**Type consistency:**
- `submitCorrection` 반환 `{status:'OK', applied, id}` — Task 1 정의, Task 3 `feedback.submitCorrection` 이 `r.data.id`/`r.data.applied` 사용. 일치.
- `getMyFeedback` 반환 `{appReports, corrections, contentReports}` — Task 1 정의, Task 3 `fetchFeedback` 소비. `corrections` 항목 `{id,label,field,status,autoApplied,reply,repliedAt}` — Task 1 `lookupCorrections` 생산, Task 4 `correctionLine` 소비(`status`/`autoApplied`/`reply`). 일치.
- `contentReports` 항목 `{type,id,outcome,reason}`, `outcome ∈ removed|kept` — Task 1 생산, Task 4 `contentLine` 소비. 일치.
- `kind:'feedback_reply'` — Task 2 `pushCorrectionOutcome` 발신, Task 7 SW 수신. 일치.
- `dismiss_report` payload `{table,id,reason}` — Task 2 처리(`payload.reason`), Task 6 송신. `table` 값 = `listReported` 의 `it.type`(review/class_memo/board_post) = `REPORTABLE_COLLECTIONS` 키. 일치.
- `feedback:mine` / `feedback:seen` / `bb-reacted` localStorage 키 — Task 3 정의, Task 4 소비. `bb-reacted` 는 `src/lib/reactions.js` 와 공유(읽기만). 일치.
