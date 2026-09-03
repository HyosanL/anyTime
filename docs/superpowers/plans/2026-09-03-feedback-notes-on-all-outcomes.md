# 모든 처리 결과에 관리자 메모 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 제출자에게 도달하는 모든 모더레이션 결과(수정 제안 적용/정리/반려, 신고글 삭제/수정/무시)에 선택적 관리자 메모를 붙일 수 있게 한다.

**Architecture:** 기존 `corrections.reply` / `reportDismissReason` 브레드크럼 패턴을 확장한다. 새 컬렉션·색인 없음. 관리자 메모는 Admin SDK 함수만 쓰는 필드로 저장되고, 익명 유지 CF `getMyFeedback` 가 제출 기기에 되돌려 준다. 신고글 수정은 새 결과 상태 `edited` 로, 신고 맥락 삭제는 `archiveDeleted` 로 복구 가능하게 바뀐다.

**Tech Stack:** React 19 + Vite, Firebase Cloud Functions v2 (Node 22), Cloudflare Pages. 테스트 프레임워크 없음 — `node --check` + `npm run build` + 배포 후 실기기.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-09-03-feedback-notes-on-all-outcomes-design.md`.
- 익명성 하드룰 [[board-full-anonymity]] — `corrections` 에 uid 저장 금지, 신고는 개별 문서 없음.
- 대화 한국어, 코드·주석·커밋 영어. 커밋 끝 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Firestore Rules·`firestore.indexes.json` 변경 없음 — 모든 신규 조회는 단일필드 쿼리 / `db.getAll` / `doc().get()`.
- `public/push-sw.js` 변경 없음 → `vite.config.js` 버전 토큰 그대로. `kind: 'feedback_reply'` 는 이미 `ADMIN_KINDS`.
- 메모 상한 300자, 트림. 없으면 `null` 저장.
- 색은 항상 `var(--token)`, CSS 는 `src/styles/` 파셜 [[design-system-tokens]].
- 배포: 함수는 `firebase deploy --only functions`, 프론트는 `git push origin main`(Cloudflare Pages Git 연동). 함수 먼저, 프론트 나중(둘 다 하위호환).

---

### Task 1: `archiveDeleted` — `adminNote` 선택 파라미터

**Files:**
- Modify: `firebase/functions/src/lib/archive.js`

**Interfaces:**
- Produces: `archiveDeleted(tx, db, { type, origId, label, text, reportCount, reason, snapshot, adminNote? })` — 문서에 `adminNote: adminNote ?? null` 추가 기록.

- [ ] **Step 1: `adminNote` 필드 추가**

Find [archive.js:13-27](../../../firebase/functions/src/lib/archive.js#L13):

```js
export function archiveDeleted(tx, db, { type, origId, label, text, reportCount, reason, snapshot }) {
  const ref = db.collection('deletedContent').doc();
  tx.set(ref, {
    type,
    origId,
    label,
    text,
    reportCount,
    reason,
    snapshot,
    reviewed: false,
    createdAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + THIRTY_DAYS_MS),
  });
  return ref.id;
}
```

Replace with:

```js
export function archiveDeleted(tx, db, { type, origId, label, text, reportCount, reason, snapshot, adminNote }) {
  const ref = db.collection('deletedContent').doc();
  tx.set(ref, {
    type,
    origId,
    label,
    text,
    reportCount,
    reason,
    snapshot,
    adminNote: adminNote ?? null, // 관리자가 신고글을 직접 삭제하며 남긴 메모(신고자에게 표시). 자동삭제 경로는 미전달 → null.
    reviewed: false,
    createdAt: FieldValue.serverTimestamp(),
    expireAt: new Date(Date.now() + THIRTY_DAYS_MS),
  });
  return ref.id;
}
```

- [ ] **Step 2: 구문 확인**

Run: `node --check firebase/functions/src/lib/archive.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add firebase/functions/src/lib/archive.js
git commit -m "feat: archiveDeleted accepts optional adminNote"
```

---

### Task 2: `applyCorrection` / `resolveCorrection` / `pushCorrectionOutcome` — 메모 전달

**Files:**
- Modify: `firebase/functions/src/admin/moderationActions.js:160-302`

**Interfaces:**
- Consumes: `corrections/{id}` 문서에 `reply` / `repliedAt` / `subId` (이미 존재).
- Produces:
  - `applyCorrection({ id, reason? })` — `status:'applied'` 와 함께 `reply: reason||null` 저장.
  - `resolveCorrection({ ids, id?, reason? })` — 각 건 `status:'resolved'` + `reply: reason||null`.
  - `pushCorrectionOutcome(snap)` — `status`·`autoApplied`·`reply` 로 push title/body 분기.

- [ ] **Step 1: 메모 클램프 헬퍼 추가**

Find [moderationActions.js:21-23](../../../firebase/functions/src/admin/moderationActions.js#L21):

```js
function millis(ts) {
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0;
}
```

Replace with:

```js
function millis(ts) {
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0;
}

