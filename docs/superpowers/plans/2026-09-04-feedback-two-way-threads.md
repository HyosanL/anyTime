# 피드백 양방향 스레드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 수정 제안·앱 문제·콘텐츠 신고 3채널을 하나의 `feedbackThreads` 컬렉션으로 묶어, 관리자가 처리 전에 제출자에게 질문하고 제출자가 익명으로 답할 수 있게 한다. 스레드는 모든 관리자에게 문서 1개로 공유된다.

**Architecture:** 스레드는 결정적 ID(`correction_<해시>` / `content_<type>_<id>` / `appreport_<id>`)로 `feedbackThreads/{threadId}` 에 산다 — Rules `if false`, 전부 Admin SDK / `getMyFeedback` CF 경유. 제출자 신원은 저장하지 않고, 기기가 쥔 참조(correctionId / appReportId / `{type,id}`)로 소유권을 증명한다. 콘텐츠 신고는 서버가 호출자 uid 로 `actorHash`(이미 신고 중복방지에 쓰는 salted 해시)를 재계산해 검증. 관리자가 처음 메시지를 보낼 때 스레드가 지연 생성된다.

**Tech Stack:** React 19 + Vite, Firebase Cloud Functions v2 (Node 22), Cloudflare Pages. 테스트 프레임워크 없음 — `node --check` + `npm run build` + 배포 후 실기기.

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-09-04-feedback-two-way-threads-design.md`.
- 이전 스펙 `2026-09-03-feedback-corrections-reports-design.md` 위에 얹는다 — `subId`(sha256 endpoint), `getMyFeedback`, `FeedbackPopup`, `src/lib/feedback.js`, `corrections/{id}` 의 `reply`/`repliedAt`/`subId`, `pushCorrectionOutcome` 가 이미 배포돼 있다.
- 익명성 하드룰 [[board-full-anonymity]] [[app-report-reply-anon]] — 어느 스레드에도 제출자 uid 저장 금지. 콘텐츠 신고는 `actorHash` 로만 라우팅.
- 대화 한국어, 코드·주석·커밋 메시지 영어. 커밋 끝 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- "배포" = `git push origin main` (functions/rules → GitHub Actions `deploy-firebase.yml`, 프론트 → Cloudflare Pages Git 연동). push 전 `git pull --rebase` (다른 세션이 main 을 움직일 수 있음). `git add` 는 **명시 경로만**, `git add -A` 금지.
- `public/push-sw.js` 변경 시 그 파일의 `PUSH_SW_VERSION` 과 `vite.config.js` 의 `importScripts: ['push-sw.js?v=14']` 를 함께 `15` 로.
- Firestore Rules 는 `feedbackThreads` 한 줄만 추가. 색인 추가 없음 — 결정적 ID `get`/`getAll`, 소규모 서브컬렉션 스캔, 월간 컬렉션 스캔만.
- 메시지 상한 50개/스레드, 각 `text` ≤ 1000자.
- `actorHash` scope 문자열(채널별, 절대 바꾸지 말 것): review=`'review-report'`, class_memo=`'memo-report'`, board_post=`'board-post-react'`.
- 콘텐츠 신고 reaction 문서 ID: review/memo = `<hash>`, board_post = `report_<hash>`.

## 파일 구조

| 파일 | 책임 | 신규/수정 |
|---|---|---|
| `firebase/functions/src/lib/feedbackThread.js` | threadId 계산, groupKey, 메시지 append 트랜잭션, 표시 변환 | 신규 |
| `firebase/functions/src/feedbackThreads.js` | `askFeedbackQuestion`·`replyFeedbackThread` CF | 신규 |
| `firebase/functions/index.js` | export 추가 | 수정 |
| `firebase/functions/src/admin.js` | `adminAction` 시크릿에 `actorHashSalt` 추가 | 수정 |
| `firebase/functions/src/admin/moderationActions.js` | `ask_feedback_question` 액션, 처리 액션의 스레드 close, `annotate_correction` 재구현 | 수정 |
| `firebase/functions/src/corrections.js` | 자동반영 게이트 + 스레드 링크 | 수정 |
| `firebase/functions/src/feedback.js` | `getMyFeedback` 에 thread 동봉, `purgeCorrections` 스레드 정리 | 수정 |
| `firebase/functions/src/appReport.js` | `purgeAppReports` 스레드 정리 | 수정 |
| `firebase/functions/src/reviews.js` · `classMemo.js` · `board.js` | 신고 CF 에 `endpoint`→`subId` | 수정 |
| `firebase/functions/src/feedbackThreads.js` (`purgeContentThreads`) | 월간 콘텐츠 스레드 정리 | 수정(같은 파일) |
| `firebase/firestore.rules` | `feedbackThreads` `if false` | 수정 |
| `src/lib/feedback.js` | `threadSeen`, `replyFeedbackThread`, `unreadCount`, thread passthrough | 수정 |
| `src/pages/Feedback.jsx` | `/feedback` 허브 페이지 + 스레드 뷰 | 신규 |
| `src/components/FeedbackThread.jsx` | 메시지 목록 + 답장 입력 (Feedback 페이지·FeedbackPopup 공용) | 신규 |
| `src/styles/feedback.css` | 스레드·허브 스타일 | 신규 |
| `src/App.jsx` | `/feedback` 라우트 | 수정 |
| `src/pages/Home.jsx` | 🚩 → `<Link to="/feedback">` + 배지, `fetchFeedback` 끌어올리기 | 수정 |
| `src/components/FeedbackPopup.jsx` | 대화형 + 인라인 답장 | 수정 |
| `src/pages/Moderation.jsx` | 3탭 스레드 UI, 질문하기, 처리함 요약+펼침 | 수정 |
| `public/push-sw.js` · `vite.config.js` | `feedback_question` kind + v15 | 수정 |

---

# Phase 1 — 통합 스레드 모델 + 골격

### Task 1: 백엔드 — `feedbackThread.js` 공용 헬퍼

**Files:**
- Create: `firebase/functions/src/lib/feedbackThread.js`

**Interfaces:**
- Produces: `groupKeyOf(c)` → string (Moderation.jsx `groupKey()` 와 동일 규칙).
- Produces: `threadIdFor(channel, ref)` → string. `ref`: correction=`{correction}`(문서 데이터), content_report=`{type,id}`, app_report=`{appReportId}`.
- Produces: `appendMessage(db, threadId, { from, authorKey, adminName, text }, { create })` → `{ seq, status }`. 트랜잭션. `create` 있으면 문서 없을 때 그 필드로 생성.
- Produces: `toClientMessages(messages, myKey)` → `[{ seq, who, pid, text, at }]`.
- Produces: `THREAD_MSG_MAX = 50`, `MSG_MAX_LEN = 1000`.

- [ ] **Step 1: 파일 작성**

Create `firebase/functions/src/lib/feedbackThread.js`:

```js
import { createHash } from 'node:crypto';
import { FieldValue } from './context.js';

// 피드백 스레드 공용 로직 — feedbackThreads.js(CF) 와 admin/moderationActions.js(관리자
// 처리 액션), feedback.js(getMyFeedback) 가 함께 쓴다.
// 설계: docs/superpowers/specs/2026-09-04-feedback-two-way-threads-design.md

export const THREAD_MSG_MAX = 50;
export const MSG_MAX_LEN = 1000;

// Moderation.jsx 의 groupKey() 와 문자 단위로 동일해야 한다 — 어긋나면 관리자 화면의
// 묶음과 스레드가 따로 논다. 순서: target|professorCode|courseCode|year|term|sectionNo|field|suggested
export function groupKeyOf(c) {
  return [
    c.target, c.professorCode ?? '', c.courseCode ?? '',
    c.year ?? '', c.term ?? '', c.sectionNo ?? '', c.field, c.suggested ?? '',
  ].join('|');
}

function sha16(s) {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// 결정적 threadId. ref 는 채널별로:
//  correction     → correction 문서 데이터(target/field/suggested 등)
//  content_report → { type, id }
//  app_report     → { appReportId }
export function threadIdFor(channel, ref) {
  if (channel === 'correction') return `correction_${sha16(groupKeyOf(ref))}`;
  if (channel === 'content_report') return `content_${ref.type}_${ref.id}`;
  if (channel === 'app_report') return `appreport_${ref.appReportId}`;
  throw new Error(`unknown channel: ${channel}`);
}

// 메시지 1개 append. 트랜잭션이라 동시 append 에도 seq 가 안 겹친다.
// create: 문서가 없을 때 새로 만들 초기 필드(관리자 첫 질문). 없는데 create 도 없으면 NO_THREAD.
export async function appendMessage(db, threadId, msg, opts = {}) {
  const ref = db.collection('feedbackThreads').doc(threadId);
  const text = String(msg.text ?? '').trim().slice(0, MSG_MAX_LEN);
  if (!text) return { status: 'EMPTY' };

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists && !opts.create) return { status: 'NO_THREAD' };

    const existing = snap.exists ? (snap.get('messages') || []) : [];
    if (existing.length >= THREAD_MSG_MAX) return { status: 'FULL' };

    const seq = existing.length + 1;
    const entry = {
      seq,
      from: msg.from,
      authorKey: msg.authorKey,
      adminName: msg.adminName ?? null,
      text,
      at: new Date(),
    };
    const nextStatus = msg.from === 'admin'
      ? (opts.close ? 'closed' : 'open')
      : 'answered';

    if (!snap.exists) {
      tx.set(ref, {
        ...opts.create,
        messages: [entry],
        participantKeys: msg.from === 'user' ? [msg.authorKey] : [],
        subIds: [],
        status: nextStatus,
        outcome: null,
        lastMessageAt: entry.at,
        createdAt: FieldValue.serverTimestamp(),
      });
    } else {
      const patch = {
        messages: [...existing, entry],
        status: nextStatus,
        lastMessageAt: entry.at,
      };
      if (opts.outcome !== undefined) patch.outcome = opts.outcome;
      if (msg.from === 'user') patch.participantKeys = FieldValue.arrayUnion(msg.authorKey);
      tx.update(ref, patch);
    }
    return { status: 'OK', seq };
  });
}

// 저장 형태 messages[] → 클라이언트가 볼 형태. authorKey/adminName/내부 필드는 벗겨낸다.
// myKey: 이 요청자의 핸들(correctionId / actorHash / appReportId). 없으면(관리자 화면은
// 별도 변환) 전부 who='other'.
export function toClientMessages(messages, myKey) {
  const order = [];              // user authorKey 첫 등장 순서 → pid
  const pidOf = (k) => {
    let i = order.indexOf(k);
    if (i < 0) { order.push(k); i = order.length - 1; }
    return i + 1;
  };
  return (messages || []).map((m) => {
    if (m.from === 'admin') return { seq: m.seq, who: 'admin', pid: null, text: m.text, at: m.at };
    const pid = pidOf(m.authorKey);
    const mine = myKey != null && m.authorKey === myKey;
    return { seq: m.seq, who: mine ? 'me' : 'other', pid, text: m.text, at: m.at };
  });
}
```

- [ ] **Step 2: 문법 확인**

```bash
node --check firebase/functions/src/lib/feedbackThread.js
```
Expected: 출력 없음(통과).

- [ ] **Step 3: 커밋**

```bash
git add firebase/functions/src/lib/feedbackThread.js
git commit -m "feat: feedbackThread shared helper (threadId, append txn, client transform)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: 백엔드 — `askFeedbackQuestion` + `replyFeedbackThread` CF

**Files:**
- Create: `firebase/functions/src/feedbackThreads.js`
- Modify: `firebase/functions/index.js`
- Modify: `firebase/firestore.rules`

**Interfaces:**
- Consumes: `appendMessage`, `threadIdFor`, `groupKeyOf`, `toClientMessages` (Task 1).
- Produces: `askFeedbackQuestionInternal(db, { uid, adminName, channel, ids?, contentRef?, appReportId?, text, close?, outcome? })` → `{ status, threadId, seq }`. 관리자 처리 액션(Task 9/11/13)이 직접 부른다.
- Produces: `askFeedbackQuestion` — `adminAction` 이 아니라 여기서 export 하지 않음(게이트웨이가 `ask_feedback_question` 으로 감싼다, Task 8).
- Produces: `replyFeedbackThread` onCall (생도) → `{ status }`.
- Produces: `purgeContentThreads` onSchedule.

- [ ] **Step 1: `feedbackThreads.js` 작성**

