# Remove Post-Share Feature & Declutter Home/Profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the board post-sharing feature (`/s/{token}`, `SharePost`, share-image, iOS paste button) in full including backend, move the home logout button into a reorganized Profile screen, and drop the timetable palette picker from Profile.

**Architecture:** Pure deletion across three layers (Cloudflare Pages Function, Firebase Cloud Functions, React frontend) plus one focused UI reorganization of `Profile.jsx`. No new abstractions, no data migration — orphaned Firestore fields (`boardPosts.shareToken`, `config/app.shareEnabled`) are left in place, harmless.

**Tech Stack:** React 19 + react-router-dom 7 + Vite 6 (frontend); Firebase Cloud Functions v2 (Node 22, ESM); Cloudflare Pages Functions; CSS with design tokens.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-09-03-remove-post-share-and-declutter-profile-design.md` — every task's requirements include it.
- **No test infrastructure.** Verification per task = `npm run build` passes (frontend) / `node --check` passes (functions) + `grep` shows zero leftover references. Manual checklist in spec Ⅳ.
- **Colors:** always `var(--token)` — never literal hex in CSS (spec / [[design-system-tokens]]).
- **Language:** Korean for user-facing copy, English for code/identifiers/commits ([[chat-korean-work-english]]).
- **Staging:** explicit paths only, never `git add -A` — the working tree is shared with other sessions.
- **Shared working tree:** other sessions edit `Home.jsx` (image sheet) and feedback files concurrently. Confirm `git status` is clean of others' work on a file before editing it; commit each task immediately.
- **Functions style:** `firebase-functions/v2` only; comment only non-obvious WHY; do not `initializeApp()` ([[firebase functions CONVENTIONS.md]]).
- **Keep (do NOT remove):** `consumePendingNav` + SW `/pending-nav` (push deep-links); all friend-timetable-sharing code (`Friends.jsx`, `lib/friends.js`, `friends.css`, `searchSharedUsers`, `getSharedGallery`); `lib/views.js`.

---

## File Structure

**Deleted:**
- `src/pages/SharePost.jsx` — the `/s/:token` public read view
- `src/lib/share.js` — `shareLink()` / `appUrl()` helpers
- `src/styles/share.css` — SharePost-only styles
- `functions/api/share-image.js` — anon R2 image proxy for share links

**Modified — frontend:**
- `src/App.jsx` — drop `SharePost` lazy import + route; simplify `PushNavigator`
- `src/pages/Post.jsx` — drop `sharePost()` + `🔗 공유` button + imports
- `src/pages/Home.jsx` — drop iOS 📋 button + `openCopiedLink` + logout button + `logout`/`isIos` imports (header region only)
- `src/pages/Admin.jsx` — drop "비회원 공유 열람" toggle
- `src/pages/Profile.jsx` — logout button, reorganization, palette removal, copy trim, anon `<details>`
- `src/lib/board.js` — drop `createShare` / `getSharedPost` / `shareImageObjectUrl`
- `src/lib/push.js` — drop `stashPendingNav`
- `src/lib/appInfo.js` — drop `shareEnabled`
- `src/hooks/useAuth.js` — comment only
- `src/components/InstallGate.jsx` — drop `/s/` gate exception
- `src/components/AboutMocks.jsx` — drop 🔗 공유 from post-screen mock
- `src/styles/home.css` — header comment; new `.anon-more` + `.account-test` rules

**Modified — backend:**
- `firebase/functions/src/board.js` — drop `createShare` / `getSharedPost` / `shareImageOk` + `shareToken` field + `randomUUID` import
- `firebase/functions/index.js` — drop the three exports
- `firebase/functions/src/admin/moderationActions.js` — drop `setShareEnabled` + action-map entry + `getAppSetting` field
- `functions/api/_middleware.js` — drop `/api/share-image` bypass
- `wrangler.toml` — comment only

---

## Task 1: Backend — remove post-share Cloud Functions & admin toggle

**Files:**
- Modify: `firebase/functions/src/board.js`
- Modify: `firebase/functions/index.js:62-64`
- Modify: `firebase/functions/src/admin/moderationActions.js`
- Delete: `functions/api/share-image.js`
- Modify: `functions/api/_middleware.js`
- Modify: `wrangler.toml:21-22`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: Cloud Functions `createShare`, `getSharedPost`, `shareImageOk` no longer exist; admin action `set_share_enabled` no longer exists; `getAppSetting` no longer returns `shareEnabled`. Frontend Task 2 depends on these being gone.

- [ ] **Step 1: Delete the Pages Function**

```bash
git rm functions/api/share-image.js
```

- [ ] **Step 2: Remove the middleware bypass**

In `functions/api/_middleware.js`, delete these lines (currently 49-51):

```js
  // 공유 링크 이미지(비회원 열람용): 접근 검증은 핸들러가 공유 토큰으로 자체 수행
  // (토큰이 가리키는 글의 이미지 + 공개 허용 상태일 때만 스트리밍).
  if (path === '/api/share-image') return next();
