# 제안·신고 회신 확장 — 설계

작성: 2026-09-03

## 배경

앱 리포트 회신(`2026-09-03-app-report-reply-design.md`)을 **강의 수정 제안**과
**콘텐츠 신고**로 확장한다. 홈의 `AppReportReplyPopup` 을 세 종류를 모아 보여주는
`FeedbackPopup` 으로 일반화한다. 익명성은 그대로 — 서버는 제출자를 모르고, 기기가
쥔 로컬 ID/참조로만 결과를 조회한다.

## 채널별 성격

| 채널 | 개별 문서 | 상태 전이 | 회신 방식 |
|---|---|---|---|
| 앱 리포트 | O (`appReports/{id}`) | pending→replied | 관리자 자유 답변 + 상태 (이미 구현됨) |
| 강의 수정 제안 | O (`corrections/{id}`) | pending→applied/rejected/resolved | 자동 결과 + 반려 시 사유(선택) |
| 콘텐츠 신고 | X (`reportCount` + `reactions/{actorHash}`) | — | 자동 결과만: 삭제됨 / 유지(사유) |

## Ⅰ. 강의 수정 제안 (`corrections`)

### 현재
`submitCorrection` 이 `corrections/{id}` 를 만들고, 관리자 `reject_correction`/
`apply_correction`/`resolve_correction` 이 **문서를 삭제**한다. `autoApplied` 건만
`ackCorrection` 전까지 남는다.

### 변경

