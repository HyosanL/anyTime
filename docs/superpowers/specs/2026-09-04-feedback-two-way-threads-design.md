# 피드백 양방향 스레드 — 설계

작성: 2026-09-04

## 배경

지금 제안·신고 회신은 **단방향**이다. 제출자가 보내면 관리자가 적용/반려/삭제하고
선택 메모 1줄(`reply`)을 남기며, 그게 `FeedbackPopup` 에 한 번 떠서 끝난다.
`2026-09-03-feedback-corrections-reports-design.md` §Ⅷ 은 "제안·신고 결과에 사용자
재질문" 을 명시적으로 범위 밖(YAGNI)으로 뒀는데, **이 문서가 그걸 뒤집는다.**

동기 사례: 강의실 수정 제안이 오면 관리자가 반영 전에 "강의실이 실제로 변동됐나요?"
를 물어보고, 제출자 답을 받은 뒤 반영하고 싶다. 이를 위해 각 제안·신고를 **게시글/채팅
형태의 스레드**로 운영하고, 처리된 것들은 펼쳐 나열하지 않고 **요약 목록 → 탭하면
전체 대화**로 본다. 스레드는 **모든 관리자에게 동일하게 공유**된다(문서 1개).

3개 채널(수정 제안 · 앱 문제 · 콘텐츠 신고)을 **하나의 스레드 모델**로 통합한다.

## 확정 결정

| 항목 | 결정 |
|---|---|
| 질문 시작 | 모든 대기 항목에 **수동 "질문하기"** 버튼. 강의실 필드는 원터치 상용구("강의실이 변동되었나요?"). 처리 버튼(적용/반려/삭제…)은 항상 활성 |
| 묶음 | 유지. 질문은 묶음/콘텐츠 전체 기기에 **팬아웃**, 아무나 답변 → 관리자 스레드 하나로 모임 |
| 자동반영 | **열린 스레드가 걸린 묶음은 3건↑ 자동반영 보류**, 스레드가 `closed` 되면 재개 |
| 제출자 화면 | 홈 🚩 = **`/feedback` 허브 페이지**(🚩에 안읽음 배지) + `FeedbackPopup` 대화형 확장 |
| 관리자 표시 | 관리자끼리는 username, 제출자에겐 "관리자" |
| 제출자 시야 | 묶음/콘텐츠 스레드에서 관리자 메시지 + 다른 제출자 답변(익명 "제안자 2·3")까지 봄 |
| 결과 기록 | `reply` 1줄 개념 제거 → **스레드가 기록**, 결과 = 마지막 메시지 + `outcome` 배지 |

---

## Ⅰ. 통합 스레드 모델

### `feedbackThreads/{threadId}` (신규)

Rules: `allow read, write: if false` — `corrections`·`appReports` 와 동일하게 전부
Admin SDK / `getMyFeedback` CF 경유.

```
{
  channel: 'correction' | 'app_report' | 'content_report',

  // 채널별 원본 참조
  correctionIds?: string[],          // channel=correction — 이 묶음에 속한 correction 문서들
  contentRef?: { type, id },         // channel=content_report — type: board_post|review|class_memo
  appReportId?: string,              // channel=app_report

  // 표시용 스냅샷 (원본이 지워져도 목록에 뜨도록)
  label: string,                     // "항공기상 3분반 · 강의실" / 게시판명 / 앱 경로
  summary: string,                   // 제안값 요약 / 신고 대상 본문 앞부분 / 리포트 텍스트

  status: 'open' | 'answered' | 'closed',
       // open    = 제출자 답 대기 (마지막 발화자 = 관리자)
       // answered= 관리자 차례   (마지막 발화자 = 제출자)
       // closed  = 결과 확정 (적용/반려/삭제/유지/수정)
  outcome: null | 'applied' | 'rejected' | 'resolved'    // correction
                | 'removed' | 'kept' | 'edited'          // content_report
                | 'reviewing' | 'planned' | 'done',      // app_report

  messages: [                        // 배열, 최대 50개 (초과 시 가장 오래된 것부터 밀어냄)
    {
      seq: number,                   // 1부터 단조 증가
      from: 'admin' | 'user',
      authorKey: string,             // admin: uid  |  user: 참여자 핸들(아래 §Ⅱ)
      adminName: string | null,      // from=admin 일 때 users/{uid}.username 스냅샷
      text: string,                  // ≤ 1000자
      at: Timestamp,
    }
  ],

  participantKeys: string[],         // 답변에 참여한 user authorKey 들 (권한 검증용, §Ⅱ)
  subIds: string[],                  // 푸시 대상 (sha256(endpoint) hex), 중복 제거

  lastMessageAt: Timestamp,
  createdAt: Timestamp,
}
```