```

And in the file's top comment block, delete this line (currently line 10):

```js
// - /api/share-image 는 무인증 통과(핸들러가 공유 토큰을 자체 검증) — 그대로 유지.
```

- [ ] **Step 3: Remove the three Cloud Functions from `board.js`**

In `firebase/functions/src/board.js`:

a) Delete the `randomUUID` import (line 1):

```js
import { randomUUID } from 'node:crypto';
```

b) In the top port-list comment (lines 13-18), change:

```js
// Port of create_board()/create_post()/get_post_b()/check_hot()/board_react()/
// create_comment_b()/delete_post()/delete_comment_b()/purge_board()/
// board_referenced_keys()/create_share()/get_shared_post()/share_image_ok()/
// notify_comment_push()/notify_hot_push() (db/schema.sql). Design doc §3 has
```

to:

```js
// Port of create_board()/create_post()/get_post_b()/check_hot()/board_react()/
// create_comment_b()/delete_post()/delete_comment_b()/purge_board()/
// board_referenced_keys()/notify_comment_push()/notify_hot_push()
// (db/schema.sql). Design doc §3 has
```

c) In `createPost`, delete the `shareToken: null,` line from the `batch.set(postRef, {...})` object (currently line 117).

d) Delete the entire `createShare` export (currently lines 345-360), the `getSharedPost` export **with its leading comment** (currently lines 362-412), and the `shareImageOk` export **with its leading comment** (currently lines 414-436). These are three consecutive top-level `export const` blocks; after deletion the file goes straight from `deleteComment`'s closing `});` to the `boardReferencedKeys` comment block (currently line 438).

- [ ] **Step 4: Remove the exports from `index.js`**

In `firebase/functions/index.js`, the board.js export block currently reads:

```js
export {
  createBoard,
  createPost,
  getPost,
  boardReact,
  createComment,
  deletePost,
  deleteComment,
  createShare,
  getSharedPost,
  shareImageOk,
  boardReferencedKeys,
  purgeBoard,
  onCommentCreatedPush,
  onPostHotChangedPush,
} from './src/board.js';
```

Delete the `createShare,`, `getSharedPost,`, `shareImageOk,` lines.

- [ ] **Step 5: Remove `setShareEnabled` from `moderationActions.js`**

In `firebase/functions/src/admin/moderationActions.js`:

a) Delete the `setShareEnabled` function (currently lines 556-560):

```js
// 공유 링크 비회원 열람 허용/차단 (회원 링크는 항상 동작).
async function setShareEnabled(uid, payload) {
  await db.doc('config/app').set({ shareEnabled: !!payload.value }, { merge: true });
  return { status: 'OK' };
}
```

b) Delete the action-map entry (currently line 785):

```js
  set_share_enabled: setShareEnabled,
```

c) In `getAppSetting`'s returned `setting` object, delete (currently line 528):

```js
      shareEnabled: app.shareEnabled ?? null,
```

d) In the section comment (currently line 496), change:

```js
//  /config/app: geoValidDays, catalogVersion, boardEnabled, shareEnabled,
//    reviewMinDays (옛 get_boot_info() 반환 필드와 정확히 동일, 그 이상도 이하도 아님)
```

to:

```js
//  /config/app: geoValidDays, catalogVersion, boardEnabled, reviewMinDays
//    (옛 get_boot_info() 반환 필드와 정확히 동일, 그 이상도 이하도 아님)
```

- [ ] **Step 6: Update `wrangler.toml` comment**

Currently lines 21-22:

```
# ※ share-image.js·board-sweep.js 는 이제 Supabase 대신 Firebase Cloud Functions
#   (shareImageOk·boardReferencedKeys, https://asia-northeast3-anytime-rokafa.cloudfunctions.net/…)
```

Change to:

```
# ※ board-sweep.js 는 이제 Supabase 대신 Firebase Cloud Functions
#   (boardReferencedKeys, https://asia-northeast3-anytime-rokafa.cloudfunctions.net/…)
```

- [ ] **Step 7: Verify syntax + no leftover references**

Run:

```bash
node --check firebase/functions/src/board.js
node --check firebase/functions/index.js
node --check firebase/functions/src/admin/moderationActions.js
node --check functions/api/_middleware.js
grep -rn "createShare\|getSharedPost\|shareImageOk\|shareToken\|setShareEnabled\|set_share_enabled\|share-image\|randomUUID" firebase/functions/ functions/api/ wrangler.toml
```

Expected: `node --check` prints nothing (all pass). `grep` returns **no matches**.

- [ ] **Step 8: Commit**

```bash
git add firebase/functions/src/board.js firebase/functions/index.js firebase/functions/src/admin/moderationActions.js functions/api/share-image.js functions/api/_middleware.js wrangler.toml
git commit -m "$(cat <<'EOF'
feat: remove board post-share backend (createShare/getSharedPost/shareImageOk)

Deletes the three share Cloud Functions, the /api/share-image Pages
Function + its middleware bypass, the set_share_enabled admin action and
the shareEnabled app-setting field, and the shareToken field on new posts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Frontend — remove post-share entry points, libs, styles

**Files:**
- Delete: `src/pages/SharePost.jsx`, `src/lib/share.js`, `src/styles/share.css`
- Modify: `src/App.jsx`, `src/pages/Post.jsx`, `src/pages/Admin.jsx`, `src/lib/board.js`, `src/lib/push.js`, `src/lib/appInfo.js`, `src/hooks/useAuth.js`, `src/components/InstallGate.jsx`, `src/components/AboutMocks.jsx`