```js
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createHash, createHmac } from 'node:crypto';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { actorHashSalt, pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { pushFanout } from './lib/pushFanout.js';
import { adminPush } from './lib/adminNotify.js';
import {
  appendMessage, threadIdFor, toClientMessages, MSG_MAX_LEN,
} from './lib/feedbackThread.js';

// 설계: docs/superpowers/specs/2026-09-04-feedback-two-way-threads-design.md
// feedbackThreads/{threadId} 는 Rules `if false` — 전부 이 파일 / moderationActions.js /
// feedback.js(getMyFeedback) 를 통해서만 읽고 쓴다.

function sha256hex(s) {
  return createHash('sha256').update(s).digest('hex');
}

// 콘텐츠 신고 채널의 제출자 핸들 = 신고 중복방지에 쓰는 actorHash 재계산.
const REPORT_SCOPE = { review: 'review-report', class_memo: 'memo-report', board_post: 'board-post-react' };
const REPORT_COLLECTION = { review: 'reviews', class_memo: 'classMemos', board_post: 'boardPosts' };
function contentActorHash(salt, uid, type, id) {
  const scope = REPORT_SCOPE[type];
  if (!scope) return null;
  return createHmac('sha256', salt).update(`${uid}:${scope}:${id}`).digest('hex');
}
// review/memo 는 reactions/{hash}, board_post 는 reactions/report_{hash}
function reportReactionId(type, hash) {
  return type === 'board_post' ? `report_${hash}` : hash;
}

// ── 관리자: 질문/후속 메시지 (moderationActions.js 가 ask_feedback_question 으로 감싼다) ──
export async function askFeedbackQuestionInternal(payload) {
  const { uid, adminName, channel, text } = payload;
  const t = String(text ?? '').trim().slice(0, MSG_MAX_LEN);
  if (!t) invalid('메시지를 입력하세요.');

  let threadId;
  let create; // 스레드 없을 때 생성 필드

  if (channel === 'correction') {
    const ids = Array.isArray(payload.ids) ? payload.ids.map(String).filter(Boolean) : [];
    if (!ids.length) invalid('대상이 없습니다.');
    const first = await db.collection('corrections').doc(ids[0]).get();
    if (!first.exists) return { status: 'NOT_FOUND' };
    const c = first.data();
    threadId = threadIdFor('correction', c);
    const fieldLabel = FIELD_LABELS[c.field] || c.field;
    create = {
      channel, correctionIds: ids,
      label: `${c.label || c.target} · ${fieldLabel}`,
      summary: String(c.suggested ?? c.note ?? '').slice(0, 200),
    };
    // 이 묶음의 모든 correction 에 threadId 링크
    const batch = db.batch();
    for (const id of ids) batch.update(db.collection('corrections').doc(id), { threadId });
    await batch.commit();
  } else if (channel === 'content_report') {
    const { type, id } = payload.contentRef ?? {};
    if (!REPORT_COLLECTION[type] || !id) invalid('대상이 없습니다.');
    threadId = threadIdFor('content_report', { type, id });
    const cSnap = await db.collection(REPORT_COLLECTION[type]).doc(String(id)).get();
    const label = payload.label || (type === 'board_post' ? '게시글' : type === 'review' ? '강의평' : '메모');
    create = { channel, contentRef: { type, id: String(id) }, label, summary: String(payload.summary ?? '').slice(0, 200) };
    if (!cSnap.exists) { /* 이미 삭제됨 — 스냅샷만으로 스레드 유지 */ }
  } else if (channel === 'app_report') {
    const appReportId = String(payload.appReportId ?? '');
    if (!appReportId) invalid('대상이 없습니다.');
    const arSnap = await db.collection('appReports').doc(appReportId).get();
    if (!arSnap.exists) return { status: 'NOT_FOUND' };
    threadId = threadIdFor('app_report', { appReportId });
    create = {
      channel, appReportId,
      label: arSnap.get('path') || '앱 문제',
      summary: String(arSnap.get('text') ?? '').slice(0, 200),
    };
    await arSnap.ref.update({ threadId });
  } else {
    invalid('알 수 없는 채널입니다.');
  }

  const r = await appendMessage(db, threadId, {
    from: 'admin', authorKey: uid, adminName: adminName ?? null, text: t,
  }, { create, close: !!payload.close, outcome: payload.outcome });
  if (r.status !== 'OK') return { status: r.status, threadId };

  // 푸시 대상 subId 수집 + 푸시
  await notifyQuestion(channel, payload, threadId, create.label);
  return { status: 'OK', threadId, seq: r.seq };
}

const FIELD_LABELS = {
  time: '요일·교시', room: '강의실', professor: '담당교수',
  name: '이름/과목명', department: '학과', office: '연구실', section: '분반 추가',
};

async function notifyQuestion(channel, payload, threadId, label) {
  const subIds = new Set();
  const threadSnap = await db.collection('feedbackThreads').doc(threadId).get();
  for (const s of (threadSnap.get('subIds') || [])) subIds.add(s);

  if (channel === 'correction') {
    for (const id of payload.ids) {
      const s = await db.collection('corrections').doc(String(id)).get();
      if (s.get('subId')) subIds.add(s.get('subId'));
    }
  } else if (channel === 'app_report') {
    const s = await db.collection('appReports').doc(String(payload.appReportId)).get();
    if (s.get('subId')) subIds.add(s.get('subId'));
  } else if (channel === 'content_report') {
    const { type, id } = payload.contentRef;
    const coll = REPORT_COLLECTION[type];
    const reactSnap = await db.collection(coll).doc(String(id)).collection('reactions')
      .where('kind', '==', 'report').get().catch(() => ({ docs: [] }));
    for (const d of reactSnap.docs) if (d.get('subId')) subIds.add(d.get('subId'));
  }
  if (!subIds.size) return;

  const subDocs = await db.getAll(...[...subIds].map((sid) => db.collection('pushSubscriptions').doc(sid)));
  const targets = subDocs.filter((s) => s.exists).map((s) => ({
    endpoint: s.get('endpoint'), p256dh: s.get('p256dh'), auth: s.get('auth'),
  }));
  if (!targets.length) return;
  try {
    await pushFanout(pushFanoutUrl.value(), pushFanoutSecret.value(),
      { kind: 'feedback_question', title: '💬 피드백 확인 요청', body: `${label} · 관리자가 확인을 요청했어요`, path: '/feedback' },
      targets);
  } catch (e) { console.error('[notifyQuestion] push failed', e); }
}

// ── 생도: 스레드에 답장 ──
export const replyFeedbackThread = onCall(
  { secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] },
  async (request) => {
    const uid = requireAuth(request);
    const d = request.data ?? {};
    const channel = String(d.channel ?? '');
    const text = String(d.text ?? '').trim();
    if (text.length < 1 || text.length > MSG_MAX_LEN) invalid('답변은 1자 이상 1000자 이하로 입력하세요.');

    let threadId;
    let authorKey;

    if (channel === 'correction') {
      const cid = String(d.correctionId ?? '');
      const cSnap = await db.collection('corrections').doc(cid).get();
      if (!cSnap.exists || !cSnap.get('threadId')) throw new Error('NO_THREAD');
      threadId = cSnap.get('threadId');
      authorKey = cid;
    } else if (channel === 'app_report') {
      const arId = String(d.appReportId ?? '');
      const arSnap = await db.collection('appReports').doc(arId).get();
      if (!arSnap.exists || !arSnap.get('threadId')) throw new Error('NO_THREAD');
      threadId = arSnap.get('threadId');
      authorKey = arId;
    } else if (channel === 'content_report') {
      const { type, id } = d.contentRef ?? {};
      if (!REPORT_COLLECTION[type] || !id) invalid('대상이 없습니다.');
      const hash = contentActorHash(actorHashSalt.value(), uid, type, String(id));
      threadId = threadIdFor('content_report', { type, id: String(id) });
      const [reactSnap, threadSnap] = await Promise.all([
        db.collection(REPORT_COLLECTION[type]).doc(String(id))
          .collection('reactions').doc(reportReactionId(type, hash)).get(),
        db.collection('feedbackThreads').doc(threadId).get(),
      ]);
      const isReporter = reactSnap.exists
        || (threadSnap.exists && (threadSnap.get('participantKeys') || []).includes(hash));
      if (!isReporter) throw new HttpsErrorPermission();
      if (!threadSnap.exists) throw new Error('NO_THREAD');
      authorKey = hash;
    } else {
      invalid('알 수 없는 채널입니다.');
    }

    const r = await appendMessage(db, threadId, { from: 'user', authorKey, text });
    if (r.status === 'NO_THREAD') throw new Error('NO_THREAD');
    if (r.status === 'FULL') return { status: 'FULL' };
    if (r.status !== 'OK') return { status: r.status };

    // 현재 푸시 구독을 스레드 subIds 에 등록(다음 관리자 메시지 때 이 기기에 알림)
    const endpoint = d.endpoint;
    if (typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024) {
      await db.collection('feedbackThreads').doc(threadId)
        .update({ subIds: FieldValue.arrayUnion(sha256hex(endpoint)) });
    }

    const threadSnap = await db.collection('feedbackThreads').doc(threadId).get();
    await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
      kind: 'feedback_reply', title: '💬 피드백 답변 도착', body: threadSnap.get('label') || '제출자가 답했어요',
    });
    return { status: 'OK' };
  },
);

function HttpsErrorPermission() {
  // firebase-functions HttpsError 를 직접 import 하지 않고 감싼다(파일 상단 import 최소화).
  const e = new Error('이 신고의 제출자만 답할 수 있습니다.');
  e.code = 'permission-denied';
  return e;
}

// ── 정리: closed 콘텐츠 신고 스레드(월간) — deletedContent 30일 TTL 과 보조 ──
export const purgeContentThreads = onSchedule({ schedule: '0 19 1 * *', timeZone: 'UTC' }, async () => {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const ms = (ts) => (typeof ts?.toMillis === 'function' ? ts.toMillis() : 0);
  const snap = await db.collection('feedbackThreads').where('channel', '==', 'content_report').get();
  const stale = snap.docs.filter((d) => d.get('status') === 'closed' && ms(d.get('lastMessageAt')) > 0 && ms(d.get('lastMessageAt')) < cutoff);
  for (let i = 0; i < stale.length; i += 400) {
    const batch = db.batch();
    for (const d of stale.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
});
```

> 주의: `HttpsError` 를 쓰는 편이 낫다. Step 1b 로 정리한다.

- [ ] **Step 1b: `HttpsError` 정식 사용으로 교체**

파일 상단 import 에 추가:

```js
import { onCall, HttpsError } from 'firebase-functions/v2/https';
```

(첫 줄 `import { onCall } from ...` 을 위 줄로 교체.)

`HttpsErrorPermission()` 함수 정의를 지우고, 호출부

```js
      if (!isReporter) throw new HttpsErrorPermission();
```

를

```js
      if (!isReporter) throw new HttpsError('permission-denied', '이 신고의 제출자만 답할 수 있습니다.');
```

로. `NO_THREAD` throw 들도 `throw new HttpsError('failed-precondition', 'NO_THREAD')` 로 교체(3곳).

- [ ] **Step 2: `index.js` export**

Find:

```js
export { getMyFeedback, purgeCorrections } from './src/feedback.js';
```

Replace with:

```js
export { getMyFeedback, purgeCorrections } from './src/feedback.js';
export { replyFeedbackThread, purgeContentThreads } from './src/feedbackThreads.js';
```

- [ ] **Step 3: Rules — `feedbackThreads`**

Find in `firebase/firestore.rules`:

```
    // ---- app problem reports: no client access, function-gated only (same
    // anonymity model as corrections above). ----
    match /appReports/{id} {
      allow read, write: if false;
    }
```

Replace with:

```
    // ---- app problem reports: no client access, function-gated only (same
    // anonymity model as corrections above). ----
    match /appReports/{id} {
      allow read, write: if false;
    }

    // ---- feedback threads (correction / app_report / content_report):
    // server-only, same anonymity model. Reads go through getMyFeedback CF. ----
    match /feedbackThreads/{id} {
      allow read, write: if false;
    }
```

- [ ] **Step 4: 문법 + 커밋**

```bash
node --check firebase/functions/src/feedbackThreads.js
node --check firebase/functions/index.js
git add firebase/functions/src/feedbackThreads.js firebase/functions/index.js firebase/firestore.rules
git commit -m "feat: feedback thread CFs (askFeedbackQuestionInternal, replyFeedbackThread, purgeContentThreads)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: 백엔드 — `getMyFeedback` 에 thread 동봉

**Files:**
- Modify: `firebase/functions/src/feedback.js`

**Interfaces:**
- Consumes: `toClientMessages`, `threadIdFor` (Task 1); actorHash 재계산 로직 (Task 2 의 상수 재사용 — feedback.js 에도 작은 사본을 둔다).
- Produces: `getMyFeedback` 응답 각 `corrections[]`/`appReports[]`/`contentReports[]` 항목에 `thread: { messages, status, outcome } | null`.

- [ ] **Step 1: import + 시크릿 바인딩**

Find [feedback.js:1-3](../../../firebase/functions/src/feedback.js#L1):

```js
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, requireAuth } from './lib/context.js';
```

Replace with:

```js
import { createHmac } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, requireAuth } from './lib/context.js';
import { actorHashSalt } from './lib/secrets.js';
import { toClientMessages, threadIdFor } from './lib/feedbackThread.js';

const REPORT_SCOPE = { review: 'review-report', class_memo: 'memo-report', board_post: 'board-post-react' };
function contentActorHash(salt, uid, type, id) {
  const scope = REPORT_SCOPE[type];
  return scope ? createHmac('sha256', salt).update(`${uid}:${scope}:${id}`).digest('hex') : null;
}
function reportReactionId(type, hash) {
  return type === 'board_post' ? `report_${hash}` : hash;
}
```

- [ ] **Step 2: `getMyFeedback` — requireAuth + secret, uid 를 lookup 들에 전달**

Find:

```js
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

Replace with:

```js
export const getMyFeedback = onCall({ secrets: [actorHashSalt] }, async (request) => {
  const uid = requireAuth(request);
  const d = request.data ?? {};
  const [appReports, corrections, contentReports] = await Promise.all([
    lookupAppReports(cleanIds(d.appReportIds)),
    lookupCorrections(cleanIds(d.correctionIds)),
    lookupContentReports(d.contentReports, uid),
  ]);
  return { status: 'OK', appReports, corrections, contentReports };
});

// threadId 목록 → { threadId: { messages, status, outcome } } (요청자 핸들 keyMap 으로 who 판정)
async function loadThreads(entries) {
  // entries: [{ threadId, myKey }]
  const uniq = [...new Set(entries.map((e) => e.threadId).filter(Boolean))];
  if (!uniq.length) return {};
  const snaps = await db.getAll(...uniq.map((id) => db.collection('feedbackThreads').doc(id)));
  const byId = {};
  snaps.forEach((s) => { if (s.exists) byId[s.id] = s.data(); });
  const out = {};
  for (const { threadId, myKey } of entries) {
    const t = byId[threadId];
    if (!t) continue;
    out[threadId] = {
      messages: toClientMessages(t.messages, myKey),
      status: t.status ?? 'open',
      outcome: t.outcome ?? null,
    };
  }
  return out;
}
```

