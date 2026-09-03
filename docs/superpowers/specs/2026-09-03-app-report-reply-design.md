# 앱 리포트 회신 — 설계

작성: 2026-09-03

## 배경

`appReports`(🚩 앱 문제 리포트)는 완전 익명 — 작성자 정보 미저장, 푸시 구독도 uid
없음([push.js:3-5](../../../src/lib/push.js#L3)). 관리자는 "확인"으로 삭제만 할 수
있고 사용자에게 처리 결과를 전할 길이 없었다(2026-09-03 앱 리포트 설계에서 명시적
YAGNI 처리). 사용자 요청: **관리자가 리포트에 답변할 수 있게, 익명성은 유지하면서.**
답변은 푸시와 별개로 **앱 접속 시 공지처럼** 그 사용자에게 뜨게 한다.

## 핵심 — 익명 연결

서버는 리포트 작성자를 모른다. 연결은 기기가 쥔 두 가지로만 이뤄진다:
1. **기기가 기억하는 리포트 ID** — 제출 시 `localStorage`에 적어 둔 자기 리포트 ID
   목록. 앱을 열 때 그 ID들의 답변 여부를 CF로 조회한다.
2. **제출 시점 푸시 구독 해시**(`subId = sha256(endpoint)`) — 있으면 리포트 문서에
   붙인다. `boardPosts/{id}/watchers`와 같은 프라이버시 등급(uid 아님, 브라우저가
   발급한 임의 endpoint의 해시). 답변 시 그 한 기기에만 푸시.

Firestore auto-ID는 20자(~119비트)라 열거 불가 — `getSharedPost`의 공유 토큰,
푸시 endpoint("본인만 안다")와 같은 위협 모델이다.

## 데이터 모델 — `appReports/{id}`

```
{ text, path, ua, standalone, status, createdAt,   // 기존
  subId:       string | null,                      // 제출 시점 푸시 구독 해시
  reply:       string | null,                      // 관리자 답변 (없으면 null)
  replyStatus: 'reviewing' | 'resolved' | 'planned' | null,
  repliedAt:   Timestamp | null }
```

`status`: `'pending'`(기존) → 답변 달리면 `'replied'`. `ack_app_report`(삭제)는
스팸·답변 불필요 건에 그대로 유지.

## 백엔드

### `submitAppReport` (수정, [appReport.js](../../../firebase/functions/src/appReport.js))
- `endpoint` 선택 파라미터 추가. 유효하면(`https://`, ≤1024) `subId = sha256(endpoint)` 저장.
- 문서에 `subId`(또는 null), `reply: null`, `replyStatus: null`, `repliedAt: null` 포함.

### `getMyAppReports` (신규 onCall, `firebase/functions/src/appReport.js`)
- `requireAuth`. `{ ids: string[] }` — 최대 20개, 각 ≤64자.
- 존재하는 문서만 `[{ id, text, status, reply, replyStatus, repliedAt }]` 반환
  (`subId`·`ua`·`path`는 빼고 — 기기엔 불필요).
- uid 검증 없음: 기기가 ID를 안다는 것이 곧 소유 증명(위 위협 모델). 주석으로 근거 명시.
- Firestore `getAll`로 배치 조회.

### `reply_app_report` (신규 admin action, [moderationActions.js](../../../firebase/functions/src/admin/moderationActions.js))
- `{ id, reply, replyStatus }`. `reply` 1~1000자, `replyStatus` ∈ 위 3값.
- 문서 update: `reply`, `replyStatus`, `repliedAt: serverTimestamp()`, `status: 'replied'`.
- `subId` 있으면 `pushSubscriptions/{subId}` 조회 → 존재하면 `pushFanout(
  { kind: 'app_report_reply', title: '📬 문의 답변', body: reply 앞 80자, path: '/' },
  [{ endpoint, p256dh, auth }])`. 실패는 삼킨다(답변 자체는 성공).
- `pushFanoutUrl`/`pushFanoutSecret` 시크릿을 `adminAction` 함수에 추가해야 함
  — 현재 `admin.js`의 `adminAction`은 시크릿 선언이 없다. 확인 후 추가.

### `list_replied_app_reports` (신규 admin action)
- `where('status','==','replied').orderBy('repliedAt','desc').limit(50)` →
  `[{ id, text, reply, replyStatus, repliedAt, createdAt }]`.

### `purgeAppReports` (신규 onSchedule, 월간)
- `'0 18 1 * *'` UTC (다른 월간 purge와 동일). `status=='replied'` & `repliedAt` 30일 경과
  → 삭제. `status=='pending'` & `createdAt` 90일 경과(방치) → 삭제.

## 기기 (프론트)

### localStorage
- `appReport:mine` — `[{ id, text, at }]`, 최대 20(오래된 것부터 버림). 제출 성공 시 append.
- `appReport:seenReplies` — `[id, …]`, 팝업으로 이미 본 답변.

### `src/lib/appReport.js` (신규 — 기기 상태 + CF 래퍼)
- `recordMyReport(id, text)` / `readMyReports()` / `pruneMyReports(existingIds)`.
- `readSeenReplies()` / `markReplySeen(ids)`.
- `fetchMyReports()` → `getMyAppReports` 호출, `appReport:mine`을 서버에 있는 것만 남기게 정리.

### `AppReportModal` (수정, [src/components/AppReportModal.jsx](../../../src/components/AppReportModal.jsx))
- 제출 시 `pushEnabled()`면 `navigator.serviceWorker.ready` → `getSubscription()` →
  `endpoint`를 `submitAppReport`에 함께 전달. (구독 없으면 endpoint 생략.)
- 제출 성공 → `recordMyReport(newId, text)`. `submitAppReport`가 새 문서 id를 반환해야 함.
- 모달 하단에 **'내가 보낸 리포트'** 구획: `fetchMyReports()` 결과를 상태·답변과 함께
  나열(답변 있으면 펼쳐 보임). 없으면 구획 자체를 숨김.

### `AppReportReplyPopup` (신규 컴포넌트, 홈에서 렌더)
- 마운트 시 `fetchMyReports()` → `reply` 있고 `seenReplies`에 없는 항목만.
- 있으면 `NoticePopup`과 같은 오버레이·모달 스타일로:
  "📬 문의하신 문제에 답변이 도착했어요" + 각 항목(원문 요약 + 답변 + 상태 배지).
- 닫으면 `markReplySeen(해당 ids)`. `styles/` 재사용(`ntc-*` 클래스).
- [Home.jsx](../../../src/pages/Home.jsx)에 `<AppReportReplyPopup />` 추가(`<NoticePopup />` 옆).

### 홈 헤더 정리 (곁다리)
- `🧹 검열` 링크에서 "검열" 텍스트 제거 — 아이콘만([Home.jsx:385](../../../src/pages/Home.jsx#L385),
  `home-mod-link`). 관리자만 보이지만 아이콘으로 충분.

## 관리자 화면 — Moderation "앱 문제" 탭

- 카드에 답변 `<textarea>` + 상태 `<select>`(검토중/해결됨/반영예정) + **"답변 보내기"** 버튼
  (`reply_app_report` 호출 → 목록에서 pending 제거, 아래 '답변함'으로 이동).
- 기존 "확인"(삭제, `ack_app_report`) 버튼은 유지(스팸용).
- 탭 하단에 **'답변함'** 구획: `list_replied_app_reports` 결과. 답변 수정 가능(같은 액션 재호출).
- `callBatch`에 `list_replied_app_reports` 추가(현재 6개 → 7개, 상한 8).

## 푸시 SW ([public/push-sw.js](../../../public/push-sw.js))

- `showPush`에서 `app_report_reply`도 서버가 실어보낸 `title`/`body`를 그대로 쓰게 —
  `ADMIN_KINDS` 판정에 `|| msg.kind === 'app_report_reply'` 추가(또는 배열에 포함하고
  주석을 "서버가 title/body 를 싣는 kind"로). `path: '/'`.
- `vite.config.js` `importScripts: ['push-sw.js?v=11']` → `?v=12`.

## Firestore Rules

**변경 없음.** `appReports`는 `allow read, write: if false` 유지 — 기기는
`getMyAppReports` CF로만 읽는다.

## 테스트

- 순수 로직 없음(대부분 I/O). `node --check`로 functions 문법.
- `npm run build` 통과.
- 배포 후 실기기:
  1. 리포트 제출 → 관리자 화면에 등장 → 답변+상태 저장 → '답변함'으로 이동.
  2. 리포트 낸 기기에서 앱 재진입 → 📬 팝업 표시 → 닫으면 다시 안 뜸.
  3. 🚩 모달 '내가 보낸 리포트'에 답변 계속 보임.
  4. 푸시 구독 상태로 제출 → 답변 시 그 기기에 푸시 1건.

## 범위 밖 (YAGNI)

- 사용자→관리자 답변에 재질문(스레드). 단방향 회신으로 충분.
- 리포트별 알림 on/off. 스크린샷 첨부. 상태 세분화(3값이면 족함).
- `getMyAppReports`의 rate-limit(요청 1회/앱진입, id ≤20 — 부하 무시 가능).