**Interfaces:**
- Consumes: Task 1's removed backend (the deleted `lib/board.js` wrappers called functions that no longer exist).
- Produces: `lib/share.js`, `SharePost.jsx`, `share.css` gone; `lib/board.js` no longer exports `createShare`/`getSharedPost`/`shareImageObjectUrl`; `lib/push.js` no longer exports `stashPendingNav`; `lib/appInfo.js` `BOOT_DEFAULTS`/`fetchBootInfo` no longer carry `shareEnabled`. Task 3 (Home) and Task 4 (Profile) rely on `share.css` being deleted (Profile's dead import) and on nothing importing `lib/share`.

- [ ] **Step 1: Delete the three files**

```bash
git rm src/pages/SharePost.jsx src/lib/share.js src/styles/share.css
```

- [ ] **Step 2: `src/App.jsx` — drop lazy import + route**

Delete (currently line 37):

```js
const SharePost = lazy(() => import('./pages/SharePost'));
```

Delete (currently lines 228-229):

```jsx
          {/* 공유 링크: 유일한 공개 콘텐츠 라우트 — 세션·게이트 없이 그 글 하나만 읽기 전용 */}
          <Route path="/s/:token" element={<SharePost />} />
```

- [ ] **Step 3: `src/App.jsx` — simplify `PushNavigator`**

The `PushNavigator` effect currently reads (lines ~143-175):

```jsx
function PushNavigator() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    // 공유 링크 화면(/s/*)에서는 소비·이동 금지 — 그 화면이 방금 stashPendingNav 로
    // 남긴 목적지(앱을 열면 그 글로)를 자기 자신이 삼켜 버리거나, 브라우저 탭을
    // 앱 내부 경로로 끌고 가 설치 게이트에 부딪히는 것을 막는다.
    const inShare = () => window.location.pathname.startsWith('/s/');
    const go = (path) => {
      if (path && window.location.pathname !== path) navigate(path);
    };
    const onMsg = (e) => {
      if (inShare()) return;
      const d = e.data;
      if (d?.type !== 'PUSH_NAV' || typeof d.path !== 'string' || !d.path.startsWith('/')) return;
      consumePendingNav();  // 캐시 보험 소비(다음 부팅 때 이중 이동 방지)
      go(d.path);
    };
    // 백그라운드에 있던 앱이 알림 탭으로 다시 앞으로 나올 때: postMessage 가 유실됐어도
    // SW 가 남긴 목적지를 회수해 이동한다(가장 흔한 실패 경로의 안전망 — 콜드/웜 모두 커버).
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !inShare()) consumePendingNav().then(go);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    document.addEventListener('visibilitychange', onVisible);
    if (!inShare()) consumePendingNav().then(go);  // 콜드스타트(openWindow 가 경로를 무시한 경우)
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [navigate]);
  return null;
}
```

Replace the whole function body with (drop `inShare`, keep everything else):

```jsx
function PushNavigator() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const go = (path) => {
      if (path && window.location.pathname !== path) navigate(path);
    };
    const onMsg = (e) => {
      const d = e.data;
      if (d?.type !== 'PUSH_NAV' || typeof d.path !== 'string' || !d.path.startsWith('/')) return;
      consumePendingNav();  // 캐시 보험 소비(다음 부팅 때 이중 이동 방지)
      go(d.path);
    };
    // 백그라운드에 있던 앱이 알림 탭으로 다시 앞으로 나올 때: postMessage 가 유실됐어도
    // SW 가 남긴 목적지를 회수해 이동한다(가장 흔한 실패 경로의 안전망 — 콜드/웜 모두 커버).
    const onVisible = () => {
      if (document.visibilityState === 'visible') consumePendingNav().then(go);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    document.addEventListener('visibilitychange', onVisible);
    consumePendingNav().then(go);  // 콜드스타트(openWindow 가 경로를 무시한 경우)
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMsg);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [navigate]);
  return null;
}
```

Leave the `consumePendingNav` import on line 5 untouched.

- [ ] **Step 4: `src/pages/Post.jsx` — drop share button + code**

a) In the import on line 4, remove `, createShare`:

```js
import { getPost, listComments, react, addComment, deletePost, deleteComment, postImageKeys, createShare } from '../lib/board';
```

becomes:

```js
import { getPost, listComments, react, addComment, deletePost, deleteComment, postImageKeys } from '../lib/board';
```

b) Delete line 5 entirely:

```js
import { shareLink, appUrl } from '../lib/share';
```

c) Delete the `sharePost` function (currently lines 146-162):

```js
  // 🔗 공유: 글당 고정 토큰(/s/{token})을 발급받아 OS 공유 시트(폴백: 클립보드)로.
  // 링크는 비회원도 읽기 전용으로 열람 가능(관리자 토글로 차단 가능), 글 삭제 시 무효.
  // 메시지에는 맥락 문구를 함께 실어 받는 쪽에서 "이게 뭐야"가 되지 않게 한다.
  async function sharePost() {
    try {
      const t = await createShare(id);
      if (!t) throw new Error('NO_TOKEN');
      const short = post.title && post.title.length > 24 ? `${post.title.slice(0, 24)}…` : post.title;
      // 어느 게시판의 어느 글인지 함께 실어 준다 — "애타 익명게시판 [우주공학과]의 "이찬" 글이에요."
      const where = post.board?.name ? `익명게시판 [${post.board.name}]` : '익명게시판';
      await shareLink({
        title: '애타 - AnyTime',
        text: short ? `애타 ${where}의 "${short}" 글이에요.` : `애타 ${where}에서 공유된 글이에요.`,
        url: appUrl(`/s/${t}`),
      });
    } catch { alert('공유 링크를 만들지 못했습니다. 잠시 후 다시 시도해주세요.'); }
  }
```

d) Delete the share button (currently line 225):

```jsx
          <button className="react-pill" onClick={sharePost} title="이 글의 링크 공유">🔗 공유</button>
```

- [ ] **Step 5: `src/lib/board.js` — drop three functions**

Delete `shareImageObjectUrl` **with its leading comment** (currently lines 77-89):

```js
// 공유 화면(비회원)용 이미지 로드 — 인증 헤더 대신 공유 토큰으로 /api/share-image 를 탄다.
// 썸네일 우선 + 404 시 원본 폴백은 위 boardImageObjectUrl 과 동일한 규약.
export async function shareImageObjectUrl(token, key, { thumb = false } = {}) {
  ...
}
```

Delete the `// ── 공유 링크 ───...` section — `createShare` and `getSharedPost` **with their comments** (currently lines 224-246):

```js
// ── 공유 링크 ─────────────────────────────────────────────────────────
// 공유 토큰 발급(회원 전용, 글당 1개 고정 — 재호출 시 기존 토큰 반환)
export async function createShare(postId) { ... }
// 공유 글 읽기(비회원 가능)...
export async function getSharedPost(token, view = false) { ... }
```

Leave `toIso` (used by `toPost`) untouched.

- [ ] **Step 6: `src/lib/push.js` — drop `stashPendingNav`**

Delete (currently lines 174-183):

```js
// 공유 링크 화면(모바일 브라우저 탭)이 목적지를 남길 때 사용 — 위 consumePendingNav 와
// 같은 통로(캐시·3분 TTL). Android WebAPK 는 브라우저와 저장소를 공유하므로 사용자가
// 애타 앱을 열면 PushNavigator 가 회수해 해당 글로 이동한다(iOS 는 저장소 분리라 미동작).
export async function stashPendingNav(path) {
  if (!('caches' in window)) return;
  try {
    const c = await caches.open(META_CACHE);
    await c.put('/pending-nav', new Response(JSON.stringify({ path, ts: Date.now() })));
  } catch { /* 실패해도 무해 — 화면의 안내 배너에 의존 */ }
}
```

