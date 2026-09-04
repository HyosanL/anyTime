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
        outcome: opts.outcome ?? null,
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
    if (m.from === 'admin') return { seq: m.seq, who: 'admin', pid: null, text: m.text, at: tsMillis(m.at) };
    const pid = pidOf(m.authorKey);
    const mine = myKey != null && m.authorKey === myKey;
    return { seq: m.seq, who: mine ? 'me' : 'other', pid, text: m.text, at: tsMillis(m.at) };
  });
}

// 배열 안의 at 은 Admin SDK 에서 Timestamp 로 저장된다 — 클라이언트로는 millis 로 넘긴다.
function tsMillis(at) {
  if (!at) return null;
  if (typeof at.toMillis === 'function') return at.toMillis();
  if (typeof at._seconds === 'number') return at._seconds * 1000;
  if (typeof at.seconds === 'number') return at.seconds * 1000;
  if (at instanceof Date) return at.getTime();
  return null;
}