### threadId — 결정적 ID (조회용 lookup 문서 불필요)

| channel | threadId | 근거 |
|---|---|---|
| correction | `correction_<sha256(groupKey).slice(0,16)>` | groupKey = `target\|professorCode\|courseCode\|year\|term\|sectionNo\|field\|suggested` (Moderation.jsx `groupKey()` 와 동일 규칙). `submitCorrection` 이 질의 없이 존재 확인 가능 |
| content_report | `content_<type>_<contentId>` | 콘텐츠당 스레드 1개. 신고자 기기는 `{type,id}` 만으로 스레드 위치를 앎 |
| app_report | `appreport_<appReportId>` | 1:1 |

원본 문서에 역참조 필드 추가:
- `corrections/{id}.threadId` (nullable)
- `appReports/{id}.threadId` (nullable)
- 콘텐츠 신고는 원본에 안 씀 — threadId 가 `{type,id}` 로 결정적이라 불필요.

### 지연 생성

스레드는 **관리자가 처음 메시지를 보낼 때** 생성된다(제출마다 만들지 않음 — egress 원칙,
`capacity-cost-800dau`). 앱 문제는 기존 "첫 답변" 시점이 곧 첫 관리자 메시지.

### 표시 계약 (authorKey 는 외부로 안 나감)

- **관리자 화면**: `authorKey`(uid) → username 해석. user `authorKey` → "제안자 N"
  (N = 스레드 내 서로 다른 user authorKey 의 첫 등장 순서).
- **`getMyFeedback` 응답**: 메시지를 `{ seq, who: 'admin'|'me'|'other', pid, text, at }`
  로 변환. `who='me'` = `authorKey === 호출자 핸들`, `who='other'` = 다른 제출자,
  `who='admin'` = 관리자(pid 없음). `pid` = "제안자 N" 의 N. `authorKey`·`adminName`·
  `subIds`·`participantKeys` 는 응답에서 제거.

---

## Ⅱ. 익명성 — 채널별 라우팅

서버는 어느 채널에서도 제출자의 uid 를 스레드에 저장하지 않는다. 제출자는 **재계산
가능한 핸들**로 자기 스레드 소유권을 증명한다. `board-full-anonymity` 원칙 유지 —
추적·차단 수단은 여전히 없고, 새로 저장되는 것은 제출자가 직접 친 답변 텍스트와
선택적 `subId`(푸시용, 이미 다른 채널이 하는 것)뿐.

| channel | 제출자 핸들 (authorKey) | 기기가 쥔 것 | 서버 검증 |
|---|---|---|---|
| correction | `correctionId` | `feedback:mine.correction[].id` (localStorage) | 해당 `corrections/{id}` 존재 + 그 `threadId` 가 대상 스레드 |
| app_report | `appReportId` | `feedback:mine.appReport[].id` | 동일 |
| content_report | `actorHash(salt, uid, scope, contentId)` | `bb-reacted` 의 `{scope}:{id} → {report:true}` | 호출자 uid 로 `actorHash` **재계산** → 콘텐츠 `reactions/{hash}` 존재 **또는** `thread.participantKeys` 포함 |

- `actorHash` 는 이미 신고 중복방지(`reactions/{hash}`)에 쓰는 salted 단방향 해시
  (`firebase/functions/src/lib/hash.js`). scope 문자열은 채널별 기존 값 그대로:
  `review-report` / (메모) `classMemo.js` 의 값 / `board-post-react`.
- 콘텐츠가 자동삭제된 뒤에는 `reactions/{hash}` 가 사라지므로 `participantKeys` 로 검증.
  질문에 한 번도 답 안 한 신고자가 그 전에 콘텐츠가 지워지면 스레드를 못 보지만
  (희귀), 그 경우 기존 `deletedContent` 경로로 "삭제 조치됨" 결과는 그대로 뜬다.

