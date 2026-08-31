# Supabase → Firebase 컷오버 스크립트

`node scripts/migrate-to-firebase.mjs [--only=table1,table2] [--dry-run]`

⚠️ 실사용자 PII(생도 계정·비밀번호 해시)를 다룬다. 컷오버 시점에만, `--dry-run`으로
먼저 리허설한 뒤 실행한다. 결정론적 문서ID + `bulkWriter.set()`(덮어쓰기)로 만들어져
있어 여러 번 재실행해도 중복이 생기지 않는다(멱등).

## 필요 환경변수

- **`DATABASE_URL`** — Supabase Postgres 연결 문자열.
  Supabase 대시보드 → 해당 프로젝트 → Project Settings → Database → Connection string
  (URI 탭, "Session pooler" 또는 "Direct connection" 중 하나 — 대량 읽기라 pooler 권장).
  비밀번호는 같은 화면의 "Database password"(프로젝트 생성 시 설정한 값, 분실 시 재설정 가능).
- **`FIREBASE_SERVICE_ACCOUNT_PATH`** — Firebase 서비스 계정 키 JSON 파일 경로.
  Firebase 콘솔 → `anytime-rokafa` 프로젝트 → 프로젝트 설정 → 서비스 계정 →
  "새 비공개 키 생성" → 다운로드한 JSON 파일의 로컬 경로를 지정.
  **이 파일은 절대 커밋하지 않는다** — `.gitignore`에 걸리지 않는 위치(예: 저장소 밖)에 둘 것.

두 값 다 스크립트가 코드로 절대 하드코딩하지 않는다 — 실행할 때 셸에서만 넘긴다:

```bash
DATABASE_URL="postgresql://postgres.xxxx:PASSWORD@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres" \
FIREBASE_SERVICE_ACCOUNT_PATH="/절대/경로/anytime-rokafa-service-account.json" \
node scripts/migrate-to-firebase.mjs --dry-run
```

## 플래그

- `--dry-run` — Firestore에 아무것도 쓰지 않고 테이블별 건수만 출력. **컷오버 전 항상 먼저 실행.**
- `--only=table1,table2` — 지정한 테이블(또는 `auth`)만 이관. 생략하면 전체.

## 실행 순서 권장

1. `--dry-run`으로 전체 리허설 → 건수가 Supabase 대시보드의 테이블별 행 수와 맞는지 확인.
2. (선택) `--only=auth --dry-run`처럼 좁혀서 개별 테이블 점검.
3. 실제 컷오버 시점에 `--dry-run` 없이 실행. 재실행해도 안전(멱등)하므로 중간에 실패해도
   원인만 고치고 그대로 다시 돌리면 된다.
4. 실행 로그의 "쓰기 오류" 목록이 비어 있는지 확인 — 남아 있으면 개별 문서 경로를 보고 원인 조치.

## 이관 대상 밖

이미지 파일 자체(Cloudflare R2에 있음, `object_key` 값만 옮김), Cloud Functions 배포,
Firestore 보안 규칙/인덱스 배포 — 이들은 별도 단계(`firebase deploy`)로 처리한다.
