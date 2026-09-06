# 남용·DoS 하드닝 설계

- 날짜: 2026-09-07
- 상태: 승인됨 (사용자: "최대 강도 / Terraform+체크리스트 / 결정은 권장안대로 / 배포까지 진행")
- 관련 메모: [[capacity-cost-800dau]], [[security-audit-2026-09-01]], [[security-review-decisions]],
  [[functions-deploy-via-gh-actions]], [[pages-deploy-model]], [[board-full-anonymity]],
  [[report-delete-archive]], [[supabase-rpc-anon-default-grant]]

---

## Ⅰ. 배경과 목표

### 위협 모델

앱은 공군사관학교 생도 대상 PWA. 인프라 3층:

1. **Cloudflare Pages** — 정적 셸 + `functions/api/*` (R2 업로드/다운로드, 웹푸시 팬아웃)
2. **Firebase** — Auth, Firestore(직접 읽기 + 쓰기), Cloud Functions v2 (`asia-northeast3`)
3. **Cloudflare R2** — 게시판 이미지 · 족보 파일

목표: **트래픽 폭주·자원 고갈·검열성 남용·저장소 오남용**을 막는다. 특히
Cloudflare·Firebase 설정을 코드/IaC로 조여 재현 가능하게 만든다.

### 구조적 제약 (설계 전체를 좌우)

**Cloudflare 존은 `anytime.rokafa.app`(= Pages 앱 + `/api/*`)만 프록시한다.**
Firestore·Cloud Functions·Auth 트래픽은 `*.googleapis.com` / `*.cloudfunctions.net` /
`identitytoolkit.googleapis.com` 로 **직행**하며 Cloudflare를 절대 거치지 않는다.

→ 방어가 두 갈래로 갈린다:

| 대상 | 방어 수단 |
|---|---|
| Pages 앱 · `/api/*` · R2 | Cloudflare (레이트리밋, WAF, 봇, Turnstile) + Pages Function 코드 |
| Firestore · Cloud Functions · Auth | **Firebase App Check** + 함수 한도 + 함수 내부 레이트리밋 + 예산 |

Cloudflare로는 Firebase를 못 지킨다. App Check가 Firebase 측 방어의 척추다.

### 현재 노출 (2026-09-07 감사)

1. **App Check 전무.** 공개 Firebase API 키 + 계정 1개면 스크립트가 모든 `onCall`
   함수와 Firestore 직접 읽기를 무제한 호출. 가입은 가입코드(교내 공유) + 지오펜스로
   막지만 지오펜스는 **클라이언트가 좌표를 보내는 구조**라 스크립트가 위조 가능.
2. **Firestore 직접 스캔.** 클라이언트가 `boardPosts`/`reviews`/`examArchive`/카탈로그를
   직접 읽음. 루프 한 줄로 read 쿼터/비용 소진 — 가장 싼 DoS.
3. **함수 레이트리밋 없음.** `createPost`·`createComment`·`createReview`·`likeReview`·
   `getPost{view}`·`submitCorrection`·`submitAppReport`·`boardReact` 등 uid당 제한 0.
4. **`likeReview` 중복방지 0.** 원본 RPC에도 없었음 — 카운터/write 무한 스팸.
5. **신고 자동삭제 악용.** `reportDeleteCount`(기본 30) 또는 15분내 `reportBurstCount`(기본
   10)면 아무 글이나 자동삭제. dedup은 (uid,글)당 1회라 **다계정이 유일 공격수단** →
   대량 계정 생성만 막으면 방어됨. 삭제분은 아카이브·복구 가능(피해는 일시적 노출 손실).
6. **`maxInstances` 미설정.** 폭주가 함수 인스턴스 기본 상한까지 확장 → 과금.
7. **`/api/exam-upload`**: 100MB 허용, **MIME 검사 없음**, 고아 스윕 크론 미등록 →
   R2 채우기 + 불법파일 호스팅.
