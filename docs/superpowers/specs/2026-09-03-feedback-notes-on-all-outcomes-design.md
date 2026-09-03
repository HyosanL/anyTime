# 모든 처리 결과에 관리자 메모 — 설계

작성: 2026-09-03

## 배경

`2026-09-03-feedback-corrections-reports-design.md` 로 강의 수정 제안·콘텐츠 신고 결과가
제출 기기에 전달된다(익명 유지, `FeedbackPopup`). 그런데 관리자가 자유 문구를 남길 수
있는 건 **반려**(`reject_correction`)와 **무시**(`dismiss_report`) 뿐이다 — 둘 다
`window.prompt()` 로 사유를 받는다.

`apply`(적용) · `resolve`(직접 수정 후 정리) · 신고글 삭제/수정은 정형 문구만 나간다
("✅ 제안이 반영됐어요"). 관리자가 "여기 이렇게 고쳤습니다" 를 덧붙일 자리가 없다.
사용자는 자기 제보가 **어떻게** 처리됐는지 알고 싶어 한다.

## 목표

제출자에게 도달하는 **모든** 처리 결과에 선택적 관리자 메모를 붙일 수 있게 한다.
새 컬렉션·색인 없음. `corrections.reply` / `reportDismiss*` 브레드크럼 패턴을 그대로 확장.

| 채널 | 결과 | 지금 | 변경 후 |
|---|---|---|---|
| 수정 제안 | 반려 | prompt 사유 → `reply` | 카드 인라인 메모 → `reply` |
| 수정 제안 | 적용 | 정형 문구만 | + 선택 메모 → `reply` |
| 수정 제안 | 정리(직접 수정) | 정형 문구만 | + 선택 메모 → `reply` |
| 신고 | 무시(유지) | prompt 사유 → `reportDismissReason` | 카드 인라인 메모 (동일 필드) |
| 신고 | 삭제 | 통보만("삭제 조치") | + 선택 메모 → `deletedContent.adminNote`, 아카이브되어 복구 가능 |
| 신고 | 수정 조치 | **통보 없음** | 새 결과 `edited` + 선택 메모 → `reportEditNote` |

푸시 핸들이 있는 건(수정 제안, `subId`)은 푸시도 결과별 문구로. 신고는 원래 푸시 핸들이
없어 팝업만(변경 없음).

## Ⅰ. 데이터

새 컬렉션·색인 **없음**. 관리자 함수(Admin SDK)만 쓰는 필드 추가:

- `corrections/{id}` — `reply` / `repliedAt` 이미 존재. `apply`·`resolve` 가 이제 `reply` 를 채운다.
- `reviews` · `classMemos` · `boardPosts` — `reportEditNote: string|null`, `reportEditedAt: Timestamp`
  (`reportDismissReason` / `reportDismissedAt` 와 같은 패턴). 수정 조치 시 `reportCount` ·
  `reportReviewedCount` 를 0 으로 → 신고 큐에서 빠지고, 이후 신고가 다시 쌓이면 재노출.
- `deletedContent/{id}` — `adminNote: string|null` 추가. `archiveDeleted()` 에 선택 파라미터.

메모 상한 300자(트림), reject 와 동일 클램프.

## Ⅱ. 백엔드 — `firebase/functions/src/admin/moderationActions.js`

### `applyCorrection({ id, reason? })`
- `reason` 트림·≤300자·없으면 null. `apply` 트랜잭션의 `tx.update` 에 `reply: reason || null` 추가
  (`status: 'applied'`, `repliedAt` 와 함께). `ALREADY_DONE` 경로도 동일.

### `resolveCorrection({ ids, id?, reason? })`
- 각 `batch.update` 에 `reply: reason || null` 추가.

### `pushCorrectionOutcome(snap)`
- `status` · `autoApplied` · `reply` 로 제목/본문 분기:
  - rejected → "🔎 제안 검토 결과"
  - applied + autoApplied → "📌 제안이 자동 반영됐어요"
  - applied → "✅ 제안이 반영됐어요"
  - resolved → "✅ 제안 처리 완료"
  - 본문: `reply` 있으면 앞 80자, 없으면 상태별 정형 한 줄.
- `kind: 'feedback_reply'` 유지 → **SW 변경·버전업 없음**.