- [ ] **Step 3: `lookupCorrections` — thread 동봉**

Find:

```js
async function lookupCorrections(ids) {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.collection('corrections').doc(id)));
  return snaps.filter((s) => s.exists).map((s) => {
    const d = s.data();
    return { id: s.id, label: d.label ?? null, field: d.field ?? null,
      status: d.status ?? 'pending', autoApplied: d.autoApplied === true,
      // 팝업 seen 키에 쓰므로 millis 로 — 관리자가 사후 메모를 남겨 repliedAt 이 갱신되면 다시 뜬다.
      reply: d.reply ?? null, repliedAt: d.repliedAt?.toMillis?.() ?? null };
  });
}
```

Replace with:

```js
async function lookupCorrections(ids) {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.collection('corrections').doc(id)));
  const rows = snaps.filter((s) => s.exists).map((s) => {
    const d = s.data();
    return { id: s.id, label: d.label ?? null, field: d.field ?? null,
      status: d.status ?? 'pending', autoApplied: d.autoApplied === true,
      reply: d.reply ?? null, repliedAt: d.repliedAt?.toMillis?.() ?? null,
      threadId: d.threadId ?? null };
  });
  const threads = await loadThreads(rows.map((r) => ({ threadId: r.threadId, myKey: r.id })));
  return rows.map((r) => ({ ...r, thread: r.threadId ? (threads[r.threadId] ?? null) : null }));
}
```

- [ ] **Step 4: `lookupAppReports` — thread 동봉**

Find:

```js
async function lookupAppReports(ids) {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.collection('appReports').doc(id)));
  return snaps.filter((s) => s.exists).map((s) => {
    const d = s.data();
    return { id: s.id, text: d.text ?? '', status: d.status ?? 'pending',
      reply: d.reply ?? null, replyStatus: d.replyStatus ?? null, repliedAt: d.repliedAt ?? null };
  });
}
```

Replace with:

```js
async function lookupAppReports(ids) {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.collection('appReports').doc(id)));
  const rows = snaps.filter((s) => s.exists).map((s) => {
    const d = s.data();
    return { id: s.id, text: d.text ?? '', status: d.status ?? 'pending',
      reply: d.reply ?? null, replyStatus: d.replyStatus ?? null, repliedAt: d.repliedAt ?? null,
      threadId: d.threadId ?? null };
  });
  const threads = await loadThreads(rows.map((r) => ({ threadId: r.threadId, myKey: r.id })));
  return rows.map((r) => ({ ...r, thread: r.threadId ? (threads[r.threadId] ?? null) : null }));
}
```

- [ ] **Step 5: `lookupContentReports` — uid 파라미터 + thread 동봉**

