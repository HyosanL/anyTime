import { FieldPath } from 'firebase-admin/firestore';
import { db, FieldValue, invalid } from '../lib/context.js';
import { applyCorrectionRowInternal } from '../corrections.js';
import { archiveDeleted } from '../lib/archive.js';
import { pushFanout } from '../lib/pushFanout.js';
import { pushFanoutUrl, pushFanoutSecret } from '../lib/secrets.js';

// Port of admin-action/index.ts's non-catalog branches: notices, banned
// words, admin grant/revoke, correction moderation, report moderation,
// deleted-content restore, app_setting get/set, board enable/disable, and the
// moderation-dashboard helpers (list_recent/clear_moderation/delete_post/
// edit_post). See ../admin.js for the gateway that dispatches into this map
// after requireAdmin() already ran — no per-handler auth checks here
// (CONVENTIONS.md).
//
// §3 of the design doc is the authoritative split for app_setting's columns
// between /config/app (client-readable, exactly get_boot_info()'s 5 fields)
// and /config/secrets (admin-only) — getAppSetting/setAppSetting below route
// every field to the correct doc; get it wrong and a setting either leaks to
// clients or silently fails to persist.

function millis(ts) {
  return typeof ts?.toMillis === 'function' ? ts.toMillis() : 0;
}

// 제출자에게 그대로 표시되는 관리자 메모: 트림, 300자 상한, 빈 값은 null.
function noteOf(payload) {
  return payload.reason != null ? (String(payload.reason).trim().slice(0, 300) || null) : null;
}

// =====================================================================
//  공지사항
// =====================================================================