8. **`/api/board-upload`**: 12MB, 사용자당 상한 없음. 스윕 크론 미등록으로 고아 이미지
   영구 축적.
9. **Cloudflare 존**: 레이트리밋/WAF 커스텀 규칙/봇 모드/Turnstile 전무.
10. **Firebase Auth**: 비번 6자, 아이디 열거 가능(`<name>@anytime.app`), 이메일열거 보호
    off → Identity Toolkit 공개 엔드포인트 무차별 대입 표적.
11. **`PUSH_SECRET` 1개 3역할**: `/api/push-fanout` + `/api/board-sweep` + `pushPrune` +
    `boardReferencedKeys` 공용. 1회 유출 = 임의 웹푸시 발송 + R2 키 열거.

---

## Ⅱ. 설계

8개 워크스트림. A(App Check)가 최우선, 나머지는 심층방어.

### A. Firebase App Check

**공급자: reCAPTCHA v3** (무제한 $0). Enterprise는 800~1200 DAU × 토큰 자동갱신에서
무료한도(10k/월) 초과.

**클라이언트** (`src/firebase.js` / 새 `src/lib/appCheck.js`):
- `initializeAppCheck(app, { provider: new ReCaptchaV3Provider(SITE_KEY), isTokenAutoRefreshEnabled: true })`
- 사이트 키는 `VITE_APPCHECK_RECAPTCHA_V3_KEY` 로 주입. **키가 없으면 init 자체를 건너뛴다**
  (no-op) — 이래야 키 발급 전에 코드를 배포해도 앱이 안 깨진다.
- 로컬 개발: `import.meta.env.DEV && (self.FIREBASE_APPCHECK_DEBUG_TOKEN = true)` 로 debug
  토큰 콘솔 출력.

**Cloud Functions** (`firebase/functions/src/lib/opts.js` 새 파일):
- `enforceAppCheck` 는 `setGlobalOptions` 에 넣지 **않는다** — 그러면 시크릿 게이트
  `onRequest` 두 개(`boardReferencedKeys`, `pushPrune`)까지 App Check 헤더를 요구해
  cron/Cloudflare 호출이 401 난다(확인: `https.js` 가 global을 fallback으로 사용).
- 대신 헬퍼 `callable(extra = {})` → `{ enforceAppCheck: ENFORCE, ...extra }`.
  `ENFORCE = process.env.APPCHECK_ENFORCE === 'true'` (기본 false).
  모든 `onCall(...)` 를 `onCall(callable({ secrets: [...] }), handler)` 로 교체
  (약 25개 — 기계적, `signup` 포함: 로그아웃 호출도 App Check는 통과).
- `firebase/functions/.env` 커밋: `APPCHECK_ENFORCE=false`. 관찰 후 `true` 로 바꿔 재배포.

**Auth**: Firebase 콘솔에서 App Check 강제 on (Identity Platform). 콘솔 전용 — 런북 단계.

**Firestore**: 콘솔에서 App Check 강제 on. 콘솔 전용 — 런북 단계.

**롤아웃 안전장치 (필수 순서)**:
1. SDK 배포 (사이트 키 포함, `APPCHECK_ENFORCE=false`, 콘솔 강제 off)
2. App Check 콘솔 "요청" 메트릭 관찰 — 정상 트래픽의 검증 비율이 충분히 높을 때까지(수일)
3. 강제 순서: **Firestore → Cloud Functions(`APPCHECK_ENFORCE=true` 재배포) → Auth**
4. 각 단계 후 실사용 확인 (본인 기기 + 관리자 계정). 문제 시 즉시 토글 복구.

### B. Cloud Functions 남용 한도

1. **`setGlobalOptions({ maxInstances: 10 })`** (`globalOptions.js`). 팬아웃 큰 함수는
   개별 상향: `nextClassNotify`·`onPostHotChangedPush`·`onCommentCreatedPush` → 그대로
   두거나 필요시 개별 지정. (스케줄러/트리거는 동시성이 낮아 10으로 충분.)