---

## Ⅲ. Cloud Functions

### 신규

**`askFeedbackQuestion(payload)`** — 관리자 전용, `adminAction` 게이트웨이 액션
```
payload: { channel, text,
           ids?: string[],          // channel=correction (Moderation 이 쥔 group.ids)
           contentRef?: {type,id},  // channel=content_report
           appReportId?: string }   // channel=app_report
```
- threadId 계산: correction 은 `corrections/{ids[0]}` 를 읽어 groupKey 조립 → `sha256`;
  content_report 는 `contentRef` 로 바로; app_report 는 `appReportId` 로 바로.
- `feedbackThreads/{threadId}` 를 `get`. 없으면 생성(label·summary 스냅샷, `createdAt`).
  있으면 append. seq·append 는 트랜잭션(`messages.length + 1` 재계산)으로 동시성 안전.
- 메시지 push: `{ seq, from:'admin', authorKey: uid, adminName: username, text, at }`.
- `status = 'open'`, `outcome` 유지, `lastMessageAt` 갱신.
- correction: `ids` 각각에 `threadId` 세팅, `correctionIds` 에 arrayUnion.
- 푸시 대상 subIds 수집:
  - correction/app_report: 각 원본 문서의 `subId`.
  - content_report: 콘텐츠 `reactions` 서브컬렉션 `where kind=='report'` 의 `subId` (있는 것만).
  - `thread.subIds` 와 합쳐 dedup, `kind: 'feedback_question'` 푸시.
- text ≤ 1000자, trim, 빈 값 거부.

**`replyFeedbackThread(payload)`** — 생도 `onCall`
```
payload: { channel, text,
           correctionId? | appReportId? | contentRef?,   // 채널별 참조
           endpoint?: string }                            // 현재 푸시 구독(있으면)
```
- 채널별 권한 검증(§Ⅱ). 실패 시 `permission-denied`.
- 대상 스레드 `get` — 없으면(관리자가 아직 질문 안 함) `NO_THREAD` 반환(프론트는 답장란을
  스레드 `open` 일 때만 노출하므로 정상 경로에선 안 생김).
- 메시지 append: `{ seq, from:'user', authorKey: <핸들>, adminName: null, text, at }`.
- `authorKey` 를 `participantKeys` 에 arrayUnion. `endpoint` 있으면 `sha256` → `subIds` arrayUnion.
- `status = 'answered'`, `lastMessageAt` 갱신.
- `adminPush({ kind: 'feedback_reply', title: '💬 피드백 답변', body: <label> })`.
- text ≤ 1000자. 스레드 `messages.length >= 50` 이면 `FULL` 반환(프론트에서 안내).
- 레이트 제한: 같은 authorKey 가 마지막 user 메시지 이후 관리자 메시지 없이 연속 3개면 거부.

### 변경

**`submitCorrection`** (`firebase/functions/src/corrections.js`)
- 신규 correction 생성 후, 기존 dupe 질의 결과에 `threadId` 가진 형제가 있으면 이 문서에도
  `threadId` 세팅 + 그 스레드 `correctionIds` arrayUnion (새 기기가 기존 대화를 봄).
- **자동반영 게이트 추가**: `isAuto && dupeCount >= 3` 이어도, `feedbackThreads/correction_<hash>`
  를 `get` 해서 존재 & `status !== 'closed'` 면 자동반영 skip(문서는 pending 유지, 관리자
  큐에 남음). auto 경로에서만 1회 추가 read.

**관리자 처리 액션** (`firebase/functions/src/admin/moderationActions.js`)
`applyCorrection` / `rejectCorrection` / `resolveCorrection` / `deletePost`(신고 맥락) /
`dismissReport` / `editPost`(신고 맥락) / `replyAppReport` — 각자 원래 일 + **스레드가 있으면**:
- `payload.text`(선택 마감 메시지) 있으면 관리자 메시지 append.
- `status = 'closed'`, `outcome` = 해당 결과값.
- 원본의 `reply`/`repliedAt` 비정규화 필드는 **목록 미리보기용**으로만 계속 채운다
  (마지막 관리자 메시지 복사 + 처리 시각). `purgeCorrections` 의 `repliedAt` 조건 유지.
