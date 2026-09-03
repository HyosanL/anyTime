# 게시글 공유 기능 제거 · 홈/프로필 정리 — 설계

작성: 2026-09-03

## 배경 — 요청

> 1. 홈화면에 있는 붙여넣기 버튼을 없애고, 관련해서 공유 기능을 제거해. — 충분히 사용자가 늘었음.
> 2. 홈화면의 로그아웃 버튼을 프로필 화면 내부로 넣어.
> 3. 프로필 창을 정리해. 특히 시간표 테마 설정은 프로필에서 제외(홈화면에 이미 있음).
>    메뉴들이 정리되지 않은 듯하고, 설명이 너무 번잡하고 김.

"붙여넣기 버튼"은 홈 헤더의 iOS 전용 📋 버튼([Home.jsx:410](../../../src/pages/Home.jsx#L410))이다.
이 버튼의 유일한 존재 이유는 **게시글 공유**(`/s/{token}` 링크)의 iOS 핸드오프다 — 사파리에서
공유 링크를 연 사람이 글 주소를 복사해 앱의 이 버튼으로 붙여넣어 그 글로 이동한다.

게시글 공유는 비회원 유입 장치였다(`SharePost` 화면에 "시작하기" CTA, 로그인 없이 열람).
사용자가 충분히 늘어 이 유입 경로가 더는 필요 없고, 교내 게이트 밖으로 글이 새는 위험만 남는다.

## 결정 사항 (사용자 확인 완료)

| 질문 | 답 |
|---|---|
| 제거 범위 | **게시글 공유만.** 친구 시간표 공유(`👥` → `/friends`, `searchSharedUsers`·`getSharedGallery`)는 그대로 유지 — 회원 간 기능이고 유입과 무관. |
| 백엔드 정리 수준 | **완전 제거.** Cloud Function·Pages 함수·관리자 토글·`shareToken` 필드까지. 기존 `/s/…` 링크는 404(SPA 폴백 → 홈). 수용. |
| 프로필 익명성 설명 | 2~3줄 요약만 노출 + `<details>` "자세히"에 상세. |
| 프로필 재구성 방식 | **Approach A** — 순서 재배치 + 설명 압축, 카드 단위는 유지. |

## 다른 세션과의 접점 (주의)

두 세션이 병행 작업 중:
- **시간표 이미지 저장**: `Home.jsx`의 🖼️ 버튼·`handleSaveImage`·`home-tt-actions` 블록·렌더 하단,
  그리고 `lib/timetableImage.js`. ([2026-09-03-timetable-image-save-options-design.md](2026-09-03-timetable-image-save-options-design.md))
- **피드백 답변**: `FeedbackPopup`, `lib/feedback`, `AppReportModal`, `CorrectionModal`, SW.

이 작업의 `Home.jsx` 변경은 **`<header>` 영역 + import + `useAuthContext` 구조분해**로만 한정한다
(`home-tt-actions`·렌더 하단·FeedbackPopup 은 건드리지 않는다). 병합 시 충돌 가능 지점은
import 줄과 `const { … } = useAuthContext()` 한 줄 — 스쿼시가 아니라 줄 단위 병합으로 해소.

`Profile.jsx` 는 다른 두 세션의 편집 대상이 아니다(피드백 세션은 홈 `FeedbackPopup`,
이미지 세션은 홈/`timetableImage`). 전면 수정해도 안전.

---

## Ⅰ. 게시글 공유 제거

### Ⅰ-1. 프론트엔드 — 진입점

**[Home.jsx](../../../src/pages/Home.jsx)**
- `import { isIos } from '../components/InstallGate';` 제거 (홈에서 `isIos` 는 📋 버튼에서만 사용).
- `openCopiedLink` 콜백 제거 ([Home.jsx:371-386](../../../src/pages/Home.jsx#L371-L386)).
- 헤더의 iOS 📋 버튼 제거 ([Home.jsx:408-410](../../../src/pages/Home.jsx#L408-L410)).
- 헤더의 `로그아웃` 버튼 제거 ([Home.jsx:413](../../../src/pages/Home.jsx#L413)) — Ⅱ 로 이동.
- `useAuthContext()` 구조분해에서 `logout` 제거 ([Home.jsx:75](../../../src/pages/Home.jsx#L75)) — 홈에서 다른 사용처 없음.
- 남는 `home-header-actions`: `🚩`(앱 리포트) + `🧹`(관리자 전용). 왼쪽 이름/뱃지 Link(`→ /profile`) 유지.

**[styles/home.css:14-15](../../../src/styles/home.css#L14-L15)** — 헤더 주석 "우측 로그아웃" 문구 갱신.

**[Post.jsx](../../../src/pages/Post.jsx)**
- import 에서 `createShare` 제거 ([Post.jsx:4](../../../src/pages/Post.jsx#L4)).
- `import { shareLink, appUrl } from '../lib/share';` 줄 통째 제거 ([Post.jsx:5](../../../src/pages/Post.jsx#L5)) — 둘 다 `sharePost` 에서만 사용.
- `sharePost` 함수 제거 ([Post.jsx:146-162](../../../src/pages/Post.jsx#L146-L162)).
- 반응 줄의 `🔗 공유` 버튼 제거 ([Post.jsx:225](../../../src/pages/Post.jsx#L225)).

**[App.jsx](../../../src/App.jsx)**
- `const SharePost = lazy(() => import('./pages/SharePost'));` 제거 ([App.jsx:37](../../../src/App.jsx#L37)).
- `<Route path="/s/:token" element={<SharePost />} />` + 그 위 주석 제거 ([App.jsx:228-229](../../../src/App.jsx#L228-L229)).
- `PushNavigator` 의 `/s/` 특례 제거 ([App.jsx:143-175](../../../src/App.jsx#L143-L175)):
  - `const inShare = () => window.location.pathname.startsWith('/s/');` 삭제.
  - `onMsg` 첫 줄 `if (inShare()) return;` 삭제.
  - `onVisible` 의 `&& !inShare()` 삭제.
  - `if (!inShare()) consumePendingNav().then(go);` → `consumePendingNav().then(go);`.
  - `consumePendingNav` import 은 **유지**(푸시 알림 딥링크가 계속 사용).
  - 관련 주석(147-149) 정리.
- `/about` 관련 주석(230-232)은 그대로 유효 — 손대지 않음.

**[components/InstallGate.jsx:66-68](../../../src/components/InstallGate.jsx#L66-L68)**
- `gated` 조건에서 `&& !pathname.startsWith('/s/')` 제거 → `!import.meta.env.DEV && isMobile() && !isStandalone() && pathname !== '/about'`.
- 공유 링크 특례를 설명하던 주석(60-63) 정리(`/about` 예외 설명만 남긴다).

### Ⅰ-2. 프론트엔드 — 라이브러리 / 스타일

**[lib/share.js](../../../src/lib/share.js)** — **파일 삭제.** `shareLink`·`appUrl` 사용처는 `Post.jsx`·`SharePost.jsx` 뿐이며 둘 다 이 작업에서 제거됨. (`navigator.share` 를 직접 쓰는 `timetableImage.js`·`syllabus.js` 등은 이 파일과 무관.)

**[lib/board.js](../../../src/lib/board.js)**
- `shareImageObjectUrl` 제거 ([board.js:77-89](../../../src/lib/board.js#L77-L89)).
- `createShare` 제거 ([board.js:224-230](../../../src/lib/board.js#L224-L230)).
- `getSharedPost` 제거 ([board.js:231-246](../../../src/lib/board.js#L231-L246)).
- `toIso` 는 다른 함수(`toPost` 등)가 계속 사용 — 유지.

**[lib/push.js](../../../src/lib/push.js)**
- `stashPendingNav` 제거 ([push.js:174-183](../../../src/lib/push.js#L174-L183)) — `SharePost` 에서만 사용.
- `consumePendingNav` 유지(SW `notificationclick` 이 `/pending-nav` 를 남기고 `App.jsx`/`push-sw.js` 가 소비).

**[lib/appInfo.js](../../../src/lib/appInfo.js)**
- `BOOT_DEFAULTS` 에서 `shareEnabled: true,` 제거 ([appInfo.js:23](../../../src/lib/appInfo.js#L23)).
- `fetchBootInfo` 반환 객체에서 `shareEnabled` 줄 제거 ([appInfo.js:40](../../../src/lib/appInfo.js#L40)).
- 헤더 주석에서 `shareEnabled` 항목 제거 ([appInfo.js:6](../../../src/lib/appInfo.js#L6)).
- `settings.shareEnabled` 는 프론트 어디에서도 소비되지 않음(그리드/게이트 로직 없음) — 안전.

**[hooks/useAuth.js:45](../../../src/hooks/useAuth.js#L45)** — 주석 "공유 허용" 문구만 삭제(코드 변경 없음).

**[pages/SharePost.jsx](../../../src/pages/SharePost.jsx)** — **파일 삭제.**

**[styles/share.css](../../../src/styles/share.css)** — **파일 삭제.** `SharePost` 전용. `Profile.jsx:12` 의
죽은 `import '../styles/share.css';` 도 함께 제거(Ⅲ).

### Ⅰ-3. 관리자 화면

**[pages/Admin.jsx:1139-1149](../../../src/pages/Admin.jsx#L1139-L1149)** — "비회원 공유 열람" 토글 `adm-toggle-row`
블록 + 그 위 주석 제거. "게시판 활성화" 토글은 유지.

### Ⅰ-4. 백엔드 (`firebase/functions/`)

**[src/board.js](../../../firebase/functions/src/board.js)**
- `createShare` 제거 ([board.js:345-360](../../../firebase/functions/src/board.js#L345-L360)).
- `getSharedPost` 제거 ([board.js:362-412](../../../firebase/functions/src/board.js#L362-L412)).
- `shareImageOk` 제거 ([board.js:414-436](../../../firebase/functions/src/board.js#L414-L436)).
- `createPost` 의 새 문서에서 `shareToken: null,` 제거 ([board.js:117](../../../firebase/functions/src/board.js#L117)).
- `import { randomUUID } from 'node:crypto';` 제거 ([board.js:1](../../../firebase/functions/src/board.js#L1)) — `createShare` 에서만 사용.
- `onRequest` import 은 유지(`boardReferencedKeys` 가 사용).
- 상단 포트 목록 주석(13-18)에서 `create_share()`/`get_shared_post()`/`share_image_ok()` 항목 제거.

**[index.js:62-64](../../../firebase/functions/index.js#L62-L64)** — board.js export 블록에서 `createShare, getSharedPost, shareImageOk,` 세 줄 제거.

**[src/admin/moderationActions.js](../../../firebase/functions/src/admin/moderationActions.js)**
- `setShareEnabled` 함수 제거 ([moderationActions.js:556-560](../../../firebase/functions/src/admin/moderationActions.js#L556-L560)).
- 액션 맵에서 `set_share_enabled: setShareEnabled,` 제거 ([moderationActions.js:785](../../../firebase/functions/src/admin/moderationActions.js#L785)).
- `getAppSetting` 반환에서 `shareEnabled: app.shareEnabled ?? null,` 제거 ([moderationActions.js:528](../../../firebase/functions/src/admin/moderationActions.js#L528)).
- 섹션 주석(496)에서 `shareEnabled` 항목 제거.

**[functions/api/share-image.js](../../../functions/api/share-image.js)** — **파일 삭제.**

**[functions/api/_middleware.js](../../../functions/api/_middleware.js)**
- `if (path === '/api/share-image') return next();` + 그 위 주석(49-51) 제거.
- 파일 상단 주석의 `/api/share-image 는 무인증 통과` 줄(10) 제거.

**[wrangler.toml:21-22](../../../wrangler.toml#L21-L22)** — 주석에서 `share-image.js`·`shareImageOk` 언급 제거(`board-sweep.js`·`boardReferencedKeys` 만 남긴다).

### Ⅰ-5. 목업 / 소개

**[components/AboutMocks.jsx](../../../src/components/AboutMocks.jsx)**
- `ScreenPost` 목업의 `<span className="ab-react-pill">🔗 공유</span>` 제거 ([AboutMocks.jsx:633](../../../src/components/AboutMocks.jsx#L633)).
- post 탭 `desc` 에서 "공유" 제거 ([AboutMocks.jsx:917](../../../src/components/AboutMocks.jsx#L917)): "공감·비공감·신고·알림이 한 줄에. 댓글은 대댓글까지 한 단계 들어갑니다."
- `points` 에서 🔗 공유 항목 제거 ([AboutMocks.jsx:920](../../../src/components/AboutMocks.jsx#L920)).
- `👥 시간표 공유` / `친구 시간표 공유`(746, 947) 등 친구 기능 항목은 **유지**.

### Ⅰ-6. 데이터 (마이그레이션 없음)

- Firestore `boardPosts/*.shareToken` — 고아 필드로 남음. 읽는 코드가 사라지므로 무해. 일괄 삭제 안 함.
- Firestore `config/app.shareEnabled` — 고아 필드. 무해. 삭제 안 함.
- `firestore.rules` — 게시글 공유 전용 규칙 없음(공유 읽기는 Cloud Function 경유였음). 변경 없음.

### Ⅰ-7. 건드리지 않는 것

- `lib/views.js`(`hasViewed`/`markViewed`) — `Post.jsx` 가 계속 사용.
- `consumePendingNav`, `push-sw.js` 의 `/pending-nav` — 푸시 딥링크.
- 친구 시간표 공유 전체: `pages/Friends.jsx`, `lib/friends.js`, `styles/friends.css`,
  `firebase/functions/src/timetable.js` 의 `searchSharedUsers`·`getSharedGallery`, `index.js:28-29`.
- `index.html` OG 태그 — 앱 일반 브랜딩(제목·설명 고정, 글 내용 미노출). `/about` 링크 미리보기에도 쓰이므로 유지. `_redirects` 는 SPA 폴백이라 그대로.
- `db/schema.sql` · `db/comments.sql` — 이관 전 Supabase 스냅샷(현재 라이브 아님). 부분 편집하면 스냅샷도 현재본도 아니게 되므로 **손대지 않는다**. (`board.js` 포트 주석이 이 파일을 근거로 인용하지만, 그 주석도 Ⅰ-4 에서 공유 항목만 지운다.)
- `README.md` — 이미 Supabase 로 낡음(이관 미반영). 이 작업 범위 밖.

---

## Ⅱ. 로그아웃 → 프로필

홈 헤더에서 제거한 로그아웃을 프로필의 **"계정"** 카드에 넣는다(Ⅲ-7).

- 위치: 비밀번호 변경 폼 **아래**, 회원 탈퇴 카드 **위**.
- 형태: 전체폭 버튼, `className="btn-ghost btn-block"`, 라벨 `로그아웃`.
- 동작: `const { logout } = useAuthContext()` (Profile 은 이미 `logout` 을 구조분해함 —
  [Profile.jsx:271](../../../src/pages/Profile.jsx#L271)). `onClick={logout}`.
  `logout`([useAuth.js:116](../../../src/hooks/useAuth.js#L116))은 Firebase 세션만 정리한다 —
  이후 `session` 이 null 이 되면 `ProtectedRoute` 가 `/login` 으로 리다이렉트(홈 헤더 버튼과 정확히 동일). 별도 `navigate` 불필요.
- 확인 프롬프트 없음(홈 헤더도 없었음 — 동작 동일 유지).

`App.jsx` 의 `GeoBlockScreen`·`GeoBanner` 로그아웃(지오 재인증 실패 경로)은 별개 — 유지.

---

## Ⅲ. 프로필 재구성 (Approach A)

[Profile.jsx](../../../src/pages/Profile.jsx) — 카드 단위 유지, **순서 재배치 + 설명 압축**.
`styles/home.css` 의 프로필 관련 클래스 재사용(신규 CSS 최소화).

### 카드 순서 (위 → 아래)

| # | 카드 | 변경 |
|---|---|---|
| 1 | **프로필** (`profile-card`) | 뱃지/이름/등급/진행바 — 변경 없음 |
| 2 | **레벨 등급** (`profile-tiers`) | 변경 없음. 하단 `profile-todo` 한 줄 유지 |
| 3 | **알림** (`PushSettings`) | 토글 전부 유지. 설명 문단 → 한 줄. 테스트 버튼 4개 + 결과 → `<details>` |
| 4 | **화면 테마** | `ThemeToggle` 만. 설명 문구 제거 |
| 5 | ~~시간표 색상~~ | **제거** |
| 6 | **이 앱의 익명성** (`anon-sec`) | 2~3줄 요약 노출 + `<details>` "자세히"에 4개 불릿 + 경고 박스 |
| 7 | **계정** | 비밀번호 변경 폼 + 로그아웃 버튼(Ⅱ) |
| 8 | **회원 탈퇴** (`account-sec danger`) | 설명 한 줄로 압축. 나머지 로직 그대로 |

### Ⅲ-5. 시간표 색상 제거

- `import PalettePicker from '../components/PalettePicker';` 제거 ([Profile.jsx:10](../../../src/pages/Profile.jsx#L10)).
- `import '../styles/share.css';` 제거 ([Profile.jsx:12](../../../src/pages/Profile.jsx#L12)) — 죽은 import (Ⅰ-2).
- "시간표 색상" `account-sec` 섹션 제거 ([Profile.jsx:395-399](../../../src/pages/Profile.jsx#L395-L399)).
- `PalettePicker.jsx` 파일은 유지 — `default export` 를 `PaletteSheet`(홈 ⚙️ 시트)가 계속 사용
  ([PalettePicker.jsx:109](../../../src/components/PalettePicker.jsx#L109)). `styles/palette.css` 유지.

### Ⅲ-3. 알림 카드 — 압축

토글·체크박스·리드타임 버튼·`<time>` 입력은 **전부 그대로**. 바꾸는 것은 설명문과 테스트 UI 배치.

**설명문 압축** (예시, 최종 문구는 구현 중 확정):

| 현재 | 압축 후 |
|---|---|
| "내가 쓴 글·댓글 단 글에 새 댓글이 달리면 알려드려요. 게시글의 🔔 버튼으로 글마다 켜고 끌 수 있습니다. (알림은 이 기기에만 연결되며 계정과 연결되지 않아요.)" | "내 글·댓글에 새 댓글이 달리면 알려드려요. 이 기기에만 연결돼요." |
| DND 안내 2문장 (204-207) | "이 시간대엔 소리·진동 없이 알림센터로만 와요." (1줄) |
| "매일 그 시각에 그날 수업 전체를 한 번에 요약해 알려드려요. 수업이 없는 날은 오지 않아요." | "매일 지정 시각에 그날 수업을 요약해 드려요." |
| 다음 수업 개인정보 설명 2문장 (239-242) | "수업 시작 전 과목·강의실을 알려드려요." |
| "이 브라우저에서는 푸시 알림을 받을 수 없어요. 애타를 홈 화면에 설치하면 (아이폰: Safari 공유 → 홈 화면에 추가) 댓글 알림을 받을 수 있습니다." | "홈 화면에 설치하면 댓글 알림을 받을 수 있어요. (아이폰: Safari 공유 → 홈 화면에 추가)" |

**테스트 UI → `<details>`**: 현재 항상 보이는 버튼 4개(🔔 테스트 / 🌙 무음 테스트 / ⏰ 다음 수업 /
🌅 오늘 수업)와 `testMsg` 출력을 `<details className="account-test">` 안으로 옮긴다.
`<summary>` 라벨: "알림 테스트". `<details>` 는 코드베이스 기존 패턴
([Wizard.jsx:1090](../../../src/pages/Wizard.jsx#L1090) `wz-cand-more`).
`on`(푸시 켜짐)일 때만 노출되는 현재 조건 유지.

핸들러(`sendTest`·`testQuietNow`·`testNextClass`·`testDailyBrief`)는 코드 변경 없음.

### Ⅲ-4. 화면 테마 카드

- `account-note` 설명("시스템 설정을 따르거나 라이트·다크를 직접 고를 수 있습니다.") 제거 —
  `ThemeToggle` 자체가 3분기 세그먼트라 자명.
- `account-sec-title` "화면 테마" + `account-theme` 래퍼 + `<ThemeToggle />` 만 남긴다.

### Ⅲ-6. 익명성 카드 — 요약 + `<details>`

- 노출: `anon-lead`(현행 2문장, 2~3줄) 유지 — 이게 요약.
- `<details className="anon-more"><summary>자세히</summary> … </details>` 안에:
  현재 `anon-list`(불릿 4개) + `anon-caveat`(경고 박스) 이동.
- 신규 CSS: `.anon-more summary` 링크풍(색 `var(--primary)`, `cursor: pointer`,
  `list-style: none` + `::-webkit-details-marker { display:none }`), `.anon-more[open]` 상단 여백.
  `styles/home.css` 익명성 블록(643-686)에 인접 추가.

### Ⅲ-8. 회원 탈퇴 카드 — 설명 압축

| 현재 | 압축 후 |
|---|---|
| "탈퇴하면 프로필·확정시간표·레벨 등 계정 정보가 모두 삭제됩니다. (익명으로 남긴 강의평·메모·족보는 작성자 식별 정보가 없어 그대로 유지됩니다.)" | "프로필·시간표·레벨이 삭제됩니다. 익명으로 남긴 글은 그대로 유지돼요." |

비번 확인 → `deleteAccount` → `logout` → `/login` 흐름은 변경 없음.

### Ⅲ-9. 코드 구조

- 전부 `Profile.jsx` 내부 편집. 새 컴포넌트 파일 없음.
- `PushSettings` 는 같은 파일 내 함수 — 그대로 두되 JSX 의 설명문/테스트 블록만 수정.
- 신규 CSS 클래스 2개(`.anon-more`, `.account-test`)만 `styles/home.css` 에 추가. 색은 토큰만.
- `<details>` 접힘 상태는 브라우저 기본(기기 저장 안 함) — 앱 관례상 사소한 UI 상태라 무방.

---

## Ⅳ. 테스트

프로젝트에 테스트 인프라 없음. 관례대로 **테스트 없이** 진행. `npm run build` 통과 + 수동 확인:

**공유 제거**
- 홈 헤더: iOS 에서 📋 없음, 로그아웃 없음, 🚩/🧹(관리자) 그대로.
- 글 상세: `🔗 공유` 버튼 없음. 반응 줄 정렬 정상.
- `/s/아무거나` 진입 → 홈으로 폴백(에러 화면 아님).
- `npm run build` — `SharePost`·`lib/share`·`share.css` 참조 잔재로 인한 실패 없음.
- `firebase/functions`: `npm run build`(또는 lint) — `createShare`/`getSharedPost`/`shareImageOk`/`randomUUID`/`setShareEnabled` 참조 잔재 없음.
- 관리자 → 게시판 관리: "비회원 공유 열람" 토글 없음, "게시판 활성화" 정상.
- 푸시 알림 탭 딥링크: 알림 탭 → 해당 글 이동 정상(`consumePendingNav` 회귀 없음).

**로그아웃 이동**
- 홈에 로그아웃 없음. 프로필 "계정" 카드의 로그아웃 → 로그인 화면으로.

**프로필 정리**
- 카드 순서 위 표대로. "시간표 색상" 카드 없음.
- 알림: 설명 짧아짐, 테스트 버튼은 "알림 테스트" 펼침 안에. 모든 토글 동작 정상.
- 화면 테마: 토글만. 라이트/다크/시스템 전환 정상.
- 익명성: 요약 + "자세히" 펼치면 불릿 4개 + 경고 박스.
- 다크 모드: `.anon-more summary`·`<details>` 양 테마에서 대비 정상.
- 회원 탈퇴: 설명 한 줄, 탈퇴 흐름 정상.

---

## Ⅴ. 범위 밖 (YAGNI)

- `boardPosts.shareToken` / `config/app.shareEnabled` 고아 필드 일괄 삭제 스크립트.
- `db/schema.sql` · `db/comments.sql` 의 공유 SQL 정리.
- `README.md` 백엔드 서술 갱신(이미 낡음, 별건).
- 친구 시간표 공유 관련 어떤 변경도.
- 프로필 카드 병합(Approach B) / 신규 설정 화면 분리.
- `index.html` OG 태그 제거.
- 로그아웃 확인 다이얼로그 추가.