Leave `consumePendingNav` untouched.

- [ ] **Step 7: `src/lib/appInfo.js` — drop `shareEnabled`**

a) In the header comment, delete line 6:

```js
//  - shareEnabled  : 공유링크 비회원 열람 허용
```

b) In `BOOT_DEFAULTS`, delete line 23:

```js
  shareEnabled: true,
```

c) In `fetchBootInfo`'s returned object, delete line 40:

```js
        shareEnabled: data?.shareEnabled ?? BOOT_DEFAULTS.shareEnabled,
```

d) In the same header comment block, adjust line 18's wording — change:

```js
// 서버 응답 전(그리고 오프라인)에 쓰는 기본값. 게시판·공유는 '열림'이 기본이라 첫 화면이 깜빡이지 않는다.
```

to:

```js
// 서버 응답 전(그리고 오프라인)에 쓰는 기본값. 게시판은 '열림'이 기본이라 첫 화면이 깜빡이지 않는다.
```

- [ ] **Step 8: `src/hooks/useAuth.js` — comment only**

Line 45 currently:

```js
  // 서버 설정(게시판 활성화·공유 허용·강의평 자격일수). 부팅 정보 한 번으로 받아 전 화면이 나눠 쓴다
```

Change to:

```js
  // 서버 설정(게시판 활성화·강의평 자격일수). 부팅 정보 한 번으로 받아 전 화면이 나눠 쓴다
```

- [ ] **Step 9: `src/pages/Admin.jsx` — drop the toggle**

Delete (currently lines 1139-1149):

```jsx
            {/* 공유 링크(/s/…)를 받은 비로그인 사용자가 그 글을 읽을 수 있는지. 차단해도 링크
                생성·공유와 회원의 링크 접속(앱 글 화면으로 이동)은 계속 동작한다. */}
            <div className="adm-toggle-row">
              <div className="adm-toggle-body">
                <span className="adm-toggle-label">비회원 공유 열람</span>
                <span className={`tag ${setting.shareEnabled === false ? 'tag-warn' : 'tag-success'}`}>{setting.shareEnabled === false ? '차단' : '허용'}</span>
              </div>
              <button className="btn-ghost btn-sm" onClick={() => run('set_share_enabled', { value: !(setting.shareEnabled !== false) }, '비회원 공유 열람 변경')}>
                {setting.shareEnabled === false ? '허용' : '차단'}
              </button>
            </div>

```

(Leave the "게시판 활성화" `adm-toggle-row` directly above it, and the "게시판별 삭제" `section-label` directly below it, intact.)

- [ ] **Step 10: `src/components/InstallGate.jsx` — drop `/s/` exception**

Currently lines 60-68:

```jsx
  // 설치 여부는 세션 동안 불변(standalone 은 실행 방식). 단 공유 링크(/s/*)는 게이트
  // 예외 — 비회원이 브라우저에서 읽는 화면이므로 막으면 공유 자체가 무효가 된다
  // (지난 공유 기능이 이 게이트에 막혀 회수된 전례: 0e001f7). 공유 화면을 벗어나
  // 앱 내부 경로로 이동하면 경로 재평가로 게이트가 다시 걸린다.
  // 앱 소개(/about)도 같은 이유로 예외 — 설치할지 말지 판단하려고 보는 화면인데
  // 설치 안내로 막으면 순서가 뒤집힌다. 데이터를 부르지 않는 정적 화면이라 안전하다.
  const { pathname } = useLocation();
  const gated = !import.meta.env.DEV && isMobile() && !isStandalone()
    && !pathname.startsWith('/s/') && pathname !== '/about';
```

Replace with:

```jsx
  // 설치 여부는 세션 동안 불변(standalone 은 실행 방식). 단 앱 소개(/about)는 게이트
  // 예외 — 설치할지 말지 판단하려고 보는 화면인데 설치 안내로 막으면 순서가 뒤집힌다.
  // 데이터를 부르지 않는 정적 화면이라 안전하다.
  const { pathname } = useLocation();
  const gated = !import.meta.env.DEV && isMobile() && !isStandalone()
    && pathname !== '/about';
```

- [ ] **Step 11: `src/components/AboutMocks.jsx` — drop 🔗 공유 from post mock**

a) Delete the share pill in `ScreenPost` (currently line 633):

```jsx
          <span className="ab-react-pill">🔗 공유</span>
```

b) Change the post-tab `desc` (currently line 917):

```js
    desc: '공감·비공감·신고·알림·공유가 한 줄에. 댓글은 대댓글까지 한 단계 들어갑니다.',
```

to:

```js
    desc: '공감·비공감·신고·알림이 한 줄에. 댓글은 대댓글까지 한 단계 들어갑니다.',
```

c) Delete the 🔗 bullet from that tab's `points` (currently line 920):

```js
      ['🔗', '<b>공유</b> — 로그인 없이 열리는 링크(/s/…)를 만듭니다. 미리보기에 글 내용은 실리지 않아요.'],
```

(Leave the `👥 시간표 공유` / `친구 시간표 공유` entries at lines ~746 and ~947 — that is the friend feature, kept.)

- [ ] **Step 12: Verify build + no leftover references**

Run:

```bash
npm run build
grep -rn "SharePost\|lib/share'\|shareLink\|createShare\|getSharedPost\|shareImageObjectUrl\|stashPendingNav\|/s/:token\|share-image\|shareEnabled\|openCopiedLink" src/
```

Expected: `npm run build` succeeds (no unresolved imports). `grep` returns **no matches** (the `isIos` 📋 button + `openCopiedLink` in `Home.jsx` are removed in Task 3 — if this grep runs before Task 3, `openCopiedLink`/`/s/` in Home.jsx is the only allowed hit; re-run after Task 3 for zero).

