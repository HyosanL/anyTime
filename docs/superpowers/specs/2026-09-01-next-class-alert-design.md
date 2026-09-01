# 다음 수업 알림 (Next-class push alert) — 설계

작성: 2026-09-01

## Ⅰ. 목표

수업 시작 전 푸시 알림으로 "⏰ 다음 수업 / 선형대수학 · 202 · 08:00" 을 보낸다.
사용자는 **5분 전 / 10분 전 / 15분 전 / 끄기** 중 선택(프로필 → 푸시 알림, 기본 끄기).

- 대상: 현재 학기 **확정(primary) 시간표**의 담긴 분반 + **직접추가 강의**.
  공통 공강(commonBlocks)은 저장 자체가 없어 자연히 제외.
- 알림 단위: **수업 블록** — 같은 과목 연속 교시는 1건(월1-3 경제 → 1교시 전 1번,
  월4 화학 → 4교시 전 1번). 교시 사이 쉬는시간(≤20분)은 이어진 것으로 본다.
- **방해금지(DND) 무시** — 사용자가 직접 정한 시각 알람이므로 22:30~08:00 창이어도
  소리·진동 유지.

## Ⅱ. 아키텍처 — 접근 B (내용은 기기에만, 서버엔 발동 시각만)

PWA(특히 iOS)는 앱이 닫혀 있으면 코드 실행·로컬 알림이 불가능하다. Notification
Triggers·Periodic Background Sync 모두 크로스플랫폼으로 못 쓴다. 닫힌 앱에 알림을
넣는 유일한 길은 **서버발 Web Push**. 단, 서버가 하는 일을 최소화한다.

```
[기기]  확정 시간표 + 카탈로그(periods) → "수업 블록" 계산
          ├─→ Cache API '/next-class-schedule'  { lead, slots:{ <주간분값>: {subject,room,start} } }   ← 내용은 여기만
          └─→ setNextClassAlerts CF → pushSubscriptions/{sha256(endpoint)}.nextClassAlerts = { lead, fireMinutes:[주간분값…] }   ← 숫자만
[서버]  nextClassNotify (onSchedule '* * * * *', Asia/Seoul)
          └─ where nextClassAlerts.fireMinutes array-contains-any [지금, 지금-1]
             → 방금(≤3분) 같은 분값으로 보낸 구독(lastFired)은 제외
             → /api/push-fanout  { kind:'next_class', mow:<주간분값>, path:'/' }   ← 내용 없음
             → 발송한 구독에 nextClassAlerts.lastFired = { mow, at } 스탬프
[기기 SW]  push 수신 → Cache 에서 slots[mow] → showNotification('⏰ 다음 수업', body) (방해금지 무시)
```

- **주간 분값(minute-of-week)**: 월 00:00 = 0 … 일 23:59 = 10079. 한국은 DST 없어
  서버(`new Date()+9h` UTC 파트)와 기기가 일치.
- **직전 1분(지금-1) 재조회**: Cloud Scheduler 가 한 틱을 지연·누락해도 놓친 알림을
  다음 분에 잡기 위함. 단 정상 스케줄에선 분값 F 가 F 분(mow)·F+1 분(back)에 두 번
  걸리므로, `lastFired` 스탬프로 방금 보낸 건 건너뛴다(그래서 스케줄러가 F 를 통째로
  건너뛴 경우에만 back 조회가 실제 발송으로 이어짐). 스케줄러 중복 실행도 같이 막힌다.
  SW 는 `renotify` 를 주지 않아(기본 false), 혹시 중복이 새어나와도 같은 tag 로 조용히
  교체된다(이중 방어).
- fanout 페이로드에 과목·강의실 없음 → 서버 로그·DB엔 **타이밍 패턴만** 남는다
  (uid·과목·강의실·어느 시간표인지 전부 모름). `/dnd-config` 미러와 동일한 익명성 수준.
- 캐시 증발 등으로 슬롯이 없으면 SW 가 조용히 스킵.

## Ⅲ. 데이터 모델

**서버** — `pushSubscriptions/{sha256(endpoint)}` 에 필드 추가(기존 문서, uid 없음 유지):

```
nextClassAlerts: { lead: 10, fireMinutes: [470, 650, …], updatedAt: <ts>,
                   lastFired: { mow: 470, at: <ts> } }   // lead 0 / 없음이면 필드 삭제
```

- `lastFired` 는 `nextClassNotify` 만 쓴다(중복 억제용). `setNextClassAlerts` 의
  `set(..., { merge: true })` 는 `lead`/`fireMinutes` 만 갱신하므로 `lastFired` 는 보존된다.

