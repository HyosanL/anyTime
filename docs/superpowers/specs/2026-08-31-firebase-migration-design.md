# Supabase → Firebase 전면 이관 — 설계

작성일: 2026-08-31

## 배경·목표
Supabase(Postgres+Auth+Edge Functions) 백엔드 전체를 Firebase(Firestore+Auth+Cloud
Functions)로 이관한다. 기존 사용자·생도 계정·강의평·게시판·시간표 데이터는 그대로
보존한다. 전환 방식은 **한 번에 전체 교체**(순차 작업, 완성될 때까지 기존 Supabase
앱은 그대로 운영) — 점진적 이중 쓰기(dual-write)는 하지 않는다.

Firebase 프로젝트: `anytime-rokafa` (표시 이름 "anyTime"), 리전 `asia-northeast3`(서울).

## 0. 현재 스키마 인벤토리 (이관 대상)
36개 테이블, 함수 65개(58개 `SECURITY DEFINER`), pg_cron 2개, pg_net 웹훅 발신 4곳.
자세한 테이블·함수·RLS 목록은 이관 작업 중 각 Cloud Functions 모듈 설계에서 참조한다
(이 문서에는 아키텍처 결정만 담는다). 관리자 기능은 거의 전부 SQL 함수가 아니라
Edge Function 하나(`admin-action`, ~50개 분기, service_role)에 있다 — 게이트웨이 함수
하나로 포팅하면 되는 유리한 조건.

## 1. 쓰기 경로 아키텍처 (혼합형)
- **소유 데이터(직접쓰기 티어)**: `grade_entry`/`rank_entry`/`tt_follow`/`board_favorite`
  → Firestore Security Rules만으로 소유권(`request.auth.uid`) 검증, 클라이언트가 직접
  읽고 쓴다.
- **소유 데이터 중 교차-문서 불변조건이 있는 것**: `timetable`/`timetable_entry`/
  `custom_class` — 5개 제한·자동 대표 승격·시간 겹침 검사는 문서 하나만 보는 Rules로
  검증 불가능하므로, 얇은 Cloud Functions(`onCall`, Firestore 트랜잭션)를 한 겹 씌운다.
- **익명/공유 데이터**: `review`/`exam_archive`/`class_memo`/`correction`/`board_*`/
  `push_*` — 해시 기반 익명성·비밀번호·신고 임계치·카운터 로직이 있어 애초에 Rules로
  표현 불가능. **쓰기는 전부 Cloud Functions(`onCall`)**, 현재 RPC 표면과 거의 1:1
  대응시킨다. **읽기는 직접 클라이언트 Firestore 읽기**(Rules: 로그인 사용자면
  허용) — 지금의 PostgREST 공개 SELECT와 비용·지연 면에서 동등하게 유지한다. 예외:
  `class_memo`는 "확정 시간표에 이 분반을 갖고 있어야" 하는 게이트가 있어 읽기도
  Cloud Function(`onCall`)으로 유지한다.
- **관리자**: 게이트웨이 Cloud Function 하나(`adminAction`)가 `admin-action` Edge
  Function의 ~50개 분기를 그대로 포팅. 함수 맨 앞에서 `context.auth.token.admin`
  검사(Firebase Admin SDK가 Rules를 우회하므로 모든 쓰기가 이 경유).

## 2. 인증·거버넌스
- **UID 보존**: Firebase Auth `importUsers()`로 이관 시 `uid`를 기존 Supabase
  `auth.users.id`(UUID) 그대로 지정한다 → `cadet.id = auth.uid()`였던 대응관계가
  깨지지 않고, 36개 테이블의 FK를 전혀 바꿀 필요가 없다.
- **비밀번호 이전**: GoTrue는 bcrypt 해시를 쓰므로 `importUsers()`의 `passwordHash`
  + `hash.algorithm: 'BCRYPT'` 옵션으로 그대로 가져온다 — 생도들이 비밀번호를 다시
  설정할 필요 없음.