### `editPost({ table, id, fields, reason?, postId? })`
- 기존 검증·패치 구성 뒤, `table ∈ {review, class_memo, board_post}` 이고 대상 문서
  `reportCount > 0` 이면 같은 `update` 패치에 병합:
  `reportEditNote: reason || null`, `reportEditedAt: serverTimestamp()`,
  `reportCount: 0`, `reportReviewedCount: 0`.
- 신고 대상 타입일 때만 문서를 1회 `get`. `board_comment` · `exam_archive` 는 신고 흐름
  없어 미적용.
- 푸시 없음(`dismissReport` 와 동일 — 신고자 푸시 핸들 미보관).

### `deletePost({ table, id, reason?, postId? })`
- `board_comment` 조기 반환은 그대로.
- `table ∈ {review, class_memo, board_post}` 이고 (`reason` 있음 **또는** `reportCount > 0`)
  이면: 문서를 읽어 `archiveDeleted(tx, db, { type: table, origId: id, label, text,
  reportCount, reason: 'admin', adminNote: reason, snapshot: { id, ...data } })` 후
  `tx.delete`, 이어서 `recursiveDelete`(서브컬렉션 잔여분) — board.js 신고삭제 패턴 그대로.
- 그 외(비신고 맥락, 메모 없음, exam_archive)는 기존대로 맨 `recursiveDelete`.
- 부수효과: 신고 맥락 삭제가 이제 `삭제됨` 탭에 뜨고 **복구 가능**해진다.

### `dismissReport` — 변경 없음
- 이미 `reason` 을 받아 `reportDismissReason` 에 저장. UI 만 prompt → 인라인 메모.

## Ⅲ. 백엔드 — `firebase/functions/src/feedback.js` (`getMyFeedback`)

### `lookupCorrections` — 변경 없음
- 이미 `reply` 반환.

### `lookupContentReports` — 결과 필드 통일
관리자 자유 문구를 전부 `note` 로(자동삭제 코드였던 `reason` 은 제거 — 팝업이 쓴 적 없음):
```js
if (!delSnap.empty)             → { type, id, outcome: 'removed', note: adminNote ?? null }
else if (!docSnap.exists)       → { type, id, outcome: 'removed', note: null }
else if (reportEditedAt)        → { type, id, outcome: 'edited',  note: reportEditNote ?? null }
else if (reportDismissedAt)     → { type, id, outcome: 'kept',    note: reportDismissReason ?? null }
```

## Ⅳ. 백엔드 — `firebase/functions/src/lib/archive.js`

- `archiveDeleted(tx, db, { ..., adminNote })` — `adminNote: adminNote ?? null` 기록.
  기존 호출부(board.js · classMemo.js)는 `adminNote` 미전달 → null, 영향 없음.

## Ⅴ. 프론트 — `src/components/FeedbackPopup.jsx`

- 라인 객체에 `note` 필드 추가. 렌더에 한 줄 더:
  `{l.note && <p className="ntc-content ar-pop-note">↳ {l.note}</p>}`
- `correctionLine`: 상태별 기본 문구(rejected 는 "🔎 이번엔 반영하지 않았어요.")
  + `note = it.reply || null`.
- `contentLine`: `removed`/`edited`/`kept` 기본 문구 + `note = it.note || null`.
  `edited` → "✏️ 신고하신 내용이 수정 조치됐어요." `kept` 는 메모 없을 때 기존 설명 문구 유지.
- `home.css` 에 `.ar-pop-note`(작은 회색, `--text-3`) 추가.

`src/lib/feedback.js` 는 `contentReports` 를 그대로 통과시키므로 변경 없음.

## Ⅵ. 프론트 — `src/pages/Moderation.jsx`

`AppReportCard` 패턴대로 카드 단위 서브컴포넌트 + 접이식 메모.

### `<CorrectionCard g … onApply onReject onEdit>` (검토 대기 목록)
- `note` state + "↳ 제출자에게 메모 (선택)" 토글 → `<textarea class="ar-reply-ta" maxLength={300}>`.
- `적용` → `onApply(g, note)`, `반려` → `confirm()` 후 `onReject(g, note)`, `편집에서 열기` 그대로.
- 부모: `applyGroup(g, note)` → `apply_correction({ id, reason: note })` 반복.
  `rejectGroup(g, note)` → `prompt` 제거, `reject_correction({ id, reason: note })`.

