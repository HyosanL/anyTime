import { createHash } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';

// push.js 와 동일한 문서ID 규칙(sha256(endpoint) hex). endpoint 자체가 추측 불가능한
// capability URL 이라 salt 불필요. 답변 시 pushSubscriptions/{subId} 를 그대로 찾는다.
function subscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}

// 앱 문제 리포트 — 정보 수정 제안(corrections.js, 강의 데이터 오류용)과는 별개 채널.
// 앱 자체의 버그·오류를 익명으로 접수한다(작성자 정보 미저장, corrections.js 와 동일한
// 익명성 원칙). 자유 텍스트라 corrections 처럼 대상·자동반영 로직은 없다.
// 설계: docs/superpowers/specs/2026-09-03-daily-brief-and-app-report-design.md
export const submitAppReport = onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  requireAuth(request);
  const { text, path, ua, standalone, sw } = request.data ?? {};

  const t = String(text ?? '').trim();
  if (t.length < 5 || t.length > 500) invalid('문제 설명은 5자 이상 500자 이하로 입력하세요.');
  const p = path != null ? String(path).slice(0, 200) : null;
  const u = ua != null ? String(ua).slice(0, 300) : null;
  // 진단: 기기의 서비스워커 상태(버전·컨트롤·알림권한). AppReportModal 이 조립한 짧은 문자열.
  const s = sw != null ? String(sw).slice(0, 200) : null;

  const { endpoint } = request.data ?? {};
  const subId = (typeof endpoint === 'string' && endpoint.startsWith('https://') && endpoint.length <= 1024)
    ? subscriptionId(endpoint)
    : null;

  const ref = await db.collection('appReports').add({
    text: t,
    path: p,
    ua: u,
    sw: s,
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

// 내가 낸 리포트의 답변 조회 — 기기가 localStorage 에 적어 둔 자기 리포트 ID 로만 조회한다.
// uid 검증 없음: ID 를 안다는 것이 곧 소유 증명이다(Firestore auto-ID 20자 ≈ 119비트,
// 열거 불가 — 푸시 endpoint 와 같은 위협 모델). subId·ua·path 는
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

// 앱 리포트 정리(월간) — 답변 후 30일, 방치된 pending 90일 경과분 삭제. 다른 월간 purge 와
// 같은 크론('0 18 1 * *' UTC = 매월 2일 03:00 KST). 컬렉션이 작아(버그 신고) 전체 스캔 +
// 메모리 필터 — purgePastMemos 와 같은 패턴(복합색인 불필요).
export const purgeAppReports = onSchedule({ schedule: '0 18 1 * *', timeZone: 'UTC' }, async () => {
  const now = Date.now();
  const repliedCutoff = now - 15 * 24 * 60 * 60 * 1000;
  const pendingCutoff = now - 90 * 24 * 60 * 60 * 1000;
  const ms = (ts) => (typeof ts?.toMillis === 'function' ? ts.toMillis() : 0);

  const snap = await db.collection('appReports').get();
  const stale = snap.docs.filter((d) => {
    const x = d.data();
    // 대화(threadId)가 달린 replied 는 purgeFeedbackThreads 가 마지막 메시지 기준으로 처리.
    if (x.status === 'replied') return !x.threadId && ms(x.repliedAt) > 0 && ms(x.repliedAt) < repliedCutoff;
    if (x.status === 'pending') return ms(x.createdAt) > 0 && ms(x.createdAt) < pendingCutoff;
    return false;
  });
  if (!stale.length) return;

  for (let i = 0; i < stale.length; i += 400) {
    const batch = db.batch();
    for (const d of stale.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
});