- **합성 이메일**: `<username>@anytime.app` 스킴 그대로 유지.
- **관리자 플래그**: `cadet.is_admin` → Firestore `/users/{uid}.isAdmin` 필드 +
  Firebase Auth **커스텀 클레임**(`admin: true`) 이중 저장. Cloud Function
  `syncAdminClaim`(Firestore `onUpdate` 트리거, `/users/{uid}`의 `isAdmin` 변경 감지)
  이 둘을 동기화한다.
- **거버넌스 원칙 역전 주의**: Supabase는 기본 거부(REVOKE) 후 화이트리스트 재허용,
  Cloud Functions `onCall`은 기본적으로 "로그인만 하면 호출 가능"이 기본값이라
  정반대다. 모든 함수는 공유 헬퍼 `requireAuth(request)` / `requireAdmin(request)`를
  진입부 첫 줄에서 호출해야 하며, 예외(비로그인 허용) 함수는 코드 상단 주석으로
  명시한다 — Supabase 쪽의 "4개 anon 화이트리스트" 패턴과 동급의 감사 가능성을 코드
  리뷰로 확보한다.
- **가입(`signup`)**: Cloud Function(`onCall`, unauthenticated 허용)이 `verifyGate`
  (가입코드+지오펜싱, `haversine`) 검사 후 Firebase Auth 사용자 생성 + `/users/{uid}`
  문서 생성. **App Check 적용을 강하게 권장** — 유일한 미인증 진입점이라 남용 위험이
  Supabase Edge Function 대비 커진다(그쪽은 Postgres 함수가 service_role 뒤에 있었음).
- **탈퇴(`delete-account`)**: Cloud Function(`onCall`)이 Admin SDK로 Auth 사용자 +
  `/users/{uid}` 서브트리 삭제.

## 3. Firestore 컬렉션 지도
```
/config/app            공개(= 옛 get_boot_info() 반환 필드와 정확히 동일, 그 이상도 이하도 아님):
                         geoValidDays, catalogVersion, boardEnabled, shareEnabled, reviewMinDays
/config/secrets         비공개(클라이언트 Rules: allow read,write: if false) — app_setting 나머지 전부:
                         campusLat, campusLng, radiusM, accountDeleteDays, hotThreshold,
                         reportDeleteCount, reportBurstCount, signupCode, modReviewedAt,
                         professorsSyncedAt. (report_salt 는 Firestore 문서가 아니라 Secret
                         Manager `ACTOR_HASH_SALT` 로 대체 — §4 참고. app_setting 은 옛
                         스키마에서도 RLS 정책이 하나도 없어 클라이언트 접근이 전무했고,
                         get_boot_info()가 선별해 반환한 5개 필드만 사실상 "공개"였다 —
                         이 경계를 그대로 유지한다.)

/professors/{code}
/semesters/{year_term}
/courses/{code}
/periods/{no}
/commonBlocks/{year_term_day_period}
/sections/{courseCode_year_term_no}      sectionTimes 는 배열 필드로 임베드(별도 컬렉션 없음)

/users/{uid}                              cadet: username, isAdmin, ttPublic, geoVerifiedAt, postCount
  /timetables/{id}                        year, term, name, isPrimary
    /entries/{sectionKey}
    /customClasses/{id}
  /gradeEntries/{id}
  /rankEntries/{year_term}
  /follows/{followeeUid}                  nickname, sortOrder
  /favoriteBoards/{boardId}

/reviews/{id}                             courseCode, professorCode, scores…, likeCount, reportCount, hasPassword
  /_private/auth                          postPasswordHash — Rules: allow read,write: if false
  /reactions/{actorHash}                  좋아요/신고 중복 방지(문서ID=해시)

/examArchive/{id}                         files: [{seq, objectKey, filename}] 임베드 배열
  /_private/auth

/classMemos/{id}
  /_private/auth
  /reactions/{actorHash}

/corrections/{id}                         Rules: allow read,write: if false (전부 Cloud Functions/Admin SDK)

/boards/{id}                              name, lastActivityAt
/boardPosts/{id}                          boardId, title, content, images:[…] 임베드, counters…, shareToken, hasPassword
  /_private/auth
  /comments/{id}                          parentId(자기참조), hasPassword
    /_private/auth
  /events/{autoId}                        kind, actorHash?, createdAt — HOT 판정용 시간창 쿼리
  /reactions/{actorHash}                  좋아요/싫어요/신고 1인1회 중복 방지
  /watchers/{subscriptionId}              댓글 알림 워처

/pushSubscriptions/{id}                   endpoint, p256dh, auth, hotAlerts — uid 없음(익명 유지)
/adminPushSubscriptions/{uid}_{endpointHash}

/deletedContent/{id}                      snapshot, reason, reviewed — TTL 필드로 30일 자동 파기(Firestore 네이티브 TTL)
/courseProfessorRatings/{courseCode_professorCode}   review 쓰기 트리거가 갱신하는 집계 문서
/professorRatings/{professorCode}
```

