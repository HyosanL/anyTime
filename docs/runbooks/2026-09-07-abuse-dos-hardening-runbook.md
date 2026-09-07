# 남용·DoS 하드닝 — 콘솔/자격증명 런북

스펙: `docs/superpowers/specs/2026-09-07-abuse-dos-hardening-design.md`
플랜: `docs/superpowers/plans/2026-09-07-abuse-dos-hardening.md`

## 이미 배포됨 (`main` + Cloudflare, 자동 실행 중)

- App Check 클라이언트(monitor — 사이트 키 미설정이라 no-op), 함수 레이트리밋,
  `maxInstances:10`, 신고 계정연령 게이트, 업로드 하드닝, Firestore 리스트 상한, CSP, 비번 8자.
- **`boardImageSweep`** — 매일 03:23 KST, `/api/board-sweep` 호출(고아 R2 이미지 정리).
  기존 팬아웃 시크릿(`X-Push-Secret`)으로 인증하므로 **새로 설정할 것 없음** — 바로 동작한다.
- **Cloudflare WAF + 레이트리밋** (API로 적용, 2026-09-07, 실트래픽 검증됨):
  - 레이트리밋: IP당 10 POST `/api/*` / 10초 초과 시 차단 (무료 플랜은 10초 고정)
  - WAF: ① `/api/*` POST 인증헤더 없으면 차단(웹훅 2개 제외) ② 비표준 메서드 차단
    ③ `cf.threat_score>50` 페이지로드에 managed challenge
  - `infra/cloudflare/README.md` 에 룰셋 ID·재적용 방법.
- **App Check enforce 플래그 = off** (`firebase/functions/src/lib/opts.js`).
- **`CLOUDFLARE_API_TOKEN`** 은 Windows 사용자 환경변수에 저장됨 → 새 셸/세션에서 `wrangler` 자동 인증.

## 대기 브랜치

- `hardening/turnstile` — `signup` 의 Turnstile 검증(soft). `TURNSTILE_SECRET`(="pending"
  으로 이미 만들어 둠) 바인딩 필요 → §0.
- `hardening/capbilling` — `capBilling`(예산 경보). `billing-alerts` Pub/Sub 토픽 필요 → §3.

---

## 0. Firebase 배포 SA 에 Secret Manager 권한 (두 브랜치 공통 블로커)

CI(`deploy-firebase.yml`)가 새 Secret Manager 항목에 런타임 SA 접근권한(IAM)을 못 걸어서
`hardening/turnstile` 배포가 깨졌었다(`SWEEP_SECRET` 은 기존 시크릿 재사용으로 우회했지만
`TURNSTILE_SECRET` 은 못 함). 한 번만:

1. Google Cloud console → **IAM & Admin → IAM** → `FIREBASE_SERVICE_ACCOUNT_KEY` 가 쓰는
   서비스계정 찾기(보통 `firebase-adminsdk-…@anytime-rokafa.iam.gserviceaccount.com`).
2. 역할 추가: **Secret Manager Admin** (`roles/secretmanager.admin`).
3. 이후 `git merge --no-ff hardening/turnstile && git push` → CI 통과.

(대안: `gcloud secrets add-iam-policy-binding TURNSTILE_SECRET --member=serviceAccount:1061916491423-compute@developer.gserviceaccount.com --role=roles/secretmanager.secretAccessor --project anytime-rokafa` — 이러면 SA 역할 안 넓혀도 됨.)

---

## 1. reCAPTCHA v3 → App Check (monitor)  ← 가장 먼저

1. https://www.google.com/recaptcha/admin/create → **reCAPTCHA v3**(점수 기반).
   도메인: `anytime.rokafa.app`, `anytime-dzi.pages.dev`, `localhost`. **사이트 키** 복사.
   (또는 Google Cloud console → reCAPTCHA Enterprise → 키 생성. v3 클래식이면 무료·무제한.)
2. Firebase console → **App Check** → 웹 앱 → **reCAPTCHA v3** provider → 사이트 키 등록.
3. `.env.production` 의 `VITE_APPCHECK_RECAPTCHA_V3_KEY=` 뒤에 붙여넣고 커밋 → Pages 재빌드.
4. App Check → **측정항목**. **enforce 하지 말 것.** 며칠 관찰: "확인된 요청" 비율이 정상
   트래픽에서 거의 100% 가 될 때까지(옛 앱 버전 기기가 빠질 시간).

