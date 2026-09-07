# 남용·DoS 하드닝 — 콘솔/자격증명 런북

스펙: `docs/superpowers/specs/2026-09-07-abuse-dos-hardening-design.md`
플랜: `docs/superpowers/plans/2026-09-07-abuse-dos-hardening.md`

`main` 에 배포된 것: App Check 클라이언트(monitor 모드 — 사이트 키 없어 no-op),
함수 레이트리밋, `maxInstances:10`, 신고 계정연령 게이트, 업로드 하드닝, Firestore
리스트 상한, CSP 확장, 비번 8자. **App Check enforce 플래그는 off.**

`hardening/phase67` 브랜치에 대기 중: `signup` 의 Turnstile 검증(soft), `capBilling`.
아래 §0 완료 후 이 브랜치를 `main` 에 머지.

아래는 사람이 콘솔·CLI 로 해야 하는 나머지. **순서 중요.**

---

## 0. 사전: phase67 브랜치 배포 조건 만들기

`signup` 이 `TURNSTILE_SECRET` 을, `capBilling` 이 Pub/Sub 토픽을 바인딩한다 —
`hardening/phase67` 이 CI(=main)에 닿기 전에 둘 다 존재해야 배포가 안 깨진다.

```
firebase functions:secrets:set TURNSTILE_SECRET   # 위젯 아직 없으면 아무 값(예: "pending")
gcloud pubsub topics create billing-alerts --project anytime-rokafa
```

그 다음:
```
git checkout main && git merge --no-ff hardening/phase67 && git push origin main
```
→ GitHub Actions 가 함수 재배포. (Turnstile 은 아직 soft — 토큰 안 오면 통과.)

---

## 1. reCAPTCHA v3 → App Check (monitor)

1. Google Cloud console → 보안 → **reCAPTCHA** → 키 만들기 → **점수 기반(v3)**.
   도메인: `anytime.rokafa.app`, `anytime-dzi.pages.dev`, `localhost`. **사이트 키** 복사.
2. Firebase console → **App Check** → 앱(웹 앱) → **reCAPTCHA v3** provider → 사이트 키 등록.
3. `.env.production` 의 `VITE_APPCHECK_RECAPTCHA_V3_KEY=` 뒤에 붙여넣고 커밋 → Pages 재빌드.
4. App Check → **측정항목**. **아직 enforce 하지 말 것.** 며칠 관찰:
   "확인된 요청(verified)" 비율이 정상 트래픽에서 거의 100% 인지 확인
   (오래된 앱 버전을 쓰는 기기가 빠질 시간을 준다).

---

## 2. Cloudflare (Terraform)

`infra/cloudflare/README.md` 대로 `terraform init/plan/apply`. apply 후:
- `terraform output turnstile_site_key` → `.env.production` 의 `VITE_TURNSTILE_SITE_KEY=` 커밋(Pages 재빌드).
- `terraform output -raw turnstile_secret` → `firebase functions:secrets:set TURNSTILE_SECRET` (§0 의 "pending" 을 진짜 값으로 교체) → 다음 `firebase/**` 배포 때 반영, 또는 즉시 `hardening/...` 없이 재배포 트리거.

Terraform 이 프로바이더 문법으로 막히면 같은 README 의 "By hand" 절대로 대시보드에서.

---

## 3. Cloud Billing 예산

`gcloud auth login` (결제 관리자 계정) →
```
cd infra/gcp && ./budget.sh 10      # USD/월, 원하는 값
```
토픽이 §0 에서 이미 생겼으면 재사용된다. 예산 알림(50/90/100%)이 `billing-alerts`
토픽으로 발행되고 `capBilling` 이 받는다.

---

## 4. Cloud Scheduler — 고아 이미지 스윕

```
wrangler pages secret put SWEEP_SECRET --project-name anytime    # 새 랜덤값 입력
gcloud scheduler jobs create http board-sweep \
  --project anytime-rokafa --location asia-northeast3 \
  --schedule "17 3 * * *" --time-zone "Asia/Seoul" \
  --uri "https://anytime.rokafa.app/api/board-sweep" \
  --http-method POST --headers "X-Sweep-Secret=<그 값>"
```
`/api/board-sweep` 는 `SWEEP_SECRET` 미설정 시 fail-closed(401)이므로 순서 무관하게 안전.

---

## 5. Firestore TTL 정책

Firebase console → Firestore → **TTL**:
- 컬렉션 `rateLimits`, 필드 `expireAt` (신규 — 레이트리밋 카운터 자동 정리)
- (기존) 컬렉션 `deletedContent`, 필드 `expireAt` 이 걸려 있는지 확인

---

## 6. Firebase Auth

Firebase console → **Authentication → Settings** →
**User account enumeration protection (사용자 계정 열거 보호)** 켜기.
(클라이언트 Login 화면은 이미 실패 문구를 하나로 통일해 둠.)

---

## 7. App Check ENFORCE — §1 관찰 통과 후에만

각 단계 뒤 본인 기기 + 관리자 계정으로 실사용 확인. 문제 시 즉시 되돌린다.

1. Firebase console → App Check → **Firestore** → **적용(Enforce)**.
   확인: 앱에서 게시판 목록/강의평이 그대로 열리는지.
2. `firebase/functions/src/lib/opts.js` → `const ENFORCE_APP_CHECK = true;` 한 줄 커밋 →
   push → CI 가 전 함수 재배포. (몇 분 뒤) 글 작성·반응·알림테스트 확인.
   되돌리기: 그 줄을 `false` 로 되돌려 커밋.
3. Firebase console → App Check → **Authentication** → 적용. 로그인/가입 확인.
   되돌리기: 콘솔에서 "모니터링" 으로.

---

## 8. (자동) Turnstile 필수화

클라이언트 위젯이 배포되어(§2 사이트키 커밋 후 Onboarding 에 위젯 삽입 작업 별도 필요)
모든 가입이 토큰을 보내게 되면, 서버 `verifyTurnstile` 이 자동으로 검증을 강제한다
(`shouldSkipTurnstile` 이 false). 추가 커밋 불필요.

> ⚠️ Onboarding.jsx 에 Turnstile 위젯(`@marsidev/react-turnstile` 또는 스크립트 직접)
> 을 삽입하고 `signup({ ..., turnstileToken })` 로 넘기는 프론트 작업은 이 런북 범위
> 밖이다. 위젯 사이트키가 `.env.production` 에 들어간 뒤 별도로 진행.

---

## 비상: 비용 폭주

`capBilling` 관리자 푸시("예산 경보")를 받았거나 청구가 튀면:
1. `firebase/functions/src/lib/globalOptions.js` → `maxInstances: 1` 커밋 → push → CI 재배포.
2. Cloudflare 대시보드 → 해당 존 → **"I'm Under Attack"** 모드(임시).
3. App Check enforce 상태 확인(§7). 아직이면 즉시 Firestore + Functions 적용.
4. 진정되면 `maxInstances` 를 10 으로 되돌린다.