**대리키 제거**: `section.id`(BIGINT surrogate)는 Firestore에서 불필요 — 문서 ID
(`courseCode_year_term_no`)가 자연키 역할을 겸한다.

**카탈로그 캐시버스팅 유지**: `app_setting.catalog_version` 패턴을 그대로
`/config/app.catalogVersion`으로 이전한다(실시간 리스너로 바꾸지 않음 — 클라이언트
IndexedDB 캐시 코드 변경 최소화, 읽기 비용 유지). 카탈로그 컬렉션 쓰기가 있는 관리자
게이트웨이 함수가 매번 이 필드를 증가시킨다.

## 4. 익명성·보안 모델 재설계
- **비밀번호 해시 격리**: Firestore는 컬럼 단위 권한이 없으므로, 공개 문서에
  `postPasswordHash` 필드를 두지 않고 `{doc}/_private/auth` 서브컬렉션으로 물리적으로
  분리한다. Rules로 `allow read, write: if false`(클라이언트 접근 완전 차단) — 지금의
  "컬럼 REVOKE + 함수 안 방어적 스트리핑" 이중 방어를 구조적 격리로 대체한다.
- **`actor_hash()` 대응**: 서버 전용 salt(Secret Manager 또는 Cloud Functions
  환경변수)로 HMAC-SHA256(`uid + kind + targetId + salt`)을 계산하는 로직을 Cloud
  Functions 내부 헬퍼(`actorHash()`, export 안 함)로 그대로 포팅한다. 중복 방지는
  "문서 ID = 해시"로 만들어 `create()`가 이미 존재하는 문서에 실패하는 원리를 이용한다
  (Postgres의 `UNIQUE(review_id, reporter_hash)`와 동일 효과).
- **신고 임계치 자동삭제+아카이브**: `report_review`/`report_memo`/`board_react`의
  버스트(15분)·누적(30건) 임계치 검사 → 초과 시 `deletedContent`에 스냅샷 저장 후
  원본 하드 삭제 → 이 로직을 그대로 각 Cloud Function 안에 포팅한다(`archiveDeleted()`
  내부 헬퍼).
- **`get_memos`/`get_post_b`의 방어적 해시 스트리핑**: `_private` 서브컬렉션 격리로
  구조적으로 불필요해진다(애초에 공개 문서에 해시가 없음) — 하지만 Rules가 유일한
  방어선이 되므로, 배포 전 반드시 에뮬레이터로 `_private` 서브컬렉션 읽기 거부를
  테스트한다.
- **핫카운터 쓰기 경합**: `board_post`의 `likeCount`/`commentCount`/`viewCount`는
  `FieldValue.increment()`로 갱신(Firestore가 원자적으로 처리, 초당 1건 경합 한도가
  있으나 800~1200 DAU 규모에서는 사실상 문제 없음 — 특정 인기글에서 경합 오류가
  로그에 보이면 그때 샤딩 카운터로 전환).