- `firestore.rules` 변경 없음 — 이 컬렉션은 이미 `allow read, write: if false`(CF 전용).
- `firestore.indexes.json` 변경 없음 — `fieldOverrides: []` 라 nested array 자동 색인이
  `array-contains-any` 를 그대로 처리. (배포 후 함수 로그에 "needs index" 가 뜨면 그때 추가)

**기기 Cache API** (`push-meta` → `/next-class-schedule`):

```
{ lead: 10, tz: 'Asia/Seoul', slots: { "470": { subject, room, start:"08:00" }, … }, updatedAt }
```

**기기 localStorage**: `nextclass:lead`(설정값), `nextclass:sig`(마지막 업로드 서명 —
`endpoint|lead|fireMinutes` 가 같으면 네트워크 스킵). `disablePush()` 는 `nextclass:sig` 를
지워, 재구독 시(같은 설정이어도) 재업로드되게 한다.

## Ⅳ. 구성요소

| 파일 | 역할 |
|---|---|
| `src/lib/nextClass.js` (신규) | `computeBlocks`·`blocksToSchedule` 순수계산, `syncNextClassAlerts` 오케스트레이션, `getLead/setLeadPref` |
| `src/lib/push.js` | `META_CACHE` export, `disablePush` 에서 `nextclass:sig` 정리 |
| `src/App.jsx` | `PushSync` 가 로그인 후 `syncNextClassAlerts()` 도 호출(다른 기기 시간표 변경 반영) |
| `src/pages/Profile.jsx` | 푸시 섹션에 `[끄기][5분 전][10분 전][15분 전]` + "다음 수업 알림 테스트" 버튼 |
| `src/components/PushPrompt.jsx` | 최초 권한 유도 배너 문구에 "다음 수업 시작 전 알림" 추가 |
| `public/push-sw.js` (+ `vite.config.js` `?v=8`) | `kind:'next_class'` → Cache 슬롯으로 알림, DND 무시 |
| `functions/api/push-fanout.js` | `mow` 패스스루 + `next_class` opts(TTL 300s, urgency high, topic `next-class`) |
| `firebase/functions/src/nextClass.js` (신규) | `setNextClassAlerts`(onCall) + `nextClassNotify`(onSchedule) |
| `firebase/functions/index.js` | 위 둘 export |

## Ⅴ. 낡음(staleness)

다른 기기에서 시간표를 고쳐도 이 기기는 다음 앱 실행(`PushSync`)에나 반영된다. 학기 중
시간표는 거의 안 바뀌고, 서버가 내용을 모르는 대가로 감수한다. `setNextClassAlerts` 는
`updatedAt` 을 남기므로, 필요하면 나중에 서버 크론이 오래된 blob 을 만료시킬 수 있다(현재 없음).

## Ⅵ. 비용

- Cloud Scheduler 잡 +1 (기존 5개 → 6개, 무료 3개 초과분 약 $0.10/월).
- 매분 호출 = 43,200/월(무료 200만 이내), 매분 쿼리 1회 + 매칭분 = 무료 읽기(일 5만) 이내.
- egress 영향 없음(텍스트 푸시).

## Ⅶ. 배포

둘 다 순수 추가라 순서 무관·독립 안전:

- **Firebase**: `firebase/**` 변경 → `.github/workflows/deploy-firebase.yml` 자동 배포
  (functions + rules/indexes). `nextClassNotify` 는 매칭 구독이 없으면 no-op.
- **Cloudflare Pages**: Git 연동 자동 빌드(`npm run build`). `push-fanout.js` 변경 포함.
- 프론트 미배포 상태에서 `setNextClassAlerts` 호출자는 없음. SW v8 은 기존 kind 에 무영향.

## Ⅷ. 테스트

- 순수 로직: 블록 병합(연속 교시·쪼개진 엔트리), fireMinute 계산, 자정 wrap, Seoul mow —
  스크래치 스크립트로 검증 완료.
- 실기기: 프로필 "⏰ 다음 수업 알림 테스트"(SW `showNextClass` 를 msg 폴백으로 태움) →
  "⏰ 다음 수업 / 선형대수학 · 202 · 08:00" 확인.
- 배포 후: `nextClassNotify` 로그에 인덱스 오류 없는지 1일 관찰.

## Ⅸ. 범위 밖 (YAGNI)

과목별 on/off, 복수 리드타임, 위치 기반 "지금 이동", 스누즈, 초안 시간표 알림, 홈 화면 노출.