- `subId` 있으면 기존대로 결과 푸시(`feedback_reply`) — 스레드 유무와 무관.

기존 `annotate_correction`(사후 메모) → `askFeedbackQuestion`(closed 스레드에 관리자 메시지
추가, `status='open'` 으로 되돌림)로 대체. 액션 이름은 `annotate_correction` 유지하되
내부 구현만 스레드 append 로.

**`getMyFeedback`** (`firebase/functions/src/feedback.js`)
- `lookupCorrections`: 각 correction 의 `threadId` 로 스레드 `getAll` → `thread` 동봉
  (§Ⅰ 표시 계약대로 변환, 호출자 핸들 = 그 correctionId).
- `lookupAppReports`: 동일, 핸들 = appReportId.
- `lookupContentReports`: `{type,id}` 마다 `feedbackThreads/content_<type>_<id>` 도 `get`.
  존재하면 `actorHash` 재계산 → `reactions/{hash}` 또는 `participantKeys` 로 검증 후 `thread` 동봉.
- 응답에 `thread: { messages: [...], status, outcome } | null` 필드 추가.

**`reportReview`** / **`reportMemo`** (`reviews.js`, `classMemo.js`) / **`boardReact`** (`board.js`, `kind='report'`)
- 선택 `endpoint` 파라미터 추가. 있으면 `reactions/{hash}` 문서에 `subId: sha256(endpoint)` 저장.
- 그 외 동작·임계치·자동삭제 로직 전부 동일.

### 정리 (스케줄)

- `purgeCorrections` (`feedback.js`): stale correction 삭제 시 그 `threadId` 의
  `feedbackThreads` 문서도 함께 삭제(같은 배치). 한 스레드에 묶인 correctionIds 가
  전부 stale 일 때만.
- `purgeAppReports` (`appReport.js`): 삭제되는 appReport 의 `appreport_<id>` 스레드 삭제.
- `deletedContent` 30일 TTL 로 사라지는 콘텐츠 신고: 신규 스케줄 `purgeContentThreads`
  (월간) — `feedbackThreads` 중 `channel=='content_report'` 이고 `status=='closed'` &
  `lastMessageAt` 30일 경과분 삭제. 컬렉션 스캔(작음, 색인 불필요).

---

## Ⅳ. 관리자 화면 — `src/pages/Moderation.jsx`

3개 탭(신고 / 수정 제안 / 앱 문제)에 스레드 UI 추가. 게시글·댓글 탭은 그대로.

### 대기 카드 (수정 제안 `CorrectionCard`, 신고 `ReportCard`, 앱 문제 `AppReportCard`)

- 하단 액션에 `💬 질문하기` 버튼. 누르면 카드 안에 답장 입력란 펼침 + `질문 보내기`.
- **강의실 필드**(`target==='section_time' && field==='room'`): `강의실 변동 확인` 원터치
  버튼 — 상용구 `"강의실이 변동되었나요? 바뀌었다면 새 강의실 번호를 알려 주세요."` 를
  바로 전송.
- 스레드가 이미 있으면 카드에 **대화 목록** 렌더(관리자 = username, 제출자 = "제안자 N",
  말풍선 좌우 구분) + 답장란. `⏳ 답변 대기`(open) / `● 새 답변`(answered) 배지.
- 기존 처리 버튼(적용/반려/삭제/무시/수정/편집에서 열기) 전부 유지. 처리 시 답장란 내용이
  있으면 마감 메시지로 함께 전송.

### 처리함 / 답변함

- 요약 행: `대상 · outcome 배지 · 마지막 메시지 미리보기 · 시각`. (지금처럼 diff 전체를
  펼치지 않음.)
- 행 탭 → 아코디언으로 **전체 대화 펼침**(읽기 전용) + 하단에 후속 메시지 입력란
  (`annotate_correction` 경유 — 보내면 제출자에게 다시 뜸).
