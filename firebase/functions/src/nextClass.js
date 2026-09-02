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

// "오늘 수업 요약" 발동 시각 등록 — setNextClassAlerts 의 자매 함수. lead 개념이 없다(사용자가
// 절대 시각을 직접 고른다). 요일당 최대 1개라 fireMinutes 상한을 60이 아니라 7로 좁힌다.
// 설계: docs/superpowers/specs/2026-09-03-daily-brief-and-app-report-design.md.
export const setTodaySummaryAlert = onCall(async (request) => {
  requireAuth(request);
  const { endpoint, fireMinutes } = request.data ?? {};
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || endpoint.length > 1024) {
    invalid('잘못된 구독 정보입니다.');
  }
  const mins = Array.isArray(fireMinutes) ? fireMinutes : [];
  if (mins.length > 7 || mins.some((m) => !Number.isInteger(m) || m < 0 || m >= MINUTES_PER_WEEK)) {
    invalid('잘못된 알림 설정입니다.');
  }

  const ref = db.collection('pushSubscriptions').doc(subscriptionId(endpoint));
  const snap = await ref.get();
  if (!snap.exists) return { status: 'OK' };

  if (mins.length === 0) {
    await ref.update({ todaySummaryAlerts: FieldValue.delete() });
  } else {
    await ref.set(
      {
        todaySummaryAlerts: {
          fireMinutes: [...new Set(mins)].sort((a, b) => a - b),
          updatedAt: FieldValue.serverTimestamp(),
        },
      },
      { merge: true }
    );
  }
  return { status: 'OK' };
});

// 매분 실행. 지금(±1분) 발동할 구독에 '내용 없는' 핑을 보낸다. Cloud Scheduler 지연·누락에
// 대비해 직전 1분(mow-1)도 함께 조회하고, 각 구독이 실제로 매칭된 분값을 핑(mow)에 실어
// SW 가 기기 Cache 에서 올바른 슬롯을 찾게 한다. array-contains-any 는 자동 단일필드
// 색인으로 처리된다(색인 파일 변경 불필요).
//
// 중복 억제: 정상 스케줄에서도 발동 분값 F 는 매분 조회에 두 번 걸린다 — F 분엔 mow 로,
// F+1 분엔 직전 1분(back)으로. 방금(≤3분) 같은 분값으로 보낸 구독은 건너뛰어, 스케줄러가
// F 분을 통째로 건너뛴 경우(스탬프 없음)에만 back 조회가 실제 발송으로 이어지게 한다.
// 스케줄러 중복 실행(at-least-once)도 같은 스탬프로 막힌다. 7일 뒤 같은 분값 재사용은
// 타임스탬프 창(3분)이 지나 정상 발송된다.
const DEDUPE_MS = 3 * 60 * 1000;

// 구독 목록 중 field(예: 'nextClassAlerts'/'todaySummaryAlerts')가 지금(mow)·직전 1분(back)에
// 걸리는 것만 추려 { byMow: Map<발동분값, 대상[]>, toStamp: [{ref, mow}] } 로 만든다.
// 두 알림 종류가 완전히 같은 매칭·중복억제 규칙을 쓰므로 한 곳에 둔다.
function collectMatches(snap, field, mow, back, now) {
  const byMow = new Map();
  const toStamp = [];
  for (const doc of snap.docs) {
    const d = doc.data();
    if (!d.endpoint || !d.p256dh || !d.auth) continue;
    const na = d[field] || {};
    const fm = na.fireMinutes || [];
    const hit = fm.includes(mow) ? mow : fm.includes(back) ? back : null;
    if (hit == null) continue;
    const lf = na.lastFired;
    if (lf && lf.mow === hit && typeof lf.at?.toMillis === 'function'
        && now - lf.at.toMillis() < DEDUPE_MS) continue;
    if (!byMow.has(hit)) byMow.set(hit, []);
    byMow.get(hit).push({ endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
    toStamp.push({ ref: doc.ref, mow: hit });
  }
  return { byMow, toStamp };
}

// byMow 를 실제로 보내고, 보낸 구독에 그 알림 종류만의 lastFired 를 찍는다(두 알림 종류가
// 서로 다른 네임스페이스에 독립적으로 중복억제되어야 하므로 stampField 로 구분).
async function sendAndStamp(kind, byMow, toStamp, stampField) {
  if (!byMow.size) return;
  for (const [hit, targets] of byMow) {
    await pushFanout(pushFanoutUrl.value(), pushFanoutSecret.value(), { kind, mow: hit, path: '/' }, targets);
  }
  // 발송 성패와 무관하게 찍는다(fire-and-forget) — 스케줄러가 그 분을 통째로 건너뛰면 이
  // 스탬프가 아예 없어 back 조회가 정상적으로 놓친 알림을 잡는다. 개별 실패는 allSettled 로 흘린다.
  await Promise.allSettled(toStamp.map(({ ref, mow: hit }) =>
    ref.update({ [`${stampField}.lastFired`]: { mow: hit, at: FieldValue.serverTimestamp() } })
  ));
}

export const nextClassNotify = onSchedule(
  { schedule: '* * * * *', timeZone: 'Asia/Seoul', secrets: [pushFanoutUrl, pushFanoutSecret] },
  async () => {
    const mow = seoulMinuteOfWeek();
    const back = (mow - 1 + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
    const now = Date.now();

    const [ncSnap, tsSnap] = await Promise.all([
      db.collection('pushSubscriptions').where('nextClassAlerts.fireMinutes', 'array-contains-any', [mow, back]).get(),
      db.collection('pushSubscriptions').where('todaySummaryAlerts.fireMinutes', 'array-contains-any', [mow, back]).get(),
    ]);

    if (!ncSnap.empty) {
      const { byMow, toStamp } = collectMatches(ncSnap, 'nextClassAlerts', mow, back, now);
      await sendAndStamp('next_class', byMow, toStamp, 'nextClassAlerts');
    }
    if (!tsSnap.empty) {
      const { byMow, toStamp } = collectMatches(tsSnap, 'todaySummaryAlerts', mow, back, now);
      await sendAndStamp('today_summary', byMow, toStamp, 'todaySummaryAlerts');
    }
  }
);