- [ ] **Step 13: Commit**

```bash
git add src/pages/SharePost.jsx src/lib/share.js src/styles/share.css src/App.jsx src/pages/Post.jsx src/pages/Admin.jsx src/lib/board.js src/lib/push.js src/lib/appInfo.js src/hooks/useAuth.js src/components/InstallGate.jsx src/components/AboutMocks.jsx
git commit -m "$(cat <<'EOF'
feat: remove board post-share frontend (SharePost, /s/ route, 🔗 button)

Deletes SharePost.jsx, lib/share.js, share.css; drops the share route +
lazy import, the Post 🔗 공유 button, createShare/getSharedPost/
shareImageObjectUrl wrappers, stashPendingNav, the shareEnabled boot
field, the admin 비회원 공유 열람 toggle, and the /s/ install-gate
exception. consumePendingNav (push deep-links) is kept.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Home header — remove iOS 📋 paste button + logout button

**Files:**
- Modify: `src/pages/Home.jsx` (header region + imports + `useAuthContext` destructure only)
- Modify: `src/styles/home.css:14-15` (comment)

**Interfaces:**
- Consumes: Task 2 (nothing in `lib/share` to import).
- Produces: `Home.jsx` header has no logout — Task 4 (Profile) adds it there.

**⚠️ Shared file:** other sessions edit `Home.jsx` (`home-tt-actions` image sheet, bottom render). Before editing, run `git status --porcelain src/pages/Home.jsx` — if it shows `M` from another session, wait for them to commit. Edit **only** the `<header className="page-header">` block, the `import` lines, and the `useAuthContext()` destructure. Stage with the explicit path.

- [ ] **Step 1: Confirm the file is clean**

Run: `git status --porcelain src/pages/Home.jsx`
Expected: no output (or only your own staged changes). If another session has it dirty, STOP and coordinate.

- [ ] **Step 2: Remove the `isIos` import**

Line 4 currently:

```js
import { isIos } from '../components/InstallGate';
```

Delete it (grep-confirm `isIos` is unused elsewhere in `Home.jsx` first: `grep -n isIos src/pages/Home.jsx` → only the import + the 📋 button line).

- [ ] **Step 3: Remove `logout` from the context destructure**

Line 75 currently:

```js
  const { cadet, session, settings, logout } = useAuthContext();
```

Change to:

```js
  const { cadet, session, settings } = useAuthContext();
```

- [ ] **Step 4: Remove the `openCopiedLink` callback**

Delete (currently lines 371-386):

```js
  // iOS 공유 핸드오프: 공유 화면(사파리)이 복사해 둔 글 주소를 붙여넣어 그 글로 이동.
  // iOS 는 사파리↔홈화면앱 저장소 분리 + 앱 실행 API 부재라 Android(pending-nav)처럼
  // 자동 전달이 불가능한 유일한 플랫폼 — 클립보드가 두 세계를 잇는 유일한 통로다.
  const openCopiedLink = useCallback(async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch {
      alert('클립보드를 읽지 못했어요. 공유 화면에서 [앱에서 이어보기]를 다시 눌러주세요.');
      return;
    }
    const m = String(text).match(/\/(board\/post\/\d+|s\/[0-9a-fA-F-]{36})/);
    if (!m) {
      alert('복사된 애타 글 주소가 없어요.\n공유 링크 화면에서 [앱에서 이어보기]를 먼저 눌러주세요.');
      return;
    }
    navigate(`/${m[1]}`);
  }, [navigate]);
```

- [ ] **Step 5: Remove the 📋 button and the 로그아웃 button**

The header's actions block currently reads (lines ~407-414):

```jsx
        <div className="home-header-actions">
          {/* iOS 전용 공유 핸드오프 진입점 — 클립보드는 몰래 확인이 불가(읽기=시스템 팝업)라
              조건부 표시가 안 되므로, 아이콘 하나로 존재감을 최소화해 상시 배치한다. */}
          {isIos() && <button className="link-btn" onClick={openCopiedLink} title="공유받은 글 붙여넣어 열기" aria-label="공유받은 글 붙여넣어 열기">📋</button>}
          <button className="link-btn" onClick={() => setAppReportOpen(true)} title="앱 문제 리포트" aria-label="앱 문제 리포트">🚩</button>
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link" title="검열" aria-label="검열">🧹</Link>}
          <button className="link-btn" onClick={logout}>로그아웃</button>
        </div>
```

Replace with:

```jsx
        <div className="home-header-actions">
          <button className="link-btn" onClick={() => setAppReportOpen(true)} title="앱 문제 리포트" aria-label="앱 문제 리포트">🚩</button>
          {isAdmin && <Link to="/admin/moderation" className="link-btn home-mod-link" title="검열" aria-label="검열">🧹</Link>}
        </div>
```

- [ ] **Step 6: Update the `home.css` header comment**

Lines 14-15 currently:

```css
/* ============================================================
   홈 헤더 — 좌측 아이디+뱃지 카드(→ /profile), 우측 로그아웃
   ============================================================ */
```

Change the second line to:

```css
   홈 헤더 — 좌측 아이디+뱃지 카드(→ /profile), 우측 리포트·검열
```

- [ ] **Step 7: Verify**

Run:

```bash
npm run build
grep -n "isIos\|openCopiedLink\|logout\|📋" src/pages/Home.jsx
```

Expected: build succeeds. `grep` returns **no matches**.

- [ ] **Step 8: Commit**

```bash
git add src/pages/Home.jsx src/styles/home.css
git commit -m "$(cat <<'EOF'
feat: drop iOS paste button and logout from home header

The 📋 handoff button supported post-share (now removed). Logout moves
into the Profile screen.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Profile — logout, reorganization, palette removal, copy trim

**Files:**
- Modify: `src/pages/Profile.jsx`
- Modify: `src/styles/home.css` (add `.anon-more`, `.account-test`)