- `list_processed_corrections` / `list_replied_app_reports` 응답에 `thread` 요약
  (`lastMessage`, `status`, `outcome`, `messageCount`) 동봉. 펼칠 때 전체 메시지는
  이미 응답에 실려 있음(스레드 ≤ 50 메시지, 부담 없음).

### 공유

스레드는 `feedbackThreads` 문서 1개라 폴링(`POLL_MS`)으로 모든 관리자가 같은 상태를 본다.
동시에 두 관리자가 메시지를 쓰면 `arrayUnion` + 서버측 `seq = messages.length + 1` 재계산
트랜잭션으로 유실 없이 둘 다 append.

---

## Ⅴ. 제출자 화면

### 홈 🚩 재구성 — `src/pages/Home.jsx`

- 지금 `🚩` 버튼(→ `AppReportModal` 오픈)을 `<Link to="/feedback">` 로 교체.
- 🚩 우상단에 **안읽음 배지**(숫자). count = 스레드 중 (마지막 seq > `threadSeen[threadId]`
  인 관리자 메시지가 있음) **또는** (`closed` 인데 outcome 을 아직 안 봄) 인 것의 **수**
  — 스레드당 최대 1. 0 이면 배지 없음.
- `FeedbackPopup` 이 이미 홈에서 `fetchFeedback()` 를 호출하므로, 그 호출을 Home 으로
  끌어올려 1회만 하고 `FeedbackPopup` + 🚩 배지가 공유(prop 또는 가벼운 context).

### `/feedback` 페이지 (신규 — `src/pages/Feedback.jsx`, `ProtectedRoute`)

- 상단: `앱 문제 신고` 버튼 → 기존 `AppReportModal` 재사용.
- 목록: 내 수정제안 · 콘텐츠 신고 · 앱 문제를 최신순 행. 각 행 = `채널 아이콘 · 요약 ·
  상태/결과 배지 · 안읽음 점`.
- 행 탭 → 스레드 뷰: 전체 메시지(관리자 = "관리자", 나 = 오른쪽, 다른 제출자 = "제안자 N"),
  `status==='open'` 이면 하단 답장 입력란 → `replyFeedbackThread`.
- 스레드 없는 항목(관리자가 아직 아무 말 안 함)도 행으로는 뜨되 "검토 대기 중" 표시,
  답장란 없음.
- 로컬 `feedback:threadSeen = { <threadId>: <lastSeenSeq> }` (스레드 없는 항목은 안 봤을
  게 없음) — 스레드 뷰를 열면 마지막 seq 로 갱신, 배지에서 빠짐. `closed` outcome 을
  본 것은 기존 `feedback:seen` 배열 재사용(`correction:<id>` 등).

### `FeedbackPopup` — `src/components/FeedbackPopup.jsx`

- 안 본 관리자 메시지(스레드 seq > seen) 또는 안 본 `closed` 결과가 있으면 표시.
- 항목마다: 관리자 마지막 메시지 말풍선 + (`status==='open'` 이면) **인라인 답장 입력란**.
  답장 전송 성공 시 그 줄을 "전송됨" 으로.
- 하단 `전체 보기` → `/feedback` 로 이동.
- 닫으면 표시했던 스레드들 `markSeen`(seq 기록).

### `src/lib/feedback.js`

- `feedback:threadSeen` 저장소 + `readThreadSeen()` / `markThreadSeen(threadKey, seq)`.
- `fetchFeedback()` 반환 항목에 `thread` 포함(그대로 패스스루).
- `replyFeedbackThread(channel, ref, text)` wrapper — `currentEndpoint()` 자동 첨부.
- `unreadCount(feedback)` — 배지 계산 헬퍼.

---

## Ⅵ. 푸시 SW — `public/push-sw.js`

- `ADMIN_KINDS`(서버가 title/body 싣는 kind)에 `feedback_question` 추가.
- `feedback_reply` 는 이미 있음(관리자 대상). `app_report_reply` → `feedback_reply` 통합
  방향 유지.
- `feedback_question` 클릭 → `/feedback`. SW 캐시 버전 bump (`?v=` 증가).

---

## Ⅶ. 색인 · Rules

- **색인 추가 없음**. `feedbackThreads` 는 전부 결정적 ID `get` / `getAll` / 컬렉션 스캔
  (purge, 작음). `reactions where kind=='report'` 는 서브컬렉션 소규모 스캔.