---

## 2. Cloudflare — 남은 것

WAF·레이트리밋은 **이미 적용됨**(위). 남은 것:

### 2a. Bot Fight Mode (대시보드 토글, 1클릭)

대시보드 → 해당 존 → **Security → Bots → Bot Fight Mode → On**. (토큰에 이 스코프가
없고 무료 토글이라 API 미노출.)

### 2b. Turnstile 위젯 (`hardening/turnstile` 배포 가능해진 뒤)

토큰에 Account Turnstile 권한 있으니 API로 생성 가능. 순서:
1. §0 완료(배포 SA 권한).
2. 위젯 생성 → 사이트키 `.env.production` `VITE_TURNSTILE_SITE_KEY=` 커밋 →
   시크릿 `firebase functions:secrets:set TURNSTILE_SECRET`("pending" 교체).
3. `Onboarding.jsx` 에 Turnstile 위젯 삽입(§7) → `signup({..., turnstileToken})`.
   이게 끝나면 자동으로 Turnstile 강제됨.

---

## 3. Cloud Billing 예산 + capBilling

`gcloud` 없이 콘솔로:
1. https://console.cloud.google.com/cloudpubsub/topic/list?project=anytime-rokafa →
   토픽 만들기 → 이름 `billing-alerts`.
2. https://console.cloud.google.com/billing → 예산 및 알림 → 예산 만들기 →
   프로젝트 `anytime-rokafa`, 월 $10(원하는 값), 임계값 50/90/100%,
   **알림 관리 → Pub/Sub 주제에 연결** → `billing-alerts`.
3. `git checkout main && git merge --no-ff hardening/capbilling && git push origin main`
   → CI 가 `capBilling` 배포.

(`gcloud` 가 있으면 `infra/gcp/budget.sh 10` 한 방.)

---

## 4. Firestore TTL 정책

Firebase console → Firestore Database → (설정/TTL 탭) 또는
https://console.cloud.google.com/firestore/databases/-default-/ttl?project=anytime-rokafa :
- 컬렉션 그룹 `rateLimits`, 필드 `expireAt` → 정책 만들기.
- (기존) `deletedContent` 의 `expireAt` 정책이 있는지 확인.

---

## 5. Firebase Auth

Firebase console → Authentication → Settings →
**User account enumeration protection (사용자 계정 열거 보호)** 켜기.

---

## 6. App Check ENFORCE — §1 관찰 통과 후에만

각 단계 뒤 본인 기기 + 관리자 계정으로 실사용 확인. 문제 시 즉시 되돌린다.

1. Firebase console → App Check → **Firestore** → 적용(Enforce).
2. `firebase/functions/src/lib/opts.js` → `const ENFORCE_APP_CHECK = true;` 커밋 → push →
   CI 재배포. 글 작성·반응·알림테스트 확인. 되돌리기: `false` 로 커밋.
3. App Check → **Authentication** → 적용. 로그인/가입 확인.

---

## 7. (프론트 작업, 별도) Turnstile 위젯

`.env.production` 에 `VITE_TURNSTILE_SITE_KEY` 가 들어간 뒤:
- `Onboarding.jsx` 가입 폼에 Turnstile 위젯(스크립트 직접 또는 `@marsidev/react-turnstile`)
  삽입, 콜백으로 토큰 받아 `signup({ ..., turnstileToken })` 로 전달.
- 이걸 하고 §2b 의 실제 시크릿 교체가 끝나면 모든 가입에 Turnstile 강제.

---

## 비상: 비용 폭주

1. `firebase/functions/src/lib/globalOptions.js` → `maxInstances: 1` 커밋 → push → CI 재배포.
2. Cloudflare 대시보드 → 존 → **"I'm Under Attack"** 모드(임시).
3. App Check enforce 확인(§6). 아직이면 즉시 Firestore + Functions 적용.
4. 진정되면 `maxInstances` 10 으로 복구.