Find the whole `lookupContentReports` function ([feedback.js:38-63](../../../firebase/functions/src/feedback.js#L38)). Replace with:

```js
async function lookupContentReports(refs, uid) {
  const list = (Array.isArray(refs) ? refs : [])
    .filter((r) => r && CONTENT_COLLECTION[r.type] && typeof r.id === 'string' && r.id.length <= 64)
    .slice(0, 30);
  if (!list.length) return [];

  const salt = actorHashSalt.value();
  const out = [];
  for (const { type, id } of list) {
    const threadId = threadIdFor('content_report', { type, id });
    const [delSnap, docSnap, threadSnap] = await Promise.all([
      db.collection('deletedContent').where('origId', '==', id).limit(1).get(),
      db.collection(CONTENT_COLLECTION[type]).doc(id).get(),
      db.collection('feedbackThreads').doc(threadId).get(),
    ]);

    let outcome = null;
    let note = null;
    if (!delSnap.empty) { outcome = 'removed'; note = delSnap.docs[0].get('adminNote') ?? null; }
    else if (!docSnap.exists) { outcome = 'removed'; }
    else if (docSnap.get('reportEditedAt')) { outcome = 'edited'; note = docSnap.get('reportEditNote') ?? null; }
    else if (docSnap.get('reportDismissedAt')) { outcome = 'kept'; note = docSnap.get('reportDismissReason') ?? null; }

    let thread = null;
    if (threadSnap.exists) {
      const hash = contentActorHash(salt, uid, type, id);
      const reactId = reportReactionId(type, hash);
      const reactSnap = docSnap.exists
        ? await db.collection(CONTENT_COLLECTION[type]).doc(id).collection('reactions').doc(reactId).get()
        : { exists: false };
      const isReporter = reactSnap.exists || (threadSnap.get('participantKeys') || []).includes(hash);
      if (isReporter) {
        thread = {
          messages: toClientMessages(threadSnap.get('messages'), hash),
          status: threadSnap.get('status') ?? 'open',
          outcome: threadSnap.get('outcome') ?? null,
        };
      }
    }

    if (outcome || thread) out.push({ type, id, outcome, note, thread });
  }
  return out;
}
```

- [ ] **Step 6: `purgeCorrections` — 스레드 정리**

Find the `purgeCorrections` body's final loop:

```js
  if (!stale.length) return;
  for (let i = 0; i < stale.length; i += 400) {
    const batch = db.batch();
    for (const d of stale.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
});
```

Replace with:

```js
  if (!stale.length) return;
  // correction 문서를 지우면서, 그 묶음의 모든 correction 이 이번에 사라진 threadId 는
  // feedbackThreads 문서도 함께 지운다.
  const staleIds = new Set(stale.map((d) => d.id));
  const threadIds = new Set(stale.map((d) => d.get('threadId')).filter(Boolean));
  for (let i = 0; i < stale.length; i += 400) {
    const batch = db.batch();
    for (const d of stale.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
  for (const threadId of threadIds) {
    const tSnap = await db.collection('feedbackThreads').doc(threadId).get();
    if (!tSnap.exists) continue;
    const linked = tSnap.get('correctionIds') || [];
    if (linked.every((id) => staleIds.has(id))) await tSnap.ref.delete();
  }
});
```

- [ ] **Step 7: 문법 + 커밋**

```bash
node --check firebase/functions/src/feedback.js
git add firebase/functions/src/feedback.js
git commit -m "feat: getMyFeedback bundles thread state for all 3 channels; purgeCorrections drains threads

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: 프론트 — `src/lib/feedback.js` 확장

**Files:**
- Modify: `src/lib/feedback.js`

**Interfaces:**
- Consumes: `getMyFeedback` 응답에 이제 각 항목 `thread` 포함.
- Produces: `readThreadSeen()`, `markThreadSeen(threadKey, seq)`.
- Produces: `replyToThread(channel, ref, text)` → `{ ok, status }`. `ref`: `{correctionId}` / `{appReportId}` / `{contentRef:{type,id}}`.
- Produces: `unreadCount(feedback)` → number.
- Produces: `fetchFeedback()` 반환 항목에 `thread` 패스스루.

- [ ] **Step 1: threadSeen 저장소 + 헬퍼 추가**

Find [feedback.js:6-9](../../../src/lib/feedback.js#L6):

```js
const MINE_KEY = 'feedback:mine';   // { appReport: [{id,summary,at}], correction: [{id,summary,at}] }
const SEEN_KEY = 'feedback:seen';   // ["appReport:<id>", "correction:<id>", "content:<type>_<id>"]
const REACTED_KEY = 'bb-reacted';   // reactions.js 와 공유 — 신고한 콘텐츠 추적
const MAX = 30;
```

Replace with:

```js
const MINE_KEY = 'feedback:mine';   // { appReport: [{id,summary,at}], correction: [{id,summary,at}] }
const SEEN_KEY = 'feedback:seen';   // ["appReport:<id>", "correction:<id>", "content:<type>_<id>"]
const TSEEN_KEY = 'feedback:threadSeen'; // { "<threadId>": <lastSeenSeq> }
const REACTED_KEY = 'bb-reacted';   // reactions.js 와 공유 — 신고한 콘텐츠 추적
const MAX = 30;

// 스레드별로 "여기까지 읽음" seq. 스레드 문서 ID 는 클라가 모르지만, 채널+ref 로 안정적인
// 로컬 키를 만든다(서버 threadId 와 같을 필요 없음 — 이 기기 안에서만 쓴다).
export function threadKeyOf(item) {
  if (item.kind === 'correction') return `correction:${item.id}`;
  if (item.kind === 'appReport') return `appReport:${item.id}`;
  if (item.kind === 'content') return `content:${item.type}_${item.id}`;
  return null;
}
export function readThreadSeen() { return readObj(TSEEN_KEY, {}); }
export function markThreadSeen(key, seq) {
  if (!key) return;
  const all = readThreadSeen();
  if (!(all[key] >= seq)) { all[key] = seq; writeObj(TSEEN_KEY, all); }
}
function lastSeq(thread) {
  return thread && thread.messages && thread.messages.length ? thread.messages[thread.messages.length - 1].seq : 0;
}
function lastAdminSeq(thread) {
  if (!thread || !thread.messages) return 0;
  for (let i = thread.messages.length - 1; i >= 0; i--) if (thread.messages[i].who === 'admin') return thread.messages[i].seq;
  return 0;
}
```

- [ ] **Step 2: `replyToThread` + `unreadCount` 추가**

`submitCorrection` export 뒤(현재 [feedback.js:76](../../../src/lib/feedback.js#L76))에 추가:

```js
// 스레드 답장 — 익명. ref: {correctionId} | {appReportId} | {contentRef:{type,id}}
export async function replyToThread(channel, ref, text) {
  const endpoint = await currentEndpoint();
  const r = await callFn('replyFeedbackThread', {
    channel, text, ...ref, ...(endpoint ? { endpoint } : {}),
  });
  return { ok: r.ok, status: r.status };
}

// 🚩 배지 수 — 스레드에 안 읽은 관리자 메시지가 있거나, closed 인데 결과를 아직 안 본 항목 수.
export function unreadCount(feedback) {
  const seenT = readThreadSeen();
  const seen = new Set(readSeen());
  let n = 0;
  const scan = (item) => {
    const key = threadKeyOf(item);
    const t = item.thread;
    const hasNewAdmin = t && lastAdminSeq(t) > (seenT[key] ?? 0);
    const outcomeKey = key; // content/correction/appReport seen 키와 동일 형식
    const hasNewOutcome = t && t.status === 'closed' && !seen.has(outcomeKey)
      || (item.kind === 'correction' && !t && ['applied', 'rejected', 'resolved'].includes(item.status) && !seen.has(outcomeKey));
    if (hasNewAdmin || hasNewOutcome) n += 1;
  };
  (feedback.corrections || []).forEach((c) => scan({ ...c, kind: 'correction' }));
  (feedback.appReports || []).forEach((a) => scan({ ...a, kind: 'appReport' }));
  (feedback.contentReports || []).forEach((c) => scan({ ...c, kind: 'content' }));
  return n;
}
```

- [ ] **Step 3: `fetchFeedback` — thread 패스스루**

Find the return of `fetchFeedback`:

```js
  return {
    appReports: appReports.map((i) => ({ ...i, summary: i.text || sumOf('appReport', i.id) })),
    corrections: corrections.map((i) => ({ ...i, summary: sumOf('correction', i.id) || i.label || '수정 제안' })),
    contentReports: r.data?.contentReports ?? [],
  };
```

`thread` 는 이미 `...i` 로 넘어오므로 변경 불필요 — `contentReports` 도 그대로. **이 스텝은 확인만**: `appReports`/`corrections` 항목에 `thread` 가 살아있는지 (스프레드로 유지됨). 코드 변경 없음.

- [ ] **Step 4: 빌드 + 커밋**

```bash
npm run build
git add src/lib/feedback.js
git commit -m "feat: feedback lib — thread seen tracking, replyToThread, unread badge count

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: 프론트 — `FeedbackThread` 컴포넌트 + `/feedback` 페이지 + 라우트

**Files:**
- Create: `src/components/FeedbackThread.jsx`
- Create: `src/pages/Feedback.jsx`
- Create: `src/styles/feedback.css`
- Modify: `src/App.jsx`

**Interfaces:**
- Consumes: `fetchFeedback`, `replyToThread`, `markThreadSeen`, `threadKeyOf` (Task 4).
- Produces: `<FeedbackThread item={...} onReplied={fn} />` — 메시지 목록 + (status==='open' 시) 답장 입력.
- Produces: `/feedback` 라우트 → `<Feedback />`.

- [ ] **Step 1: `FeedbackThread.jsx`**

```jsx
import { useEffect, useRef, useState } from 'react';
import { replyToThread, markThreadSeen, threadKeyOf } from '../lib/feedback';

// 한 항목(수정제안/앱문제/신고)의 대화. item.kind ∈ 'correction'|'appReport'|'content'.
// item.thread = { messages:[{seq,who,pid,text,at}], status, outcome } | null.
const REPLY_REF = {
  correction: (it) => ({ correctionId: it.id }),
  appReport: (it) => ({ appReportId: it.id }),
  content: (it) => ({ contentRef: { type: it.type, id: it.id } }),
};

function fmtAt(at) {
  const ms = at?._seconds ? at._seconds * 1000 : (at?.seconds ? at.seconds * 1000 : (typeof at === 'number' ? at : Date.parse(at)));
  return ms ? new Date(ms).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
}

export default function FeedbackThread({ item, onReplied }) {
  const t = item.thread;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    if (t && t.messages.length) markThreadSeen(threadKeyOf(item), t.messages[t.messages.length - 1].seq);
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [item, t]);

  if (!t) return <p className="fb-thread-empty">검토 대기 중이에요. 관리자가 확인하면 여기에 표시됩니다.</p>;

  async function send() {
    const v = text.trim();
    if (!v) return;
    setBusy(true); setErr('');
    const r = await replyToThread(item.kind === 'appReport' ? 'app_report' : item.kind === 'content' ? 'content_report' : 'correction',
      REPLY_REF[item.kind](item), v);
    setBusy(false);
    if (!r.ok) { setErr(r.status === 'FULL' ? '대화가 가득 찼어요.' : '전송에 실패했어요.'); return; }
    setText('');
    onReplied?.();
  }

  return (
    <div className="fb-thread">
      <ul className="fb-msgs">
        {t.messages.map((m) => (
          <li key={m.seq} className={`fb-msg fb-msg-${m.who}`}>
            <span className="fb-msg-who">{m.who === 'admin' ? '관리자' : m.who === 'me' ? '나' : `제안자 ${m.pid}`}</span>
            <p className="fb-msg-text">{m.text}</p>
            <span className="fb-msg-at">{fmtAt(m.at)}</span>
          </li>
        ))}
        <li ref={endRef} />
      </ul>
      {t.status === 'open' ? (
        <div className="fb-reply">
          <textarea rows={2} value={text} maxLength={1000} placeholder="답장 입력…"
            onChange={(e) => setText(e.target.value)} />
          <button className="btn-add btn-sm" disabled={busy || !text.trim()} onClick={send}>보내기</button>
        </div>
      ) : (
        <p className="fb-thread-status">{t.status === 'closed' ? '처리 완료' : '관리자 확인 중'}</p>
      )}
      {err && <p className="error-msg">{err}</p>}
    </div>
  );
}
```

- [ ] **Step 2: `feedback.css`**

```css
.fb-page { padding: 1rem; }
.fb-new-btn { margin-bottom: 1rem; }
.fb-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.fb-row { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 0.75rem 0.9rem; cursor: pointer; }
.fb-row-head { display: flex; align-items: center; gap: 0.5rem; }
.fb-row-title { font-weight: 600; font-size: 0.92rem; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-row-badge { font-size: 0.72rem; padding: 0.1rem 0.4rem; border-radius: 6px; background: var(--chip-bg); color: var(--chip-fg); }
.fb-row-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger, #e5484d); }
.fb-row-sum { margin: 0.25rem 0 0; font-size: 0.82rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fb-thread { margin-top: 0.6rem; }
.fb-thread-empty, .fb-thread-status { font-size: 0.82rem; color: var(--text-muted); margin: 0.5rem 0 0; }
.fb-msgs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; max-height: 50vh; overflow-y: auto; }
.fb-msg { display: flex; flex-direction: column; max-width: 82%; padding: 0.4rem 0.6rem; border-radius: 10px; }
.fb-msg-admin { align-self: flex-start; background: var(--chip-bg); }
.fb-msg-me { align-self: flex-end; background: var(--accent-soft, #dbeafe); }
.fb-msg-other { align-self: flex-start; background: var(--surface-2, #f1f1f4); }
.fb-msg-who { font-size: 0.68rem; color: var(--text-muted); }
.fb-msg-text { margin: 0.1rem 0; font-size: 0.88rem; white-space: pre-wrap; word-break: break-word; }
.fb-msg-at { font-size: 0.64rem; color: var(--text-muted); align-self: flex-end; }
.fb-reply { display: flex; gap: 0.4rem; margin-top: 0.5rem; }
.fb-reply textarea { flex: 1; resize: none; }
.home-flag-wrap { position: relative; display: inline-flex; }
.home-flag-badge { position: absolute; top: -4px; right: -4px; min-width: 15px; height: 15px; padding: 0 3px; border-radius: 999px; background: var(--danger, #e5484d); color: #fff; font-size: 0.6rem; line-height: 15px; text-align: center; font-weight: 700; }
```

> `var(--*)` 토큰은 [[design-system-tokens]] 규칙 — 없는 토큰은 fallback 을 함께 적었다. 빌드 후 실제 토큰명(`src/styles/tokens.css` 등)과 맞는지 한 번 확인하고, 어긋나면 기존 토큰으로 교체.

- [ ] **Step 3: `Feedback.jsx`**

```jsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BackButton from '../components/BackButton';
import AppReportModal from '../components/AppReportModal';
import FeedbackThread from '../components/FeedbackThread';
import { fetchFeedback, readThreadSeen, threadKeyOf } from '../lib/feedback';
import '../styles/feedback.css';

const CH_ICON = { correction: '🚩', appReport: '🐞', content: '🚨' };
const OUTCOME_LABEL = {
  applied: '반영됨', rejected: '반려', resolved: '처리됨',
  removed: '삭제 조치', kept: '유지', edited: '수정 조치',
  reviewing: '검토중', planned: '반영예정', done: '완료',
};

function statusBadge(item) {
  const t = item.thread;
  if (t?.status === 'open') return '답장 필요';
  if (t?.outcome) return OUTCOME_LABEL[t.outcome] || '완료';
  if (t?.status === 'answered') return '관리자 확인 중';
  if (t?.status === 'closed') return '완료';
  if (item.kind === 'correction' && ['applied', 'rejected', 'resolved'].includes(item.status)) return OUTCOME_LABEL[item.status];
  return '검토 대기';
}

export default function Feedback() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);   // threadKey
  const [modal, setModal] = useState(false);

  const load = useCallback(async () => {
    const f = await fetchFeedback().catch(() => null);
    if (!f) return;
    const all = [
      ...(f.corrections || []).map((c) => ({ ...c, kind: 'correction', title: c.summary || c.label || '수정 제안', at: c.repliedAt || 0 })),
      ...(f.contentReports || []).map((c) => ({ ...c, kind: 'content', title: `신고 · ${c.type}`, at: 0 })),
      ...(f.appReports || []).map((a) => ({ ...a, kind: 'appReport', title: a.summary || a.text || '앱 문제', at: 0 })),
    ];
    setRows(all);
  }, []);

  useEffect(() => { load(); }, [load]);

  const seenT = readThreadSeen();
  const hasUnread = (item) => {
    const t = item.thread;
    if (!t) return false;
    const lastAdmin = [...t.messages].reverse().find((m) => m.who === 'admin');
    return lastAdmin && lastAdmin.seq > (seenT[threadKeyOf(item)] ?? 0);
  };

  return (
    <div className="page fb-page">
      <header className="page-header"><BackButton /><h2>내 피드백</h2></header>
      <button className="btn-add fb-new-btn" onClick={() => setModal(true)}>🐞 앱 문제 신고</button>

      {rows.length === 0 && <p className="fb-thread-empty">보낸 제안·신고가 없어요.</p>}
      <ul className="fb-list">
        {rows.map((item) => {
          const key = threadKeyOf(item);
          const isOpen = open === key;
          return (
            <li key={key} className="fb-row" onClick={() => setOpen(isOpen ? null : key)}>
              <div className="fb-row-head">
                <span>{CH_ICON[item.kind]}</span>
                <span className="fb-row-title">{item.title}</span>
                <span className="fb-row-badge">{statusBadge(item)}</span>
                {hasUnread(item) && <span className="fb-row-dot" />}
              </div>
              {!isOpen && <p className="fb-row-sum">{item.thread ? `대화 ${item.thread.messages.length}개` : '검토 대기 중'}</p>}
              {isOpen && <div onClick={(e) => e.stopPropagation()}><FeedbackThread item={item} onReplied={load} /></div>}
            </li>
          );
        })}
      </ul>

      {modal && <AppReportModal onClose={() => { setModal(false); load(); }} />}
    </div>
  );
}
```

- [ ] **Step 4: `App.jsx` 라우트**

Find:

```js
const Calc = lazy(() => import('./pages/Calc'));
```

Add after:

```js
const Feedback = lazy(() => import('./pages/Feedback'));
```

Find:

```jsx
          <Route path="/calc" element={<ProtectedRoute><Calc /></ProtectedRoute>} />
```

Add after:

```jsx
          <Route path="/feedback" element={<ProtectedRoute><Feedback /></ProtectedRoute>} />
```

- [ ] **Step 5: 빌드 + 커밋**

```bash
npm run build
git add src/components/FeedbackThread.jsx src/pages/Feedback.jsx src/styles/feedback.css src/App.jsx
git commit -m "feat: /feedback hub page + FeedbackThread component

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: 프론트 — 홈 🚩 → `/feedback` + 안읽음 배지

**Files:**
- Modify: `src/pages/Home.jsx`

**Interfaces:**
- Consumes: `fetchFeedback`, `unreadCount` (Task 4).

- [ ] **Step 1: import 정리**

Find [Home.jsx:6](../../../src/pages/Home.jsx#L6) 부근 + [Home.jsx:22](../../../src/pages/Home.jsx#L22):

```js
import FeedbackPopup from '../components/FeedbackPopup';
```
```js
import AppReportModal from '../components/AppReportModal';
```

`AppReportModal` import 줄을 삭제하고(더 이상 홈에서 직접 안 씀), 대신:

```js
import { fetchFeedback, unreadCount } from '../lib/feedback';
```

를 `FeedbackPopup` import 아래에 추가.

- [ ] **Step 2: 배지 상태 + 로드**

Find [Home.jsx:96](../../../src/pages/Home.jsx#L96):

```js
  const [appReportOpen, setAppReportOpen] = useState(false);   // 앱 문제 리포트 모달(🚩)
```

Replace with:

```js
  const [fbUnread, setFbUnread] = useState(0);   // 🚩 배지 — 안 읽은 피드백 수
```

`Home()` 컴포넌트 본문의 다른 `useEffect` 들 근처에 추가:

```js
  useEffect(() => {
    let on = true;
    fetchFeedback().then((f) => { if (on) setFbUnread(unreadCount(f)); }).catch(() => {});
    return () => { on = false; };
  }, []);
```

- [ ] **Step 3: 헤더 버튼 교체**

Find [Home.jsx:384-386](../../../src/pages/Home.jsx#L384):

```jsx
        <div className="home-header-actions">
          <button className="link-btn" onClick={() => setAppReportOpen(true)} title="앱 문제 리포트" aria-label="앱 문제 리포트">🚩</button>
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link" title="검열" aria-label="검열">🧹</Link>}
        </div>
```

Replace with:

```jsx
        <div className="home-header-actions">
          <Link to="/feedback" className="link-btn home-flag-wrap" title="내 피드백" aria-label="내 피드백">
            🚩{fbUnread > 0 && <span className="home-flag-badge">{fbUnread > 9 ? '9+' : fbUnread}</span>}
          </Link>
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link" title="검열" aria-label="검열">🧹</Link>}
        </div>
```

- [ ] **Step 4: `AppReportModal` 렌더 제거**

`Home.jsx` 하단에서 `{appReportOpen && <AppReportModal ... />}` 렌더 줄을 찾아 삭제. (`grep -n "appReportOpen\|AppReportModal" src/pages/Home.jsx` 로 잔여 참조 0 확인.)

- [ ] **Step 5: 빌드 + 커밋**

```bash
npm run build
grep -n "appReportOpen\|AppReportModal" src/pages/Home.jsx   # 결과 없어야 함
git add src/pages/Home.jsx
git commit -m "feat: home flag icon opens /feedback hub with unread badge

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: SW — `feedback_question` kind + v15

**Files:**
- Modify: `public/push-sw.js`
- Modify: `vite.config.js`

- [ ] **Step 1: `PUSH_SW_VERSION`**

`public/push-sw.js` — `const PUSH_SW_VERSION = 14;` → `const PUSH_SW_VERSION = 15;`

- [ ] **Step 2: ADMIN_KINDS + 제목**

Find:

```js
  const ADMIN_KINDS = ['correction', 'auto_correction', 'report_deleted', 'app_report', 'app_report_reply', 'feedback_reply'];
```

Replace with:

```js
  const ADMIN_KINDS = ['correction', 'auto_correction', 'report_deleted', 'app_report', 'app_report_reply', 'feedback_reply', 'feedback_question'];
```

Find:

```js
  const title = admin ? (msg.title || ((msg.kind === 'app_report_reply' || msg.kind === 'feedback_reply') ? '📬 결과 알림' : '🔔 관리자 알림'))
```

Replace with:

```js
  const title = admin ? (msg.title || ((msg.kind === 'app_report_reply' || msg.kind === 'feedback_reply') ? '📬 결과 알림' : msg.kind === 'feedback_question' ? '💬 확인 요청' : '🔔 관리자 알림'))
```

- [ ] **Step 3: `vite.config.js`**

`importScripts: ['push-sw.js?v=14'],` → `importScripts: ['push-sw.js?v=15'],`

- [ ] **Step 4: 빌드 + 커밋**

```bash
npm run build
git add public/push-sw.js vite.config.js
git commit -m "feat: SW handles feedback_question push kind; bump sw v15

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

# Phase 2 — 수정 제안 스레드

### Task 8: 백엔드 — `ask_feedback_question` 액션 + `submitCorrection` 자동반영 게이트

**Files:**
- Modify: `firebase/functions/src/admin.js`
- Modify: `firebase/functions/src/admin/moderationActions.js`
- Modify: `firebase/functions/src/corrections.js`

**Interfaces:**
- Consumes: `askFeedbackQuestionInternal` (Task 2), `threadIdFor`/`groupKeyOf` (Task 1).
- Produces: `ask_feedback_question` adminAction — `{ channel, ids?/contentRef?/appReportId?, text, close?, outcome? }`.

- [ ] **Step 1: `admin.js` — `actorHashSalt` 시크릿 바인딩**

`replyFeedbackThread` 는 별도 onCall 이라 무관하지만, `ask_feedback_question` 이 `content_report` 브랜치에서 `reactions` 를 읽을 때 salt 는 필요 없다(actorHash 재계산은 생도 쪽만). **이 스텝은 변경 없음** — 확인만: `adminAction` 시크릿은 이미 `[pushFanoutUrl, pushFanoutSecret]`, 그걸로 충분.

- [ ] **Step 2: `moderationActions.js` — import + 액션**

Find [moderationActions.js:1-6](../../../firebase/functions/src/admin/moderationActions.js#L1):

```js
import { FieldPath } from 'firebase-admin/firestore';
import { db, FieldValue, invalid } from '../lib/context.js';
import { applyCorrectionRowInternal } from '../corrections.js';
import { archiveDeleted } from '../lib/archive.js';
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
import { askFeedbackQuestionInternal } from '../feedbackThreads.js';

// 관리자 username 스냅샷 — 스레드 메시지에 "누가 썼는지"(관리자끼리만 보임).
async function adminNameOf(uid) {
  try { return (await db.collection('users').doc(uid).get()).get('username') ?? null; }
  catch { return null; }
}

async function askFeedbackQuestion(uid, payload) {
  const adminName = await adminNameOf(uid);
  return askFeedbackQuestionInternal({ uid, adminName, ...payload });
}
```

- [ ] **Step 3: 액션 등록**

Find the `moderationActions` export object, add entry (near `annotate_correction`):

```js
  annotate_correction: annotateCorrection,
```

Replace with:

```js
  annotate_correction: annotateCorrection,
  ask_feedback_question: askFeedbackQuestion,
```

- [ ] **Step 4: `annotateCorrection` 재구현 (스레드 후속 메시지)**

Find [moderationActions.js:236-245](../../../firebase/functions/src/admin/moderationActions.js#L236) (`annotateCorrection`). Replace with:

```js
// 처리함에서 사후 메시지 — 이미 처리된 제안 스레드에 관리자 메시지를 하나 더 붙이고
// status='open' 으로 되돌려 제출자에게 다시 뜨게 한다(옛 '사후 메모'의 대체).
async function annotateCorrection(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  const snap = await db.collection('corrections').doc(id).get();
  if (!snap.exists) return { status: 'GONE' };
  const text = payload.reason != null ? String(payload.reason).trim() : '';
  if (!text) return { status: 'OK' };
  const adminName = await adminNameOf(uid);
  const r = await askFeedbackQuestionInternal({
    uid, adminName, channel: 'correction', ids: [id], text,
  });
  // reply 비정규화(목록 미리보기) 갱신
  await snap.ref.update({ reply: text.slice(0, 300), repliedAt: FieldValue.serverTimestamp() });
  return { status: r.status === 'OK' ? 'OK' : r.status };
}
```

- [ ] **Step 5: `corrections.js` — 자동반영 게이트 + 스레드 링크**

Find [corrections.js:39](../../../firebase/functions/src/corrections.js#L39) 부근 import 영역. Add:

```js
import { threadIdFor } from './lib/feedbackThread.js';
```

(다른 `import` 들과 같은 블록, `adminNotify.js` import 아래.)

Find the auto-apply block [corrections.js:422-424](../../../firebase/functions/src/corrections.js#L422):

```js
  let applied = false;
  if (isAuto && sug != null && dupeCount >= 3) {
    const result = await db.runTransaction((tx) => applyCorrectionRowInternal(tx, db, correctionRef.id));
```

Replace with:

```js
  // 이 묶음에 열린 피드백 스레드가 걸려 있으면(관리자가 확인 질문 중) 자동반영을 보류한다 —
  // 스레드가 closed 되면 다음 제출부터 다시 자동반영.
  let threadOpen = false;
  {
    const tSnap = await db.collection('feedbackThreads')
      .doc(threadIdFor('correction', { target, professorCode, courseCode, year, term, sectionNo, field, suggested: sug }))
      .get();
    threadOpen = tSnap.exists && tSnap.get('status') !== 'closed';
    if (tSnap.exists) {
      // 새 제출도 이 스레드에 연결 — 새 기기가 기존 대화를 본다.
      await correctionRef.update({ threadId: tSnap.id });
      await tSnap.ref.update({ correctionIds: FieldValue.arrayUnion(correctionRef.id) });
    }
  }

  let applied = false;
  if (isAuto && sug != null && dupeCount >= 3 && !threadOpen) {
    const result = await db.runTransaction((tx) => applyCorrectionRowInternal(tx, db, correctionRef.id));
```

- [ ] **Step 6: 문법 + 커밋**

```bash
node --check firebase/functions/src/admin/moderationActions.js
node --check firebase/functions/src/corrections.js
git add firebase/functions/src/admin/moderationActions.js firebase/functions/src/corrections.js
git commit -m "feat: ask_feedback_question action; annotate_correction posts thread message; auto-apply holds on open thread

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: 백엔드 — 수정 제안 처리 액션이 스레드를 close

**Files:**
- Modify: `firebase/functions/src/admin/moderationActions.js`

**Interfaces:**
- Produces: `apply_correction`/`reject_correction`/`resolve_correction` 이 `payload.text`(선택 마감 메시지)를 받아 스레드 close + outcome.

- [ ] **Step 1: 공용 헬퍼 — correction 스레드 close**

`askFeedbackQuestion` 함수 아래에 추가:

```js
// 처리 결과를 스레드에 마감 메시지로 남기고 status='closed' + outcome. 스레드가 없으면 무시.
async function closeCorrectionThread(uid, ids, outcome, text) {
  const first = await db.collection('corrections').doc(String(ids[0])).get();
  if (!first.exists || !first.get('threadId')) return;
  const adminName = await adminNameOf(uid);
  await askFeedbackQuestionInternal({
    uid, adminName, channel: 'correction', ids: ids.map(String),
    text: text && String(text).trim() ? String(text).trim() : outcomeDefaultMsg(outcome),
    close: true, outcome,
  });
}
function outcomeDefaultMsg(outcome) {
  return outcome === 'applied' ? '확인 후 반영했어요. 감사합니다!'
    : outcome === 'rejected' ? '검토했지만 이번엔 반영하지 않았어요.'
    : '확인 후 처리했어요.';
}
```

- [ ] **Step 2: `rejectCorrection`**

Find [moderationActions.js:166-175](../../../firebase/functions/src/admin/moderationActions.js#L166):

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

Replace with:

```js
async function rejectCorrection(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  const ref = db.collection('corrections').doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'OK' };
  const note = noteOf(payload) ?? (payload.text ? String(payload.text).trim().slice(0, 300) : null);
  await ref.update({ status: 'rejected', reply: note, repliedAt: FieldValue.serverTimestamp() });
  await closeCorrectionThread(uid, [id], 'rejected', payload.text ?? payload.reason);
  await pushCorrectionOutcome(await ref.get());
  return { status: 'OK' };
}
```

- [ ] **Step 3: `applyCorrection`**

Find [moderationActions.js:177-199](../../../firebase/functions/src/admin/moderationActions.js#L177). After the `if (status === 'OK' || status === 'ALREADY_DONE') { ... await pushCorrectionOutcome(snap); }` block, and before `return { status };`, insert the thread close:

```js
  if (status === 'OK' || status === 'ALREADY_DONE') {
    const snap = await db.collection('corrections').doc(id).get();
    if (snap.exists) await pushCorrectionOutcome(snap);
    await closeCorrectionThread(uid, [id], 'applied', payload.text ?? payload.reason);
  }
  return { status };
```

(기존 `if (status === 'OK' ...)` 블록을 위 내용으로 교체 — `pushCorrectionOutcome` 호출은 유지하고 `closeCorrectionThread` 한 줄 추가.)

- [ ] **Step 4: `resolveCorrection`**

Find [moderationActions.js:203-221](../../../firebase/functions/src/admin/moderationActions.js#L203). After `await batch.commit();` and the existing push loop, add:

```js
  if (liveRefs.length) {
    const fresh = await db.getAll(...liveRefs);
    for (const s of fresh) await pushCorrectionOutcome(s);
  }
  await closeCorrectionThread(uid, ids.map(String), 'resolved', payload.text ?? payload.reason);
  return { status: 'OK' };
```

(기존 `if (liveRefs.length) {...}` + `return` 을 위로 교체.)

- [ ] **Step 5: 문법 + 커밋**

```bash
node --check firebase/functions/src/admin/moderationActions.js
git add firebase/functions/src/admin/moderationActions.js
git commit -m "feat: correction apply/reject/resolve close the feedback thread with an outcome

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: 프론트 — Moderation 수정 제안 탭 스레드 UI

**Files:**
- Modify: `src/pages/Moderation.jsx`

**Interfaces:**
- Consumes: `ask_feedback_question` action; `list_corrections`/`list_processed_corrections` 는 이제 correction 문서에 `threadId` 포함.
- Note: 스레드 본문(messages)은 관리자 화면에서 별도 조회가 필요하다 — `list_corrections` 응답에 스레드를 실어주는 게 간단하다. **Step 0** 에서 백엔드에 한 줄 추가.

- [ ] **Step 0: 백엔드 — `list_corrections`/`list_processed_corrections` 에 스레드 첨부**

`firebase/functions/src/admin/moderationActions.js` — `listCorrections` 와 `listProcessedCorrections` 가 `items` 를 만들 때, `threadId` 가 있는 항목의 스레드를 `getAll` 로 붙인다. `listCorrections` 를 예로:

Find:

```js
async function listCorrections(uid, payload) {
  const status = payload.status ? String(payload.status) : 'pending';
  const snap = await db.collection('corrections').where('status', '==', status).orderBy('createdAt', 'desc').limit(200).get();
  return { status: 'OK', items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}
```

Replace with:

```js
async function listCorrections(uid, payload) {
  const status = payload.status ? String(payload.status) : 'pending';
  const snap = await db.collection('corrections').where('status', '==', status).orderBy('createdAt', 'desc').limit(200).get();
  return { status: 'OK', items: await withThreads(snap.docs.map((d) => ({ id: d.id, ...d.data() }))) };
}

// 관리자 화면용: correction items[] 에 스레드 메시지(관리자 시야 — username 그대로) 첨부.
async function withThreads(items) {
  const ids = [...new Set(items.map((i) => i.threadId).filter(Boolean))];
  if (!ids.length) return items;
  const snaps = await db.getAll(...ids.map((id) => db.collection('feedbackThreads').doc(id)));
  const byId = {};
  snaps.forEach((s) => { if (s.exists) byId[s.id] = s.data(); });
  return items.map((i) => {
    const t = i.threadId && byId[i.threadId];
    if (!t) return i;
    return { ...i, thread: {
      status: t.status, outcome: t.outcome ?? null,
      messages: (t.messages || []).map((m) => ({
        seq: m.seq, from: m.from, name: m.from === 'admin' ? (m.adminName || '관리자') : `제안자`,
        text: m.text, at: m.at?.toMillis?.() ?? (m.at?._seconds ? m.at._seconds * 1000 : null),
      })),
    } };
  });
}
```

Then `listProcessedCorrections` — same treatment:

Find:

```js
async function listProcessedCorrections() {
  const snap = await db.collection('corrections').orderBy('repliedAt', 'desc').limit(150).get();
  return { status: 'OK', items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}
```

Replace with:

```js
async function listProcessedCorrections() {
  const snap = await db.collection('corrections').orderBy('repliedAt', 'desc').limit(150).get();
  return { status: 'OK', items: await withThreads(snap.docs.map((d) => ({ id: d.id, ...d.data() }))) };
}
```

```bash
node --check firebase/functions/src/admin/moderationActions.js
git add firebase/functions/src/admin/moderationActions.js
git commit -m "feat: list_corrections/list_processed_corrections attach thread messages for admin view

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 1: `Moderation.jsx` — `askQuestion` 핸들러 + 상수**

Find [Moderation.jsx:17](../../../src/pages/Moderation.jsx#L17) 부근 `FIELD_LABEL` 아래에 추가:

```js
const ROOM_QUESTION = '강의실이 변동되었나요? 바뀌었다면 새 강의실 번호를 알려 주세요.';
```

`Moderation()` 컴포넌트 안, `applyGroup` 근처에 추가:

```js
  // 수정 제안 묶음에 질문(또는 후속 메시지). g.ids 전체에 팬아웃.
  async function askGroup(g, text) {
    const t = (text || '').trim();
    if (!t) return;
    const r = await call('ask_feedback_question', { channel: 'correction', ids: g.ids, text: t });
    if (!r.ok) { alert('질문 전송 실패: ' + (r.status ?? '오류')); return; }
    load();
  }
```

- [ ] **Step 2: `CorrectionCard` — 스레드 표시 + 질문 입력**

Find the `CorrectionCard` function ([Moderation.jsx:695-726](../../../src/pages/Moderation.jsx#L695)). Replace its body with:

```jsx
function CorrectionCard({ g, cat, fmtDateTime, onApply, onReject, onEdit, onAsk }) {
  const [note, setNote] = useState('');
  const [q, setQ] = useState('');
  const highRisk = HIGH_RISK.has(`${g.target}:${g.field}`) && g.count >= 3;
  const memo = note.trim() || undefined;
  const thread = g.thread;
  const isRoom = g.target === 'section_time' && g.field === 'room';
  return (
    <li className={`card mod-card ${highRisk ? 'flagged' : ''}`}>
      <div className="mod-card-top">
        <span className="tag tag-primary mod-type">{g.target === 'section_add' ? '분반추가' : '수정제안'}</span>
        <span className="mod-course">{g.label || g.target} · <span className="mod-corr-field">{FIELD_LABEL[g.field] || g.field}</span></span>
        {g.count > 1 && <span className="tag mod-badge">동일 {g.count}건</span>}
        {highRisk && <span className="tag tag-warn mod-badge">⚠ 검토 필요</span>}
        {thread?.status === 'open' && <span className="tag mod-badge">⏳ 답변 대기</span>}
        {thread?.status === 'answered' && <span className="tag tag-warn mod-badge">● 새 답변</span>}
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

      {thread && thread.messages.length > 0 && (
        <ul className="mod-thread">
          {thread.messages.map((m) => (
            <li key={m.seq} className={`mod-thread-msg mod-thread-${m.from}`}>
              <b>{m.from === 'admin' ? m.name : `제안자`}</b> {m.text}
            </li>
          ))}
        </ul>
      )}

      <div className="mod-ask">
        {isRoom && !thread && (
          <button type="button" className="link-btn" onClick={() => onAsk(g, ROOM_QUESTION)}>💬 강의실 변동 확인</button>
        )}
        <textarea className="ar-reply-ta" rows={2} value={q} maxLength={1000}
          placeholder="제출자에게 질문 (보내면 답이 올 때까지 대기)"
          onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn-ghost btn-sm" disabled={!q.trim()} onClick={() => { onAsk(g, q); setQ(''); }}>질문 보내기</button>
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
```

- [ ] **Step 3: `CorrectionCard` 호출부에 `onAsk` 전달**

Find [Moderation.jsx:592-595](../../../src/pages/Moderation.jsx#L592):

```jsx
            {corrGroups.map((g) => (
              <CorrectionCard key={`corr-${g.id}`} g={g} cat={cat} fmtDateTime={fmtDateTime}
                onApply={applyGroup} onReject={rejectGroup} onEdit={openEdit} />
            ))}
```

Replace with:

```jsx
            {corrGroups.map((g) => (
              <CorrectionCard key={`corr-${g.id}`} g={g} cat={cat} fmtDateTime={fmtDateTime}
                onApply={applyGroup} onReject={rejectGroup} onEdit={openEdit} onAsk={askGroup} />
            ))}
```

- [ ] **Step 4: `groupCorrections` — thread 도 묶음 대표로 전달**

Find [Moderation.jsx:158-166](../../../src/pages/Moderation.jsx#L158):

```js
function groupCorrections(list) {
  const m = new Map();
  for (const c of list) {
    const k = groupKey(c);
    if (!m.has(k)) m.set(k, { ...c, ids: [c.id], count: 1 });
    else { const g = m.get(k); g.ids.push(c.id); g.count++; }
  }
  return [...m.values()];
}
```

Replace with:

```js
function groupCorrections(list) {
  const m = new Map();
  for (const c of list) {
    const k = groupKey(c);
    if (!m.has(k)) m.set(k, { ...c, ids: [c.id], count: 1 });
    else {
      const g = m.get(k); g.ids.push(c.id); g.count++;
      if (c.thread && !g.thread) g.thread = c.thread;   // 스레드는 묶음 어느 문서에나 같은 threadId
    }
  }
  return [...m.values()];
}
```

- [ ] **Step 5: `applyGroup`/`rejectGroup` — 마감 메시지 전달(선택)**

Find [Moderation.jsx:387-396](../../../src/pages/Moderation.jsx#L387) `applyGroup`:

```js
  async function applyGroup(g, note) {
    for (const id of g.ids) {
      const r = await call('apply_correction', { id, reason: note });
```

Replace with:

```js
  async function applyGroup(g, note) {
    for (const id of g.ids) {
      const r = await call('apply_correction', { id, reason: note, text: note });
```

Same for `rejectGroup` [Moderation.jsx:402-406](../../../src/pages/Moderation.jsx#L402):

```js
  async function rejectGroup(g, note) {
    if (!confirm('이 제안을 반려할까요?')) return;
    for (const id of g.ids) await call('reject_correction', { id, reason: note });
```

Replace with:

```js
  async function rejectGroup(g, note) {
    if (!confirm('이 제안을 반려할까요?')) return;
    for (const id of g.ids) await call('reject_correction', { id, reason: note, text: note });
```

- [ ] **Step 6: `ProcessedCorrectionCard` — 대화 펼침**

Find `ProcessedCorrectionCard` ([Moderation.jsx:731-770](../../../src/pages/Moderation.jsx#L731)). Replace with:

```jsx
function ProcessedCorrectionCard({ c, fmtDateTime, onAnnotate }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const statusLabel = c.autoApplied ? '자동 반영' : (CORR_STATUS_LABEL[c.status] || c.status);
  const thread = c.thread;
  const last = thread?.messages?.[thread.messages.length - 1];

  async function save() {
    if (!note.trim()) return;
    setBusy(true);
    await onAnnotate(c.id, note.trim());
    setBusy(false); setNote('');
  }

  return (
    <li className="card mod-card">
      <div className="mod-card-top" onClick={() => setOpen((v) => !v)} style={{ cursor: 'pointer' }}>
        <span className={`tag mod-type ${c.status === 'rejected' ? 'tag-warn' : 'tag-primary'}`}>{statusLabel}</span>
        <span className="mod-course">{c.label || c.target} · <span className="mod-corr-field">{FIELD_LABEL[c.field] || c.field}</span></span>
        <span className="mod-time">{fmtDateTime(c.repliedAt)}</span>
      </div>
      {!open && last && <p className="mod-corr-note">↳ {last.from === 'admin' ? (last.name || '관리자') : '제안자'}: {last.text}</p>}
      {open && (
        <>
          {(c.prevValue || c.suggested) && (
            <p className="mod-corr-diff">
              <span className="mod-diff-label">이전</span>
              <span className="mod-diff-before">{c.prevValue ?? '—'}</span>
              <span className="mod-diff-arrow">→</span>
              <span className="mod-diff-label">제안</span>
              <b className="mod-diff-after">{c.suggested ? fmtCorrAfter(c) : '—'}</b>
            </p>
          )}
          {thread && thread.messages.length > 0 && (
            <ul className="mod-thread">
              {thread.messages.map((m) => (
                <li key={m.seq} className={`mod-thread-msg mod-thread-${m.from}`}>
                  <b>{m.from === 'admin' ? (m.name || '관리자') : '제안자'}</b> {m.text}
                </li>
              ))}
            </ul>
          )}
          <textarea className="ar-reply-ta" rows={2} value={note} maxLength={1000}
            placeholder="후속 메시지 (보내면 제출자에게 다시 표시됩니다)"
            onChange={(e) => setNote(e.target.value)} />
          <div className="mod-actions">
            <button className="btn-add btn-sm" disabled={busy || !note.trim()} onClick={save}>메시지 보내기</button>
          </div>
        </>
      )}
    </li>
  );
}
```

- [ ] **Step 7: CSS — `mod-thread`**

Append to `src/styles/correction.css` (또는 `src/styles/admin.css` — Moderation 이 둘 다 import):

```css
.mod-thread { list-style: none; margin: 0.5rem 0; padding: 0.5rem; background: var(--surface-2, #f5f5f7); border-radius: 8px; display: flex; flex-direction: column; gap: 0.3rem; }
.mod-thread-msg { font-size: 0.82rem; }
.mod-thread-msg b { font-size: 0.72rem; color: var(--text-muted); margin-right: 0.3rem; }
.mod-thread-admin { color: var(--text); }
.mod-thread-user { color: var(--accent-strong, #1d4ed8); }
.mod-ask { display: flex; flex-direction: column; gap: 0.35rem; margin: 0.4rem 0; }
```

- [ ] **Step 8: 빌드 + 커밋**

```bash
npm run build
git add src/pages/Moderation.jsx src/styles/correction.css
git commit -m "feat: moderation corrections tab — thread UI, ask question, processed list expands to conversation

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: 프론트 — `FeedbackPopup` 대화형

**Files:**
- Modify: `src/components/FeedbackPopup.jsx`

- [ ] **Step 1: 스레드가 열린 항목이면 인라인 답장**

Find the whole `FeedbackPopup.jsx`. Replace the render of each line to include a thread reply when `l.thread?.status === 'open'`. Full replacement:

```jsx
import { useEffect, useState } from 'react';
import { fetchFeedback, readSeen, markSeen, readThreadSeen, markThreadSeen, threadKeyOf } from '../lib/feedback';
import FeedbackThread from './FeedbackThread';

// 앱 접속 시, 안 본 관리자 메시지·결과를 공지처럼 한 번 띄운다.
const APP_STATUS = { reviewing: '검토중', resolved: '해결됨', planned: '반영예정' };

function hasNewAdmin(item, seenT) {
  const t = item.thread;
  if (!t) return false;
  const lastAdmin = [...t.messages].reverse().find((m) => m.who === 'admin');
  return lastAdmin && lastAdmin.seq > (seenT[threadKeyOf(item)] ?? 0);
}

export default function FeedbackPopup() {
  const [items, setItems] = useState([]);

  const load = () => fetchFeedback().then((f) => {
    const seen = new Set(readSeen());
    const seenT = readThreadSeen();
    const all = [
      ...(f.corrections || []).map((c) => ({ ...c, kind: 'correction', title: c.summary || c.label || '수정 제안' })),
      ...(f.contentReports || []).map((c) => ({ ...c, kind: 'content', title: '신고' })),
      ...(f.appReports || []).map((a) => ({ ...a, kind: 'appReport', title: a.summary || a.text || '앱 문제' })),
    ].filter((item) => {
      if (hasNewAdmin(item, seenT)) return true;
      // 스레드 없는 옛 경로: closed 결과를 아직 안 봤을 때
      const key = threadKeyOf(item);
      if (item.kind === 'correction' && !item.thread && ['applied', 'rejected', 'resolved'].includes(item.status)) return !seen.has(key);
      if (item.kind === 'content' && !item.thread && item.outcome) return !seen.has(key);
      return false;
    });
    setItems(all);
  }).catch(() => {});

  useEffect(() => { load(); }, []);

  if (items.length === 0) return null;

  function close() {
    for (const item of items) {
      const key = threadKeyOf(item);
      markSeen([key]);
      if (item.thread?.messages?.length) markThreadSeen(key, item.thread.messages[item.thread.messages.length - 1].seq);
    }
    setItems([]);
  }

  return (
    <div className="ntc-overlay" onClick={close}>
      <div className="ntc-modal" role="dialog" aria-modal="true" aria-label="피드백" onClick={(e) => e.stopPropagation()}>
        <div className="ntc-head">
          <h3 className="ntc-title">📬 보내주신 의견에 새 소식이 있어요</h3>
          <button className="ntc-x" onClick={close} aria-label="닫기">✕</button>
        </div>
        <div className="ntc-list">
          {items.map((item) => (
            <article key={threadKeyOf(item)} className="ntc-item">
              <div className="ntc-item-head"><strong className="ntc-item-title">{item.title}</strong></div>
              {item.thread
                ? <FeedbackThread item={item} onReplied={load} />
                : <p className="ntc-content">{legacyLine(item)}</p>}
            </article>
          ))}
        </div>
        <button className="btn-add btn-block" onClick={close}>확인</button>
      </div>
    </div>
  );
}

function legacyLine(item) {
  if (item.kind === 'correction') {
    return item.status === 'applied' && item.autoApplied ? '📌 여러 명이 같은 제안을 해서 자동 반영됐어요.'
      : item.status === 'applied' ? '✅ 제안이 반영됐어요.'
      : item.status === 'rejected' ? '🔎 검토했지만 이번엔 반영하지 않았어요.'
      : '✅ 확인 후 처리했어요.';
  }
  if (item.kind === 'content') {
    return item.outcome === 'removed' ? '🗑️ 신고하신 내용이 삭제 조치됐어요.'
      : item.outcome === 'edited' ? '✏️ 신고하신 내용이 수정 조치됐어요.'
      : (item.note ? `검토 결과 유지됩니다: ${item.note}` : '검토 결과 유지됩니다.');
  }
  return item.reply || '답변이 등록됐어요.';
}
```

- [ ] **Step 2: 빌드 + 커밋**

```bash
npm run build
git add src/components/FeedbackPopup.jsx
git commit -m "feat: FeedbackPopup shows conversations with inline reply

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

# Phase 3 — 앱 문제 스레드

### Task 12: 백엔드 — `replyAppReport` → 스레드, `getMyFeedback` app_report 이미 처리됨

**Files:**
- Modify: `firebase/functions/src/admin/moderationActions.js`

**Interfaces:**
- `reply_app_report({ id, reply, replyStatus })` — 스레드에 관리자 메시지 append + status/outcome.
- `list_replied_app_reports` — 스레드 요약 첨부.

- [ ] **Step 1: `replyAppReport` — 스레드 append**

Find [moderationActions.js:289-323](../../../firebase/functions/src/admin/moderationActions.js#L289) (`replyAppReport`). After the existing `await ref.update({ reply, replyStatus, repliedAt, status: 'replied' })`, add before the push block:

```js
  // 스레드에도 관리자 메시지로 남긴다(제출자가 다시 답할 수 있게 status='open').
  const adminName = await adminNameOf(uid);
  await askFeedbackQuestionInternal({
    uid, adminName, channel: 'app_report', appReportId: id, text: reply,
    outcome: replyStatus,   // reviewing|resolved|planned
  });
```

`resolved`/`planned` 도 `status='open'` 으로 두는 건 의도적 — 제출자가 추가로 물을 수 있고, 스레드 요약 배지는 `outcome` 으로 이미 "해결됨" 표시된다. 관리자가 완전히 끝내려면 처리함에서 close.

> 실제로는 `replyStatus==='resolved'` 면 `close:true, outcome:'done'` 로 닫는 게 더 자연스럽다. 아래처럼:

```js
  const adminName = await adminNameOf(uid);
  await askFeedbackQuestionInternal({
    uid, adminName, channel: 'app_report', appReportId: id, text: reply,
    close: replyStatus === 'resolved',
    outcome: replyStatus === 'resolved' ? 'done' : replyStatus,
  });
```

- [ ] **Step 2: `list_replied_app_reports` — 스레드 요약**

Find `listRepliedAppReports` ([moderationActions.js:351-368](../../../firebase/functions/src/admin/moderationActions.js#L351)). In the `.map`, add thread lookup. Simplest: after building `items`, batch-load threads:

```js
async function listRepliedAppReports() {
  const snap = await db.collection('appReports')
    .where('status', '==', 'replied')
    .orderBy('repliedAt', 'desc')
    .limit(50)
    .get();
  const rows = snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id, text: x.text ?? '', path: x.path ?? null,
      reply: x.reply ?? '', replyStatus: x.replyStatus ?? null,
      repliedAt: x.repliedAt ?? null, createdAt: x.createdAt ?? null,
      threadId: x.threadId ?? null,
    };
  });
  return { status: 'OK', items: await withThreads(rows) };
}
```

(`withThreads` from Task 10 Step 0 works — it keys on `.threadId`.)

- [ ] **Step 3: 문법 + 커밋**

```bash
node --check firebase/functions/src/admin/moderationActions.js
git add firebase/functions/src/admin/moderationActions.js
git commit -m "feat: app report replies flow into the feedback thread

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: 프론트 — `AppReportModal` 정리 + Moderation 앱문제 탭 스레드

**Files:**
- Modify: `src/components/AppReportModal.jsx`
- Modify: `src/pages/Moderation.jsx`

- [ ] **Step 1: `AppReportModal` — "내가 보낸 리포트" 는 `/feedback` 로 유도**

`AppReportModal` 은 이제 `/feedback` 페이지에서만 열린다(홈 🚩 제거됨). "내가 보낸 리포트" 목록 섹션은 중복이므로 제거하고, 제출 완료 시 안내만:

Find [AppReportModal.jsx:70-74](../../../src/components/AppReportModal.jsx#L70):

```jsx
        {done ? (
          <div className="cor-done">
            <p>✅ 접수되었습니다. 검토 후 반영됩니다. 감사합니다!</p>
            <button className="btn-add btn-block" onClick={onClose}>닫기</button>
          </div>
        ) : (
```

Replace with:

```jsx
        {done ? (
          <div className="cor-done">
            <p>✅ 접수되었습니다. 검토 후 반영됩니다. 감사합니다!</p>
            <p className="cor-hint">답변·추가 질문은 이 화면(내 피드백)에서 이어집니다.</p>
            <button className="btn-add btn-block" onClick={onClose}>닫기</button>
          </div>
        ) : (
```

Then remove the `{mine.length > 0 && (...)}` block ([AppReportModal.jsx:92-111](../../../src/components/AppReportModal.jsx#L92)) and the `mine`/`fetchMyReports` state + effect ([AppReportModal.jsx:41,43](../../../src/components/AppReportModal.jsx#L41)). Keep `submitReport`.

Final import line becomes:

```js
import { submitAppReport as submitReport } from '../lib/feedback';
```

- [ ] **Step 2: `Moderation.jsx` — `AppReportCard` 질문 버튼**

`AppReportCard` ([Moderation.jsx:819-860](../../../src/pages/Moderation.jsx#L819)) 에 질문 입력을 추가. `replyToAppReport` 는 그대로(이제 백엔드가 스레드에도 append). 질문 버튼:

`AppReportCard` 의 `<div className="mod-actions">` 앞에 삽입:

```jsx
      <div className="mod-ask">
        <textarea className="ar-reply-ta" rows={2} value={reply} maxLength={1000}
          placeholder="답변 / 추가 질문 (제출자에게 전달)"
          onChange={(e) => setReply(e.target.value)} />
      </div>
```

(이미 `reply`/`setReply` state 가 있으므로 재사용. 기존 textarea 는 위 것으로 대체 — 중복 제거.)

`it.thread` 렌더도 추가 (list_app_reports 는 스레드를 아직 안 실어주지만 replied 는 실어줌 — pending 카드엔 보통 스레드 없음):

`<p className="mod-text">{it.text}</p>` 아래에:

```jsx
      {it.thread && it.thread.messages?.length > 0 && (
        <ul className="mod-thread">
          {it.thread.messages.map((m) => (
            <li key={m.seq} className={`mod-thread-msg mod-thread-${m.from}`}>
              <b>{m.from === 'admin' ? (m.name || '관리자') : '제출자'}</b> {m.text}
            </li>
          ))}
        </ul>
      )}
```

- [ ] **Step 3: `list_app_reports` 에도 withThreads (pending 도 답장 왕복 가능)**

`firebase/functions/src/admin/moderationActions.js` — `listAppReports`:

Find:

```js
async function listAppReports() {
  const snap = await db.collection('appReports').where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(200).get();
  return { status: 'OK', items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}
```

Replace with:

```js
async function listAppReports() {
  const snap = await db.collection('appReports').where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(200).get();
  return { status: 'OK', items: await withThreads(snap.docs.map((d) => ({ id: d.id, ...d.data() }))) };
}
```

- [ ] **Step 4: 빌드 + 문법 + 커밋**

```bash
npm run build
node --check firebase/functions/src/admin/moderationActions.js
grep -n "fetchMyAppReports\|fetchMyReports" src/   # AppReportModal 에서 사라졌는지
git add src/components/AppReportModal.jsx src/pages/Moderation.jsx firebase/functions/src/admin/moderationActions.js
git commit -m "feat: app report thread UI in moderation; AppReportModal defers history to /feedback

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

# Phase 4 — 콘텐츠 신고 스레드

### Task 14: 백엔드 — 신고 CF 에 `endpoint`→`subId`

**Files:**
- Modify: `firebase/functions/src/reviews.js`
- Modify: `firebase/functions/src/classMemo.js`
- Modify: `firebase/functions/src/board.js`

- [ ] **Step 1: `reviews.js` `reportReview` — reaction 에 subId**

Find [reviews.js:127-146](../../../firebase/functions/src/reviews.js#L127):

```js
export const reportReview = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { id } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');

  const hash = actorHash(actorHashSalt.value(), uid, 'review-report', id);
```

Replace with:

```js
export const reportReview = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { id, endpoint } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');

  const subId = (typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024)
    ? createHash('sha256').update(endpoint).digest('hex') : null;
  const hash = actorHash(actorHashSalt.value(), uid, 'review-report', id);
```

Add `createHash` to the node:crypto import at top:

Find [reviews.js:1](../../../firebase/functions/src/reviews.js#L1):

```js
import { onCall, HttpsError } from 'firebase-functions/v2/https';
```

Add after the existing imports (reviews.js has no crypto import yet):

```js
import { createHash } from 'node:crypto';
```

Find the reaction write inside the transaction:

```js
    tx.set(reactionRef, { kind: 'report', createdAt: FieldValue.serverTimestamp() });
```

Replace with:

```js
    tx.set(reactionRef, { kind: 'report', subId, createdAt: FieldValue.serverTimestamp() });
```

- [ ] **Step 2: `classMemo.js` `reportMemo` — 동일**

Find [classMemo.js:107-115](../../../firebase/functions/src/classMemo.js#L107):

```js
export const reportMemo = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { id } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');
```

Replace with:

```js
export const reportMemo = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { id, endpoint } = request.data ?? {};
  if (!id) invalid('id가 필요합니다.');
  const subId = (typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024)
    ? createHash('sha256').update(endpoint).digest('hex') : null;
```

Add `import { createHash } from 'node:crypto';` to classMemo.js top imports.

Find:

```js
    tx.set(reactionRef, { kind: 'report', createdAt: FieldValue.serverTimestamp() });
```

Replace with:

```js
    tx.set(reactionRef, { kind: 'report', subId, createdAt: FieldValue.serverTimestamp() });
```

- [ ] **Step 3: `board.js` `boardReact` — report 일 때 reaction 에 subId**

Find [board.js:143-147](../../../firebase/functions/src/board.js#L143):

```js
export const boardReact = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { postId, kind } = request.data ?? {};
```

Replace with:

```js
export const boardReact = onCall({ secrets: [actorHashSalt, pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  const uid = requireAuth(request);
  const { postId, kind, endpoint } = request.data ?? {};
```

Find [board.js:190](../../../firebase/functions/src/board.js#L190):

```js
    tx.set(reactionRef, { kind, createdAt: FieldValue.serverTimestamp() });
```

Replace with:

```js
    const reactExtra = (kind === 'report' && typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024)
      ? { subId: createHash('sha256').update(endpoint).digest('hex') } : {};
    tx.set(reactionRef, { kind, ...reactExtra, createdAt: FieldValue.serverTimestamp() });
```

Add `import { createHash } from 'node:crypto';` to board.js top imports (check it's not already there — board.js may import from a hash lib; add the crypto import regardless if `createHash` isn't imported).

- [ ] **Step 4: 프론트 신고 호출에 endpoint 첨부**

`src/lib/board.js` [board.js:190](../../../src/lib/board.js#L190):

```js
  callFn('boardReact', { postId, kind }).then((r) => (r.ok ? r.data.status : 'ERROR'));
```

이건 like/dislike 도 함께 타므로, report 만 endpoint 를 붙이도록 호출부를 확인. `src/pages/Post.jsx` 또는 `src/lib/reactions.js` 에서 report 를 부르는 곳을 찾는다:

```bash
grep -rn "boardReact\|reportReview\|reportMemo" src/
```

각 report 호출 앞에 endpoint 를 얻어 payload 에 추가. 공용 헬퍼를 `src/lib/feedback.js` 에서 export:

```js
export async function pushEndpoint() { return currentEndpoint(); }
```

그리고 각 호출부 (예: `src/pages/Reviews.jsx` `report()`):

```js
    const r = await callFn('reportReview', { id });
```

→

```js
    const r = await callFn('reportReview', { id, endpoint: await pushEndpoint() });
```

동일하게 `reportMemo`(Memo.jsx), `boardReact` report(Post.jsx / Board.jsx). like/dislike 호출은 건드리지 않는다.

- [ ] **Step 5: 문법 + 빌드 + 커밋**

```bash
node --check firebase/functions/src/reviews.js
node --check firebase/functions/src/classMemo.js
node --check firebase/functions/src/board.js
npm run build
git add firebase/functions/src/reviews.js firebase/functions/src/classMemo.js firebase/functions/src/board.js src/lib/feedback.js src/pages/Reviews.jsx src/pages/Memo.jsx src/pages/Post.jsx
git commit -m "feat: content report CFs capture optional push endpoint for thread notifications

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 15: 프론트 — Moderation 신고 탭 스레드 UI + purge 훅

**Files:**
- Modify: `src/pages/Moderation.jsx`
- Modify: `firebase/functions/src/admin/moderationActions.js`
- Modify: `firebase/functions/src/appReport.js`

- [ ] **Step 1: `list_reported` 에 스레드 첨부**

`moderationActions.js` `listReported` — `items` 를 만든 뒤, 각 `{type,id}` 로 `content_<type>_<id>` 스레드를 batch 조회해 붙인다. `listReported` 의 `return { status: 'OK', items };` 앞에:

```js
  // content_report 스레드 첨부(관리자 시야)
  const tRefs = items.map((it) => db.collection('feedbackThreads').doc(`content_${it.type}_${it.id}`));
  const tSnaps = tRefs.length ? await db.getAll(...tRefs) : [];
  const tById = {};
  tSnaps.forEach((s) => { if (s.exists) tById[s.id] = s.data(); });
  for (const it of items) {
    const t = tById[`content_${it.type}_${it.id}`];
    if (t) it.thread = {
      status: t.status, outcome: t.outcome ?? null,
      messages: (t.messages || []).map((m) => ({
        seq: m.seq, from: m.from, name: m.from === 'admin' ? (m.adminName || '관리자') : '신고자',
        text: m.text, at: m.at?.toMillis?.() ?? (m.at?._seconds ? m.at._seconds * 1000 : null),
      })),
    };
  }
```

- [ ] **Step 2: `Moderation.jsx` `ReportCard` — 질문 + 스레드**

`ReportCard` ([Moderation.jsx:772-817](../../../src/pages/Moderation.jsx#L772)) 에:

`<ModMemo value={note} onChange={setNote} />` 위에:

```jsx
      {it.thread && it.thread.messages?.length > 0 && (
        <ul className="mod-thread">
          {it.thread.messages.map((m) => (
            <li key={m.seq} className={`mod-thread-msg mod-thread-${m.from}`}>
              <b>{m.from === 'admin' ? (m.name || '관리자') : '신고자'}</b> {m.text}
            </li>
          ))}
        </ul>
      )}
      <div className="mod-ask">
        <textarea className="ar-reply-ta" rows={2} value={q} maxLength={1000}
          placeholder="신고자에게 질문 (예: 어느 부분이 문제인가요?)"
          onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn-ghost btn-sm" disabled={!q.trim()}
          onClick={() => { onAsk(it, q); setQ(''); }}>질문 보내기</button>
      </div>
```

`ReportCard` 상단 state 에 `const [q, setQ] = useState('');` 추가.

`ReportCard` 호출부에 `onAsk` 추가:

Find [Moderation.jsx:547-551](../../../src/pages/Moderation.jsx#L547):

```jsx
          {reported.map((it) => (
            <ReportCard key={`rep-${it.type}-${it.id}`} it={it} fmtDateTime={fmtDateTime} navigate={navigate}
              onAck={ackReport} onDismiss={dismissReport} onDelete={remove}
              onEdit={(t, note) => saveEditFrom(it, t, note)} />
          ))}
```

Replace with:

```jsx
          {reported.map((it) => (
            <ReportCard key={`rep-${it.type}-${it.id}`} it={it} fmtDateTime={fmtDateTime} navigate={navigate}
              onAck={ackReport} onDismiss={dismissReport} onDelete={remove} onAsk={askReport}
              onEdit={(t, note) => saveEditFrom(it, t, note)} />
          ))}
```

`Moderation()` 에 핸들러:

```js
  async function askReport(it, text) {
    const t = (text || '').trim();
    if (!t) return;
    const r = await call('ask_feedback_question', {
      channel: 'content_report', contentRef: { type: it.type, id: it.id },
      label: it.courseCode, summary: (it.text || '').slice(0, 200), text: t,
    });
    if (!r.ok) { alert('질문 전송 실패: ' + (r.status ?? '오류')); return; }
    load();
  }
```

- [ ] **Step 3: 신고 처리(삭제/무시/수정)가 스레드 close**

`Moderation.jsx` 에서는 이미 `remove`/`dismissReport`/`saveEditFrom` 이 `call('delete_post'|'dismiss_report'|'edit_post', {..., reason})` 를 부른다. 백엔드에서 이 세 액션이 스레드를 close 하도록:

`moderationActions.js`:
- `deletePost` — `ARCHIVE_ON_DELETE` 브랜치에서 `archiveDeleted` 후, `payload.table`+`id` 로 `content_<table>_<id>` 스레드가 있으면 close(`outcome:'removed'`).
- `dismissReport` — 끝에 스레드 close(`outcome:'kept'`).
- `editPost` — 신고맥락 브랜치(`reportEditedAt` 세팅하는 곳)에서 close(`outcome:'edited'`).

공용 헬퍼 (`closeCorrectionThread` 옆에):

```js
async function closeContentThread(uid, type, id, outcome, text) {
  const tRef = db.collection('feedbackThreads').doc(`content_${type}_${id}`);
  const tSnap = await tRef.get();
  if (!tSnap.exists) return;
  const adminName = await adminNameOf(uid);
  await askFeedbackQuestionInternal({
    uid, adminName, channel: 'content_report', contentRef: { type, id },
    label: tSnap.get('label'), summary: tSnap.get('summary'),
    text: (text && String(text).trim()) || (outcome === 'removed' ? '신고 확인 후 삭제 조치했어요.' : outcome === 'edited' ? '신고 확인 후 수정 조치했어요.' : '검토 결과 유지합니다.'),
    close: true, outcome,
  });
}
```

호출 삽입:
- `deletePost`: `await db.recursiveDelete(ref); return { status: 'OK' };` 바로 앞(ARCHIVE 브랜치)에서 `await closeContentThread(uid, table, id, 'removed', note);`
- `dismissReport`: 함수 마지막 `return { status: 'OK' };` 앞에 `await closeContentThread(uid, table, id, 'kept', reason);`
- `editPost`: 신고맥락 패치 후 `await ref.update(patch);` 다음에 `if (patch.reportEditedAt) await closeContentThread(uid, table, id, 'edited', noteOf(payload));`

- [ ] **Step 4: purge 훅 — `purgeAppReports` 스레드 정리**

`firebase/functions/src/appReport.js` `purgeAppReports` 마지막 배치 루프 뒤에:

```js
  for (const d of stale) {
    const tid = d.get('threadId');
    if (tid) await db.collection('feedbackThreads').doc(tid).delete().catch(() => {});
  }
```

(stale 는 이미 `d.data()` 로 필터했으므로 `d.get('threadId')` 대신 필터 시점에 `x.threadId` 를 함께 캡처하거나, `d.ref` 로 재조회 없이 `d.get`. `d` 는 QueryDocumentSnapshot 이라 `d.get('threadId')` 동작함.)

- [ ] **Step 5: 문법 + 빌드 + 커밋**

```bash
node --check firebase/functions/src/admin/moderationActions.js
node --check firebase/functions/src/appReport.js
npm run build
git add src/pages/Moderation.jsx firebase/functions/src/admin/moderationActions.js firebase/functions/src/appReport.js
git commit -m "feat: content report thread UI + processing closes thread; purge hooks

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

# Phase 5 — 검증 + 배포

### Task 16: 통합 검증 + 배포

- [ ] **Step 1: 전체 문법 + 빌드**

```bash
npm run build
for f in index.js src/corrections.js src/feedback.js src/feedbackThreads.js \
  src/admin.js src/admin/moderationActions.js src/reviews.js src/classMemo.js \
  src/board.js src/appReport.js src/lib/feedbackThread.js; do
  node --check "firebase/functions/$f" || echo "FAIL $f"
done
grep -rn "appReportOpen\|AppReportReplyPopup" src/    # 결과 없어야 함
```

- [ ] **Step 2: 배포**

```bash
git status
git pull --rebase origin main
git push origin main
```

- GitHub Actions `deploy-firebase.yml` 성공 확인 — `replyFeedbackThread`, `purgeContentThreads` 생성, rules 반영.
- Cloudflare Pages 자동 재빌드(push-sw v15).

- [ ] **Step 3: 배포 후 실기기 확인** (스펙 Ⅹ)

1. 강의실 제안 제출 → 관리자 `💬 강의실 변동 확인` → 제출자 앱 재진입 → `FeedbackPopup` 질문 + 답장란 → 답장 → 관리자 카드 `● 새 답변` + "제안자 1: …" → 관리자 `적용` → 제출자 결과 팝업, 🚩 배지 갱신.
2. 같은 제안 3건 중 1건에 열린 스레드 → 3번째 자동반영 안 됨 → 스레드 `closed` 후 4번째 자동반영 재개.
3. 게시글 신고 2명(푸시 구독) → 관리자 질문 → 두 기기 푸시 → 한 명 답 → 다른 한 명도 "제안자 2" 로 봄 → 관리자 삭제 → 양쪽 "삭제 조치".
4. 앱 문제 → 관리자 답변(검토중) → 제출자 추가 질문 → 관리자 재답변 → `resolved` 로 마감 → 답변함 요약 1행, 탭 → 전체 대화.
5. 🚩 → `/feedback` 목록, 행 탭 → 대화, `open` 이면 답장.
6. 회귀: 질문 없이 바로 적용/반려/삭제 → 기존 결과 팝업 정상.

- [ ] **Step 4: 스펙 갱신 + 커밋 + 푸시**

`docs/superpowers/specs/2026-09-04-feedback-two-way-threads-design.md` 하단에:

```markdown
## 구현

2026-09-04 구현·배포 완료. 계획: `docs/superpowers/plans/2026-09-04-feedback-two-way-threads.md`.
```

```bash
git add docs/superpowers/specs/2026-09-04-feedback-two-way-threads-design.md
git commit -m "docs: mark feedback-two-way-threads spec implemented

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git pull --rebase origin main && git push origin main
```

---

## Self-Review

**Spec coverage:**

| 스펙 섹션 | Task |
|---|---|
| Ⅰ `feedbackThreads` 스키마 · threadId · 지연생성 · 표시계약 | 1, 2 |
| Ⅰ 원본 `threadId` 역참조 | 2 (correction/app_report), 8 (submitCorrection link) |
| Ⅱ 채널별 라우팅 · actorHash 검증 | 2 (replyFeedbackThread), 3 (getMyFeedback) |
| Ⅲ `askFeedbackQuestion` | 2 (internal) + 8 (adminAction wrap) |
| Ⅲ `replyFeedbackThread` | 2 |
| Ⅲ 관리자 처리 → close + outcome | 9 (correction), 12 (app_report), 15 (content) |
| Ⅲ `getMyFeedback` thread 동봉 | 3 |
| Ⅲ `submitCorrection` 자동반영 게이트 | 8 |
| Ⅲ 신고 CF endpoint→subId | 14 |
| Ⅲ purge (corrections/appReports/content) | 3, 15 (appReports), 2 (purgeContentThreads) |
| Ⅲ `annotate_correction` 재구현 | 8 |
| Ⅳ 관리자 화면 대기 카드 질문 · 스레드 · 강의실 원터치 | 10 (correction), 13 (app), 15 (content) |
| Ⅳ 처리함/답변함 요약 + 펼침 | 10, 12 |
| Ⅳ 공유(문서 1개, seq 트랜잭션) | 1 (appendMessage) |
| Ⅴ 홈 🚩 → `/feedback` + 배지 | 6 |
| Ⅴ `/feedback` 페이지 | 5 |
| Ⅴ `FeedbackPopup` 대화형 | 11 |
| Ⅴ `src/lib/feedback.js` threadSeen · replyToThread · unreadCount | 4 |
| Ⅵ SW `feedback_question` + v15 | 7 |
| Ⅶ Rules `feedbackThreads` if false · 색인 없음 | 2 |
| Ⅷ 자동반영 상호작용 | 8 |
| Ⅸ 4단계 구현 | Phase 1–4 |
| Ⅹ 테스트 | 16 |

**Placeholder scan:** Task 13 Step 1(AppReportModal 정리 — 삭제할 블록 line 참조 명시), Task 14 Step 4(report 호출부 grep 로 특정), Task 15 Step 3(3개 액션에 close 삽입 지점 서술) 은 "파일 확인 후 정확 위치" 를 명시. 나머지 코드 블록은 완전. `node --check` 로 각 커밋 게이트.

**Type consistency:**
- `threadIdFor(channel, ref)` — Task 1 정의. correction 은 `ref` = correction 데이터(`groupKeyOf` 필드), Task 2/8 이 그 형태로 호출. content 는 `{type,id}`, app 은 `{appReportId}`. 일치.
- `appendMessage(db, threadId, {from, authorKey, adminName, text}, {create, close, outcome})` → `{status, seq}`. Task 1 정의, Task 2 (`askFeedbackQuestionInternal`, `replyFeedbackThread`) 소비. 일치.
- `toClientMessages(messages, myKey)` → `[{seq, who, pid, text, at}]`. Task 1 정의, Task 3 (`loadThreads`, `lookupContentReports`) 소비. FeedbackThread.jsx(Task 5) 가 `who ∈ admin|me|other`, `pid` 사용. 일치.
- 관리자 화면용 스레드 shape 은 별도: `withThreads`(Task 10 Step 0) 가 `{status, outcome, messages:[{seq, from, name, text, at}]}` 생산 — `from ∈ admin|user`, `name` 문자열. Moderation.jsx CorrectionCard/ReportCard/AppReportCard(Task 10/13/15) 가 `m.from`, `m.name` 소비. 일치(클라 `getMyFeedback` shape 과 의도적으로 다름 — 관리자는 username 봄).
- `ask_feedback_question` payload `{channel, ids?|contentRef?|appReportId?, text, close?, outcome?, label?, summary?}` — Task 8 wrap, Task 10/13/15 송신, Task 2 `askFeedbackQuestionInternal` 처리. 일치.
- `replyFeedbackThread` payload `{channel, text, correctionId?|appReportId?|contentRef?, endpoint?}` — Task 2 정의, Task 4 `replyToThread` 송신, Task 5 `FeedbackThread` 가 `replyToThread(channel, ref, text)` 로 감쌈. `ref` = `{correctionId}` / `{appReportId}` / `{contentRef}`. 일치.
- `kind:'feedback_question'` — Task 2 발신, Task 7 SW 수신. `kind:'feedback_reply'` (adminPush) — Task 2 발신, SW 는 이미 처리(기존). 일치.
- localStorage `feedback:threadSeen` — Task 4 정의, Task 5/6/11 소비. `threadKeyOf(item)` — `item.kind ∈ correction|appReport|content`. 일치.
- `unreadCount(feedback)` — Task 4 정의, Task 6 소비. `feedback` = `fetchFeedback()` 반환(`{corrections, appReports, contentReports}` 각 항목 `thread` 포함). 일치.

**갭 없음.** 단, 다음은 실행 중 주의:
- Task 5 `feedback.css` 토큰명은 실제 `src/styles` 토큰과 대조 필요(fallback 은 넣어둠).
- Task 8 Step 5 `submitCorrection` 의 `threadIdFor` 호출은 `suggested: sug`(정규화된 값) 를 써야 groupKey 가 Moderation/askFeedbackQuestion 과 일치 — `sug` 는 이미 `suggested || null`.
- `withThreads`/`closeContentThread`/`closeCorrectionThread`/`adminNameOf` 는 `moderationActions.js` 안에서 한 번만 정의(Task 10 Step 0 이 `withThreads`, Task 8 이 `adminNameOf`+`askFeedbackQuestion`, Task 9 가 `closeCorrectionThread`, Task 15 가 `closeContentThread`) — 순서상 Task 8 이 먼저 `adminNameOf` 를 만든다. Task 실행 순서 준수 필수.
