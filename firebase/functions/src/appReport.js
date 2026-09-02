import { onCall } from 'firebase-functions/v2/https';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';

// 앱 문제 리포트 — 정보 수정 제안(corrections.js, 강의 데이터 오류용)과는 별개 채널.
// 앱 자체의 버그·오류를 익명으로 접수한다(작성자 정보 미저장, corrections.js 와 동일한
// 익명성 원칙). 자유 텍스트라 corrections 처럼 대상·자동반영 로직은 없다.
// 설계: docs/superpowers/specs/2026-09-03-daily-brief-and-app-report-design.md
export const submitAppReport = onCall({ secrets: [pushFanoutUrl, pushFanoutSecret] }, async (request) => {
  requireAuth(request);
  const { text, path, ua, standalone } = request.data ?? {};

  const t = String(text ?? '').trim();
  if (t.length < 5 || t.length > 500) invalid('문제 설명은 5자 이상 500자 이하로 입력하세요.');
  const p = path != null ? String(path).slice(0, 200) : null;
  const u = ua != null ? String(ua).slice(0, 300) : null;

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
