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
      // 팝업 seen 키에 쓰므로 millis 로 — 관리자가 사후 메모를 남겨 repliedAt 이 갱신되면 다시 뜬다.
      reply: d.reply ?? null, repliedAt: d.repliedAt?.toMillis?.() ?? null };
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
