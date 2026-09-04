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
  const rows = snaps.filter((s) => s.exists).map((s) => {
    const d = s.data();
    return { id: s.id, text: d.text ?? '', status: d.status ?? 'pending',
      reply: d.reply ?? null, replyStatus: d.replyStatus ?? null, repliedAt: d.repliedAt ?? null,
      threadId: d.threadId ?? null };
  });
  const threads = await loadThreads(rows.map((r) => ({ threadId: r.threadId, myKey: r.id })));
  return rows.map((r) => ({ ...r, thread: r.threadId ? (threads[r.threadId] ?? null) : null }));
}

async function lookupCorrections(ids) {
  if (!ids.length) return [];
  const snaps = await db.getAll(...ids.map((id) => db.collection('corrections').doc(id)));
  const rows = snaps.filter((s) => s.exists).map((s) => {
    const d = s.data();
    return { id: s.id, label: d.label ?? null, field: d.field ?? null,
      status: d.status ?? 'pending', autoApplied: d.autoApplied === true,
      // 팝업 seen 키에 쓰므로 millis 로 — 관리자가 사후 메모를 남겨 repliedAt 이 갱신되면 다시 뜬다.
      reply: d.reply ?? null, repliedAt: d.repliedAt?.toMillis?.() ?? null,
      threadId: d.threadId ?? null };
  });
  const threads = await loadThreads(rows.map((r) => ({ threadId: r.threadId, myKey: r.id })));
  return rows.map((r) => ({ ...r, thread: r.threadId ? (threads[r.threadId] ?? null) : null }));
}

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

    // note = 관리자가 남긴 자유 문구(있으면). removed 의 delSnap.reason 은 자동삭제 코드라 노출 안 함.
    let outcome = null;
    let note = null;
    if (!delSnap.empty) { outcome = 'removed'; note = delSnap.docs[0].get('adminNote') ?? null; }
    else if (!docSnap.exists) { outcome = 'removed'; } // 작성자 자삭 — 신고자엔 '사라짐'으로 동일
    else if (docSnap.get('reportEditedAt')) { outcome = 'edited'; note = docSnap.get('reportEditNote') ?? null; }
    else if (docSnap.get('reportDismissedAt')) { outcome = 'kept'; note = docSnap.get('reportDismissReason') ?? null; }

    let thread = null;
    if (threadSnap.exists) {
      const hash = contentActorHash(salt, uid, type, id);
      const reactSnap = docSnap.exists
        ? await db.collection(CONTENT_COLLECTION[type]).doc(id).collection('reactions').doc(reportReactionId(type, hash)).get()
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
    // else: pending 이고 스레드도 없음 — 알리지 않으므로 넣지 않는다
  }
  return out;
}

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

// threadId 목록 → { threadId: { messages, status, outcome } } (요청자 핸들 myKey 로 who 판정)
async function loadThreads(entries) {
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