2. **`src/lib/rateLimit.js` 신설** — `assertUnderLimit(uid, action, { limit, windowSec })`:
   - `rateLimits/{uid}_{action}` 문서에 `{ count, windowStart }`. 트랜잭션으로 원자 증가.
   - 창 만료 시 리셋. 초과 시 `HttpsError('resource-exhausted', '요청이 너무 잦습니다...')`.
   - 호출당 write 1회 — Firestore 쓰기는 부하~0 ([[capacity-cost-800dau]]).
   - `rateLimits` 는 Rules `if false` (Admin SDK 전용). TTL 정책으로 자동 정리(7일).
   - 크론(`onSchedule`) 하나로 만료 문서 정리(선택 — TTL로 충분하면 생략).
   - 적용 대상과 기본 한도:

   | 함수 | 한도 |
   |---|---|
   | `createPost` / `createReview` / `createExam` / `createMemo` | 10 / 시간 |
   | `createComment` | 30 / 시간 |
   | `createBoard` | 5 / 일 |
   | `boardReact` | 60 / 시간 |
   | `likeReview` | 60 / 시간 |
   | `submitCorrection` / `submitAppReport` | 20 / 일 |
   | `replyFeedbackThread` | 30 / 시간 |
   | `sendSelfTestPush` | 5 / 시간 |
   | `getPost` (view=true 일 때만) | 조회수 증가는 (uid,글) 24h 1회 dedup — 아래 4 |

3. **`likeReview` 중복방지** — `boardReact` 와 동일: `reviews/{id}/reactions/{actorHash}`
   문서ID 방식으로 1인 1좋아요. `actorHash(salt, uid, 'review-like', id)`. 취소(unlike)도
   지원. `onReviewWritten` 집계 트리거는 like가 평균을 안 바꾸므로 영향 없음.
   설계 메모(reviews.js "Do not add actor-hash dedup here")는 이 스펙으로 상위 결정 갱신.
4. **`getPost` 조회수** — `boardPosts/{id}/_private/views/{actorHash}` 존재 검사로 (uid,글)
   당 24h 1회만 `viewCount` 증가. 이미 있으면 증가 건너뜀. `_private/*` 는 Rules `if false`.

### C. 신고·검열 내성

1. **유저 문서에 `createdAt`** 기록 — `signup` 트랜잭션에서
   `createdAt: FieldValue.serverTimestamp()` 추가. (`geoVerifiedAt` 은 `geoVerify` 가
   갱신해서 계정연령으로 못 씀.)
2. **`boardReact`/`reportReview`/`reportMemo` 의 `kind==='report'` 경로**: 계정 생성
   24h 미만이면 신고는 **접수(dedup 문서·events 는 기록)하되 임계·버스트 산정에서 제외**.
   즉 `reportCount` 증가는 하지만 24h 미만 계정발(發) 이벤트는 자동삭제 트리거 카운트에
   안 들어감. (관리자 신고 목록에는 그대로 보임.)
   - 구현: report events 문서에 `young: true` 마킹, 버스트/임계 카운트 쿼리에서
     `where('young', '!=', true)` 필터 또는 카운트 후 차감.
3. 자동삭제 → 아카이브 + 관리자 푸시는 그대로 유지 (기존 동작).
4. `reportDeleteCount`/`reportBurstCount` 는 관리자 화면에서 계속 조정 가능.

### D. Cloudflare Pages Functions 하드닝

1. **`functions/api/exam-upload.js`**:
   - MIME allowlist: `application/pdf`, `image/(jpeg|png|webp|gif|heic|heif|avif)`,
     `application/(msword|vnd.openxmlformats-officedocument.*|haansofthwp|x-hwp|zip|x-zip-compressed)`,
     `text/plain`. 목록 밖이면 415.
   - 크기 상한 100MB → **25MB**.
   - `courseCode` 정규화(이미 있음) 유지.