// 제출자에게 그대로 표시되는 관리자 메모: 트림, 300자 상한, 빈 값은 null.
function noteOf(payload) {
  return payload.reason != null ? (String(payload.reason).trim().slice(0, 300) || null) : null;
}
```

- [ ] **Step 2: `rejectCorrection` 를 `noteOf` 로 정리**

Find [moderationActions.js:160-170](../../../firebase/functions/src/admin/moderationActions.js#L160):

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

Replace with:

```js
async function rejectCorrection(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  const ref = db.collection('corrections').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'OK' };
  await ref.update({ status: 'rejected', reply: noteOf(payload), repliedAt: FieldValue.serverTimestamp() });
  await pushCorrectionOutcome(await ref.get());
  return { status: 'OK' };
}
```

- [ ] **Step 3: `applyCorrection` 에 `reply` 저장**

Find [moderationActions.js:172-193](../../../firebase/functions/src/admin/moderationActions.js#L172):

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
    // 삭제 대신 'applied' 로 남겨 제출자에게 결과를 보여준다(purgeCorrections 가 30일 후 정리).
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

Replace with:

```js
async function applyCorrection(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  const note = noteOf(payload);
  // 실제 반영 로직은 corrections.js(applyCorrectionRowInternal) 에 단일화 —
  // 관리자 수동적용과 자동반영(submitCorrection 경로)이 같은 코드를 쓴다.
  // catalogVersion 증가는 applyCorrectionRowInternal 내부 markApplied() 가 이미
  // 처리한다(확인됨) — 이 함수는 반영 후 큐(correction 문서) 정리만 담당한다.
  const status = await db.runTransaction(async (tx) => {
    const st = await applyCorrectionRowInternal(tx, db, id);
    // 삭제 대신 'applied' 로 남겨 제출자에게 결과를 보여준다(purgeCorrections 가 30일 후 정리).
    if (st === 'OK' || st === 'ALREADY_DONE') {
      tx.update(db.collection('corrections').doc(id),
        { status: 'applied', reply: note, repliedAt: FieldValue.serverTimestamp() });
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

- [ ] **Step 4: `resolveCorrection` 에 `reply` 저장**

Find [moderationActions.js:197-209](../../../firebase/functions/src/admin/moderationActions.js#L197):

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

Replace with:

```js
async function resolveCorrection(uid, payload) {
  const ids = Array.isArray(payload.ids) ? payload.ids : (payload.id != null ? [payload.id] : []);
  if (!ids.length) return { status: 'OK' };
  const note = noteOf(payload);
  const refs = ids.map((id) => db.collection('corrections').doc(String(id)));
  const snaps = await db.getAll(...refs);
  const batch = db.batch();
  for (const s of snaps) {
    if (s.exists) batch.update(s.ref, { status: 'resolved', reply: note, repliedAt: FieldValue.serverTimestamp() });
  }
  await batch.commit();
  // reply 를 갓 쓴 최신본으로 푸시 문구를 만든다.
  const fresh = await db.getAll(...snaps.filter((s) => s.exists).map((s) => s.ref));
  for (const s of fresh) await pushCorrectionOutcome(s);
  return { status: 'OK' };
}
```

- [ ] **Step 5: `pushCorrectionOutcome` 문구 분기**

Find [moderationActions.js:289-302](../../../firebase/functions/src/admin/moderationActions.js#L289):

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

Replace with:

```js
// 수정 제안 결과를 제출 기기에 알린다(subId 있을 때). 실패는 삼킨다.
async function pushCorrectionOutcome(snap) {
  const subId = snap.get('subId');
  if (!subId) return;
  const status = snap.get('status');
  const autoApplied = snap.get('autoApplied') === true;
  const reply = (snap.get('reply') || '').trim();
  const title = status === 'rejected' ? '🔎 제안 검토 결과'
    : (status === 'applied' && autoApplied) ? '📌 제안이 자동 반영됐어요'
    : status === 'applied' ? '✅ 제안이 반영됐어요'
    : '✅ 제안 처리 완료'; // resolved
  const fallback = status === 'rejected' ? '보내주신 수정 제안을 검토했어요.'
    : status === 'applied' ? '보내주신 수정 제안이 반영됐어요.'
    : '보내주신 수정 제안을 확인하고 처리했어요.';
  const body = reply ? (reply.length > 80 ? `${reply.slice(0, 80)}…` : reply) : fallback;
  try {
    const subSnap = await db.collection('pushSubscriptions').doc(subId).get();
    if (!subSnap.exists) return;
    await pushFanout(pushFanoutUrl.value(), pushFanoutSecret.value(),
      { kind: 'feedback_reply', title, body, path: '/' },
      [{ endpoint: subSnap.get('endpoint'), p256dh: subSnap.get('p256dh'), auth: subSnap.get('auth') }]);
  } catch (e) {
    console.error('[pushCorrectionOutcome] push failed', e);
  }
}
```

- [ ] **Step 6: 구문 확인**

Run: `node --check firebase/functions/src/admin/moderationActions.js`
Expected: no output (exit 0)

- [ ] **Step 7: Commit**

```bash
git add firebase/functions/src/admin/moderationActions.js
git commit -m "feat: apply/resolve corrections carry an optional note to the submitter"
```

---

### Task 3: `editPost` / `deletePost` — 신고 맥락에 메모·아카이브

**Files:**
- Modify: `firebase/functions/src/admin/moderationActions.js:705-750`

**Interfaces:**
- Consumes: `archiveDeleted(..., { adminNote })` (Task 1). `REPORTABLE_COLLECTIONS` 상수(이미 존재).
- Produces:
  - `editPost({ table, id, fields, reason?, postId? })` — `table ∈ {review,class_memo,board_post}` & `reportCount>0` 이면 같은 update 에 `reportEditNote`/`reportEditedAt`/`reportCount:0`/`reportReviewedCount:0` 병합.
  - `deletePost({ table, id, reason?, postId? })` — `table ∈ {review,class_memo,board_post}` & (`reason` 있음 or `reportCount>0`) 이면 `archiveDeleted(reason:'admin', adminNote)` 후 삭제.

- [ ] **Step 1: `archiveDeleted` import 추가**

Find [moderationActions.js:1-5](../../../firebase/functions/src/admin/moderationActions.js#L1):

```js
import { FieldPath } from 'firebase-admin/firestore';
import { db, FieldValue, invalid } from '../lib/context.js';
import { applyCorrectionRowInternal } from '../corrections.js';
import { pushFanout } from '../lib/pushFanout.js';
import { pushFanoutUrl, pushFanoutSecret } from '../lib/secrets.js';
```

Replace with:

```js
import { FieldPath } from 'firebase-admin/firestore';
import { db, FieldValue, invalid } from '../lib/context.js';
import { applyCorrectionRowInternal } from '../corrections.js';
import { archiveDeleted } from '../lib/archive.js';
import { pushFanout } from '../lib/pushFanout.js';
import { pushFanoutUrl, pushFanoutSecret } from '../lib/secrets.js';
```

- [ ] **Step 2: `deletePost` — 신고 맥락이면 아카이브**

Find [moderationActions.js:705-726](../../../firebase/functions/src/admin/moderationActions.js#L705):

```js
async function deletePost(uid, payload) {
  const table = String(payload.table ?? '');
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');

  if (table === 'board_comment') {
    const postId = String(payload.postId ?? '');
    if (!postId) invalid('게시글 정보가 필요합니다.');
    const postRef = db.collection('boardPosts').doc(postId);
    const snap = await postRef.collection('comments').doc(id).get();
    if (!snap.exists) return { status: 'OK' };
    await deleteCommentTree(postRef, id);
    return { status: 'OK' };
  }

  const collectionName = POST_COLLECTIONS[table];
  if (!collectionName) invalid('알 수 없는 게시물 종류입니다.');
  // board_post/review/exam_archive 삭제는 recursiveDelete 한 번으로 _private·
  // comments·events·reactions·watchers 서브컬렉션까지 함께 제거된다.
  await db.recursiveDelete(db.collection(collectionName).doc(id));
  return { status: 'OK' };
}
```

Replace with:

```js
// 관리자 메모가 붙거나 신고 누적分을 지우는 삭제는 복구 가능하게 아카이브한다.
// (exam_archive·board_comment 는 신고 대상이 아니라 제외 — 항상 맨 삭제.)
const ARCHIVE_ON_DELETE = new Set(['review', 'class_memo', 'board_post']);

function archiveTextOf(table, data) {
  if (table === 'board_post') return [data.title, data.content].filter(Boolean).join(' — ') || null;
  if (table === 'review') return [data.profComment, data.courseComment].filter(Boolean).join(' / ') || null;
  return data.content ?? null; // class_memo
}

async function deletePost(uid, payload) {
  const table = String(payload.table ?? '');
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  const note = noteOf(payload);

  if (table === 'board_comment') {
    const postId = String(payload.postId ?? '');
    if (!postId) invalid('게시글 정보가 필요합니다.');
    const postRef = db.collection('boardPosts').doc(postId);
    const snap = await postRef.collection('comments').doc(id).get();
    if (!snap.exists) return { status: 'OK' };
    await deleteCommentTree(postRef, id);
    return { status: 'OK' };
  }

  const collectionName = POST_COLLECTIONS[table];
  if (!collectionName) invalid('알 수 없는 게시물 종류입니다.');
  const ref = db.collection(collectionName).doc(id);

  if (ARCHIVE_ON_DELETE.has(table)) {
    const snap = await ref.get();
    if (snap.exists && (note || (snap.get('reportCount') ?? 0) > 0)) {
      const data = snap.data();
      let label = data.courseCode ?? '';
      if (table === 'board_post') {
        const bs = await db.collection('boards').doc(String(data.boardId ?? '')).get();
        label = bs.exists ? bs.get('name') : '게시판';
      }
      await db.runTransaction(async (tx) => {
        archiveDeleted(tx, db, {
          type: table,
          origId: id,
          label,
          text: archiveTextOf(table, data),
          reportCount: data.reportCount ?? 0,
          reason: 'admin',
          adminNote: note,
          snapshot: { id, ...data },
        });
        tx.delete(ref);
      });
      await db.recursiveDelete(ref); // tx 밖 서브컬렉션 잔여분
      return { status: 'OK' };
    }
  }

  // board_post/review/exam_archive 삭제는 recursiveDelete 한 번으로 _private·
  // comments·events·reactions·watchers 서브컬렉션까지 함께 제거된다.
  await db.recursiveDelete(ref);
  return { status: 'OK' };
}
```

- [ ] **Step 3: `editPost` — 신고글이면 수정 조치 브레드크럼**

Find [moderationActions.js:728-750](../../../firebase/functions/src/admin/moderationActions.js#L728):

```js
async function editPost(uid, payload) {
  const table = String(payload.table ?? '');
  const id = String(payload.id ?? '');
  const allow = EDITABLE_FIELDS[table];
  if (!allow) invalid('알 수 없는 게시물 종류입니다.');
  if (!id) invalid('id가 필요합니다.');
  const fields = payload.fields ?? {};
  const patch = {};
  for (const k of allow) if (k in fields) patch[k] = fields[k];
  if (!Object.keys(patch).length) invalid('수정할 내용이 없습니다.');

  if (table === 'board_comment') {
    const postId = String(payload.postId ?? ''); // deletePost 와 같은 이유로 postId 필요
    if (!postId) invalid('게시글 정보가 필요합니다.');
    await db.collection('boardPosts').doc(postId).collection('comments').doc(id).update(patch);
    return { status: 'OK' };
  }

  const collectionName = POST_COLLECTIONS[table];
  if (!collectionName) invalid('알 수 없는 게시물 종류입니다.');
  await db.collection(collectionName).doc(id).update(patch);
  return { status: 'OK' };
}
```

Replace with:

```js
async function editPost(uid, payload) {
  const table = String(payload.table ?? '');
  const id = String(payload.id ?? '');
  const allow = EDITABLE_FIELDS[table];
  if (!allow) invalid('알 수 없는 게시물 종류입니다.');
  if (!id) invalid('id가 필요합니다.');
  const fields = payload.fields ?? {};
  const patch = {};
  for (const k of allow) if (k in fields) patch[k] = fields[k];
  if (!Object.keys(patch).length) invalid('수정할 내용이 없습니다.');

  if (table === 'board_comment') {
    const postId = String(payload.postId ?? ''); // deletePost 와 같은 이유로 postId 필요
    if (!postId) invalid('게시글 정보가 필요합니다.');
    await db.collection('boardPosts').doc(postId).collection('comments').doc(id).update(patch);
    return { status: 'OK' };
  }

  const collectionName = POST_COLLECTIONS[table];
  if (!collectionName) invalid('알 수 없는 게시물 종류입니다.');
  const ref = db.collection(collectionName).doc(id);

  // 신고 누적 중인 글을 관리자가 직접 고쳤다면: 그 신고의 결과를 '수정 조치' 로 남기고
  // (신고자가 getMyFeedback 으로 조회) 신고 큐에서 뺀다. reportDismissedAt 과 같은 패턴.
  if (ARCHIVE_ON_DELETE.has(table)) {
    const snap = await ref.get();
    if (snap.exists && (snap.get('reportCount') ?? 0) > 0) {
      patch.reportEditNote = noteOf(payload);
      patch.reportEditedAt = FieldValue.serverTimestamp();
      patch.reportCount = 0;
      patch.reportReviewedCount = 0;
    }
  }

  await ref.update(patch);
  return { status: 'OK' };
}
```

- [ ] **Step 4: 구문 확인**

Run: `node --check firebase/functions/src/admin/moderationActions.js`
Expected: no output (exit 0)

- [ ] **Step 5: Commit**

```bash
git add firebase/functions/src/admin/moderationActions.js
git commit -m "feat: reported-content edit/delete carry a note and archive for recovery"
```

---

### Task 4: `getMyFeedback` — `edited` 결과 + `note` 통일

**Files:**
- Modify: `firebase/functions/src/feedback.js:37-59`

**Interfaces:**
- Consumes: `reviews`/`classMemos`/`boardPosts` 의 `reportEditedAt`/`reportEditNote`/`reportDismissedAt`/`reportDismissReason`; `deletedContent.adminNote` (Task 1·3).
- Produces: `contentReports` 항목 `{ type, id, outcome: 'removed'|'edited'|'kept', note: string|null }` — `reason` 필드 제거.

- [ ] **Step 1: `lookupContentReports` 분기 교체**

Find [feedback.js:37-59](../../../firebase/functions/src/feedback.js#L37):

```js
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
```

Replace with:

```js
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
    // note = 관리자가 남긴 자유 문구(있으면). removed 의 delSnap.reason 은 자동삭제 코드라 노출 안 함.
    if (!delSnap.empty) {
      out.push({ type, id, outcome: 'removed', note: delSnap.docs[0].get('adminNote') ?? null });
    } else if (!docSnap.exists) {
      out.push({ type, id, outcome: 'removed', note: null }); // 작성자 자삭 — 신고자엔 '사라짐'으로 동일
    } else if (docSnap.get('reportEditedAt')) {
      out.push({ type, id, outcome: 'edited', note: docSnap.get('reportEditNote') ?? null });
    } else if (docSnap.get('reportDismissedAt')) {
      out.push({ type, id, outcome: 'kept', note: docSnap.get('reportDismissReason') ?? null });
    }
    // else: pending — 알리지 않으므로 넣지 않는다
  }
  return out;
}
```

- [ ] **Step 2: 구문 확인**

Run: `node --check firebase/functions/src/feedback.js`
Expected: no output (exit 0)

- [ ] **Step 3: Commit**

```bash
git add firebase/functions/src/feedback.js
git commit -m "feat: getMyFeedback reports 'edited' outcome; unify admin text as note"
```

---

### Task 5: `FeedbackPopup` — 메모 줄 렌더 + `edited`

**Files:**
- Modify: `src/components/FeedbackPopup.jsx`
- Modify: `src/styles/home.css:855`

**Interfaces:**
- Consumes: `fetchFeedback()` → `corrections[].reply`, `contentReports[].outcome`(`removed`|`edited`|`kept`)·`.note`.
- Produces: 라인 객체 `{ key, badge, q, a, note }`.

- [ ] **Step 1: 라인 빌더 + 렌더 교체**

Find [FeedbackPopup.jsx:7-24](../../../src/components/FeedbackPopup.jsx#L7):

```js
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
```

Replace with:

```js
function appReportLine(it) {
  return { key: `appReport:${it.id}`, badge: APP_STATUS[it.replyStatus] || '답변',
    q: it.summary, a: it.reply, note: null };
}
function correctionLine(it) {
  const a = it.status === 'applied' && it.autoApplied ? '📌 여러 명이 같은 제안을 해서 자동 반영됐어요.'
    : it.status === 'applied' ? '✅ 제안이 반영됐어요.'
    : it.status === 'rejected' ? '🔎 검토했지만 이번엔 반영하지 않았어요.'
    : it.status === 'resolved' ? '✅ 확인 후 처리했어요.'
    : null;
  return a ? { key: `correction:${it.id}`, badge: '수정 제안', q: it.summary, a, note: it.reply || null } : null;
}
function contentLine(it) {
  const a = it.outcome === 'removed' ? '🗑️ 신고하신 내용이 삭제 조치됐어요.'
    : it.outcome === 'edited' ? '✏️ 신고하신 내용이 수정 조치됐어요.'
    : it.outcome === 'kept' ? (it.note ? '검토 결과 유지됩니다.' : '검토 결과 규정 위반이 아니라 유지됩니다.')
    : null;
  return a ? { key: `content:${it.type}_${it.id}`, badge: '신고', q: '', a, note: it.note || null } : null;
}
```

- [ ] **Step 2: `note` 줄 렌더**

Find [FeedbackPopup.jsx:62-70](../../../src/components/FeedbackPopup.jsx#L62):

```jsx
          {lines.map((l) => (
            <article key={l.key} className="ntc-item">
              <div className="ntc-item-head">
                <strong className="ntc-item-title">{l.badge}</strong>
              </div>
              {l.q && <p className="ntc-content ar-pop-q">“{l.q}”</p>}
              <p className="ntc-content">{l.a}</p>
            </article>
          ))}
```

Replace with:

```jsx
          {lines.map((l) => (
            <article key={l.key} className="ntc-item">
              <div className="ntc-item-head">
                <strong className="ntc-item-title">{l.badge}</strong>
              </div>
              {l.q && <p className="ntc-content ar-pop-q">“{l.q}”</p>}
              <p className="ntc-content">{l.a}</p>
              {l.note && <p className="ntc-content ar-pop-note">↳ {l.note}</p>}
            </article>
          ))}
```

- [ ] **Step 3: `.ar-pop-note` 스타일**

Find [home.css:854-855](../../../src/styles/home.css#L854):

```css
/* 앱 리포트 답변 팝업: 원래 질문 인용 */
.ar-pop-q { color: var(--text-3); font-size: 0.78rem; font-style: italic; }
```

Replace with:

```css
/* 앱 리포트 답변 팝업: 원래 질문 인용 */
.ar-pop-q { color: var(--text-3); font-size: 0.78rem; font-style: italic; }
/* 관리자가 결과에 덧붙인 메모 */
.ar-pop-note { color: var(--text-2); font-size: 0.82rem; padding-left: 0.15rem; border-left: 2px solid var(--border); padding-left: 0.5rem; }
```

- [ ] **Step 4: Commit**

```bash
git add src/components/FeedbackPopup.jsx src/styles/home.css
git commit -m "feat: FeedbackPopup shows the admin note line and 'edited' outcome"
```

---

### Task 6: `Moderation.jsx` — 수정 제안 카드 인라인 메모

**Files:**
- Modify: `src/pages/Moderation.jsx:363-390` (handlers), `:567-601` (검토 대기 렌더), 파일 하단(새 `CorrectionCard`)

**Interfaces:**
- Consumes: `call('apply_correction', { id, reason })`, `call('reject_correction', { id, reason })`, `groupCorrections` 그룹 `g` (`{ id, ids, target, field, label, count, suggested, note, createdAt }`), 모듈 헬퍼 `currentValue(cat, g)`·`fmtCorrAfter(g)`·`FIELD_LABEL`·`HIGH_RISK`·`editPath(g)`.
- Produces: `<CorrectionCard g cat fmtDateTime onApply onReject onEdit />`.

- [ ] **Step 1: `applyGroup` / `rejectGroup` 가 메모를 받도록**

Find [Moderation.jsx:363-384](../../../src/pages/Moderation.jsx#L363):

```js
  // ── 수정 제안: 그룹 단위 적용/반려 ──
  async function applyGroup(g) {
    for (const id of g.ids) {
      const r = await call('apply_correction', { id });
      // ALREADY_DONE(예: 분반추가인데 그 사이 이미 생성됨)은 정리된 것으로 보고 넘어간다.
      if (!r.ok && r.status !== 'ALREADY_DONE') { alert('적용 실패: ' + (r.status ?? '오류') + (r.status === 'BAD_TIME' ? ' (시간 형식 오류)' : '')); return; }
    }
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
    // 반영값이 카탈로그(교수·과목·시간)에 바로 보이도록 로컬 캐시 무효화(관리자 화면 즉시 확인용).
    clearCatalog().catch(() => {});
  }
  // 편집 페이지로 이동(제안 내용을 라우터 state 로 함께 넘겨 배너에 그린다).
  function openEdit(g) {
    const path = editPath(g);
    if (path) navigate(path, { state: { corr: { ...g } } });
  }
  async function rejectGroup(g) {
    const reason = prompt('반려 사유 (선택 — 제안자에게 그대로 표시됩니다. 비워도 반려됩니다)');
    if (reason === null) return;   // 취소
    for (const id of g.ids) await call('reject_correction', { id, reason: reason.trim() });
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
  }
```

Replace with:

```js
  // ── 수정 제안: 그룹 단위 적용/반려 (note = 제출자에게 표시될 관리자 메모, 선택) ──
  async function applyGroup(g, note) {
    for (const id of g.ids) {
      const r = await call('apply_correction', { id, reason: note });
      // ALREADY_DONE(예: 분반추가인데 그 사이 이미 생성됨)은 정리된 것으로 보고 넘어간다.
      if (!r.ok && r.status !== 'ALREADY_DONE') { alert('적용 실패: ' + (r.status ?? '오류') + (r.status === 'BAD_TIME' ? ' (시간 형식 오류)' : '')); return; }
    }
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
    // 반영값이 카탈로그(교수·과목·시간)에 바로 보이도록 로컬 캐시 무효화(관리자 화면 즉시 확인용).
    clearCatalog().catch(() => {});
  }
  // 편집 페이지로 이동(제안 내용을 라우터 state 로 함께 넘겨 배너에 그린다).
  function openEdit(g) {
    const path = editPath(g);
    if (path) navigate(path, { state: { corr: { ...g } } });
  }
  async function rejectGroup(g, note) {
    if (!confirm('이 제안을 반려할까요?')) return;
    for (const id of g.ids) await call('reject_correction', { id, reason: note });
    setCorrs((prev) => prev.filter((c) => !g.ids.includes(c.id)));
  }
```

- [ ] **Step 2: 검토 대기 렌더를 `CorrectionCard` 로**

Find [Moderation.jsx:572-601](../../../src/pages/Moderation.jsx#L572):

```jsx
            {corrGroups.map((g) => {
              const highRisk = HIGH_RISK.has(`${g.target}:${g.field}`) && g.count >= 3;
              return (
                <li key={`corr-${g.id}`} className={`card mod-card ${highRisk ? 'flagged' : ''}`}>
                  <div className="mod-card-top">
                    <span className="tag tag-primary mod-type">{g.target === 'section_add' ? '분반추가' : '수정제안'}</span>
                    <span className="mod-course">{g.label || g.target} · <span className="mod-corr-field">{FIELD_LABEL[g.field] || g.field}</span></span>
                    {g.count > 1 && <span className="tag mod-badge">동일 {g.count}건</span>}
                    {highRisk && <span className="tag tag-warn mod-badge">⚠ 검토 필요</span>}
                    <span className="mod-time">{fmtDateTime(g.createdAt)}</span>
                  </div>
                  <div className="mod-text">
                    <p className="mod-corr-diff">
                      <span className="mod-diff-label">현재</span>
                      <span className="mod-diff-before">{currentValue(cat, g) ?? '—'}</span>
                      <span className="mod-diff-arrow">→</span>
                      <span className="mod-diff-label">제안</span>
                      <b className="mod-diff-after">{g.suggested ? fmtCorrAfter(g) : '(제안값 없음)'}</b>
                    </p>
                    {g.note ? <p className="mod-corr-note">설명: {g.note}</p> : null}
                  </div>
                  <div className="mod-actions">
                    <button className="btn-add btn-sm" onClick={() => applyGroup(g)}>{g.target === 'section_add' ? '분반 생성' : '적용'}</button>
                    {editPath(g) && <button className="link-btn" onClick={() => openEdit(g)}>✏️ 편집에서 열기</button>}
                    <button className="rev-del-btn" onClick={() => rejectGroup(g)}>반려</button>
                  </div>
                </li>
              );
            })}
```

Replace with:

```jsx
            {corrGroups.map((g) => (
              <CorrectionCard key={`corr-${g.id}`} g={g} cat={cat} fmtDateTime={fmtDateTime}
                onApply={applyGroup} onReject={rejectGroup} onEdit={openEdit} />
            ))}
```

- [ ] **Step 3: `CorrectionCard` 컴포넌트 추가**

Find [Moderation.jsx:674-676](../../../src/pages/Moderation.jsx#L674) (the `AppReportCard` 바로 위):

```js
const REPLY_STATUS_LABEL = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

function AppReportCard({ it, onReply, onAck, fmtDateTime }) {
```

Replace with:

```js
const REPLY_STATUS_LABEL = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

// 제출자에게 그대로 전달되는 선택 메모. 적용/반려 어느 버튼을 눌러도 이 값이 실린다.
function ModMemo({ value, onChange }) {
  const [open, setOpen] = useState(!!value);
  if (!open) {
    return <button type="button" className="link-btn mod-memo-toggle" onClick={() => setOpen(true)}>↳ 제출자에게 메모</button>;
  }
  return (
    <textarea className="ar-reply-ta" rows={2} value={value} maxLength={300}
      placeholder="제출자에게 표시될 메모 (선택 — 예: '요일만 수정, 강의실은 그대로 두었어요')"
      onChange={(e) => onChange(e.target.value)} />
  );
}

function CorrectionCard({ g, cat, fmtDateTime, onApply, onReject, onEdit }) {
  const [note, setNote] = useState('');
  const highRisk = HIGH_RISK.has(`${g.target}:${g.field}`) && g.count >= 3;
  const memo = note.trim() || undefined;
  return (
    <li className={`card mod-card ${highRisk ? 'flagged' : ''}`}>
      <div className="mod-card-top">
        <span className="tag tag-primary mod-type">{g.target === 'section_add' ? '분반추가' : '수정제안'}</span>
        <span className="mod-course">{g.label || g.target} · <span className="mod-corr-field">{FIELD_LABEL[g.field] || g.field}</span></span>
        {g.count > 1 && <span className="tag mod-badge">동일 {g.count}건</span>}
        {highRisk && <span className="tag tag-warn mod-badge">⚠ 검토 필요</span>}
        <span className="mod-time">{fmtDateTime(g.createdAt)}</span>
      </div>
      <div className="mod-text">
        <p className="mod-corr-diff">
          <span className="mod-diff-label">현재</span>
          <span className="mod-diff-before">{currentValue(cat, g) ?? '—'}</span>
          <span className="mod-diff-arrow">→</span>
          <span className="mod-diff-label">제안</span>
          <b className="mod-diff-after">{g.suggested ? fmtCorrAfter(g) : '(제안값 없음)'}</b>
        </p>
        {g.note ? <p className="mod-corr-note">설명: {g.note}</p> : null}
      </div>
      <ModMemo value={note} onChange={setNote} />
      <div className="mod-actions">
        <button className="btn-add btn-sm" onClick={() => onApply(g, memo)}>{g.target === 'section_add' ? '분반 생성' : '적용'}</button>
        {editPath(g) && <button className="link-btn" onClick={() => onEdit(g)}>✏️ 편집에서 열기</button>}
        <button className="rev-del-btn" onClick={() => onReject(g, memo)}>반려</button>
      </div>
    </li>
  );
}

function AppReportCard({ it, onReply, onAck, fmtDateTime }) {
```

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: `✓ built in …` (no errors)

- [ ] **Step 5: Commit**

```bash
git add src/pages/Moderation.jsx
git commit -m "feat: correction moderation cards carry an inline note to the submitter"
```

---

### Task 7: `Moderation.jsx` — 신고 카드 인라인 메모 + 수정 조치

**Files:**
- Modify: `src/pages/Moderation.jsx:284-330` (handlers), `:500-534` (신고 탭 렌더), 파일 하단(새 `ReportCard`)

**Interfaces:**
- Consumes: `ModMemo` (Task 6), `call('delete_post'|'dismiss_report'|'edit_post', …)`, `TYPE_LABEL`·`contentPath(it)`·`editableText(it)`.
- Produces: `<ReportCard it fmtDateTime navigate onAck onDismiss onDelete onEdit />`.

- [ ] **Step 1: `remove` / `dismissReport` 가 메모를 받고, `editReported` 추가**

Find [Moderation.jsx:284-316](../../../src/pages/Moderation.jsx#L284):

```js
  // ── 게시글·댓글 / 신고 공통: 삭제 ──
  // board_comment 는 boardPosts/{postId}/comments/{id} 서브컬렉션이라 postId 가 있어야
  // 위치를 특정할 수 있다(옛 낱개 테이블 삭감이 아니라 Firestore 구조 차이에서 온 계약 확장).
  async function remove(it) {
    if (!confirm(`이 ${TYPE_LABEL[it.type]}을(를) 삭제할까요?`)) return;
    const payload = { table: it.type, id: it.id };
    if (it.type === 'board_comment') payload.postId = it.meta?.postId;
    const r = await call('delete_post', payload);
    if (r.ok) {
      setItems((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
      setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
    }
  }

  async function saveEdit() {
    const fields = (edit.type === 'class_memo' || edit.type === 'board_post' || edit.type === 'board_comment')
      ? { content: edit.text }
      : edit.type === 'exam_archive'
        ? { description: edit.text }
        : { courseComment: edit.text };
    const payload = { table: edit.type, id: edit.id, fields };
    if (edit.type === 'board_comment') payload.postId = edit.postId;
    const r = await call('edit_post', payload);
    if (r.ok) { setEdit(null); load(); }
  }

  // ── 신고: 무시(정상 처리) — 신고 수 초기화(담합·오신고 폭주 리셋용) ──
  async function dismissReport(it) {
    const reason = prompt('이 신고를 무시(정상 처리)합니다. 유지 사유 (선택 — 신고자에게 표시됩니다):');
    if (reason === null) return;   // 취소
    const r = await call('dismiss_report', { table: it.type, id: it.id, reason: reason.trim() });
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
  }
```

Replace with:

```js
  // ── 게시글·댓글 / 신고 공통: 삭제 ──
  // board_comment 는 boardPosts/{postId}/comments/{id} 서브컬렉션이라 postId 가 있어야
  // 위치를 특정할 수 있다(옛 낱개 테이블 삭감이 아니라 Firestore 구조 차이에서 온 계약 확장).
  // note = 신고자에게 표시될 메모(선택). 신고 맥락 삭제는 서버가 복구 가능하게 아카이브한다.
  async function remove(it, note) {
    if (!confirm(`이 ${TYPE_LABEL[it.type]}을(를) 삭제할까요?`)) return;
    const payload = { table: it.type, id: it.id };
    if (it.type === 'board_comment') payload.postId = it.meta?.postId;
    if (note && note.trim()) payload.reason = note.trim();
    const r = await call('delete_post', payload);
    if (r.ok) {
      setItems((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
      setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
    }
  }

  async function saveEdit() {
    const fields = (edit.type === 'class_memo' || edit.type === 'board_post' || edit.type === 'board_comment')
      ? { content: edit.text }
      : edit.type === 'exam_archive'
        ? { description: edit.text }
        : { courseComment: edit.text };
    const payload = { table: edit.type, id: edit.id, fields };
    if (edit.type === 'board_comment') payload.postId = edit.postId;
    if (edit.note && edit.note.trim()) payload.reason = edit.note.trim();
    const r = await call('edit_post', payload);
    if (r.ok) {
      setEdit(null);
      setReported((prev) => prev.filter((x) => !(x.type === edit.type && x.id === edit.id)));
      load();
    }
  }

  // ── 신고: 무시(정상 처리) — 신고 수 초기화(담합·오신고 폭주 리셋용) ──
  async function dismissReport(it, note) {
    if (!confirm('이 신고를 무시(정상 처리)할까요? 신고 수가 0으로 초기화됩니다.')) return;
    const payload = { table: it.type, id: it.id };
    if (note && note.trim()) payload.reason = note.trim();
    const r = await call('dismiss_report', payload);
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
  }
```

- [ ] **Step 2: 신고 탭 렌더를 `ReportCard` 로**

Find [Moderation.jsx:510-531](../../../src/pages/Moderation.jsx#L510):

```jsx
          {reported.map((it) => (
            <li key={`rep-${it.type}-${it.id}`} className="card mod-card flagged">
              <div className="mod-card-top">
                <span className="tag tag-primary mod-type">{TYPE_LABEL[it.type]}</span>
                <span className="mod-course">{it.courseCode}{it.meta?.sectionNo ? `·${it.meta.sectionNo}분반` : ''}</span>
                <span className="tag tag-warn mod-badge">🚨 신고 {it.reportCount}건</span>
                <span className="mod-time">{fmtDateTime(it.createdAt)}</span>
              </div>
              <p
                className={`mod-text${contentPath(it) ? ' mod-text-link' : ''}`}
                onClick={() => { const p = contentPath(it); if (p) navigate(p); }}
              >
                <Highlighted text={it.text || '(내용 없음)'} />
              </p>
              <div className="mod-actions">
                {contentPath(it) && <button className="link-btn" onClick={() => navigate(contentPath(it))}>원문 보기</button>}
                <button className="btn-add btn-sm" onClick={() => ackReport(it)}>확인</button>
                <button className="btn-remove btn-sm" onClick={() => remove(it)}>삭제</button>
                <button className="rev-del-btn" onClick={() => dismissReport(it)}>무시(정상)</button>
              </div>
            </li>
          ))}
```

Replace with:

```jsx
          {reported.map((it) => (
            <ReportCard key={`rep-${it.type}-${it.id}`} it={it} fmtDateTime={fmtDateTime} navigate={navigate}
              onAck={ackReport} onDismiss={dismissReport} onDelete={remove}
              onEdit={(t, note) => saveEditFrom(it, t, note)} />
          ))}
```

- [ ] **Step 3: `saveEditFrom` 헬퍼 추가 (신고 카드에서 바로 수정)**

Find [Moderation.jsx:320-324](../../../src/pages/Moderation.jsx#L320):

```js
  async function ackReport(it) {
    const r = await call('ack_report', { table: it.type, id: it.id });
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
    else alert('확인 처리 실패: ' + (r.status ?? '오류'));
  }
```

Replace with:

```js
  async function ackReport(it) {
    const r = await call('ack_report', { table: it.type, id: it.id });
    if (r.ok) setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
    else alert('확인 처리 실패: ' + (r.status ?? '오류'));
  }

  // 신고 카드에서 바로 내용 수정 → 서버가 '수정 조치' 로 신고자에게 통보하고 큐에서 뺀다.
  async function saveEditFrom(it, text, note) {
    const fields = (it.type === 'class_memo' || it.type === 'board_post') ? { content: text } : { courseComment: text };
    const payload = { table: it.type, id: it.id, fields };
    if (note && note.trim()) payload.reason = note.trim();
    const r = await call('edit_post', payload);
    if (r.ok) {
      setReported((prev) => prev.filter((x) => !(x.type === it.type && x.id === it.id)));
      setItems((prev) => prev.map((x) => (x.type === it.type && x.id === it.id ? { ...x, text } : x)));
    } else alert('수정 실패: ' + (r.status ?? '오류'));
  }
```

- [ ] **Step 4: `ReportCard` 컴포넌트 추가**

Find [Moderation.jsx](../../../src/pages/Moderation.jsx) 의 `CorrectionCard` 정의 끝(`}` 다음, `function AppReportCard` 앞). Insert 사이에:

```js
function ReportCard({ it, fmtDateTime, navigate, onAck, onDismiss, onDelete, onEdit }) {
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(it.text || '');
  const memo = note.trim() || undefined;
  const canEdit = it.type === 'review' || it.type === 'class_memo' || it.type === 'board_post';

  return (
    <li className="card mod-card flagged">
      <div className="mod-card-top">
        <span className="tag tag-primary mod-type">{TYPE_LABEL[it.type]}</span>
        <span className="mod-course">{it.courseCode}{it.meta?.sectionNo ? `·${it.meta.sectionNo}분반` : ''}</span>
        <span className="tag tag-warn mod-badge">🚨 신고 {it.reportCount}건</span>
        <span className="mod-time">{fmtDateTime(it.createdAt)}</span>
      </div>

      {editing ? (
        <textarea className="ar-reply-ta" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="mod-text" onClick={() => { const p = contentPath(it); if (p) navigate(p); }}>
          <Highlighted text={it.text || '(내용 없음)'} />
        </p>
      )}

      <ModMemo value={note} onChange={setNote} />

      <div className="mod-actions">
        {editing ? (
          <>
            <button className="btn-add btn-sm" onClick={() => { onEdit(text, memo); setEditing(false); }}>저장(수정 조치)</button>
            <button className="rev-del-btn" onClick={() => { setText(it.text || ''); setEditing(false); }}>취소</button>
          </>
        ) : (
          <>
            {contentPath(it) && <button className="link-btn" onClick={() => navigate(contentPath(it))}>원문 보기</button>}
            <button className="btn-add btn-sm" onClick={() => onAck(it)}>확인</button>
            {canEdit && <button className="link-btn" onClick={() => setEditing(true)}>수정</button>}
            <button className="btn-remove btn-sm" onClick={() => onDelete(it, memo)}>삭제</button>
            <button className="rev-del-btn" onClick={() => onDismiss(it, memo)}>무시(정상)</button>
          </>
        )}
      </div>
    </li>
  );
}

```

- [ ] **Step 5: 빌드 확인**

Run: `npm run build`
Expected: `✓ built in …` (no errors). `ReferenceError`·미사용 변수 경고 없음.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Moderation.jsx
git commit -m "feat: report cards get an inline note + in-place edit-as-action"
```

---

### Task 8: `Moderation.jsx` 검열 탭 편집 + `AdminCourse.jsx` 배너 메모

**Files:**
- Modify: `src/pages/Moderation.jsx:462-495` (검열 탭 편집 블록), `:490` (edit 시작 시 `note` 초기화)
- Modify: `src/pages/AdminCourse.jsx:173-191` (핸들러), `:225-246` (배너 렌더)

**Interfaces:**
- Consumes: `saveEdit()` 가 이미 `edit.note` 를 읽음(Task 7 Step 1). `call('apply_correction'|'resolve_correction', { …, reason })`.
- Produces: 검열 탭 편집 블록에 메모 입력. AdminCourse 배너에 `note` state + 메모 textarea.

- [ ] **Step 1: 검열 탭 편집 블록에 메모 입력**

Find [Moderation.jsx:471-478](../../../src/pages/Moderation.jsx#L471):

```jsx
                {edit && edit.type === it.type && edit.id === it.id ? (
                  <div className="mod-edit">
                    <textarea value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} rows={3} />
                    <div className="mod-edit-actions">
                      <button className="btn-add btn-sm" onClick={saveEdit}>저장</button>
                      <button className="rev-del-btn" onClick={() => setEdit(null)}>취소</button>
                    </div>
                  </div>
                ) : (
```

Replace with:

```jsx
                {edit && edit.type === it.type && edit.id === it.id ? (
                  <div className="mod-edit">
                    <textarea value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} rows={3} />
                    <textarea className="ar-reply-ta" rows={2} value={edit.note ?? ''} maxLength={300}
                      placeholder="신고자에게 표시될 메모 (선택 — 신고 누적 중인 글에만 전달됩니다)"
                      onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
                    <div className="mod-edit-actions">
                      <button className="btn-add btn-sm" onClick={saveEdit}>저장</button>
                      <button className="rev-del-btn" onClick={() => setEdit(null)}>취소</button>
                    </div>
                  </div>
                ) : (
```

- [ ] **Step 2: `edit` 시작 시 `note` 필드 포함 (이미 스프레드라 별도 초기화 불필요 확인)**

Find [Moderation.jsx:490](../../../src/pages/Moderation.jsx#L490):

```jsx
                  <button className="rev-del-btn" onClick={() => setEdit({ type: it.type, id: it.id, text: editableText(it), postId: it.meta?.postId })}>수정</button>
```

Replace with:

```jsx
                  <button className="rev-del-btn" onClick={() => setEdit({ type: it.type, id: it.id, text: editableText(it), postId: it.meta?.postId, note: '' })}>수정</button>
```

- [ ] **Step 3: `AdminCourse` 핸들러가 메모를 싣도록**

Find [AdminCourse.jsx:173-191](../../../src/pages/AdminCourse.jsx#L173):

```js
  // 제안대로 적용: 대표 1건 반영 + 동일 묶음 나머지 정리 + 카탈로그 새로고침.
  async function applyProposal() {
    if (!corr) return;
    setMsg('');
    const r = await callAdmin('apply_correction', { id: corr.id });
    if (!r.ok && r.status !== 'ALREADY_DONE') { setMsg(`⚠️ 적용 실패: ${r.status ?? '오류'}`); return; }
    const others = (corr.ids || []).filter((id) => id !== corr.id);
    if (others.length) await callAdmin('resolve_correction', { ids: others });
    setCat(await getCatalog({ force: true }).catch(() => cat));
    setMsg(r.status === 'ALREADY_DONE' ? '✅ 이미 반영돼 있어 제안만 정리했습니다.' : '✅ 제안을 반영했습니다.');
    setCorr(null);
  }
  // 제안 정리: 반영 없이 큐에서 삭제(직접 고친 뒤 처리완료).
  async function dismissProposal() {
    if (!corr) return;
    await callAdmin('resolve_correction', { ids: corr.ids || [corr.id] });
    setMsg('✅ 제안을 정리했습니다.');
    setCorr(null);
  }
```

Replace with:

```js
  // 제안대로 적용: 대표 1건 반영 + 동일 묶음 나머지 정리 + 카탈로그 새로고침.
  async function applyProposal() {
    if (!corr) return;
    setMsg('');
    const reason = note.trim() || undefined;
    const r = await callAdmin('apply_correction', { id: corr.id, reason });
    if (!r.ok && r.status !== 'ALREADY_DONE') { setMsg(`⚠️ 적용 실패: ${r.status ?? '오류'}`); return; }
    const others = (corr.ids || []).filter((id) => id !== corr.id);
    if (others.length) await callAdmin('resolve_correction', { ids: others, reason });
    setCat(await getCatalog({ force: true }).catch(() => cat));
    setMsg(r.status === 'ALREADY_DONE' ? '✅ 이미 반영돼 있어 제안만 정리했습니다.' : '✅ 제안을 반영했습니다.');
    setCorr(null);
  }
  // 제안 정리: 반영 없이 큐에서 삭제(직접 고친 뒤 처리완료).
  async function dismissProposal() {
    if (!corr) return;
    await callAdmin('resolve_correction', { ids: corr.ids || [corr.id], reason: note.trim() || undefined });
    setMsg('✅ 제안을 정리했습니다.');
    setCorr(null);
  }
```

- [ ] **Step 4: `note` state + 배너 textarea**

Find [AdminCourse.jsx:103](../../../src/pages/AdminCourse.jsx#L103):

```js
  const [corr, setCorr] = useState(location.state?.corr ?? null);
```

Replace with:

```js
  const [corr, setCorr] = useState(location.state?.corr ?? null);
  const [note, setNote] = useState(''); // 제안 처리 시 제출자에게 표시될 메모(선택)
```

Find [AdminCourse.jsx:238-243](../../../src/pages/AdminCourse.jsx#L238):

```jsx
            <div className="adm-corr-banner-acts">
              <button className="btn-add btn-sm" onClick={applyProposal}>
                {corr.target === 'section_add' ? '제안대로 분반 생성' : '제안대로 적용'}
              </button>
              <button className="rev-del-btn" onClick={dismissProposal}>제안 정리(직접 수정함)</button>
            </div>
```

Replace with:

```jsx
            <textarea className="ar-reply-ta" rows={2} value={note} maxLength={300}
              placeholder="제출자에게 표시될 메모 (선택 — 예: '요일만 반영, 강의실은 확인 후 별도 수정')"
              onChange={(e) => setNote(e.target.value)} />
            <div className="adm-corr-banner-acts">
              <button className="btn-add btn-sm" onClick={applyProposal}>
                {corr.target === 'section_add' ? '제안대로 분반 생성' : '제안대로 적용'}
              </button>
              <button className="rev-del-btn" onClick={dismissProposal}>제안 정리(직접 수정함)</button>
            </div>
```

- [ ] **Step 5: `.ar-reply-ta` 가 `admin.css` 밖에서도 로드되는지 확인 (AdminCourse)**

Run: `grep -n "import '../styles" src/pages/AdminCourse.jsx`
Expected: `admin.css` 가 목록에 있어야 함(있으면 `.ar-reply-ta` 재사용 OK). 없으면 Step 6 에서 `correction.css` 에 규칙 복제.

- [ ] **Step 6: (조건부) 메모 토글·textarea 스타일 파셜에 추가**

`src/styles/correction.css` 끝에 append (`.mod-memo-toggle` 는 신규, `.ar-reply-ta` 는 admin.css 에 이미 있으면 생략):

```css
/* 모더레이션 카드: 제출자 메모 토글 */
.mod-memo-toggle { align-self: flex-start; margin: 0.2rem 0; font-size: 0.82rem; }
```

- [ ] **Step 7: 빌드 확인**

Run: `npm run build`
Expected: `✓ built in …` (no errors)

- [ ] **Step 8: Commit**

```bash
git add src/pages/Moderation.jsx src/pages/AdminCourse.jsx src/styles/correction.css
git commit -m "feat: catalog-edit and AdminCourse proposal banner carry a submitter note"
```

---

### Task 9: 전체 검증 + 배포

**Files:** 없음 (검증·배포만)

- [ ] **Step 1: 함수 전체 구문 확인**

Run: `for f in firebase/functions/src/lib/archive.js firebase/functions/src/admin/moderationActions.js firebase/functions/src/feedback.js; do node --check "$f" && echo "ok $f"; done`
Expected: `ok` 3줄

- [ ] **Step 2: 프론트 빌드**

Run: `npm run build`
Expected: `✓ built in …`

- [ ] **Step 3: 스펙 자기점검 — 회귀 지점 수동 확인**

- `FeedbackPopup` 의 `f.corrections.map(correctionLine).filter(Boolean)` 는 `note` 만 있고 `a` 없는 항목을 안 만든다(모든 status 분기가 `a` 를 채움 or null → filter). ✅
- `getMyFeedback` `contentReports` 에서 `reason` 제거 → `src/lib/feedback.js` 는 `...i` 스프레드라 영향 없음, `FeedbackPopup.contentLine` 은 `it.note` 로 갱신됨. ✅
- `pushCorrectionOutcome` 를 `rejectCorrection` 이 `await ref.get()` 재조회로 호출 → `reply` 최신본 반영. ✅

- [ ] **Step 4: 함수 배포**

Run: `firebase deploy --only functions`
Expected: `✔ Deploy complete!` — 변경 함수만 업데이트(`getMyFeedback`, admin gateway).

- [ ] **Step 5: 스펙 구현 완료 표기**

`docs/superpowers/specs/2026-09-03-feedback-notes-on-all-outcomes-design.md` 맨 아래 `## 구현` 섹션에 완료 한 줄 추가.

- [ ] **Step 6: 프론트 배포 (커밋 + 푸시 → Cloudflare Pages)**

```bash
git add docs/superpowers/specs/2026-09-03-feedback-notes-on-all-outcomes-design.md
git commit -m "docs: mark feedback-notes-on-all-outcomes spec implemented"
git push origin main
```

Expected: push 성공. Cloudflare Pages 가 `main` 빌드를 자동 트리거.

- [ ] **Step 7: 배포 후 실기기 스모크 (스펙 Ⅸ 1~6)**

수동. 각각 앱 재진입 후 `FeedbackPopup` 문구·`↳ 메모` 줄 확인.

---

## Self-Review

**1. Spec coverage**

| 스펙 항목 | Task |
|---|---|
| Ⅰ 데이터 (필드 추가, 색인 없음) | 1, 3 (필드는 write 시 생성) |
| Ⅱ `applyCorrection`/`resolveCorrection`/`pushCorrectionOutcome` | 2 |
| Ⅱ `editPost`/`deletePost` | 3 |
| Ⅱ `dismissReport` 변경 없음(UI만) | 7 |
| Ⅲ `getMyFeedback` `note` 통일 + `edited` | 4 |
| Ⅳ `archiveDeleted` `adminNote` | 1 |
| Ⅴ `FeedbackPopup` + `home.css` | 5 |
| Ⅵ `Moderation.jsx` 수정제안/신고 카드 | 6, 7 |
| Ⅵ 검열 탭 편집 블록 | 8 |
| Ⅶ `AdminCourse.jsx` 배너 | 8 |
| Ⅷ CSS | 5, 8 |
| Ⅸ 테스트 | 9 |

**2. Placeholder scan:** Task 8 Step 5–6 은 조건부(파일에 이미 있으면 생략)지만 판단 기준·명령을 명시함 — placeholder 아님. 나머지 전 스텝 실제 코드 포함.

**3. Type consistency:**
- `noteOf(payload)` — Task 2 Step 1 정의, Task 2·3 에서 사용. ✅
- `ModMemo` — Task 6 Step 3 정의, Task 7 Step 4 에서 사용(같은 파일, 정의가 먼저). ✅
- `ARCHIVE_ON_DELETE` — Task 3 Step 2 정의, Task 3 Step 3 에서 사용. ✅
- `CorrectionCard`/`ReportCard` props — 렌더 호출부(Task 6 Step 2, Task 7 Step 2)와 정의 시그니처 일치. ✅
- `edit.note` — Task 7 Step 1(`saveEdit` 읽기)·Task 8 Step 1–2(쓰기) 일치. ✅
- `contentReports[].note` — Task 4 produces, Task 5 `contentLine` consumes. ✅
