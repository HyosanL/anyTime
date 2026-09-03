# 앱 리포트 회신 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관리자가 앱 문제 리포트에 답변할 수 있게 하고, 그 답변을 익명성을 지키면서 (푸시 + 앱 접속 시 공지 팝업 + 🚩 모달 내 목록) 해당 사용자에게 전한다.

**Architecture:** 서버는 리포트 작성자를 모른다 — 기기가 `localStorage`에 적어 둔 자기 리포트 ID로 답변을 조회하고(CF `getMyAppReports`), 제출 시점의 푸시 구독 해시(`subId`, uid 아님)로 그 한 기기에만 푸시한다. `appReports` 문서에 `reply`/`replyStatus`/`repliedAt`/`subId` 필드를 더하고, 답변 달린 리포트는 삭제 대신 `status:'replied'`로 보존한다.

**Tech Stack:** React 19 + Vite, Firebase Cloud Functions v2 (Node 22), Cloudflare Pages. 테스트 프레임워크 없음 — `node --check`(functions 문법) + `npm run build` + 배포 후 실기기.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-09-03-app-report-reply-design.md`.
- 익명성은 하드룰([[board-full-anonymity]]) — `appReports`에 uid를 저장하지 않는다. `subId`는 브라우저가 발급한 임의 endpoint의 sha256 해시(watcher와 동일 등급).
- `db/schema.sql`(레거시 Supabase)은 건드리지 않는다 — Firestore만.
- `functions/api/push-fanout.js`는 건드리지 않는다 — `kind`/`title`/`body`/`path` 이미 패스스루.
- 대화 한국어, 코드·주석·커밋 영어. 커밋 끝에 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- "배포" = `git push origin main` (Firebase Actions + Cloudflare Pages 자동).
- `public/push-sw.js`를 바꾸면 같은 태스크에서 `vite.config.js`의 `importScripts: ['push-sw.js?v=N']`을 범프한다(현재 `v=11`).
- Firestore Rules 변경 없음 — `appReports`는 `if false` 유지, 기기는 CF로만 읽는다.
- `firebase/functions/CONVENTIONS.md` 준수 — 시크릿은 `{ secrets: [...] }`로 바인딩 후 핸들러 안에서 `.value()`.

---

### Task 1: 백엔드 — `submitAppReport` subId + id 반환, `getMyAppReports` 신규

**Files:**
- Modify: `firebase/functions/src/appReport.js`
- Modify: `firebase/functions/index.js`

**Interfaces:**
- Produces: `submitAppReport({ text, path, ua, standalone, endpoint? })` → `{ status:'OK', id }`. `endpoint` 유효 시 `subId = sha256(endpoint)` 저장.
- Produces: `getMyAppReports({ ids: string[] })` (onCall, requireAuth) → `{ status:'OK', items: [{ id, text, status, reply, replyStatus, repliedAt }] }`.

- [ ] **Step 1: `appReport.js` 상단에 crypto import + subscriptionId 헬퍼**

Find the top of `firebase/functions/src/appReport.js`:

```js
import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';
```

Replace with:

```js
import { createHash } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';

// push.js 와 동일한 문서ID 규칙(sha256(endpoint) hex). endpoint 자체가 추측 불가능한
// capability URL 이라 salt 불필요. 답변 시 pushSubscriptions/{subId} 를 그대로 찾는다.
function subscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}
```

- [ ] **Step 2: `submitAppReport` 본문 — subId 저장 + id 반환**

Find the body of `submitAppReport` (the `db.collection('appReports').add({...})` block and `return`):

```js
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

Replace with:

```js
  const { endpoint } = request.data ?? {};
  const subId = (typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024)
    ? subscriptionId(endpoint)
    : null;

  const ref = await db.collection('appReports').add({
    text: t,
    path: p,
    ua: u,
    standalone: !!standalone,
    status: 'pending',
    subId,
    reply: null,
    replyStatus: null,
    repliedAt: null,
    createdAt: FieldValue.serverTimestamp(),
  });

  // admin_push() 는 자체 실패를 삼킨다(pushFanout.js) — 알림 실패가 접수 자체를 막지 않는다.
  await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
    kind: 'app_report',
    title: '🐞 새 앱 문제 리포트',
    body: t.length > 80 ? `${t.slice(0, 80)}…` : t,
  });

  return { status: 'OK', id: ref.id };
});
```

- [ ] **Step 3: `getMyAppReports` 신규 — 파일 끝에 추가**

Append to `firebase/functions/src/appReport.js`:

```js
// 내가 낸 리포트의 답변 조회 — 기기가 localStorage 에 적어 둔 자기 리포트 ID 로만 조회한다.
// uid 검증 없음: ID 를 안다는 것이 곧 소유 증명이다(Firestore auto-ID 20자 ≈ 119비트,
// 열거 불가 — getSharedPost 공유 토큰·푸시 endpoint 와 같은 위협 모델). subId·ua·path 는
// 돌려주지 않는다(기기엔 불필요).
export const getMyAppReports = onCall(async (request) => {
  requireAuth(request);
  const ids = Array.isArray(request.data?.ids) ? request.data.ids : [];
  const clean = [...new Set(ids)]
    .filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 64)
    .slice(0, 20);
  if (!clean.length) return { status: 'OK', items: [] };

  const refs = clean.map((id) => db.collection('appReports').doc(id));
  const snaps = await db.getAll(...refs);
  const items = snaps
    .filter((s) => s.exists)
    .map((s) => {
      const d = s.data();
      return {
        id: s.id,
        text: d.text ?? '',
        status: d.status ?? 'pending',
        reply: d.reply ?? null,
        replyStatus: d.replyStatus ?? null,
        repliedAt: d.repliedAt ?? null,
      };
    });
  return { status: 'OK', items };
});
```

- [ ] **Step 4: `index.js` export**

Find:

```js
export { submitAppReport } from './src/appReport.js';
```

Replace with:

```js
export { submitAppReport, getMyAppReports, purgeAppReports } from './src/appReport.js';
```

(`purgeAppReports` 는 Task 3 에서 같은 파일에 추가된다 — 이 export 를 지금 넣어 두면 Task 3 이 export 를 또 건드리지 않는다.)

- [ ] **Step 5: 문법 확인 + 커밋**