2. **`functions/api/board-upload.js`**: 원본 12MB → **8MB**, 썸네일 4MB → **2MB** 유지.
3. **`functions/api/_middleware.js` 시크릿 분리**:
   - `/api/board-sweep` → `SWEEP_SECRET` (이미 참조하나 미설정) **또는** `PUSH_SECRET`
     둘 다 허용 (전환기). 이후 `PUSH_SECRET` 분기 제거.
   - `boardReferencedKeys`/`pushPrune` (Firebase 측)는 `pushFanoutSecret` 재사용 유지 —
     이건 별개 이슈(CONVENTIONS.md가 `lib/secrets.js` 편집 금지). 전달 헤더만 문서화.
4. **고아 스윕 크론 등록** — `board-sweep` 를 Cloud Scheduler(또는 Cloudflare Cron
   Trigger)로 일 1회 `X-Sweep-Secret` 헤더 호출. GRACE 48h 유지.
   - Cloudflare Pages는 Cron Trigger 미지원 → **Cloud Scheduler → HTTPS(`/api/board-sweep`)**
     로 구성. 런북 단계.

### E. Cloudflare 존 설정 (Terraform)

`infra/cloudflare/` 신설. `main.tf` + `variables.tf` + `terraform.tfvars.example` + `README.md`.
Provider: `cloudflare/cloudflare`(현행 v5 — 리소스명은 구현 시 CF 문서로 확정).
인증: `CLOUDFLARE_API_TOKEN` (env).
필요 권한: Zone.Firewall Services, Zone.WAF, Zone.Rate Limiting, Account.Turnstile,
Zone Settings (Bot Fight Mode 토글). 무료 플랜 가정 — Enterprise 전용 리소스
(`cloudflare_bot_management`)는 안 씀.

리소스:
1. **Rate Limiting Rules** (`cloudflare_ruleset`, phase `http_ratelimit`):
   - `/api/board-upload` · `/api/exam-upload`: IP당 10 req / 60s → 차단 60s
   - `/api/*` 전체: IP당 100 req / 60s → 관리형 챌린지
   - 앱 셸(`not /api/*`): IP당 600 req / 60s → 관리형 챌린지
2. **WAF 커스텀 규칙** (`cloudflare_ruleset`, phase `http_request_firewall_custom`):
   - `/api/*` + `Authorization` 헤더 없음 + not (`/api/board-sweep` or `/api/push-fanout`)
     → block. (secret-gated 엔드포인트는 자체 검증.)
   - method not in {GET, POST, HEAD, OPTIONS} → block
   - 알려진 스캐너/공격 UA 패턴 → managed challenge
3. **Bot Fight Mode** — 무료 티어 존 설정 토글(`cloudflare_zone_setting` 등 현행 리소스).
   Pro+ 면 Super Bot Fight Mode.
4. **지역 챌린지** (선택, 완전차단 아님): `ip.geoip.country ne "KR"` + `/api/*` →
   managed challenge. 해외 생도/VPN 고려해 challenge(차단 아님).
5. **Turnstile 위젯** (`cloudflare_turnstile_widget`):
   - 도메인: `anytime.rokafa.app`, `anytime-dzi.pages.dev`, `localhost`
   - 모드: managed. 위젯 사이트 키(공개) → `.env.production` 의 `VITE_TURNSTILE_SITE_KEY`.
     시크릿 → Firebase 시크릿 `TURNSTILE_SECRET`.

체크리스트(`infra/cloudflare/README.md`): 토큰 발급 권한, `terraform init/plan/apply`,
apply 후 대시보드에서 규칙 활성 확인, Turnstile 사이트키·시크릿 배포처 확인.

### F. Firebase Auth 하드닝

콘솔/Identity Platform 전용 — 전부 런북 단계 (Terraform `google` provider로도 가능하나
프로젝트에 GCP IaC가 없어 런북으로).