**Interfaces:**
- Consumes: Task 2 (`share.css` deleted → the dead `import '../styles/share.css'` must go); Task 3 (logout removed from home).
- Produces: final Profile layout. Nothing downstream.

- [ ] **Step 1: Remove dead imports**

In `src/pages/Profile.jsx`:

Delete line 10:

```js
import PalettePicker from '../components/PalettePicker';
```

Delete line 12:

```js
import '../styles/share.css';
```

- [ ] **Step 2: Reorder the card stack + remove the palette card**

The `Profile()` component's returned JSX `<div className="home-body">` currently contains, in order: `<PushSettings />`, `profile-card`, `profile-tiers`, `anon-sec`, `화면 테마` section, `시간표 색상` section, `비밀번호 변경` section, `회원 탈퇴` section.

Rewrite `<div className="home-body">…</div>` to this order (full content in the following steps):

1. `profile-card` (badge/name/tier/progress) — unchanged
2. `profile-tiers` (level list) — unchanged
3. `<PushSettings />`
4. `화면 테마` section — trimmed (Step 4)
5. `이 앱의 익명성` section — summary + `<details>` (Step 5)
6. `계정` section — password form + logout button (Step 6)
7. `회원 탈퇴` section — trimmed copy (Step 7)

Delete the entire `시간표 색상` section (currently lines 395-399):

```jsx
        <section className="card account-sec">
          <h3 className="account-sec-title">시간표 색상</h3>
          <p className="account-note">시간표 과목 칸의 색 테마를 고를 수 있어요. (이 기기에만 저장됩니다.)</p>
          <PalettePicker />
        </section>
```

- [ ] **Step 3: Trim `PushSettings` copy + fold test buttons into `<details>`**

In the `PushSettings` component's returned JSX:

a) The unsupported-browser note (currently lines 169-172):

```jsx
        <p className="account-note">
          이 브라우저에서는 푸시 알림을 받을 수 없어요. 애타를 <b>홈 화면에 설치</b>하면
          (아이폰: Safari 공유 → 홈 화면에 추가) 댓글 알림을 받을 수 있습니다.
        </p>
```

→

```jsx
        <p className="account-note">
          홈 화면에 설치하면 댓글 알림을 받을 수 있어요. (아이폰: Safari 공유 → 홈 화면에 추가)
        </p>
```

b) The main note (currently lines 175-178):

```jsx
          <p className="account-note">
            내가 쓴 글·댓글 단 글에 새 댓글이 달리면 알려드려요. 게시글의 🔔 버튼으로
            글마다 켜고 끌 수 있습니다. (알림은 이 기기에만 연결되며 계정과 연결되지 않아요.)
          </p>
```

→

```jsx
          <p className="account-note">
            내 글·댓글에 새 댓글이 달리면 알려드려요. 이 기기에만 연결돼요.
          </p>
```

c) The DND explainer (currently lines 203-208):

```jsx
              {dnd.on && (
                <p className="account-note" style={{ marginTop: 6 }}>
                  이 시간대(디바이스 시간 기준)엔 알림이 소리·진동 없이 알림센터로만 조용히 도착해요.
                  확실히 무음을 원하면 기기의 방해 금지 모드도 함께 켜두시는 걸 권해요.
                </p>
              )}
```

→

```jsx
              {dnd.on && (
                <p className="account-note" style={{ marginTop: 6 }}>
                  이 시간대엔 소리·진동 없이 알림센터로만 조용히 도착해요.
                </p>
              )}
```

d) The daily-brief note (currently lines 220-222):

```jsx
                <p className="account-note" style={{ marginTop: 6 }}>
                  매일 그 시각에 그날 수업 전체를 한 번에 요약해 알려드려요. 수업이 없는 날은 오지 않아요.
                </p>
```

→

```jsx
                <p className="account-note" style={{ marginTop: 6 }}>
                  매일 지정 시각에 그날 수업을 요약해 드려요. 수업 없는 날은 오지 않아요.
                </p>
```

e) The next-class note (currently lines 239-242):

```jsx
                <p className="account-note" style={{ marginTop: 6 }}>
                  수업 시작 전 “⏰ 다음 수업 / 과목 · 강의실 · 시각”을 알려드려요. 알림 시각(요일·시각)만
                  이 기기 구독에 저장되고, 과목·강의실은 서버에 저장되지 않아요.
                </p>
```

→

```jsx
                <p className="account-note" style={{ marginTop: 6 }}>
                  수업 시작 전 과목·강의실을 알려드려요. 과목·강의실은 서버에 저장되지 않아요.
                </p>
```

f) The test-button row + `testMsg` (currently lines 245-259):

```jsx
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                <button className="btn-ghost btn-sm" onClick={sendTest}>
                  🔔 테스트 알림 보내기
                </button>
                <button className="btn-ghost btn-sm" onClick={testQuietNow}>
                  🌙 지금 방해금지로 무음 테스트
                </button>
                <button className="btn-ghost btn-sm" onClick={testNextClass}>
                  ⏰ 다음 수업 알림 테스트
                </button>
                <button className="btn-ghost btn-sm" onClick={testDailyBrief}>
                  🌅 오늘 수업 요약 테스트
                </button>
              </div>
              {testMsg && <p className="account-note" style={{ marginTop: 6 }}>{testMsg}</p>}
```

→

```jsx
              <details className="account-test">
                <summary>알림 테스트</summary>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                  <button className="btn-ghost btn-sm" onClick={sendTest}>🔔 테스트 알림</button>
                  <button className="btn-ghost btn-sm" onClick={testQuietNow}>🌙 무음 테스트</button>
                  <button className="btn-ghost btn-sm" onClick={testNextClass}>⏰ 다음 수업</button>
                  <button className="btn-ghost btn-sm" onClick={testDailyBrief}>🌅 오늘 수업</button>
                </div>
                {testMsg && <p className="account-note" style={{ marginTop: 6 }}>{testMsg}</p>}
              </details>
```

- [ ] **Step 4: Trim the 화면 테마 section**

Currently (lines 387-393):

