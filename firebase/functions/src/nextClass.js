import { createHash } from 'node:crypto';
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { db, FieldValue, requireAuth, invalid } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { pushFanout } from './lib/pushFanout.js';

// "다음 수업" 알림 — 설계: docs/superpowers/specs/2026-09-01-next-class-alert-design.md (접근 B).
// 익명 유지: 구독 문서(pushSubscriptions/{hash})에 과목·강의실은 저장하지 않는다. 기기가
// 계산해 올린 '발동 시각'(주간 분값) 목록만 둔다. 매분 도는 nextClassNotify 가 지금 시각에
// 걸리는 구독에 '내용 없는' 핑을 쏘고, SW(public/push-sw.js)가 기기 Cache 에서 과목·강의실을
// 꺼내 표시한다. push.js 의 pushSubscribe/pushWatch 와 같은 문서ID·검증 규칙을 따른다.

// push.js 와 동일한 문서ID 규칙(sha256(endpoint) hex) — endpoint 자체가 이미 추측 불가능한
// capability URL 이라 salt 불필요("upsert by endpoint" 를 plain doc set 으로 바꾸는 용도).
function subscriptionId(endpoint) {
  return createHash('sha256').update(endpoint).digest('hex');
}

const MINUTES_PER_WEEK = 7 * 24 * 60;
const VALID_LEADS = [0, 5, 10, 15];

// 지금(Asia/Seoul)의 '주간 분값' — 월요일 00:00 = 0 … 일요일 23:59 = 10079.
// 한국은 DST 가 없어 UTC+9 고정이므로 오프셋만 더하면 된다(nextClass.js 와 동일 규약).
function seoulMinuteOfWeek(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const isoDay = kst.getUTCDay() === 0 ? 7 : kst.getUTCDay(); // 1=월 … 7=일
  return (isoDay - 1) * 1440 + kst.getUTCHours() * 60 + kst.getUTCMinutes();
}

export const setNextClassAlerts = onCall(async (request) => {
  // uid 는 남용 방지 게이트일 뿐 — pushSubscribe 와 같이 어디에도 저장하지 않는다.
  requireAuth(request);
  const { endpoint, lead, fireMinutes } = request.data ?? {};
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1024) {
    invalid('잘못된 구독 정보입니다.');
  }
  const leadN = Number(lead);
  if (!VALID_LEADS.includes(leadN)) invalid('잘못된 알림 설정입니다.');
  const mins = Array.isArray(fireMinutes) ? fireMinutes : [];
  if (mins.length > 60 || mins.some((m) => !Number.isInteger(m) || m < 0 || m >= MINUTES_PER_WEEK)) {
    invalid('잘못된 알림 설정입니다.');
  }

  const ref = db.collection('pushSubscriptions').doc(subscriptionId(endpoint));
  const snap = await ref.get();
  if (!snap.exists) return { status: 'OK' }; // 구독 없음 → 조용히 무시(pushWatch 와 같은 패턴)

  if (leadN === 0 || mins.length === 0) {
    await ref.update({ nextClassAlerts: FieldValue.delete() });
  } else {
    await ref.set(
      {
        nextClassAlerts: {
          lead: leadN,
          fireMinutes: [...new Set(mins)].sort((a, b) => a - b),
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );
  }
  return { status: 'OK' };
});

// 매분 실행. 지금(±1분) 발동할 구독에 '내용 없는' 핑을 보낸다. Cloud Scheduler 지연에
// 대비해 직전 1분(mow-1)도 함께 조회하고, 각 구독이 실제로 매칭된 분값을 핑(mow)에 실어
// SW 가 기기 Cache 에서 올바른 슬롯을 찾게 한다. array-contains-any 는 자동 단일필드
// 색인으로 처리된다(색인 파일 변경 불필요).
export const nextClassNotify = onSchedule(
  { schedule: '* * * * *', timeZone: 'Asia/Seoul', secrets: [pushFanoutUrl, pushFanoutSecret] },
  async () => {
    const mow = seoulMinuteOfWeek();
    const back = (mow - 1 + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    const snap = await db
      .collection('pushSubscriptions')
      .where('nextClassAlerts.fireMinutes', 'array-contains-any', [mow, back])
      .get();
    if (snap.empty) return;

    const byMow = new Map(); // 매칭된 분값 → 대상 구독 목록
    for (const doc of snap.docs) {
      const d = doc.data();
      if (!d.endpoint || !d.p256dh || !d.auth) continue;
      const fm = d.nextClassAlerts?.fireMinutes || [];
      const hit = fm.includes(mow) ? mow : fm.includes(back) ? back : null;
      if (hit == null) continue;
      if (!byMow.has(hit)) byMow.set(hit, []);
      byMow.get(hit).push({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
    }

    for (const [hit, targets] of byMow) {
      await pushFanout(
        pushFanoutUrl.value(),
        pushFanoutSecret.value(),
        { kind: 'next_class', mow: hit, path: '/' },
        targets
      );
    }
  }
);
