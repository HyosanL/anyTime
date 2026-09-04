import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createHash, createHmac } from 'node:crypto';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { actorHashSalt, pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { pushFanout } from './lib/pushFanout.js';
import { adminPush } from './lib/adminNotify.js';
import { appendMessage, threadIdFor, MSG_MAX_LEN } from './lib/feedbackThread.js';

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

const FIELD_LABELS = {
  time: '요일·교시', room: '강의실', professor: '담당교수',
  name: '이름/과목명', department: '학과', office: '연구실', section: '분반 추가',
};

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
      channel,
      correctionIds: ids,
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
    threadId = threadIdFor('content_report', { type, id: String(id) });
    const label = payload.label || (type === 'board_post' ? '게시글' : type === 'review' ? '강의평' : '메모');
    create = { channel, contentRef: { type, id: String(id) }, label, summary: String(payload.summary ?? '').slice(0, 200) };
  } else if (channel === 'app_report') {
    const appReportId = String(payload.appReportId ?? '');
    if (!appReportId) invalid('대상이 없습니다.');
    const arSnap = await db.collection('appReports').doc(appReportId).get();
    if (!arSnap.exists) return { status: 'NOT_FOUND' };
    threadId = threadIdFor('app_report', { appReportId });
    create = {
      channel,
      appReportId,
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

  await notifyQuestion(channel, payload, threadId, create.label);
  return { status: 'OK', threadId, seq: r.seq };
}

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
    let reactSnap = { docs: [] };
    try {
      reactSnap = await db.collection(coll).doc(String(id)).collection('reactions')
        .where('kind', '==', 'report').get();
    } catch { /* 콘텐츠가 이미 삭제됨 — 스냅샷만으로 스레드 유지 */ }
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
  } catch (e) {
    console.error('[notifyQuestion] push failed', e);
  }
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
      if (!cSnap.exists || !cSnap.get('threadId')) throw new HttpsError('failed-precondition', 'NO_THREAD');
      threadId = cSnap.get('threadId');
      authorKey = cid;
    } else if (channel === 'app_report') {
      const arId = String(d.appReportId ?? '');
      const arSnap = await db.collection('appReports').doc(arId).get();
      if (!arSnap.exists || !arSnap.get('threadId')) throw new HttpsError('failed-precondition', 'NO_THREAD');
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
      if (!isReporter) throw new HttpsError('permission-denied', '이 신고의 제출자만 답할 수 있습니다.');
      if (!threadSnap.exists) throw new HttpsError('failed-precondition', 'NO_THREAD');
      authorKey = hash;
    } else {
      invalid('알 수 없는 채널입니다.');
    }

    const r = await appendMessage(db, threadId, { from: 'user', authorKey, text });
    if (r.status === 'NO_THREAD') throw new HttpsError('failed-precondition', 'NO_THREAD');
    if (r.status === 'FULL') return { status: 'FULL' };
    if (r.status !== 'OK') return { status: r.status };

    // 현재 푸시 구독을 스레드 subIds 에 등록(다음 관리자 메시지 때 이 기기에 알림)
    const { endpoint } = d;
    if (typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024) {
      await db.collection('feedbackThreads').doc(threadId)
        .update({ subIds: FieldValue.arrayUnion(sha256hex(endpoint)) });
    }

    // 제출자가 연달아 여러 개 보내면 관리자에게는 그 묶음의 첫 메시지에만 알린다(푸시 도배 방지).
    const threadSnap = await db.collection('feedbackThreads').doc(threadId).get();
    const msgs = threadSnap.get('messages') || [];
    const prev = msgs[msgs.length - 2];
    const burstContinuation = prev && prev.from === 'user' && prev.authorKey === authorKey;
    if (!burstContinuation) {
      await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
        kind: 'feedback_reply', title: '💬 피드백 답변 도착', body: threadSnap.get('label') || '제출자가 답했어요',
      });
    }
    return { status: 'OK' };
  },
);

// ── 정리: 마지막 메시지 이후 15일 지난 피드백 스레드(매일). 종료 여부와 무관하게
// 15일간 활동 없으면 대화 기록을 파기하고, 연결된 소스 문서(correction·appReport)도 함께 지운다.
// 콘텐츠 신고는 소스 문서가 없다(reportCount + reactions 뿐). ──
export const purgeFeedbackThreads = onSchedule({ schedule: '0 18 * * *', timeZone: 'UTC' }, async () => {
  const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
  const ms = (ts) => (typeof ts?.toMillis === 'function' ? ts.toMillis() : 0);
  const snap = await db.collection('feedbackThreads').get();
  const stale = snap.docs.filter((doc) => ms(doc.get('lastMessageAt')) > 0 && ms(doc.get('lastMessageAt')) < cutoff);
  for (const doc of stale) {
    const t = doc.data();
    if (t.channel === 'correction') {
      for (const cid of (t.correctionIds || [])) {
        await db.collection('corrections').doc(cid).delete().catch(() => {});
      }
    } else if (t.channel === 'app_report' && t.appReportId) {
      await db.collection('appReports').doc(t.appReportId).delete().catch(() => {});
    }
    await doc.ref.delete().catch(() => {});
  }
});