## 5. 웹훅·트리거·스케줄
| Supabase | Firebase 대응 |
|---|---|
| `notify_comment_push()` (트리거) | Firestore `onCreate` on `boardPosts/{id}/comments/{id}` → Cloud Function → 기존 `/api/push-fanout`(Cloudflare Pages Function) 그대로 호출 (Web Push 발신 로직 재사용) |
| `notify_hot_push()` (트리거, false→true) | Firestore `onUpdate` on `boardPosts/{id}`, before/after `hot` 필드 비교 → 동일 fanout 호출 |
| `admin_push()` | 각 Cloud Function(`submitCorrection`/`reportReview`/`reportMemo`/`boardReact`) 안에서 동기 호출, 포팅 그대로 |
| `bump_catalog_version()` (트리거) | 관리자 게이트웨이 함수의 각 카탈로그 쓰기 분기에서 `/config/app.catalogVersion` `FieldValue.increment(1)` |
| `purge_old_exams`/`purge_past_memos`/`purge_expired_accounts` (월간 cron) | Cloud Scheduler + `onSchedule` 함수 3개, 로직 그대로 포팅 |
| `purge_board` (일간 cron) | `onSchedule` 함수, 로직 그대로 포팅 |
| `purge_deleted_archive` (일간 cron) | **Firestore 네이티브 TTL 정책**으로 대체(스케줄 함수 불필요) |
| `sync-professors` Edge Function (월간, 비활성) | `onSchedule` 함수로 포팅(활성화 여부는 이관 후 결정) |

## 6. 데이터·Auth 마이그레이션
- 컷오버 시점에 **1회성 스크립트**(Node.js, `firebase-admin` + `pg`)로 실행:
  1. `auth.users`에서 `id, email, encrypted_password(bcrypt), banned_until` 등을 읽어
     `importUsers()` 배치(최대 1000건/호출)로 Firebase Auth에 적재, `uid` 보존.
  2. `is_admin=true`인 사용자에게 커스텀 클레임 부여.
  3. 36개 테이블을 섹션(§3 컬렉션 지도) 순서대로 읽어 Firestore 문서로 변환, `bulkWriter()`로 적재(500건/배치 제한 준수).
  4. R2 오브젝트 키(`object_key`)는 값 그대로 옮긴다 — 이미지 자체는 R2에 남아있고
     이관 대상이 아니다(§7).
- 스크립트는 **재실행 가능(idempotent)**하게 작성한다 — 컷오버 리허설을 여러 번 돌려
  드릴 수 있도록.

## 7. 스토리지 (변경 없음)
족보 첨부·게시판 이미지는 이미 Cloudflare R2에 있고 Supabase Storage를 쓰지 않는다
([capacity-cost-800dau] 메모리 참고 — R2 egress 0 배포가 이미 되어 있음). Firebase
Storage로 옮기지 않고 **R2를 그대로 유지**한다. `functions/api/board-*.js`,
`exam-*.js`의 오브젝트 키 검증만 Firestore 문서 참조로 바뀐다.

## 8. Cloudflare Pages Functions 인증 계층 교체
`functions/api/_middleware.js`의 Supabase HS256 로컬 검증을 **Firebase ID 토큰(RS256)
검증**으로 교체한다. Firebase ID 토큰은 Google의 회전하는 공개키(JWKS)로 서명되므로
정적 시크릿 HMAC 검증은 불가능 — `jose` 패키지(Workers 런타임 호환)로 JWKS 캐싱 +
RS256 서명 검증 + `iss`(`https://securetoken.google.com/anytime-rokafa`) + `aud`
(`anytime-rokafa`) + 만료 검사를 구현한다. `parse-syllabus.js`의 `is_admin` 확인도
Supabase RPC 호출 대신 ID 토큰의 `admin` 커스텀 클레임 확인으로 바뀐다.

## 9. AI(Gemini) 결제 통합
`GEMINI_API_KEY`(Google AI Studio 발급)는 현재 `anytime-rokafa`와 무관한 프로젝트에
결제가 묶여 있을 수 있다. Blaze 결제 계정 연결 후, `anytime-rokafa` 프로젝트로 새
Gemini API 키를 발급해 Cloudflare Pages Secret을 교체한다(엔드포인트·호출 코드 변경
없음, 결제만 통합).

## 10. 범위 밖(이번 이관에 포함하지 않음)
- Firestore 실시간 리스너를 새 기능으로 도입하지 않는다(엄격한 기능 동등성 우선,
  실시간화는 이관 안정화 후 별도 과제).
- Firebase Storage로의 전환(§7 참고, R2 유지).
- `sync-professors`의 활성화 여부(현재도 비활성 상태 유지, 필요 시 이관 후 별도 결정).