- **Rules**: `feedbackThreads` `if false` 추가. 나머지 변경 없음.

---

## Ⅷ. 자동반영 상호작용 (요약)

1. 제출자 A 가 강의실 제안 → pending.
2. 관리자가 `💬 질문하기` → `feedbackThreads/correction_<hash>` 생성, `status='open'`.
3. 제출자 B, C 가 같은 제안 → `submitCorrection` 이 스레드 존재 & `open` 확인 → **자동반영
   skip**, B·C 문서도 같은 threadId 로 연결(대화 공유).
4. 누군가 "네, 305로 바뀌었어요" 답 → `status='answered'`, 관리자에 푸시.
5. 관리자가 제안값이 305 와 맞으면 `적용`(마감 메시지 선택) → `status='closed'`,
   `outcome='applied'`, 카탈로그 반영, 묶음 전체 drain.
6. (만약 관리자가 스레드를 닫지 않고 방치하면 자동반영은 계속 보류 — 의도된 동작.)

---

## Ⅸ. 구현 단계 (계획에서 분할)

1. **모델 + 골격**: `feedbackThreads` 스키마, `askFeedbackQuestion`/`replyFeedbackThread`
   CF, `getMyFeedback` 확장, Rules, SW kind. `/feedback` 페이지 + 🚩 링크·배지 골격
   (아직 correction 만 연결).
2. **수정 제안 스레드**: `Moderation` 수정 제안 탭 UI, `submitCorrection` 자동반영 게이트,
   관리자 처리 액션 → `closed`/`outcome`, `annotate_correction` 재구현, `FeedbackPopup`
   대화형.
3. **앱 문제 스레드**: `replyAppReport` → 스레드 흡수, `AppReportCard` UI, 답변함 요약,
   `getMyFeedback` app_report thread.
4. **콘텐츠 신고 스레드**: `reportReview`/`reportMemo`/`boardReact` 의 `endpoint`→`subId`,
   `ReportCard` UI, `lookupContentReports` thread + actorHash 검증, `purgeContentThreads`.

각 단계 끝에 `node --check`(functions) + `npm run build`. 라이브 스키마 변경 없음
(Firestore 필드 추가만) — `live-migration-deploy-order` 대상 아님. 배포는
`functions-deploy-via-gh-actions`(push→Actions), 프론트는 Pages Git 연동.

---

## Ⅹ. 테스트 (배포 후 실기기)

1. 강의실 제안 → 관리자 `강의실 변동 확인` 원터치 → 제출자 앱 재진입 →
   `FeedbackPopup` 에 질문 + 답장란 → 답장 → 관리자 화면에 "제안자 1: …" →
   관리자 `적용`(마감 메시지) → 제출자에 결과 팝업.
2. 같은 제안 3건 중 1건에 열린 스레드 → 3번째 제출해도 자동반영 안 됨 확인 →
   스레드 `closed` 후 4번째 제출 시 자동반영 재개.
3. 게시글 신고 2명 → 관리자 질문 → 두 기기 모두 질문 수신 → 한 명 답 →
   다른 한 명도 그 답을 "제안자 2" 로 봄 → 관리자 삭제 → 양쪽 "삭제 조치됨".
4. 앱 문제 리포트 → 관리자 질문 → 제출자 답 → 관리자 재질문 → 왕복 3회 →
   `done` 마감. 답변함에 요약 1행, 탭하면 전체 대화.
5. 🚩 배지: 안 읽은 관리자 메시지 수 정확, `/feedback` 에서 스레드 열면 감소.
6. 회귀: 스레드 없는 기존 흐름(질문 없이 바로 적용/반려/삭제)이 그대로 동작.

---

## Ⅺ. 범위 밖 (YAGNI)

- 댓글 신고 스레드(댓글은 개별 신고 UI 자체가 최소).
- 스레드 실시간 구독(폴링 + 앱 재진입으로 충분).
- 신고자 차단·계정 추적(익명 설계 유지 — `board-full-anonymity`).
- 스레드 첨부 이미지.
- 관리자 간 스레드 내부 메모(제출자 비공개) — 필요해지면 별도.
