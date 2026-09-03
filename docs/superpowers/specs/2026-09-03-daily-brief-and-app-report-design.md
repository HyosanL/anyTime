# 오늘 수업 요약 알림 + 앱 문제 리포트 — 설계

작성: 2026-09-03

## Ⅰ. 오늘 수업 요약(모닝 브리핑)

### 목표

"다음 수업 알림"(수업마다 N분 전 개별 알림)과는 별개로, 사용자가 정한 시각에
그날 수업 전체를 한 번에 요약해 알려주는 새 알림. 두 알림은 독립적으로
켜고 끌 수 있다(다음 수업 알림이 꺼져 있어도 요약 알림만 켤 수 있음).

- 발송 시각: 사용자가 5분 단위로 직접 지정(기본 꺼짐).
- 내용: 그날 확정 시간표 + 직접추가 강의를 시간순으로 나열
  (`⏰ 다음 수업 알림`과 같은 대상 — `computeBlocks()` 재사용).
- 수업이 없는 요일은 발동 시각 자체를 만들지 않는다(조용히 건너뜀 — 빈 알림 없음).
- **방해금지(DND) 무시** — 다음 수업 알림과 같은 이유: 사용자가 직접 정한 시각
  알람이므로 기본 방해금지 창(22:30~08:00)과 겹쳐도(예: 07:30) 소리·진동 유지.

### 아키텍처 — 다음 수업 알림과 동일한 접근 B 재사용

```
[기기]  확정 시간표 + 카탈로그 → computeBlocks() (기존, 재사용)
          → 요일별로 묶어 "그날 요약 문구" 생성
          ├─→ Cache API '/today-summary-schedule'  { hhmm, tz, byDay:{ "1":"09:00 경제원론 · 302\n11:00 …", … } }
          └─→ setTodaySummaryAlert CF → pushSubscriptions/{hash}.todaySummaryAlerts = { fireMinutes:[…] }
[서버]  기존 nextClassNotify(매분) 안에 쿼리 하나 추가:
          where('todaySummaryAlerts.fireMinutes','array-contains-any',[mow,back])
          → /api/push-fanout { kind:'today_summary', mow, path:'/' }  (내용 없음)
          → 보낸 구독에 todaySummaryAlerts.lastFired = {mow,at} 스탬프(독립적인 중복억제)
[기기 SW]  push 수신 → dayOfWeek = floor(mow/1440)+1 → byDay[dayOfWeek] → showNotification('🌅 오늘 수업', body) (DND 무시)
```

- 새 Cloud Scheduler 잡 없음 — 기존 매분 함수에 쿼리 1회 추가(무료 한도 내, 기존
  next-class-alert 설계 문서의 비용 분석과 동일 결론).
- `todaySummaryAlerts.lastFired`는 `nextClassAlerts.lastFired`와 별도 네임스페이스로
  독립 중복억제.
- fireMinutes는 최대 7개(요일당 최대 1개) — 서버 검증 상한(60개) 내 여유.

### 데이터 모델

**서버** — `pushSubscriptions/{hash}`에 필드 추가:
```
todaySummaryAlerts: { fireMinutes: [부요일 발동 시각…], updatedAt, lastFired: {mow, at} }
```
lead 값은 서버에 없음(발송 시각 자체가 리드타임 개념이 아니라 절대 시각이라 불필요).

**기기 Cache** (`push-meta` → `/today-summary-schedule`):
```
{ hhmm: "07:30", tz: "Asia/Seoul", byDay: { "1": "09:00 경제원론 · 302\n11:00 물리학 · 401", … }, updatedAt }
```
6개 초과 수업은 앞 6개만 담고 "외 N개" 덧붙임(알림 본문 과다 방지).

**기기 localStorage**: `dailybrief:on`(불리언), `dailybrief:hhmm`("HH:MM"), `dailybrief:sig`(업로드 서명, 다음 수업 알림의 `nextclass:sig`와 같은 역할).

### 구성요소

