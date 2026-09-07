# 남용·DoS 하드닝 — 콘솔/자격증명 런북

스펙: `docs/superpowers/specs/2026-09-07-abuse-dos-hardening-design.md`
플랜: `docs/superpowers/plans/2026-09-07-abuse-dos-hardening.md`

## ✅ 완료 (라이브)

**Firebase (`main` 배포):**
- 함수 레이트리밋(uid별), `maxInstances:10`, 신고 24h 계정연령 게이트, `likeReview` 중복방지,
  `getPost` view 제한, 업로드 확장자/크기, Firestore 리스트 쿼리 상한, CSP 확장, 비번 8자
- `boardImageSweep` (매일 03:23 KST 고아 R2 이미지 정리 — `X-Push-Secret` 재사용, 설정 불필요)
- `capBilling` (예산 경보 수신 — 아래 예산과 연결됨)
- **Turnstile 검증** — 위젯 "anytime signup" 생성, `signup` 에서 **강제**(실제 시크릿 + 토큰 필수).
  siteverify 장애 시 fail-open. 문제 시 탈출구: `TURNSTILE_SECRET` 을 `pending` 으로 되돌리고 재배포.
- App Check 클라이언트 SDK (**monitor 모드** — 사이트 키 없어 no-op)
- App Check enforce 플래그 = **off** (`firebase/functions/src/lib/opts.js`)

**Cloudflare (API 적용, 실트래픽 검증):**
- 레이트리밋 1개: IP당 10 POST `/api/*` / 10초 초과 → 차단 (무료 플랜 10초 고정)
- WAF 3개: 무인증 `/api/*` POST 차단(웹훅 제외) / 비표준 메서드 차단 / threat>50 페이지로드 challenge
- Turnstile 위젯 (sitekey `.env.production`, secret Firebase `TURNSTILE_SECRET`)
- `infra/cloudflare/README.md` 에 룰셋 ID
- `CLOUDFLARE_API_TOKEN` → Windows 사용자 env (새 셸에서 wrangler 자동 인증)

**GCP (API 적용):**
- Pub/Sub 토픽 `billing-alerts` + Cloud Billing 예산 ₩15,000/월 (알림 50/90/100% → 토픽)
- Firestore TTL: `rateLimits.expireAt`, `deletedContent.expireAt`
- Firebase Auth **이메일 열거 보호** — 이미 켜져 있었음(확인함)
- `TURNSTILE_SECRET` 런타임 SA 접근권한 (IAM) 부여됨 → CI 배포 정상
- **App Check reCAPTCHA v3** — 사이트키 `.env.production`, 비밀키 App Check 에 API로 등록.
  Firestore·Auth enforcement = **UNENFORCED (monitor)** 확인함. tokenTtl 1일, minValidScore 0.5.

---

## 남은 것 (웹 UI — 자동화 불가)

### 1. App Check 측정항목 관찰  ← 지금

Firebase console → **App Check → 측정항목**. 클라이언트가 이제 토큰을 보낸다(monitor).
정상 트래픽의 "확인된 요청" 비율이 거의 100% 가 될 때까지 **며칠** 관찰
(옛 앱 버전 기기가 빠질 시간). 점수가 낮아 거부되는 게 많으면 App Check 웹앱 설정에서
`minValidScore` 를 0.3 으로 낮춘다.

### 2. ✅ Bot Fight Mode — 켜짐 (2026-09-07, 사용자가 대시보드에서)

### 3. App Check ENFORCE — §1 관찰 통과 후에만

각 단계 뒤 본인 기기 + 관리자 계정으로 실사용 확인. 문제 시 즉시 되돌린다.

1. Firebase console → App Check → **Firestore** → 적용(Enforce).
2. `firebase/functions/src/lib/opts.js` → `const ENFORCE_APP_CHECK = true;` 커밋 → push →
   CI 재배포. 글 작성·반응·알림테스트 확인. 되돌리기: `false` 로 커밋.
3. App Check → **Authentication** → 적용. 로그인/가입 확인.

---

## 비상: 비용 폭주

1. `firebase/functions/src/lib/globalOptions.js` → `maxInstances: 1` 커밋 → push → CI 재배포.
2. Cloudflare 대시보드 → 존 → **"I'm Under Attack"** 모드(임시).
3. App Check enforce 확인(§3). 아직이면 즉시 Firestore + Functions 적용.
4. 진정되면 `maxInstances` 10 으로 복구.