**`submitCorrection`** ([corrections.js:304](../../../firebase/functions/src/corrections.js#L304))
- `endpoint` 선택 파라미터 → `subId = sha256(endpoint)` 저장.
- 문서에 `reply: null`, `repliedAt: null` 추가.
- 반환값에 `id` 추가. **자동반영된 경우**(`applied === true`)도 그 `id` 로 결과 조회됨.

**관리자 액션** ([moderationActions.js:160-193](../../../firebase/functions/src/admin/moderationActions.js#L160))
`reject`/`apply`/`resolve` 를 **삭제 대신 상태 전환 + 보존**으로:
- `rejectCorrection({ id, reason? })` → `status: 'rejected'`, `reply: reason || null`, `repliedAt`.
- `applyCorrection({ id })` → 반영 후 `status: 'applied'`, `repliedAt` (문서 유지). `ALREADY_DONE` 도 `status: 'applied'`.
- `resolveCorrection({ ids })` → `status: 'resolved'`, `repliedAt` (관리자가 편집 페이지에서 직접 고침).
- 셋 다 `subId` 있으면 그 기기에 푸시(`kind: 'feedback_reply'`).
- `listCorrections` 는 여전히 `status == 'pending'` 만 → 관리자 큐 그대로 깨끗.
- `autoApplied` 자동반영 건: `submitCorrection` 이 이미 `status: 'applied'` + `autoApplied: true` 로 남긴다. `ackCorrection` 은 유지(자동반영 알림 확인 = 관리자용, 삭제).

**`purgeCorrections`** (신규 onSchedule 월간) — `status IN (applied,rejected,resolved)` &
`repliedAt` 30일 경과분 삭제. (`autoApplied` 미확인 건은 `ackCorrection` 이 별도로 정리.)

### 사용자에게 보이는 결과
- `applied` + `autoApplied` → "📌 여러 명이 같은 제안을 해서 자동 반영됐어요"
- `applied` → "✅ 제안이 반영됐어요"
- `rejected` + reply → "❌ 반려됐어요: {사유}" / reply 없음 → "❌ 이번엔 반영하지 않았어요"
- `resolved` → "✅ 확인 후 직접 수정했어요"

## Ⅱ. 콘텐츠 신고 (게시글·강의평·수업메모)

신고는 개별 문서가 없다 — `reportCount` 증가 + `{content}/reactions/{actorHash}`.
기기는 이미 `src/lib/reactions.js` 의 `bb-reacted` localStorage 에
`{scope}:{id} → { report: true }` 를 기록한다(연타 방지용). 이걸 그대로 읽는다.

### 관리자 — `dismissReport` 에 사유 (선택)

[moderationActions.js:338](../../../firebase/functions/src/admin/moderationActions.js#L338)
`dismissReport({ table, id, reason? })` — `reportCount: 0` 리셋에 더해 콘텐츠 문서에
`reportDismissReason: reason || null`, `reportDismissedAt: serverTimestamp()` 를 남긴다
(`reportCount` 는 0으로 돌아가도 이 두 필드는 브레드크럼으로 유지). 관리자 화면
신고 카드에 "무시" 옆 사유 입력란(선택) 추가.

**신고자에게 푸시는 없다** — 신고엔 제출자의 푸시 핸들이 어디에도 없다(익명 fire-and-forget).
결과는 앱 접속 시 팝업으로만.

### 결과 판정 (`getMyFeedback` 안에서)
기기가 보낸 `[{ type, id }]` 각각:
- `deletedContent` 에 `origId == id` 문서 있음 → **removed** (+ `reason`: threshold/burst/admin)
- 원 컬렉션에 문서 없음 & deletedContent 에도 없음 → **removed** (작성자 자삭 — 신고자 시점에선 "사라짐"으로 동일 취급, 일반 문구)
- 원 문서에 `reportDismissedAt` 있음 → **kept** (+ `reportDismissReason`)
- 그 외 → **pending** (알리지 않음)

### 사용자에게 보이는 결과
- removed → "🗑️ 신고하신 내용이 삭제 조치됐어요" (여러 건이면 "신고하신 내용 N건이 삭제됐어요")
- kept + reason → "신고하신 내용은 검토 결과 유지됩니다: {사유}"
- kept, reason 없음 → "신고하신 내용은 검토 결과 규정 위반이 아니라 유지됩니다"

## Ⅲ. 프론트 일반화

### `src/lib/feedback.js` (신규 — `appReport.js` 흡수·확장)
```
localStorage:
  feedback:mine  = { appReport: [{id, summary, at}], correction: [{id, summary, at}] }
  feedback:seen  = ["appReport:<id>", "correction:<id>", "content:<type>_<id>"]

exports:
  recordSubmission(kind, { id, summary })      // appReport / correction
  readMine(kind) / readSeen() / markSeen(keys)
  reportedContentRefs()                        // bb-reacted 스캔 → [{type, id}] (report:true, 최대 30)
  fetchFeedback()  → { appReports:[…], corrections:[…], contentReports:[…] }
                     각 항목에 outcome/reply/summary. CF getMyFeedback 1회. 로컬 mine 정리.
  submitAppReport(...) / submitCorrection(...)  // 기존 wrapper + recordSubmission
```
`appReport.js` 는 삭제하고 `feedback.js` 로 대체. `appReport.js` 를 쓰던 곳:
`AppReportModal`, `AppReportReplyPopup` → `feedback.js` 로 갱신.

### `getMyFeedback` (신규 onCall, `firebase/functions/src/feedback.js`)
- `requireAuth`. `{ appReportIds:[], correctionIds:[], contentReports:[{type,id}] }`
  — 각 배열 ≤30, id ≤64자.
- `appReports`: `db.getAll` → `{id,text,status,reply,replyStatus,repliedAt}` (기존 `getMyAppReports` 로직 이관).
- `corrections`: `db.getAll` → `{id, label, field, status, autoApplied, reply, repliedAt}`.
- `contentReports`: 각 `{type,id}` 마다 deletedContent 쿼리 + 원 문서 존재/`reportDismissedAt` 확인 → `{type, id, outcome, reason}`.
- uid 검증 없음 (앱 리포트 회신 설계의 위협 모델과 동일).
- `getMyAppReports` 는 남겨 둔다(배포된 CF, 미참조여도 무해).

### `FeedbackPopup` (= `AppReportReplyPopup` 개명·확장)
- `fetchFeedback()` → 안 본(`seen` 에 없는) 결과만 모아 `NoticePopup` 스타일로.
- 섹션 3개(앱 문제 답변 / 수정 제안 결과 / 신고 결과), 각 항목 문구는 위 표.
- 닫으면 전부 `markSeen`.
- `Home.jsx` 의 `<AppReportReplyPopup />` → `<FeedbackPopup />`.

### `CorrectionModal` ([src/components/CorrectionModal.jsx:141](../../../src/components/CorrectionModal.jsx#L141))
- 제출을 `feedback.submitCorrection(payload)` 로. 성공 시 `recordSubmission('correction', { id: r.id, summary: subject })`.
- 완료 화면에 한 줄 추가: "결과는 앱을 다시 열 때 알려드려요."
- `endpoint` 자동 첨부(푸시 구독 시).

### `AppReportModal`
- import 를 `feedback.js` 로 교체(동작 동일 — `submitReport`→`feedback.submitAppReport`, `fetchMyReports`→`feedback.fetchFeedback().then(f => f.appReports)`).

## Ⅳ. 푸시 SW

`kind: 'feedback_reply'` 추가 (앱 리포트의 `app_report_reply` 를 일반화하거나 나란히).
`ADMIN_KINDS`(서버가 title/body 싣는 kind)에 `feedback_reply` 포함. `?v=12 → v=13`.
앱 리포트 답변은 계속 `app_report_reply` 로 보내도 되고 `feedback_reply` 로 통합해도 됨
— **통합**: `reply_app_report` 도 `kind: 'feedback_reply'` 로 바꾼다(SW 는 둘 다 처리하되
신규는 `feedback_reply`).

## Ⅴ. 색인 (`firestore.indexes.json`)

- `corrections (status ASC, repliedAt DESC)` — `purgeCorrections` 는 전체 스캔(작음)이라
  실제로는 색인 불필요. `listCorrections` 등 기존 쿼리는 그대로. **색인 추가 없음** 목표
  — `purgeCorrections` 도 `deletedContent`/`appReports` purge 처럼 컬렉션 스캔.

## Ⅵ. Rules

변경 없음. `corrections`·`appReports` 는 `if false` 유지, 기기는 `getMyFeedback` CF로만.
`deletedContent` 도 함수 전용 유지.

## Ⅶ. 테스트

- `node --check` (functions), `npm run build`.
- 배포 후 실기기:
  1. 수정 제안 제출 → 관리자 반려(사유 입력) → 앱 재진입 → "❌ 반려: {사유}" 팝업.
  2. 수정 제안 자동반영(같은 제안 3건) → "📌 자동 반영" 팝업.
  3. 게시글 신고 → 관리자 삭제 → 신고자 앱 재진입 → "🗑️ 삭제 조치" 팝업.
  4. 게시글 신고 → 관리자 무시(사유) → "검토 결과 유지: {사유}" 팝업.
  5. 앱 리포트 회신(기존) 회귀 확인 — `FeedbackPopup` 으로도 뜨는지.

## Ⅷ. 범위 밖 (YAGNI)

- 신고별 1:1 관리자 답변(개별 문서 필요 → 익명 설계 위배).
- 댓글 신고 결과 통보(댓글은 개별 신고 UI 자체가 제한적).
- 제안·신고 결과에 사용자 재질문.