```jsx
        <section className="card account-sec">
          <h3 className="account-sec-title">화면 테마</h3>
          <p className="account-note">시스템 설정을 따르거나 라이트·다크를 직접 고를 수 있습니다.</p>
          <div className="account-theme">
            <ThemeToggle />
          </div>
        </section>
```

→

```jsx
        <section className="card account-sec">
          <h3 className="account-sec-title">화면 테마</h3>
          <div className="account-theme">
            <ThemeToggle />
          </div>
        </section>
```

- [ ] **Step 5: Rewrite the 익명성 section — summary + `<details>`**

Currently (lines 367-385):

```jsx
        <section className="card account-sec anon-sec">
          <h3 className="account-sec-title">🔒 이 앱의 익명성</h3>
          <p className="anon-lead">
            애타는 <b>누가 무엇을 썼는지</b> 앱 자체가 알 수 없도록 설계돼 있습니다.
            강의평·수업메모·족보·게시글은 작성자 정보 없이 저장됩니다.
          </p>
          <ul className="anon-list">
            <li><b>글에 작성자가 남지 않아요.</b> 게시글·강의평 데이터에는 내용과 시각만 저장되고, 누가 썼는지를 가리키는 정보가 아예 없습니다.</li>
            <li><b>실명·전화번호를 받지 않아요.</b> 가입은 아이디·비밀번호만으로 이뤄지고 이메일·전화·실명은 수집하지 않습니다.</li>
            <li><b>관리자도 작성자를 특정할 수 없어요.</b> 데이터를 전부 열람해도 “이 글을 누가 썼는지”는 나오지 않습니다. 신고가 쌓이면 내용만 자동으로 가려질 뿐, 작성자를 역추적하거나 지목하지 않습니다.</li>
            <li><b>삭제는 글 비밀번호로 해요.</b> 계정 소유로 지우는 게 아니라(그런 연결이 없으니까) 글마다 정한 삭제 비밀번호로 지웁니다.</li>
          </ul>
          <p className="anon-caveat">
            ⚠️ 다만 이건 <b>학교·관리자·다른 생도로부터의 익명성</b>이에요.
            명예훼손·협박 같은 불법 콘텐츠는 다른 인터넷 서비스와 마찬가지로,
            법적 절차(수사기관의 IP·통신기록 조회 등)에 따라 추적 대상이 될 수 있습니다.
            서로 존중하며 이용해주세요.
          </p>
        </section>
```

→

```jsx
        <section className="card account-sec anon-sec">
          <h3 className="account-sec-title">🔒 이 앱의 익명성</h3>
          <p className="anon-lead">
            애타는 <b>누가 무엇을 썼는지</b> 앱 자체가 알 수 없도록 설계돼 있어요.
            강의평·수업메모·족보·게시글은 작성자 정보 없이 저장되고, 삭제는 글 비밀번호로 합니다.
          </p>
          <details className="anon-more">
            <summary>자세히</summary>
            <ul className="anon-list">
              <li><b>글에 작성자가 남지 않아요.</b> 게시글·강의평 데이터에는 내용과 시각만 저장되고, 누가 썼는지를 가리키는 정보가 아예 없습니다.</li>
              <li><b>실명·전화번호를 받지 않아요.</b> 가입은 아이디·비밀번호만으로 이뤄지고 이메일·전화·실명은 수집하지 않습니다.</li>
              <li><b>관리자도 작성자를 특정할 수 없어요.</b> 데이터를 전부 열람해도 “이 글을 누가 썼는지”는 나오지 않습니다. 신고가 쌓이면 내용만 자동으로 가려질 뿐입니다.</li>
              <li><b>삭제는 글 비밀번호로 해요.</b> 계정 소유로 지우는 게 아니라 글마다 정한 삭제 비밀번호로 지웁니다.</li>
            </ul>
            <p className="anon-caveat">
              ⚠️ 다만 이건 <b>학교·관리자·다른 생도로부터의 익명성</b>이에요.
              명예훼손·협박 같은 불법 콘텐츠는 다른 인터넷 서비스와 마찬가지로,
              법적 절차(수사기관의 IP·통신기록 조회 등)에 따라 추적 대상이 될 수 있습니다.
              서로 존중하며 이용해주세요.
            </p>
          </details>
        </section>
```

- [ ] **Step 6: Rename 비밀번호 변경 section → 계정, add logout button**

Currently (lines 401-409):

```jsx
        <section className="card account-sec">
          <h3 className="account-sec-title">비밀번호 변경</h3>
          <form className="account-form" onSubmit={onChangePw}>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="새 비밀번호(6자 이상)" autoComplete="new-password" />
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="새 비밀번호 확인" autoComplete="new-password" />
            <button type="submit" className="btn-add btn-block" disabled={busy}>변경</button>
          </form>
          {pwMsg && <p className="account-msg">{pwMsg}</p>}
        </section>
```

→

```jsx
        <section className="card account-sec">
          <h3 className="account-sec-title">계정</h3>
          <form className="account-form" onSubmit={onChangePw}>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="새 비밀번호(6자 이상)" autoComplete="new-password" />
            <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} placeholder="새 비밀번호 확인" autoComplete="new-password" />
            <button type="submit" className="btn-add btn-block" disabled={busy}>비밀번호 변경</button>
          </form>
          {pwMsg && <p className="account-msg">{pwMsg}</p>}
          <button type="button" className="btn-ghost btn-block" style={{ marginTop: 10 }} onClick={logout}>로그아웃</button>
        </section>
```

`logout` is already destructured from `useAuthContext()` at line 271 — no import change needed.

- [ ] **Step 7: Trim the 회원 탈퇴 note**

Currently (line 413):

```jsx
          <p className="account-note">탈퇴하면 프로필·확정시간표·레벨 등 계정 정보가 모두 삭제됩니다. (익명으로 남긴 강의평·메모·족보는 작성자 식별 정보가 없어 그대로 유지됩니다.)</p>
```

→

```jsx
          <p className="account-note">프로필·시간표·레벨이 삭제됩니다. 익명으로 남긴 강의평·메모·족보·글은 그대로 유지돼요.</p>
```