async function listNotices() {
  const snap = await db.collection('notices').orderBy('createdAt', 'desc').limit(100).get();
  return { status: 'OK', items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

// id 없으면 생성, 있으면 수정. 수정 시 updatedAt 갱신 → 이미 본 사용자에게도 팝업 재표시.
async function setNotice(uid, payload) {
  const title = String(payload.title ?? '').trim();
  const content = String(payload.content ?? '').trim();
  if (!title || !content) invalid('제목과 내용을 입력하세요.');
  if (payload.id) {
    // 수정: 활성 상태·게시기한은 유지(내림/재게시는 set_notice_active 로만).
    await db.collection('notices').doc(String(payload.id)).update({ title, content, updatedAt: FieldValue.serverTimestamp() });
  } else {
    await db.collection('notices').add({
      title,
      content,
      isActive: true,
      expiresAt: new Date(Date.now() + 48 * 3600_000), // 기본 48시간 게시
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }
  return { status: 'OK' };
}

async function setNoticeActive(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('공지를 지정하세요.');
  const on = !!payload.value;
  const patch = { isActive: on, updatedAt: FieldValue.serverTimestamp() };
  // 게시(재게시)하면 그 시점부터 48시간 게시 재설정.
  if (on) patch.expiresAt = new Date(Date.now() + 48 * 3600_000);
  await db.collection('notices').doc(id).update(patch);
  return { status: 'OK' };
}

async function deleteNotice(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('공지를 지정하세요.');
  await db.collection('notices').doc(id).delete();
  return { status: 'OK' };
}

// =====================================================================
//  금지어
// =====================================================================

async function listBannedWords() {
  const snap = await db.collection('bannedWords').orderBy('createdAt', 'desc').get();
  return { status: 'OK', words: snap.docs.map((d) => ({ word: d.id, createdAt: d.get('createdAt') })) };
}

async function addBannedWord(uid, payload) {
  const word = String(payload.word ?? '').trim();
  if (!word) invalid('금지어를 입력하세요.');
  if (word.length > 40) invalid('금지어는 40자 이하여야 합니다.');
  // word 가 자연키(PK) → 문서 ID. 이미 있으면 조용히 성공(중복 무시), created_at 보존.
  const ref = db.collection('bannedWords').doc(word);
  const snap = await ref.get();
  if (!snap.exists) await ref.set({ word, createdAt: FieldValue.serverTimestamp() });
  return { status: 'OK' };
}

async function deleteBannedWord(uid, payload) {
  const word = String(payload.word ?? '');
  if (!word) return { status: 'OK' }; // old .eq('word','') matched 0 rows silently — same no-op here
  await db.collection('bannedWords').doc(word).delete();
  return { status: 'OK' };
}

// =====================================================================
//  가입코드 (auth.js 의 독립 onCall `setSignupCode` 와 별개 — admin-action 의
//  원래 진입점을 그대로 게이트웨이 액션으로도 포팅한다. 둘 다 config/secrets.
//  signupCode 하나를 같은 방식으로 갱신하므로 상충 없음.)
// =====================================================================

async function getSignupCode() {
  const snap = await db.doc('config/secrets').get();
  return { status: 'OK', code: snap.get('signupCode') ?? '' };
}

async function setSignupCode(uid, payload) {
  const code = String(payload.code ?? '').trim();
  if (!code) invalid('가입 코드를 입력하세요.');
  await db.doc('config/secrets').set({ signupCode: code }, { merge: true });
  return { status: 'OK' };
}

// =====================================================================
//  관리자 부여/회수
// =====================================================================

async function listAdmins() {
  const snap = await db.collection('users').where('isAdmin', '==', true).get();
  return { status: 'OK', admins: snap.docs.map((d) => ({ id: d.id, username: d.get('username') })) };
}

async function grantAdmin(uid, payload) {
  const username = String(payload.username ?? '').trim();
  const snap = await db.collection('users').where('username', '==', username).limit(1).get();
  if (snap.empty) return { status: 'NO_USER' };
  // isAdmin 필드만 바꾼다 — 커스텀 클레임은 auth.js 의 syncAdminClaim(onUpdate 트리거)
  // 가 동기화한다(design doc §2). 여기서 setCustomUserClaims 를 직접 호출하지 않는다.
  await snap.docs[0].ref.update({ isAdmin: true });
  return { status: 'OK' };
}

async function revokeAdmin(uid, payload) {
  const username = String(payload.username ?? '').trim();
  const snap = await db.collection('users').where('username', '==', username).limit(1).get();
  if (snap.empty) return { status: 'NO_USER' };
  const countSnap = await db.collection('users').where('isAdmin', '==', true).count().get();
  if (countSnap.data().count <= 1) return { status: 'LAST_ADMIN' }; // 마지막 관리자 제거 방지
  await snap.docs[0].ref.update({ isAdmin: false });
  return { status: 'OK' };
}

// =====================================================================
//  정보 수정 제안(correction) 모더레이션
//  corrections/{id} 필드명(target, professorCode, courseCode, year, term,
//  sectionNo, label, field, suggested, note, status, autoApplied, prevValue,
//  createdAt)은 ../corrections.js 의 실제 구현과 대조 확인됨.
// =====================================================================

async function listCorrections(uid, payload) {
  const status = payload.status ? String(payload.status) : 'pending';
  const snap = await db.collection('corrections').where('status', '==', status).orderBy('createdAt', 'desc').limit(200).get();
  return { status: 'OK', items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

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

// 실제 반영 없이 큐에서 정리(삭제) — 관리자가 편집 페이지에서 직접 고친 뒤 그 제안
// (동일 묶음 전체)을 처리완료로 치울 때 쓴다. ids 배열 또는 단일 id 를 받는다.
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
  const liveRefs = snaps.filter((s) => s.exists).map((s) => s.ref);
  if (liveRefs.length) {
    const fresh = await db.getAll(...liveRefs);
    for (const s of fresh) await pushCorrectionOutcome(s);
  }
  return { status: 'OK' };
}

// 편집 페이지로 딥링크했을 때 배너에 제안값을 그리기 위한 단건 조회.
async function getCorrection(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) return { status: 'NOT_FOUND', item: null };
  const snap = await db.collection('corrections').doc(id).get();
  return { status: snap.exists ? 'OK' : 'NOT_FOUND', item: snap.exists ? { id: snap.id, ...snap.data() } : null };
}

// 자동반영 알림 목록: 사용자 동일 제안 3건↑로 시스템이 이미 반영한 건.
async function listAutoNotices() {
  const snap = await db.collection('corrections').where('autoApplied', '==', true).orderBy('createdAt', 'desc').limit(200).get();
  return { status: 'OK', items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

async function ackCorrection(uid, payload) {
  // 알림 확인 = 처리 끝 → 삭제.
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  await db.collection('corrections').doc(id).delete();
  return { status: 'OK' };
}

// =====================================================================
//  앱 문제 리포트 — appReports/{id} 필드명(text, path, ua, standalone, status,
//  createdAt)은 ../appReport.js 의 실제 구현과 대조 확인됨.
// =====================================================================

async function listAppReports() {
  const snap = await db.collection('appReports').where('status', '==', 'pending').orderBy('createdAt', 'desc').limit(200).get();
  return { status: 'OK', items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

async function ackAppReport(uid, payload) {
  // 확인 처리 = 즉시 삭제(수정제안 ackCorrection 과 동일 — 익명이라 이력 보관 가치 없음).
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  await db.collection('appReports').doc(id).delete();
  return { status: 'OK' };
}

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

// =====================================================================
//  신고 확인 (report_count > 0 인 살아있는 글)
// =====================================================================

const REPORTABLE_COLLECTIONS = { review: 'reviews', class_memo: 'classMemos', board_post: 'boardPosts' };

async function listReported() {
  const [revSnap, memoSnap, postSnap] = await Promise.all([
    db.collection('reviews').where('reportCount', '>', 0).orderBy('reportCount', 'desc').limit(200).get(),
    db.collection('classMemos').where('reportCount', '>', 0).orderBy('reportCount', 'desc').limit(200).get(),
    db.collection('boardPosts').where('reportCount', '>', 0).orderBy('reportCount', 'desc').limit(200).get(),
  ]);

  // '확인처리'(ackReport) 이후 신고가 더 쌓인 것만(신고수 > 확인시점 신고수) 노출 —
  // 열-대-열 비교는 Firestore 쿼리로 못 걸어서 읽은 뒤 JS 로 거른다(최대 200×3, 부담 없음).
  const unreviewed = (d) => (d.get('reportCount') ?? 0) > (d.get('reportReviewedCount') ?? 0);
  const revRows = revSnap.docs.filter(unreviewed);
  const memoRows = memoSnap.docs.filter(unreviewed);
  const postRows = postSnap.docs.filter(unreviewed);

  const boardIds = [...new Set(postRows.map((d) => d.get('boardId')).filter(Boolean))];
  const boardSnaps = boardIds.length ? await db.getAll(...boardIds.map((id) => db.collection('boards').doc(id))) : [];
  const boardMap = new Map();
  boardSnaps.forEach((s) => { if (s.exists) boardMap.set(s.id, s.get('name')); });

  const items = [
    ...revRows.map((d) => ({
      type: 'review', id: d.id, courseCode: d.get('courseCode'), createdAt: d.get('createdAt'),
      reportCount: d.get('reportCount'), text: [d.get('profComment'), d.get('courseComment')].filter(Boolean).join(' / '), meta: {},
    })),
    ...memoRows.map((d) => ({
      type: 'class_memo', id: d.id, courseCode: d.get('courseCode'), createdAt: d.get('createdAt'),
      reportCount: d.get('reportCount'), text: d.get('content'),
      meta: { year: d.get('year'), term: d.get('term'), sectionNo: d.get('sectionNo') },
    })),
    ...postRows.map((d) => ({
      type: 'board_post', id: d.id, courseCode: boardMap.get(d.get('boardId')) ?? '게시판', createdAt: d.get('createdAt'),
      reportCount: d.get('reportCount'), text: [d.get('title'), d.get('content')].filter(Boolean).join(' — '), meta: {},
    })),
  ].sort((a, b) => (b.reportCount - a.reportCount) || (millis(b.createdAt) - millis(a.createdAt)));

  return { status: 'OK', items };
}

// 신고 무시(정상 처리): 신고 이벤트/중복방지 흔적 삭제 + reportCount 초기화. 글은 유지.
// 누적을 '없애는' 쪽 — 담합/오신고 폭주 리셋용(검토만 하고 넘어가려면 ackReport 사용).
async function dismissReport(uid, payload) {
  const table = String(payload.table ?? '');
  const collectionName = REPORTABLE_COLLECTIONS[table];
  if (!collectionName) invalid('알 수 없는 대상입니다.');
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  const ref = db.collection(collectionName).doc(id);
  // reportCount 는 0으로 돌아가도 이 두 필드는 브레드크럼으로 남긴다 — 신고자 기기가
  // getMyFeedback 으로 '검토 결과 유지'와 그 사유를 조회한다.
  const reason = payload.reason != null ? String(payload.reason).trim().slice(0, 300) : null;
  const dismissMark = { reportDismissReason: reason || null, reportDismissedAt: FieldValue.serverTimestamp() };

  if (table === 'board_post') {
    // board_post 의 reactions 는 like/dislike/report 가 한 서브컬렉션에 섞여 있다
    // (문서ID = `${kind}_${actorHash}`) — report 항목만 documentId() prefix 범위
    // 쿼리로 골라 지운다. events 는 kind 필드로 바로 거른다.
    const reportReactions = await ref.collection('reactions')
      .where(FieldPath.documentId(), '>=', 'report_')
      .where(FieldPath.documentId(), '<', 'report_')
      .get();
    const reportEvents = await ref.collection('events').where('kind', '==', 'report').get();
    const batch = db.batch();
    for (const d of reportReactions.docs) batch.delete(d.ref);
    for (const d of reportEvents.docs) batch.delete(d.ref);
    batch.update(ref, { reportCount: 0, reportReviewedCount: 0, ...dismissMark });
    await batch.commit();
  } else {
    // review/class_memo: 이 대상들엔 좋아요 중복방지가 없어 reactions/events 서브
    // 컬렉션이 애초에 report 전용이다 — 통째로 지워도 안전하다.
    await db.recursiveDelete(ref.collection('reactions'));
    await db.recursiveDelete(ref.collection('events'));
    await ref.update({ reportCount: 0, reportReviewedCount: 0, ...dismissMark });
  }
  return { status: 'OK' };
}

// 신고 확인처리: 내용을 검토했고 삭제할 정도는 아니라 넘어감. reportReviewedCount 를
// 현재 reportCount 로 올려 목록에서만 감춘다(누적 보존, 이후 신고가 더 쌓이면 재노출).
async function ackReport(uid, payload) {
  const table = String(payload.table ?? '');
  const collectionName = REPORTABLE_COLLECTIONS[table];
  if (!collectionName) invalid('알 수 없는 대상입니다.');
  const id = String(payload.id ?? '');
  if (!id) return { status: 'NOT_FOUND' };
  const ref = db.collection(collectionName).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return { status: 'NOT_FOUND' };
  await ref.update({ reportReviewedCount: snap.get('reportCount') ?? 0 });
  return { status: 'OK' };
}

// =====================================================================
//  삭제됨(신고 누적 자동삭제 아카이브) — archive.js 의 archiveDeleted() 가 쌓는다.
//  주의: 그 헬퍼는 필드명을 createdAt 으로 쓴다(옛 deleted_at 이 아님) — 정렬 기준도 동일.
// =====================================================================

async function listDeleted() {
  const snap = await db.collection('deletedContent').orderBy('createdAt', 'desc').limit(200).get();
  return {
    status: 'OK',
    items: snap.docs.map((d) => ({
      id: d.id,
      type: d.get('type'),
      origId: d.get('origId'),
      label: d.get('label') ?? '',
      text: d.get('text') ?? '',
      reportCount: d.get('reportCount'),
      reason: d.get('reason'),
      reviewed: d.get('reviewed'),
      createdAt: d.get('createdAt'),
    })),
  };
}

const RESTORE_COLLECTIONS = { review: 'reviews', class_memo: 'classMemos', board_post: 'boardPosts' };

// 복구: 스냅샷을 원본 컬렉션의 원래 문서 ID로 재삽입(신고수 0 초기화) 후 아카이브 삭제.
// board_post 스냅샷의 images 는 옛 스키마처럼 별도 자식 행이 아니라 애초에 스냅샷 안에
// 임베드돼 있으므로(design doc §3) 옛 restore_deleted() 의 '_images' 분리·재조립이 불필요.
async function restoreDeleted(uid, payload) {
  const archId = String(payload.id ?? '');
  if (!archId) invalid('id가 필요합니다.');
  const archRef = db.collection('deletedContent').doc(archId);

  return db.runTransaction(async (tx) => {
    const archSnap = await tx.get(archRef);
    if (!archSnap.exists) return { status: 'NOT_FOUND' };
    const type = archSnap.get('type');
    const collectionName = RESTORE_COLLECTIONS[type];
    if (!collectionName) return { status: 'BAD_TYPE' };

    const snapshot = { ...(archSnap.get('snapshot') ?? {}) };
    const origId = String(snapshot.id ?? archSnap.get('origId'));
    delete snapshot.id; // 문서 데이터 안에 자기 자신의 id 를 중복 저장하지 않는다(원본도 그렇지 않았다)
    snapshot.reportCount = 0; // 복구 즉시 재삭제 방지
    snapshot.reportReviewedCount = 0;

    // 옛 FK RESTRICT(foreign_key_violation → PARENT_GONE)에 대응 — 소속 과목/게시판이
    // 이미 정리됐으면 복구를 막는다. Firestore 는 FK 가 없어 직접 확인해야 한다.
    if (type === 'review' || type === 'class_memo') {
      const courseSnap = await tx.get(db.collection('courses').doc(String(snapshot.courseCode ?? '')));
      if (!courseSnap.exists) return { status: 'PARENT_GONE' };
    } else if (type === 'board_post') {
      const boardSnap = await tx.get(db.collection('boards').doc(String(snapshot.boardId ?? '')));
      if (!boardSnap.exists) return { status: 'PARENT_GONE' };
    }

    const targetRef = db.collection(collectionName).doc(origId);
    const targetSnap = await tx.get(targetRef);
    if (targetSnap.exists) return { status: 'ALREADY_EXISTS' }; // 이미 같은 id 로 복구됨

    tx.set(targetRef, snapshot);
    tx.delete(archRef);
    return { status: 'OK' };
  });
}

// 확인(검토완료): 미확인 배지에서 제외. 데이터는 Firestore TTL 정책으로 30일 뒤 자동 파기.
async function ackDeleted(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('id가 필요합니다.');
  await db.collection('deletedContent').doc(id).update({ reviewed: true });
  return { status: 'OK' };
}

// =====================================================================
//  app_setting get/set — design doc §3 의 app/secrets 분리를 정확히 지켜야 한다.
//  /config/app: geoValidDays, catalogVersion, boardEnabled, shareEnabled,
//    reviewMinDays (옛 get_boot_info() 반환 필드와 정확히 동일, 그 이상도 이하도 아님)
//  /config/secrets: 그 나머지 전부(campusLat, campusLng, radiusM,
//    accountDeleteDays, hotThreshold, reportDeleteCount, reportBurstCount,
//    signupCode, modReviewedAt, professorsSyncedAt)
// =====================================================================

// 개수·일수 기준값은 정수만(1 이상) — 강의평 작성자격(reviewMinDays)만 0 허용
// ('보유 즉시 작성 가능'). campusLat/campusLng 는 옛 코드도 그냥 통과시켰다(포트 그대로).
const INT_MIN1_FIELDS = ['geoValidDays', 'accountDeleteDays', 'radiusM', 'hotThreshold', 'reportDeleteCount', 'reportBurstCount'];
const INT_MIN0_FIELDS = ['reviewMinDays'];
const SETTABLE_FIELDS = new Set([...INT_MIN1_FIELDS, ...INT_MIN0_FIELDS, 'campusLat', 'campusLng']);
// set_app_setting 이 다루는 9개 필드 중 /config/app 소속은 이 둘뿐 — 나머지는 전부 secrets.
const APP_DOC_FIELDS = new Set(['geoValidDays', 'reviewMinDays']);

async function getAppSetting() {
  const [appSnap, secretsSnap] = await Promise.all([db.doc('config/app').get(), db.doc('config/secrets').get()]);
  const app = appSnap.data() ?? {};
  const secrets = secretsSnap.data() ?? {};
  // 관리자 화면이 두 문서로 나뉜 걸 몰라도 되도록 하나로 합쳐 반환한다 — 옛
  // get_app_setting() 이 반환하던 12개 필드와 정확히 동일한 집합(catalogVersion·
  // signupCode·modReviewedAt 은 이 액션의 범위 밖 — 옛 함수도 반환하지 않았다).
  return {
    status: 'OK',
    setting: {
      campusLat: secrets.campusLat ?? null,
      campusLng: secrets.campusLng ?? null,
      radiusM: secrets.radiusM ?? null,
      reviewMinDays: app.reviewMinDays ?? null,
      geoValidDays: app.geoValidDays ?? null,
      accountDeleteDays: secrets.accountDeleteDays ?? null,
      boardEnabled: app.boardEnabled ?? null,
      shareEnabled: app.shareEnabled ?? null,
      hotThreshold: secrets.hotThreshold ?? null,
      reportDeleteCount: secrets.reportDeleteCount ?? null,
      reportBurstCount: secrets.reportBurstCount ?? null,
      professorsSyncedAt: secrets.professorsSyncedAt ?? null,
    },
  };
}

async function setAppSetting(uid, payload) {
  const field = String(payload.field ?? '');
  if (!SETTABLE_FIELDS.has(field)) invalid('알 수 없는 설정 항목입니다.');
  let value = payload.value;
  if (INT_MIN1_FIELDS.includes(field) || INT_MIN0_FIELDS.includes(field)) {
    value = Math.round(Number(value));
    const min = INT_MIN0_FIELDS.includes(field) ? 0 : 1;
    if (!Number.isFinite(value) || value < min) invalid('값이 올바르지 않습니다.');
  }
  const targetDoc = APP_DOC_FIELDS.has(field) ? 'config/app' : 'config/secrets';
  await db.doc(targetDoc).set({ [field]: value }, { merge: true });
  return { status: 'OK' };
}

async function setBoardEnabled(uid, payload) {
  await db.doc('config/app').set({ boardEnabled: !!payload.value }, { merge: true });
  return { status: 'OK' };
}

// 공유 링크 비회원 열람 허용/차단 (회원 링크는 항상 동작).
async function setShareEnabled(uid, payload) {
  await db.doc('config/app').set({ shareEnabled: !!payload.value }, { merge: true });
  return { status: 'OK' };
}

// =====================================================================
//  게시판 관리자 조작
// =====================================================================

async function deleteBoard(uid, payload) {
  const id = String(payload.id ?? '');
  if (!id) invalid('게시판을 지정하세요.');
  // 옛 board_post.board_id ON DELETE CASCADE 대응 — Firestore 엔 카스케이드가
  // 없으므로 그 게시판의 글을 먼저 찾아 개별적으로 recursiveDelete(comments/
  // events/reactions/watchers/_private 까지 함께 제거) 한다.
  const CONCURRENCY = 20;
  const postsSnap = await db.collection('boardPosts').where('boardId', '==', id).get();
  for (let i = 0; i < postsSnap.docs.length; i += CONCURRENCY) {
    await Promise.all(postsSnap.docs.slice(i, i + CONCURRENCY).map((d) => db.recursiveDelete(d.ref)));
  }
  await db.recursiveDelete(db.collection('boards').doc(id));
  return { status: 'OK' };
}

// 모든 게시판의 글을 통째로 삭제(게시판 목록 자체는 유지) — 옛 코드의
// `board_post` 전체 DELETE 와 동일 범위.
async function purgeAllBoards() {
  const CONCURRENCY = 20;
  const postsSnap = await db.collection('boardPosts').get();
  for (let i = 0; i < postsSnap.docs.length; i += CONCURRENCY) {
    await Promise.all(postsSnap.docs.slice(i, i + CONCURRENCY).map((d) => db.recursiveDelete(d.ref)));
  }
  return { status: 'OK' };
}

// =====================================================================
//  모더레이션 대시보드 — 최근 글 훑어보기 / '모두 확인 처리'
// =====================================================================

async function listRecent(uid, payload) {
  const limit = Math.min(Number(payload.limit) || 80, 200);
  const secretsSnap = await db.doc('config/secrets').get();
  const cutoff = secretsSnap.get('modReviewedAt') ?? null;

  function recentQuery(collRef) {
    let q = collRef.orderBy('createdAt', 'desc');
    if (cutoff) q = q.where('createdAt', '>', cutoff);
    return q.limit(limit);
  }

  const [revSnap, memoSnap, examSnap, postSnap, commentSnap] = await Promise.all([
    recentQuery(db.collection('reviews')).get(),
    recentQuery(db.collection('classMemos')).get(),
    recentQuery(db.collection('examArchive')).get(),
    recentQuery(db.collection('boardPosts')).get(),
    // board_comment 는 옛 스키마에서 평평한 테이블이었지만 여기선 boardPosts 의
    // 서브컬렉션이라 collectionGroup 으로 전체를 훑는다(firestore.indexes.json 에
    // comments(createdAt) COLLECTION_GROUP 색인 추가됨).
    recentQuery(db.collectionGroup('comments')).get(),
  ]);

  const boardIds = new Set(postSnap.docs.map((d) => d.get('boardId')).filter(Boolean));
  // 댓글의 소속 글은 doc.ref.parent.parent 로 바로 얻는다(postId 필드를 별도로
  // 저장해두지 않았어도 서브컬렉션 구조 자체가 부모 참조를 내장하고 있다).
  const parentPostRefs = commentSnap.docs.map((d) => d.ref.parent.parent);
  const parentPostSnaps = parentPostRefs.length ? await db.getAll(...parentPostRefs) : [];
  const parentPostMap = new Map();
  parentPostSnaps.forEach((s, i) => {
    if (s.exists) {
      parentPostMap.set(parentPostRefs[i].id, s);
      boardIds.add(s.get('boardId'));
    }
  });
  const boardIdList = [...boardIds].filter(Boolean);
  const boardSnaps = boardIdList.length ? await db.getAll(...boardIdList.map((id) => db.collection('boards').doc(id))) : [];
  const boardMap = new Map();
  boardSnaps.forEach((s) => { if (s.exists) boardMap.set(s.id, s.get('name')); });

  const items = [
    ...revSnap.docs.map((d) => ({
      type: 'review', id: d.id, courseCode: d.get('courseCode'), createdAt: d.get('createdAt'),
      text: [d.get('profComment'), d.get('courseComment')].filter(Boolean).join(' / '),
      meta: { professorCode: d.get('professorCode') ?? null },
    })),
    ...memoSnap.docs.map((d) => ({
      type: 'class_memo', id: d.id, courseCode: d.get('courseCode'), createdAt: d.get('createdAt'),
      text: d.get('content'), meta: { year: d.get('year'), term: d.get('term'), sectionNo: d.get('sectionNo') },
    })),
    ...examSnap.docs.map((d) => ({
      type: 'exam_archive', id: d.id, courseCode: d.get('courseCode'), createdAt: d.get('createdAt'),
      text: [d.get('title'), d.get('description')].filter(Boolean).join(' — '), meta: {},
    })),
    ...postSnap.docs.map((d) => ({
      type: 'board_post', id: d.id, courseCode: boardMap.get(d.get('boardId')) ?? '게시판', createdAt: d.get('createdAt'),
      text: [d.get('title'), d.get('content')].filter(Boolean).join(' — '), meta: {},
    })),
    ...commentSnap.docs.map((d) => {
      const parentRef = d.ref.parent.parent;
      const parent = parentPostMap.get(parentRef.id);
      const bname = (parent && boardMap.get(parent.get('boardId'))) || '게시판';
      return {
        type: 'board_comment', id: d.id,
        courseCode: parent?.get('title') ? `${bname}·${parent.get('title')}` : bname,
        createdAt: d.get('createdAt'), text: d.get('content'), meta: { postId: parentRef.id },
      };
    }),
  ].sort((a, b) => millis(b.createdAt) - millis(a.createdAt));

  return { status: 'OK', items, reviewedAt: cutoff };
}

// '모두 확인 처리': 컷오프를 현재로 갱신 → 이전 글은 대시보드에서 숨김(삭제 아님).
async function clearModeration() {
  const at = new Date();
  await db.doc('config/secrets').set({ modReviewedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { status: 'OK', reviewedAt: at };
}

// =====================================================================
//  게시물 직접 삭제/수정 (관리자 전용 — 비밀번호 확인 없음, 작성자 미상이라
//  postCount 조정도 하지 않는다: 옛 admin-action delete_post 도 동일했다)
// =====================================================================

const POST_COLLECTIONS = { review: 'reviews', exam_archive: 'examArchive', class_memo: 'classMemos', board_post: 'boardPosts' };
const EDITABLE_FIELDS = {
  review: ['profComment', 'courseComment'],
  class_memo: ['content'],
  exam_archive: ['title', 'description'],
  board_post: ['title', 'content'],
  board_comment: ['content'],
};

// board.js 의 사설(미export) deleteCommentTree 와 동일 로직 — parentId 자기참조는
// Firestore 에 카스케이드가 없어 답글 트리를 직접 걸어 지운다. 공유 lib 파일을 고치는
// 대신 여기서 다시 작게 둔다(timetable.js 가 sectionKeyOf 를 다루는 것과 같은 관례).
async function deleteCommentTree(postRef, commentId) {
  const repliesSnap = await postRef.collection('comments').where('parentId', '==', commentId).get();
  for (const reply of repliesSnap.docs) {
    await deleteCommentTree(postRef, reply.id);
  }
  await db.recursiveDelete(postRef.collection('comments').doc(commentId));
}

// table='board_comment' 는 옛 payload({table,id})만으로 위치를 특정할 수 없다 —
// board_comment 가 이제 boardPosts/{postId}/comments/{id} 서브컬렉션이라 postId 가
// 없으면 전체 컬렉션을 훑어야 하는데(비용·확장성 문제, capacity-cost 메모 참고)
// 그건 이 앱의 egress 절약 원칙에 어긋난다 — payload 에 postId 를 추가로 요구한다
// (Firestore 구조 차이에서 오는 불가피한 계약 확장, 옛 낱개 필드 삭감이 아님).
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

export const moderationActions = {
  list_notices: listNotices,
  set_notice: setNotice,
  set_notice_active: setNoticeActive,
  delete_notice: deleteNotice,
  list_banned_words: listBannedWords,
  add_banned_word: addBannedWord,
  delete_banned_word: deleteBannedWord,
  get_signup_code: getSignupCode,
  set_signup_code: setSignupCode,
  list_admins: listAdmins,
  grant_admin: grantAdmin,
  revoke_admin: revokeAdmin,
  list_corrections: listCorrections,
  reject_correction: rejectCorrection,
  apply_correction: applyCorrection,
  resolve_correction: resolveCorrection,
  get_correction: getCorrection,
  list_auto_notices: listAutoNotices,
  ack_correction: ackCorrection,
  list_reported: listReported,
  dismiss_report: dismissReport,
  ack_report: ackReport,
  list_deleted: listDeleted,
  restore_deleted: restoreDeleted,
  ack_deleted: ackDeleted,
  list_app_reports: listAppReports,
  list_replied_app_reports: listRepliedAppReports,
  ack_app_report: ackAppReport,
  reply_app_report: replyAppReport,
  get_app_setting: getAppSetting,
  set_app_setting: setAppSetting,
  set_board_enabled: setBoardEnabled,
  set_share_enabled: setShareEnabled,
  delete_board: deleteBoard,
  purge_all_boards: purgeAllBoards,
  list_recent: listRecent,
  clear_moderation: clearModeration,
  delete_post: deletePost,
  edit_post: editPost,
};