1. **Email Enumeration Protection** on — 로그인/가입 오류를 뭉뚱그려 아이디 존재여부
   노출 차단. 클라이언트(`src/lib/auth.js`)의 오류 분기가 `auth/invalid-credential`
   단일 코드로 수렴하므로 문구 조정 필요 (로그인 실패 = "아이디 또는 비밀번호가
   올바르지 않습니다" 단일화).
2. **App Check 강제 on Authentication** (A의 롤아웃에 포함).
3. **신규 가입 비밀번호 8자**: `signup` 함수 `password.length < 8` + 클라이언트
   `Onboarding.jsx` `minLength={8}` + 안내 문구. 기존 계정 영향 없음.
4. (콘솔) Auth 남용 방지 — SMS 미사용이므로 해당 없음. 이메일/비번만.

### G. 비용 방어

1. **Cloud Billing 예산 + 알림** — 임계 50/90/100%, 알림 수신자 = 프로젝트 결제 관리자.
   `gcloud billing budgets create` 스크립트 (`infra/gcp/budget.sh`) + 런북.
2. **`capBilling` 함수** (`firebase/functions/src/ops.js` 새 파일):
   - `onMessagePublished({ topic: 'billing-alerts' })` — 예산 알림 Pub/Sub 수신.
   - `costAmount / budgetAmount >= 1.0` 이면 전 Cloud Functions를 `maxInstances: 0` 으로
     설정(Cloud Functions Admin API `patch`) → 호출 차단. Firestore 직접읽기·Auth는
     생존 → 앱 열람 가능.
   - 관리자 푸시 발송("⚠️ 예산 초과 — 함수 차단됨").
   - 복구는 수동 (`APPCHECK_ENFORCE` 처럼 재배포 또는 콘솔).
   - 함수 자신은 차단 대상에서 제외.
   - 필요 IAM: 서비스 계정에 `roles/cloudfunctions.admin` (배포 SA에 추가 — 런북).
3. `maxInstances: 10` (B) 이 1차 방어선 — capBilling은 최후 수단.

### H. Firestore 규칙 조임

`firebase/firestore.rules`:
1. `boardPosts` `allow list`: `request.query.limit <= 30`
2. `reviews` `allow list`: `request.query.limit <= 250`
3. `examArchive` `allow list`: `request.query.limit <= 120`
4. `boardPosts/{id}/comments` `allow list`: `request.query.limit <= 500`
5. 클라이언트 `src/lib/board.js` `listComments` 에 `limit(500)` 추가 (현재 무제한).
6. 단건 `get` 은 제한 없음 (`allow get`). `courseProfessorRatings`/`professorRatings`/
   `boards`/카탈로그/`bannedWords` 는 전량 다운로드가 정상 사용이므로 limit 규칙 제외
   (App Check가 유일 방어).

`request.query.limit` 는 리스트 연산에서 규칙이 읽을 수 있고, limit 없는 쿼리는 규칙이
거부 → 클라이언트가 반드시 `limit()` 을 붙여야 함. 5번이 그 대비.

---

## Ⅲ. 실행 · 롤아웃

### 자율 실행 가능 (코드 → 커밋 → CI 배포)

- A: App Check 클라이언트 SDK (키 없으면 no-op), `callable()` 헬퍼, `.env` `APPCHECK_ENFORCE=false`
- B: `maxInstances`, `rateLimit.js`, `likeReview` dedup, `getPost` 조회수 dedup
- C: `signup` 에 `createdAt`, 신고 계정연령 게이트
- D: exam-upload MIME/크기, board-upload 크기, middleware 시크릿 하위호환
- H: Firestore 규칙 limit + `listComments` limit
- E의 Terraform 파일 **작성** (apply는 사용자)
- F3: 비밀번호 8자 (코드 부분)
- G2: `capBilling` 함수 코드 (배포는 IAM 준비 후)

배포 경로: `firebase/**` 변경 → GitHub Actions(`deploy-firebase.yml`) → 함수 + Firestore
규칙 배포. `src/**`·`.env.production` 변경 → Cloudflare Pages Git 빌드.
([[functions-deploy-via-gh-actions]], [[pages-deploy-model]])

### 사용자 필요 (콘솔/자격증명) — 런북 `docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md`

1. reCAPTCHA v3 사이트 키 발급 (Google Cloud console) → `.env.production` 에
   `VITE_APPCHECK_RECAPTCHA_V3_KEY` 추가 → Firebase App Check 콘솔에 등록
2. App Check 메트릭 관찰 (수일) → Firestore/Functions/Auth 강제 토글
3. `APPCHECK_ENFORCE=true` 커밋 (메트릭 확인 후)
4. Cloudflare: `CLOUDFLARE_API_TOKEN` 발급 → `terraform apply` → 대시보드 확인
5. Turnstile: 위젯 사이트키 → `.env.production`, 시크릿 → `firebase functions:secrets:set TURNSTILE_SECRET`
   → `signup` 의 Turnstile 검증 활성 커밋(스테이징된 것) 머지
6. Firebase Auth 콘솔: Email Enumeration Protection on
7. Cloud Billing: `infra/gcp/budget.sh` 실행 (결제 권한 필요), Pub/Sub 토픽
   `billing-alerts` 생성, 배포 SA에 `roles/cloudfunctions.admin` → `capBilling` 배포
8. Cloud Scheduler: `board-sweep` 일 1회 HTTPS 호출 job 생성 (`X-Sweep-Secret`)
9. 시크릿 분리 마무리: `SWEEP_SECRET` 설정 확인 후 middleware의 `PUSH_SECRET` 하위호환 제거

### Turnstile in `signup` — 단계적

- 1단계 (자율): `signup` 이 `turnstileToken` 을 **선택적**으로 받음. `TURNSTILE_SECRET`
  미설정 또는 토큰 없음 → 검증 건너뜀(로그만). 클라이언트는 아직 위젯 없음.
- 2단계 (런북 5 이후): 클라이언트 위젯 삽입 + `signup` 검증 필수화 커밋 머지.

---

## Ⅳ. 비목표 (YAGNI)

- 게시판 목록·카탈로그를 Cloud Function 뒤로 옮기기 — 함수 호출료 증가, App Check로 충분
- 외부 검색 인덱스(Algolia 등) — 범위 밖
- 결제 통째 비활성화 킬스위치 — 자발적 전면장애라 배제 (G2가 대안)
- 신고 담합 탐지 ML/휴리스틱 — 계정연령 게이트 + 관리자 복구로 충분
- WAF Rate Limiting을 Firebase 도메인에 적용 — 불가능 (CF 프록시 밖)
- App Check `consumeAppCheckToken`(replay 보호) — 성능/쿼터 비용, 이 앱엔 과함
- `/api/*` 에 App Check 토큰 검증 — 이미 Firebase ID 토큰 필수 + CF 레이트리밋으로 충분

---

## Ⅴ. 리스크

| 리스크 | 완화 |
|---|---|
| App Check 강제 후 정상 사용자 차단 | 메트릭 관찰 후 단계 토글, 즉시 롤백 가능한 env/콘솔 토글 |
| 레이트리밋 한도가 너무 빡빡 | 넉넉한 기본값, `resource-exhausted` 코드로 클라이언트가 안내 문구 표시 |
| Firestore limit 규칙이 놓친 쿼리를 깨뜨림 | 배포 전 전 `getDocs` 호출부 감사 (본 스펙 Ⅱ.H.5), 규칙은 boardPosts/reviews/examArchive/comments만 |
| `capBilling` 오발동으로 함수 전면 차단 | 임계 1.0(100%)에서만, 관리자 푸시, 수동 복구, `maxInstances:10` 이 이미 상한 |
| Turnstile 필수화 시점에 위젯 미배포면 가입 불가 | 2단계 분리 — 위젯 배포 확인 후에만 필수화 커밋 머지 |
| Terraform state 관리 | 로컬 state + `.gitignore`, README에 명시. 원격 백엔드는 범위 밖 |
| reCAPTCHA v3 키 발급 전 App Check 코드 배포 | 키 없으면 init no-op (Ⅱ.A) |