- [ ] **Step 8: Add the two CSS rules**

In `src/styles/home.css`, at the end of the 익명성 block (after the `.anon-caveat b` rule, currently line 686), add:

```css

/* 익명성 "자세히" 접기 */
.anon-more {
  margin-top: 0.6rem;
}
.anon-more > summary {
  cursor: pointer;
  font-size: 0.84rem;
  font-weight: 650;
  color: var(--primary);
  list-style: none;
}
.anon-more > summary::-webkit-details-marker { display: none; }
.anon-more[open] > summary { margin-bottom: 0.7rem; }

/* 알림 테스트 접기 */
.account-test {
  margin-top: 0.9rem;
}
.account-test > summary {
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 650;
  color: var(--text-2);
  list-style: none;
}
.account-test > summary::-webkit-details-marker { display: none; }
```

- [ ] **Step 9: Verify**

Run:

```bash
npm run build
grep -n "PalettePicker\|share.css\|시간표 색상" src/pages/Profile.jsx
```

Expected: build succeeds. `grep` returns **no matches**.

Manual (dev server or after deploy): open `/profile` → card order is profile / 레벨 등급 / 알림 / 화면 테마 / 익명성 / 계정 / 회원 탈퇴; no "시간표 색상" card; "알림 테스트" and "자세히" collapse/expand; logout in the 계정 card signs out to `/login`; toggle dark mode → `.anon-more summary` and `.account-test summary` stay legible.

- [ ] **Step 10: Commit**

```bash
git add src/pages/Profile.jsx src/styles/home.css
git commit -m "$(cat <<'EOF'
feat: declutter Profile — logout in, palette out, copy trimmed

Reorders the card stack, moves logout into a new 계정 card, drops the
timetable palette picker (already on home), folds push test buttons and
the anonymity detail into <details>, and shortens every explainer.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Build, deploy, integrated push

**Files:** none (operational).

**Interfaces:**
- Consumes: Tasks 1-4 committed; all other concurrent sessions confirmed done.
- Produces: deployed backend + frontend, `origin/main` updated with all sessions' work.

- [ ] **Step 1: Confirm every session is done**

Via `SendMessage`, collect an explicit "done + last commit hash" from each active peer session (`anytime-e1`, `anytime-ea`, plus any others touching this tree). Do not proceed until each has confirmed and its work is committed. Run `git status --porcelain` — expected: clean.

- [ ] **Step 2: Full frontend build**

```bash
npm run build
```

Expected: succeeds, `dist/` written, no unresolved imports.

- [ ] **Step 3: Syntax-check all touched functions**

```bash
node --check firebase/functions/src/board.js
node --check firebase/functions/index.js
node --check firebase/functions/src/admin/moderationActions.js
```

Expected: all pass.

- [ ] **Step 4: Deploy Cloud Functions**

```bash
firebase deploy --only functions --force
```

`--force` is required: the deploy detects `createShare`, `getSharedPost`, `shareImageOk` as removed and would otherwise prompt before deleting them (non-interactive = abort). Expected: deploy completes; the three functions are deleted; all others updated.

- [ ] **Step 5: Push to origin/main**

```bash
git push origin main
```

This is the integrated push — carries every session's commits. Cloudflare Pages is Git-connected ([[pages-deploy-model]]): the push triggers the production build automatically (`npm run build`, `VITE_` public config from `.env.production`).

- [ ] **Step 6: Verify the Pages deploy**

Watch the Cloudflare Pages build to green (dashboard or `wrangler pages deployment list --project-name=anytime`). Then load the production URL: home header has no 📋 / logout; `/profile` shows the new layout; open a board post → no 🔗 공유; visiting `/s/anything` falls back to home.

- [ ] **Step 7: Report**

Summarize to the user: what deployed, the Pages build status, and any follow-ups (orphaned `shareToken`/`shareEnabled` fields left in Firestore by design).

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| Ⅰ-1 frontend entry points | Task 2 (App/Post/Admin/InstallGate/AboutMocks), Task 3 (Home) |
| Ⅰ-2 libs / styles | Task 2 |
| Ⅰ-3 admin toggle | Task 2 Step 9 |
| Ⅰ-4 backend | Task 1 |
| Ⅰ-5 mocks | Task 2 Step 11 |
| Ⅰ-6 data (no migration) | Task 5 Step 7 (reported, not acted) |
| Ⅰ-7 keep-list | Global Constraints + Task 2 Steps 3,6 |
| Ⅱ logout → Profile | Task 3 (remove), Task 4 Step 6 (add) |
| Ⅲ-3 push copy + `<details>` | Task 4 Step 3 |
| Ⅲ-4 화면 테마 trim | Task 4 Step 4 |
| Ⅲ-5 palette removal | Task 4 Steps 1-2 |
| Ⅲ-6 anon `<details>` | Task 4 Step 5 |
| Ⅲ-7 계정 card | Task 4 Step 6 |
| Ⅲ-8 회원 탈퇴 trim | Task 4 Step 7 |
| Ⅲ-9 CSS (2 classes) | Task 4 Step 8 |
| Ⅳ verification | each task's verify step + Task 4 Step 9 manual |
| deploy + push | Task 5 |

No gaps.

**2. Placeholder scan:** No TBD/TODO. Every code step shows the exact before/after. Copy strings are final (not "trim later").

**3. Type consistency:** `stashPendingNav` removed / `consumePendingNav` kept — consistent across Task 2 Step 3 & Step 6 and Global Constraints. `logout` from `useAuthContext` — removed in Home (Task 3 Step 3), used in Profile where it is already destructured (Task 4 Step 6). `shareEnabled` removed in both backend (`getAppSetting`, Task 1 Step 5c) and frontend (`appInfo.js` + `Admin.jsx`, Task 2 Steps 7 & 9) — no reader left. New CSS classes `.anon-more` / `.account-test` defined in Task 4 Step 8 match their JSX use in Steps 3 & 5.