```bash
node --check firebase/functions/src/appReport.js   # purgeAppReports 아직 없음 → index.js는 Task 3 후 검사
git add firebase/functions/src/appReport.js
git commit -m "feat: appReport stores push subId + returns id; getMyAppReports for anon reply lookup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

(index.js 는 Task 3 완료 후 함께 검사·커밋한다 — 지금 커밋하면 `purgeAppReports` 미정의로 배포 시 깨진다.)

---

### Task 2: 백엔드 — `reply_app_report` + `list_replied_app_reports` admin action

**Files:**
- Modify: `firebase/functions/src/admin.js` (secrets 바인딩)
- Modify: `firebase/functions/src/admin/moderationActions.js` (핸들러 2개 + 등록)

**Interfaces:**
- Consumes: `pushFanout` ([lib/pushFanout.js](../../../firebase/functions/src/lib/pushFanout.js)), `pushFanoutUrl`/`pushFanoutSecret` ([lib/secrets.js](../../../firebase/functions/src/lib/secrets.js)).
- Produces: admin action `reply_app_report({ id, reply, replyStatus })` → `{ status:'OK' }`, 문서에 답변 기록 + `subId` 있으면 푸시 1건.
- Produces: admin action `list_replied_app_reports()` → `{ status:'OK', items: [...] }`.

- [ ] **Step 1: `admin.js` — adminAction 에 push 시크릿 바인딩**

Find [admin.js:1-4](../../../firebase/functions/src/admin.js#L1):

```js
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { requireAdmin, invalid } from './lib/context.js';
import { catalogActions } from './admin/catalogActions.js';
import { moderationActions } from './admin/moderationActions.js';
```

Replace with:

```js
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { requireAdmin, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { catalogActions } from './admin/catalogActions.js';
import { moderationActions } from './admin/moderationActions.js';
```

Find [admin.js:19](../../../firebase/functions/src/admin.js#L19):

```js
export const adminAction = onCall(async (request) => {
```

Replace with:

```js
// reply_app_report 가 리포트 작성자 기기에 푸시를 보낸다 — 그 한 액션 때문에 시크릿을
// adminAction 전체에 바인딩한다(v2 시크릿은 함수 단위 바인딩, 핸들러 안에서 .value()).
export const adminAction = onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, async (request) => {
```

- [ ] **Step 2: `moderationActions.js` — import 추가**

Find the top imports of `firebase/functions/src/admin/moderationActions.js` and add (after the existing `context.js` import line — keep it grouped with other `../lib/` imports):

```js
import { pushFanout } from '../lib/pushFanout.js';
import { pushFanoutUrl, pushFanoutSecret } from '../lib/secrets.js';
```

- [ ] **Step 3: `moderationActions.js` — 핸들러 2개 추가**

Find `ackAppReport` (currently [moderationActions.js:225-231](../../../firebase/functions/src/admin/moderationActions.js#L225)):

```js
async function ackAppReport(uid, payload) {
  // 확인 처리 = 즉시 삭제(수정제안 ackCorrection 과 동일 — 익명이라 이력 보관 가치 없음).
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  await db.collection('appReports').doc(id).delete();
  return { status: 'OK' };
}
```

Insert **after** that function:

```js
const REPLY_STATUSES = new Set(['reviewing', 'resolved', 'planned']);

async function replyAppReport(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  const reply = String(payload.reply ?? '').trim();
  if (reply.length < 1 || reply.length > 1000) invalid('답변은 1자 이상 1000자 이하로 입력하세요.');
  const replyStatus = String(payload.replyStatus ?? '');
  if (!REPLY_STATUSES.has(replyStatus)) invalid('처리 상태가 올바르지 않습니다.');

  const ref = db.collection('appReports').doc(id);
  const snap = await ref.get();
  if (!snap.exists) invalid('리포트를 찾을 수 없습니다.');

  await ref.update({
    reply,
    replyStatus,
    repliedAt: FieldValue.serverTimestamp(),
    status: 'replied',
  });

  // 제출 시점 푸시 구독이 살아 있으면 그 한 기기에만 알린다(실패는 삼킨다 — 답변은 이미 저장됨).
  const subId = snap.get('subId');
  if (subId) {
    try {
      const subSnap = await db.collection('pushSubscriptions').doc(subId).get();
      if (subSnap.exists) {
        await pushFanout(pushFanoutUrl.value(), pushFanoutSecret.value(),
          { kind: 'app_report_reply', title: '📬 문의 답변', body: reply.length > 80 ? `${reply.slice(0, 80)}…` : reply, path: '/' },
          [{ endpoint: subSnap.get('endpoint'), p256dh: subSnap.get('p256dh'), auth: subSnap.get('auth') }]);
      }
    } catch (e) {
      console.error('[replyAppReport] push failed', e);
    }
  }
  return { status: 'OK' };
}

async function listRepliedAppReports() {
  const snap = await db.collection('appReports')
    .where('status', '==', 'replied')
    .orderBy('repliedAt', 'desc')
    .limit(50)
    .get();
  return {
    status: 'OK',
    items: snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id, text: x.text ?? '', path: x.path ?? null,
        reply: x.reply ?? '', replyStatus: x.replyStatus ?? null,
        repliedAt: x.repliedAt ?? null, createdAt: x.createdAt ?? null,
      };
    }),
  };
}
```

- [ ] **Step 4: `moderationActions.js` — 액션 등록**

Find (currently near [moderationActions.js:684-685](../../../firebase/functions/src/admin/moderationActions.js#L684)):

```js
  list_app_reports: listAppReports,
  ack_app_report: ackAppReport,
```

Replace with:

```js
  list_app_reports: listAppReports,
  list_replied_app_reports: listRepliedAppReports,
  ack_app_report: ackAppReport,
  reply_app_report: replyAppReport,
```

- [ ] **Step 5: 문법 + 커밋**

```bash
node --check firebase/functions/src/admin.js
node --check firebase/functions/src/admin/moderationActions.js
git add firebase/functions/src/admin.js firebase/functions/src/admin/moderationActions.js
git commit -m "feat: reply_app_report admin action (writes reply + pushes to reporter's device)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: 백엔드 — `purgeAppReports` 월간 정리

**Files:**
- Modify: `firebase/functions/src/appReport.js` (import + 함수 추가)

**Interfaces:**
- Produces: `purgeAppReports` (onSchedule '0 18 1 * *' UTC) — `replied` 30일 / `pending` 90일 경과분 삭제.

- [ ] **Step 1: `appReport.js` import 에 onSchedule + Timestamp**

Find (top of `firebase/functions/src/appReport.js`, after Task 1's edits):

```js
import { createHash } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
```

Replace with:

```js
import { createHash } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, FieldValue, Timestamp, requireAuth, invalid } from './lib/context.js';
```

- [ ] **Step 2: `purgeAppReports` 함수 — 파일 끝에 추가**

Append to `firebase/functions/src/appReport.js`:

```js
// 앱 리포트 정리(월간) — 답변 후 30일, 방치된 pending 90일 경과분 삭제. 다른 월간 purge 와
// 같은 크론('0 18 1 * *' UTC = 매월 2일 03:00 KST).
export const purgeAppReports = onSchedule({ schedule: '0 18 1 * *', timeZone: 'UTC' }, async () => {
  const now = Date.now();
  const repliedCutoff = Timestamp.fromMillis(now - 30 * 24 * 60 * 60 * 1000);
  const pendingCutoff = Timestamp.fromMillis(now - 90 * 24 * 60 * 60 * 1000);

  const [repliedSnap, pendingSnap] = await Promise.all([
    db.collection('appReports').where('status', '==', 'replied').where('repliedAt', '<', repliedCutoff).get(),
    db.collection('appReports').where('status', '==', 'pending').where('createdAt', '<', pendingCutoff).get(),
  ]);
  const docs = [...repliedSnap.docs, ...pendingSnap.docs];
  if (!docs.length) return;

  for (let i = 0; i < docs.length; i += 400) {
    const batch = db.batch();
    for (const d of docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
});
```

- [ ] **Step 3: 문법 확인(전체) + 커밋**

```bash
node --check firebase/functions/src/appReport.js
node --check firebase/functions/index.js
git add firebase/functions/src/appReport.js firebase/functions/index.js
git commit -m "feat: purgeAppReports monthly cleanup + wire index.js exports

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: 프론트 — `src/lib/appReport.js` (기기 상태 + CF 래퍼)

**Files:**
- Create: `src/lib/appReport.js`

**Interfaces:**
- Produces: `submitReport({ text, path, ua, standalone })` → `{ ok, id? , message? }` (endpoint 자동 첨부, 성공 시 `recordMyReport`).
- Produces: `readMyReports()` → `[{ id, text, at }]`.
- Produces: `fetchMyReports()` → `[{ id, text, status, reply, replyStatus, repliedAt }]` (서버에 없는 로컬 항목 정리).
- Produces: `readSeenReplies()` / `markReplySeen(ids)`.

- [ ] **Step 1: 파일 작성**

Create `src/lib/appReport.js`:

```js
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
```

- [ ] **Step 2: 빌드 + 커밋**

```bash
npm run build
git add src/lib/appReport.js
git commit -m "feat: appReport device-state lib (local report IDs + anon reply lookup)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: 프론트 — `AppReportModal` 제출 경로 교체 + '내가 보낸 리포트'

**Files:**
- Modify: `src/components/AppReportModal.jsx`
- Modify: `src/styles/correction.css` (내 리포트 목록 스타일)

**Interfaces:**
- Consumes: Task 4 `submitReport`, `fetchMyReports`.

- [ ] **Step 1: import + 제출 핸들러 교체**

Find [AppReportModal.jsx:1-4](../../../src/components/AppReportModal.jsx#L1):

```js
import { useState } from 'react';
import { callFn } from '../lib/functions';
import { isStandalone } from './InstallGate';
import '../styles/correction.css';
```

Replace with:

```js
import { useEffect, useState } from 'react';
import { submitReport, fetchMyReports } from '../lib/appReport';
import { isStandalone } from './InstallGate';
import '../styles/correction.css';

const STATUS_LABEL = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };
```

Find the `submit` function:

```js
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
```

Replace with:

```js
  async function submit() {
    const t = text.trim();
    if (t.length < 5) return setErr('무엇이 문제였는지 5자 이상 적어주세요.');
    setBusy(true); setErr('');
    const r = await submitReport({
      text: t,
      path: location.pathname,
      ua: navigator.userAgent,
      standalone: isStandalone(),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message || '제출에 실패했습니다.');
    setDone(true);
    setMine((prev) => [{ id: r.id, text: t, status: 'pending', reply: null, replyStatus: null }, ...prev]);
  }
```

- [ ] **Step 2: '내가 보낸 리포트' 상태 + 로드**

Find the state declarations:

```js
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
```

Replace with:

```js
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const [mine, setMine] = useState([]);

  useEffect(() => { fetchMyReports().then(setMine).catch(() => {}); }, []);
```

- [ ] **Step 3: 렌더 — 폼 아래에 목록**

Find the closing of the form branch (the `</>` after the submit button `<p className="cor-hint">`):

```jsx
            <p className="cor-hint">익명으로 접수됩니다(작성자 정보 미저장). 진단 정보(현재 화면 경로·기기환경)가 함께 전송돼요.</p>
          </>
        )}
      </div>
    </div>
  );
}
```

Replace with:

```jsx
            <p className="cor-hint">익명으로 접수됩니다(작성자 정보 미저장). 진단 정보(현재 화면 경로·기기환경)가 함께 전송돼요.</p>
          </>
        )}

        {mine.length > 0 && (
          <div className="ar-mine">
            <h4 className="ar-mine-h">내가 보낸 리포트</h4>
            <ul className="ar-mine-list">
              {mine.map((m) => (
                <li key={m.id} className="ar-mine-item">
                  <p className="ar-mine-text">{m.text}</p>
                  {m.reply ? (
                    <div className="ar-mine-reply">
                      <span className="ar-mine-badge">{STATUS_LABEL[m.replyStatus] || '답변'}</span>
                      <p className="ar-mine-reply-t">{m.reply}</p>
                    </div>
                  ) : (
                    <p className="ar-mine-pending">접수됨 · 검토 중</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: CSS — `src/styles/correction.css` 끝에 추가**

```css
/* 앱 리포트 모달: 내가 보낸 리포트 목록 */
.ar-mine { margin-top: 1rem; border-top: 1px solid var(--border); padding-top: 0.8rem; }
.ar-mine-h { margin: 0 0 0.5rem; font-size: 0.82rem; color: var(--text-2); }
.ar-mine-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
.ar-mine-item { font-size: 0.8rem; }
.ar-mine-text { margin: 0; color: var(--text); }
.ar-mine-pending { margin: 0.2rem 0 0; color: var(--text-3); font-size: 0.76rem; }
.ar-mine-reply { margin-top: 0.35rem; padding: 0.5rem 0.6rem; background: var(--surface); border-radius: var(--r-sm); }
.ar-mine-badge { display: inline-block; font-size: 0.7rem; font-weight: 700; color: var(--accent); margin-bottom: 0.2rem; }
.ar-mine-reply-t { margin: 0; color: var(--text); line-height: 1.5; white-space: pre-wrap; }
```

- [ ] **Step 5: 빌드 + 커밋**

```bash
npm run build
git add src/components/AppReportModal.jsx src/styles/correction.css
git commit -m "feat: app report modal submits via appReport lib, shows my past reports + replies

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: 프론트 — `AppReportReplyPopup` + 홈 배선 + 검열 텍스트 제거

**Files:**
- Create: `src/components/AppReportReplyPopup.jsx`
- Modify: `src/pages/Home.jsx` (팝업 렌더 + `home-mod-link` 텍스트 제거)

**Interfaces:**
- Consumes: Task 4 `fetchMyReports`, `readSeenReplies`, `markReplySeen`.

- [ ] **Step 1: 컴포넌트 작성**

Create `src/components/AppReportReplyPopup.jsx`:

```js
import { useEffect, useState } from 'react';
import { fetchMyReports, readSeenReplies, markReplySeen } from '../lib/appReport';

// ntc-* 클래스는 home.css(index.css 가 전역 @import)에 있다 — NoticePopup 과 동일하게 별도 import 불필요.
const STATUS_LABEL = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

// 앱 접속 시, 내가 낸 리포트에 새 답변이 있으면 공지처럼 한 번 띄운다(NoticePopup 과 같은 톤).
// 한 번 본 답변은 기기(localStorage)에 기록되어 다시 뜨지 않는다.
export default function AppReportReplyPopup() {
  const [replies, setReplies] = useState([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const items = await fetchMyReports();
        if (!active) return;
        const seen = new Set(readSeenReplies());
        setReplies(items.filter((i) => i.reply && !seen.has(i.id)));
      } catch { /* 오프라인 등 — 다음 진입 때 */ }
    })();
    return () => { active = false; };
  }, []);

  if (replies.length === 0) return null;

  function close() {
    markReplySeen(replies.map((r) => r.id));
    setReplies([]);
  }

  return (
    <div className="ntc-overlay" onClick={close}>
      <div className="ntc-modal" role="dialog" aria-modal="true" aria-label="문의 답변" onClick={(e) => e.stopPropagation()}>
        <div className="ntc-head">
          <h3 className="ntc-title">📬 문의하신 문제에 답변이 도착했어요</h3>
          <button className="ntc-x" onClick={close} aria-label="닫기">✕</button>
        </div>
        <div className="ntc-list">
          {replies.map((r) => (
            <article key={r.id} className="ntc-item">
              <div className="ntc-item-head">
                <strong className="ntc-item-title">{STATUS_LABEL[r.replyStatus] || '답변'}</strong>
              </div>
              <p className="ntc-content ar-pop-q">“{r.text}”</p>
              <p className="ntc-content">{r.reply}</p>
            </article>
          ))}
        </div>
        <button className="btn-add btn-block" onClick={close}>확인</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `ar-pop-q` 스타일을 `home.css` 에 추가**

`.ntc-*` 는 `src/styles/home.css`(824줄~)에 있다. 그 블록 끝(`.ntc-item-title` 다음 줄들 뒤)에 추가:

```css
/* 앱 리포트 답변 팝업: 원래 질문 인용 */
.ar-pop-q { color: var(--text-3); font-size: 0.78rem; font-style: italic; }
```

- [ ] **Step 3: Home.jsx — 팝업 렌더**

Find [Home.jsx:6](../../../src/pages/Home.jsx#L6) area imports and add:

```js
import NoticePopup from '../components/NoticePopup';
```

→ add a line after it:

```js
import NoticePopup from '../components/NoticePopup';
import AppReportReplyPopup from '../components/AppReportReplyPopup';
```

Find `<NoticePopup />` in the render (near the top of the returned JSX):

```jsx
      <NoticePopup />
```

Replace with:

```jsx
      <NoticePopup />
      <AppReportReplyPopup />
```

- [ ] **Step 4: Home.jsx — 검열 링크 텍스트 제거**

Find [Home.jsx:385](../../../src/pages/Home.jsx#L385):

```jsx
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link">🧹 검열</Link>}
```

Replace with:

```jsx
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link" title="검열" aria-label="검열">🧹</Link>}
```

- [ ] **Step 5: 빌드 + 커밋**

```bash
npm run build
git add src/components/AppReportReplyPopup.jsx src/styles/notice.css src/pages/Home.jsx
git commit -m "feat: app-report reply popup on home; collapse 검열 link to icon only

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: 프론트 — Moderation "앱 문제" 탭 답변 UI

**Files:**
- Modify: `src/pages/Moderation.jsx`

**Interfaces:**
- Consumes: admin actions `reply_app_report`, `list_replied_app_reports` (Task 2).

- [ ] **Step 1: 상태 + batch 로드**

Find [Moderation.jsx:191](../../../src/pages/Moderation.jsx#L191):

```js
  const [appReports, setAppReports] = useState([]); // 앱 문제 리포트(pending)
```

Replace with:

```js
  const [appReports, setAppReports] = useState([]); // 앱 문제 리포트(pending)
  const [repliedReports, setRepliedReports] = useState([]); // 답변한 리포트
```

Find [Moderation.jsx:200-207](../../../src/pages/Moderation.jsx#L200):

```js
    const [r, rc, rr, ra, rd, rap] = await callBatch([
      { action: 'list_recent', payload: { limit: 100 } },
      { action: 'list_corrections', payload: { status: 'pending' } },
      { action: 'list_reported' },
      { action: 'list_auto_notices' },
      { action: 'list_deleted' },
      { action: 'list_app_reports' },
    ]);
```

Replace with:

```js
    const [r, rc, rr, ra, rd, rap, rrep] = await callBatch([
      { action: 'list_recent', payload: { limit: 100 } },
      { action: 'list_corrections', payload: { status: 'pending' } },
      { action: 'list_reported' },
      { action: 'list_auto_notices' },
      { action: 'list_deleted' },
      { action: 'list_app_reports' },
      { action: 'list_replied_app_reports' },
    ]);
```

Find [Moderation.jsx:213](../../../src/pages/Moderation.jsx#L213):

```js
    if (rap.ok) setAppReports(rap.data.items ?? []);
```

Replace with:

```js
    if (rap.ok) setAppReports(rap.data.items ?? []);
    if (rrep.ok) setRepliedReports(rrep.data.items ?? []);
```

Find [Moderation.jsx:225-230](../../../src/pages/Moderation.jsx#L225) (the snapshot save):

```js
      if (rc.ok && rr.ok && ra.ok && rd.ok && rap.ok) {
        kvSet('mod:snapshot', {
          items: withFlags, corrs: rc.data.items ?? [], reported: rr.data.items ?? [],
          autos: ra.data.items ?? [], deleted: rd.data.items ?? [], appReports: rap.data.items ?? [],
          reviewedAt: r.data.reviewedAt ?? null,
        });
      }
```

Replace with:

```js
      if (rc.ok && rr.ok && ra.ok && rd.ok && rap.ok && rrep.ok) {
        kvSet('mod:snapshot', {
          items: withFlags, corrs: rc.data.items ?? [], reported: rr.data.items ?? [],
          autos: ra.data.items ?? [], deleted: rd.data.items ?? [], appReports: rap.data.items ?? [],
          repliedReports: rrep.data.items ?? [],
          reviewedAt: r.data.reviewedAt ?? null,
        });
      }
```

Find [Moderation.jsx:250-252](../../../src/pages/Moderation.jsx#L250) (snapshot restore):

```js
      setAutos(c.autos ?? []); setDeleted(c.deleted ?? []); setAppReports(c.appReports ?? []);
```

Replace with:

```js
      setAutos(c.autos ?? []); setDeleted(c.deleted ?? []); setAppReports(c.appReports ?? []);
      setRepliedReports(c.repliedReports ?? []);
```

- [ ] **Step 2: 답변 핸들러**

Find `ackAppReport` [Moderation.jsx:340-343](../../../src/pages/Moderation.jsx#L340):

```js
  async function ackAppReport(it) {
    const r = await call('ack_app_report', { id: it.id });
    if (r.ok) setAppReports((prev) => prev.filter((x) => x.id !== it.id));
  }
```

Insert **after** it:

```js
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
```

- [ ] **Step 3: 카드 UI — 답변 폼 + '답변함' 구획**

Find the appreports tab block [Moderation.jsx:616-642](../../../src/pages/Moderation.jsx#L616):

```jsx
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
```

Replace with:

```jsx
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
```

- [ ] **Step 4: `AppReportCard` 컴포넌트 + 라벨 상수**

Find the end of the `Moderation` component (the `editableText` helper at [Moderation.jsx:647-651](../../../src/pages/Moderation.jsx#L647)):

```js
// 수정 대상 텍스트(편집 가능한 필드)
function editableText(it) {
  return it.text || '';
}
```

Insert **before** it:

```js
const REPLY_STATUS_LABEL = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

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
```

- [ ] **Step 5: `useState` import 확인 + CSS**

`Moderation.jsx` 상단은 `import { useCallback, useEffect, useMemo, useRef, useState } from 'react'` 형태 — `useState` 이미 있음(확인만). `AppReportCard` 가 파일 스코프 함수이므로 문제 없음.

`mod-*` 스타일은 `src/styles/admin.css` 에 있다. 그 파일 끝에 추가:

```css
.ar-reply-ta { width: 100%; margin: 0.4rem 0; font: inherit; padding: 0.4rem 0.5rem; border: 1px solid var(--border); border-radius: var(--r-sm); resize: vertical; }
.mod-subhead { margin: 1.2rem 0 0.5rem; font-size: 0.85rem; color: var(--text-2); }
```

- [ ] **Step 6: 빌드 + 커밋**

```bash
npm run build
git add src/pages/Moderation.jsx src/styles/admin.css
git commit -m "feat: moderation app-report tab — reply form, status, 답변함 section

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: SW — `app_report_reply` kind + 버전 범프

**Files:**
- Modify: `public/push-sw.js`
- Modify: `vite.config.js`

- [ ] **Step 1: `showPush` — app_report_reply 를 서버-텍스트 kind 로**

Find [push-sw.js:146-148](../../../public/push-sw.js#L146):

```js
  // 관리자 알림(수정제안·신고삭제·자동반영·앱문제리포트) — 제목·본문을 서버가 직접 실어 보낸다.
  const ADMIN_KINDS = ['correction', 'auto_correction', 'report_deleted', 'app_report'];
  const admin = ADMIN_KINDS.includes(msg.kind);
```

Replace with:

```js
  // 제목·본문을 서버가 직접 실어 보내는 알림(관리자 알림 + 앱 리포트 답변).
  const ADMIN_KINDS = ['correction', 'auto_correction', 'report_deleted', 'app_report', 'app_report_reply'];
  const admin = ADMIN_KINDS.includes(msg.kind);
```

Find [push-sw.js:151-152](../../../public/push-sw.js#L151):

```js
  const title = admin ? (msg.title || '🔔 관리자 알림')
    : hot ? '🔥 인기글이 나왔어요' : commentTitle(msg.kind, reason, msg.title);
```

Replace with:

```js
  const title = admin ? (msg.title || (msg.kind === 'app_report_reply' ? '📬 문의 답변' : '🔔 관리자 알림'))
    : hot ? '🔥 인기글이 나왔어요' : commentTitle(msg.kind, reason, msg.title);
```

- [ ] **Step 2: `vite.config.js` 버전 범프**

Find [vite.config.js:63](../../../vite.config.js#L63):

```js
        importScripts: ['push-sw.js?v=11'],
```

Replace with:

```js
        importScripts: ['push-sw.js?v=12'],
```

- [ ] **Step 3: 빌드 + 커밋**

```bash
npm run build
git add public/push-sw.js vite.config.js
git commit -m "feat: SW handles app_report_reply push (server-supplied title/body); bump sw v12

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: 통합 검증 + 배포

- [ ] **Step 1: 전체 빌드 + functions 문법**

```bash
npm run build
node --check firebase/functions/index.js
node --check firebase/functions/src/appReport.js
node --check firebase/functions/src/admin.js
node --check firebase/functions/src/admin/moderationActions.js
```

모두 성공/무출력이어야 한다.

- [ ] **Step 2: 배포**

```bash
git status            # 클린 확인
git push origin main
```

- **Firebase**: `firebase/**` 변경(appReport.js, admin.js, moderationActions.js, index.js) → `deploy-firebase.yml`. GitHub Actions 성공 + `getMyAppReports`·`purgeAppReports` 생성 로그 확인.
  ```bash
  gh run list --limit 3
  gh run watch <id> --exit-status
  ```
- **Cloudflare Pages**: 같은 push 에 프론트 자동 재빌드(push-sw.js v12 포함).

- [ ] **Step 3: 배포 후 실기기 확인**

1. 일반 계정 🚩 → 리포트 제출 → "접수되었습니다" + 모달 하단 '내가 보낸 리포트'에 "검토 중"으로 등장.
2. 관리자 → 검열 → 앱 문제 탭 → 그 리포트에 답변 입력 + 상태 '해결됨' → "답변 보내기" → pending 목록에서 사라지고 '답변함'에 나타남.
3. 리포트 낸 기기에서 앱 재진입(홈) → 📬 팝업 표시(원문 + 답변 + '해결됨') → 확인 → 재진입해도 안 뜸.
4. 🚩 모달 다시 열기 → '내가 보낸 리포트'에 답변 계속 보임.
5. 푸시 구독 상태로 제출한 계정: 답변 시 그 기기에 "📬 문의 답변" 푸시 1건.
6. 홈 헤더: 관리자에게 `🧹` 아이콘만(텍스트 없음).

- [ ] **Step 4: 스펙 갱신 + 커밋 + 푸시**

`docs/superpowers/specs/2026-09-03-app-report-reply-design.md` 하단에:

```markdown
## 구현

2026-09-03 구현·배포 완료. 계획: `docs/superpowers/plans/2026-09-03-app-report-reply.md`.
```

```bash
git add docs/superpowers/specs/2026-09-03-app-report-reply-design.md
git commit -m "docs: mark app-report-reply spec implemented

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| 스펙 항목 | Task |
|---|---|
| `appReports` 필드(subId/reply/replyStatus/repliedAt) | 1 |
| `submitAppReport` endpoint→subId + id 반환 | 1 |
| `getMyAppReports` | 1 |
| `reply_app_report` + 푸시 | 2 |
| `list_replied_app_reports` | 2 |
| `adminAction` 시크릿 바인딩 | 2 |
| `purgeAppReports` 월간 | 3 |
| `src/lib/appReport.js` 기기 상태 | 4 |
| AppReportModal 제출 경로 + 내 리포트 목록 | 5 |
| AppReportReplyPopup(공지 팝업) + 홈 배선 | 6 |
| 🧹 검열 텍스트 제거 | 6 |
| Moderation 답변 UI + 답변함 | 7 |
| SW `app_report_reply` + v12 | 8 |
| Rules 변경 없음 | Global Constraints |

**Placeholder scan:** Task 6 Step 2 / Task 7 Step 5 는 스타일시트 파일명을 `grep`으로 확정하라고 지시(파셜 분할이 파일마다 달라 정확 경로를 못 박음) — 그 외 코드는 완전.

**Type consistency:**
- `submitAppReport` 반환 `{ status, id }` — Task 1 정의, Task 4 `submitReport`가 `r.data.id` 사용. 일치.
- `getMyAppReports` items `{ id, text, status, reply, replyStatus, repliedAt }` — Task 1 정의, Task 4 `fetchMyReports`·Task 5·Task 6 소비. 일치.
- `reply_app_report({ id, reply, replyStatus })` — Task 2 정의, Task 7 `replyToAppReport` 호출. `replyStatus` 3값(`reviewing`/`resolved`/`planned`) — Task 2 `REPLY_STATUSES`, Task 5·6 `STATUS_LABEL`, Task 7 `REPLY_STATUS_LABEL`·`<select>` 옵션 전부 동일 3값. 일치.
- `kind: 'app_report_reply'` — Task 2 발신, Task 8 SW 수신. 일치.
- `subId` (sha256 hex) — Task 1 저장(`subscriptionId`), Task 2 `pushSubscriptions/{subId}` 조회. push.js 의 `subscriptionId` 와 동일 정의(sha256(endpoint) hex). 일치.