| 파일 | 역할 |
|---|---|
| `src/lib/dailyBrief.js` (신규) | `computeBlocks`(nextClass.js 재사용) → 요일별 요약 문구·발동시각 계산, `syncDailyBrief` 오케스트레이션, `getBriefOn/setBriefOn/getBriefTime/setBriefTime` |
| `src/lib/nextClass.js` | 변경 없음(computeBlocks export 그대로 재사용) |
| `src/App.jsx` | `PushSync`가 `syncDailyBrief()`도 호출 |
| `src/pages/Profile.jsx` | 새 섹션 "🌅 오늘 수업 요약" — 켜기/끄기 + `<input type="time" step="300">` + 테스트 버튼 |
| `public/push-sw.js` (+ `vite.config.js` `?v=10→11`) | `kind:'today_summary'` → Cache 요일별 문구로 알림, DND 무시 |
| `functions/api/push-fanout.js` | 변경 없음(`kind`·`mow`·`path` 이미 패스스루) |
| `firebase/functions/src/nextClass.js` | `setTodaySummaryAlert`(onCall, 신규) + `nextClassNotify`에 두 번째 쿼리·전송 분기 추가 |
| `firebase/functions/index.js` | `setTodaySummaryAlert` export 추가 |

### 테스트

- 순수 로직: 요일별 그룹핑·문구 포맷(6개 초과 절단 포함), 빈 요일 스킵, mow 계산.
- 실기기: 프로필 "🌅 오늘 수업 요약 테스트" 버튼 → 오늘 요일의 실제 요약 문구로 알림.
- 배포 후: `nextClassNotify` 로그에 인덱스 오류 없는지 확인(신규 `array-contains-any` 필드).

### 범위 밖 (YAGNI)

요일별 다른 시각 설정, 수업 없는 날 "쉬는 날" 알림, 브리핑에 공통공강/시험 등 추가 정보.

---

## Ⅱ. 앱 문제 리포트

### 목표

앱 사용 중 생기는 문제를 사용자가 직접 신고할 수 있는 채널. 기존 "정보 수정
제안"(🚩, 강의 데이터 오류용)과는 별개 — 앱 자체의 버그·오류를 위한 채널이다.
완전 익명(작성자 정보 미저장), 기존 게시판/제안 익명성 설계와 동일한 원칙.

### 진입점

Home 헤더의 📋(공유받은 글 붙여넣기, iOS 전용) 옆에 🚩 아이콘을 상시 노출
(플랫폼 무관). 클릭 시 `AppReportModal` 오픈.

### 모달

- 자유 텍스트 입력(필수, 5~500자): "무엇이 문제였나요?"
- 진단 정보는 자동 첨부, 사용자가 편집하지 않음: 현재 경로(`location.pathname`),
  `navigator.userAgent`, PWA 설치 여부(`isStandalone()`, `components/InstallGate.jsx`
  기존 헬퍼 재사용). 안내 문구로 투명하게 고지("진단 정보(경로·기기환경)가 함께
  전송돼요").
- 제출 → `submitAppReport` Cloud Function → 완료 화면("✅ 접수되었습니다").
- 스타일은 `styles/correction.css`의 기존 클래스(`.cor-overlay`, `.cor-modal`,
  `.cor-head`, `.field` 등) 재사용 — 새 CSS 파일 불필요.

### 백엔드

`firebase/functions/src/appReport.js` (신규):
```
submitAppReport(onCall): requireAuth 후
  - text 길이 검증(5~500자), path/ua 길이 상한(≤200/≤300)
  - appReports/{id} 문서 생성: { text, path, ua, standalone, status:'pending', createdAt }
  - adminPush(kind:'app_report', title:'🐞 새 앱 문제 리포트', body: text 앞 80자) — 매 건마다(제안과
    달리 자유 텍스트라 중복묶음·자동반영 없음)
```

`firestore.rules`: `match /appReports/{id} { allow read, write: if false; }` (기존
`corrections`/`pushSubscriptions`과 동일하게 함수 전용).

### 관리자 화면

기존 검열(Moderation.jsx) 탭바에 "앱 문제" 탭 추가.
`moderationActions.js`에 추가:
- `list_app_reports`: `status == 'pending'` 목록(createdAt desc, limit 200) — `listCorrections`와 동일 패턴.
- `ack_app_report`: 확인 처리 = 즉시 삭제(`ackCorrection`과 동일 — 익명이라 이력
  보관 가치 없음).

카드에 텍스트·경로·기기환경·시각 표시 + "확인" 버튼.

### push-sw.js

`ADMIN_KINDS`에 `'app_report'` 추가(제목·본문을 서버가 그대로 실어 보내는 기존
관리자 알림 경로 재사용, `path: '/admin/moderation'`).

### 범위 밖 (YAGNI)

리포트 상태 다변화(진행중/해결됨 등 세분화), 사용자에게 처리 결과 회신,
스크린샷 첨부.