### `<ReportCard it … onAck onDismiss onDelete onEdit>` (신고 탭)
- `note` state + 접이식 메모. `editing` state + 내용 `<textarea>`.
- 버튼: `확인`(메모 없음, 그대로) · `수정` · `삭제`(`confirm` 후) · `무시`(`confirm` 후).
- `수정` → 내용 textarea 펼침, `저장` → `onEdit(it, text, note)`.
- 부모:
  - `remove(it, note)` → `delete_post({ table, id, reason: note })`, 목록에서 제거.
  - `dismissReport(it, note)` → `prompt` 제거, `dismiss_report({ table, id, reason: note })`.
  - `editReported(it, text, note)` → `edit_post({ table, id, fields, reason: note })`,
    성공 시 신고 목록에서 제거(+ `load()`).

### 검열(글) 탭 편집 블록
- 기존 `mod-edit` textarea 아래 메모 입력 한 줄 추가, `edit.note` 바인딩.
- `saveEdit()` → `edit_post({ ..., reason: edit.note })`. (비신고 글이면 서버가 메모 무시.)

## Ⅶ. 프론트 — `src/pages/AdminCourse.jsx` (제안 배너)

- `.adm-corr-banner` 에 `<textarea>` "제출자에게 메모 (선택)" + `note` state.
- `applyProposal()` → `apply_correction({ id: corr.id, reason: note })`,
  나머지 형제 → `resolve_correction({ ids: others, reason: note })`.
- `dismissProposal()` → `resolve_correction({ ids, reason: note })`.

## Ⅷ. CSS

- `src/styles/admin.css` 또는 `correction.css` — `.mod-memo-toggle`(link 버튼),
  메모 textarea 는 기존 `.ar-reply-ta` 재사용. 토큰만(색은 `var(--token)`).
- `home.css` — `.ar-pop-note`.

## Ⅸ. 테스트

- `node --check` (변경 함수), `npm run build`.
- 배포 후 실기기:
  1. 수정 제안 제출 → 관리자 `적용` + 메모 → 앱 재진입 → "✅ 반영됐어요" + "↳ {메모}" 팝업.
  2. 반려 + 메모(회귀, 이제 인라인) → "🔎 …" + "↳ {메모}".
  3. AdminCourse 배너에서 직접 수정 후 `제안 정리` + 메모 → "✅ 제안 처리 완료" + 메모.
  4. 게시글 신고 → 검열 탭에서 `수정` + 메모 → 신고자 앱 재진입 → "✏️ 수정 조치" + 메모,
     신고 큐에서 사라짐.
  5. 게시글 신고 → `삭제` + 메모 → 신고자 "🗑️ 삭제 조치" + 메모, `삭제됨` 탭에 뜨고 복구 가능.
  6. 무시 + 메모(회귀) → "검토 결과 유지" + 메모.

## Ⅹ. 범위 밖 (YAGNI)

- 신고자에게 푸시(핸들 미보관 — 팝업만).
- `ack_report` · `ack_correction` · 자동반영에 메모(무동작/시스템 경로).
- 결과에 사용자 재질문(제출자는 회신 불가 — 유지).
- 전송된 메모 수정·회수.

## 구현

계획: `docs/superpowers/plans/2026-09-03-feedback-notes-on-all-outcomes.md`.

2026-09-03 구현·배포 완료.
- `archiveDeleted` 에 `adminNote`. `applyCorrection`/`resolveCorrection` 가 `reply` 저장,
  `pushCorrectionOutcome` 상태별 문구. `editPost`/`deletePost` 가 신고 맥락이면
  `reportEditNote`/`reportEditedAt` 브레드크럼 + 삭제는 `archiveDeleted(reason:'admin')`.
- `getMyFeedback` `contentReports` 결과 필드 `reason`→`note` 통일, `edited` 결과 추가.
- `FeedbackPopup` 메모 줄(`.ar-pop-note`) + `edited` 문구.
- `Moderation.jsx` `ModMemo`(접이식) + `CorrectionCard`/`ReportCard` 서브컴포넌트,
  반려·무시 prompt() → 인라인 메모 + confirm(). 검열 탭 편집·AdminCourse 배너에 메모.
