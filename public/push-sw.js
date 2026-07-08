// 웹푸시 서비스워커 핸들러 — vite.config.js 의 workbox.importScripts 로 sw.js 에 포함된다.
// ⚠️ 이 파일만 바뀌면 sw.js 는 그대로라 설치된 SW 가 갱신을 못 알아챈다.
//    내용 수정 시 vite.config.js importScripts 의 파일명 쿼리(?v=N)를 올려줄 것.
/* eslint-env serviceworker */

// 앱(window)과 SW 가 공유하는 저장소 — SW 는 localStorage 를 못 읽으므로 Cache API 를 쓴다.
// · /watch-reasons: { [postId]: 'post'|'comment'|'watch' } — 이 기기가 글을 지켜보는 이유
//   (src/lib/push.js 가 watch 변경 때마다 미러링). 알림 문구의 "내가 쓴 글" 구분에 사용.
// · /dnd-config: { on, start, end } — 방해금지 시간(디바이스 시간 기준). src/lib/push.js
//   가 미러링. 창 안이면 알림을 소리·진동 없이 조용히(silent) 띄운다.
// · /pending-nav: 알림 클릭 목적지. openWindow 가 경로를 무시하는 플랫폼(iOS PWA 등)
//   대비 보험 — 앱이 부팅하면서 회수해 이동한다(App.jsx PushNavigator).
const META_CACHE = 'push-meta';

// 방해금지 기본값 — 설정 전 기기도 기본 켬(22:30~08:00). src/lib/push.js 의 DND_DEFAULT 와 일치.
const DND_DEFAULT = { on: true, start: '22:30', end: '08:00' };

async function watchReason(postId) {
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match('/watch-reasons');
    if (!r) return '';
    const m = await r.json();
    return (m && m[postId]) || '';
  } catch { return ''; }
}

// 방해금지 설정을 Cache 에서 읽는다. 아직 미러 전인 기기는 기본값(기본 켬)을 쓴다.
async function dndConfig() {
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match('/dnd-config');
    if (!r) return DND_DEFAULT;
    const cfg = await r.json();
    return cfg && typeof cfg === 'object' ? cfg : DND_DEFAULT;
  } catch { return DND_DEFAULT; }
}

// 'HH:MM' → 분(0~1439). 형식이 어긋나면 null.
function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return null;
  return (Number(m[1]) % 24) * 60 + (Number(m[2]) % 60);
}

// 지금(디바이스 로컬시간)이 방해금지 창 안인가. 자정을 넘는 창(22:30~08:00)도 처리.
function inQuietHours(cfg, now) {
  if (!cfg || !cfg.on) return false;
  const s = hhmmToMin(cfg.start), e = hhmmToMin(cfg.end);
  if (s == null || e == null || s === e) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
}

// HOT 알림 본문: 어느 게시판의 무슨 글인지 함께 — "[우주공학과] "이찬"" 형태.
function hotBody(msg) {
  const t = msg.title ? `"${msg.title}"` : '';
  return msg.board ? `[${msg.board}] ${t}`.trim() : t;
}

// 댓글·답글 알림 제목: 게시글 제목을 기준으로 "무슨 글의 무슨 알림"인지 드러낸다.
//  · 내가 쓴 "제목" 글에 댓글이 달렸어요 / 내가 쓴 "제목" 글의 댓글에 답글이 달렸어요
//  · 내가 댓글 단 "제목" 글에 … / (수동 벨) "제목" 글에 …
function commentTitle(kind, reason, title) {
  const short = title && title.length > 22 ? `${title.slice(0, 22)}…` : title;
  const t = short ? `"${short}" 글` : '글';
  const who = reason === 'post' ? '내가 쓴 ' : reason === 'comment' ? '내가 댓글 단 ' : '';
  return kind === 'reply'
    ? `💬 ${who}${t}의 댓글에 답글이 달렸어요`
    : `💬 ${who}${t}에 댓글이 달렸어요`;
}

// 알림 표시 본체 — 실제 push 와 테스트 메시지(TEST_PUSH)가 같은 경로를 타게 분리했다.
// 방해금지 silent 판정과 클릭 딥링크(data.path)가 어느 쪽이든 동일하게 적용된다.
async function showPush(msg) {
  // 목적지: msg.path(테스트에서 명시) 우선, 없으면 post_id 로 유도.
  const path = (typeof msg.path === 'string' && msg.path.startsWith('/'))
    ? msg.path
    : (msg.post_id ? `/board/post/${msg.post_id}` : '/');
  // 해당 글을 지금 보고 있는 창이 있으면 알림 생략
  // (댓글 단 직후 본인에게 돌아오는 알림도 대부분 이 경로로 걸러진다)
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (wins.some((c) => c.visibilityState === 'visible' && new URL(c.url).pathname === path)) return;
  const hot = msg.kind === 'hot';
  const reason = hot ? '' : await watchReason(String(msg.post_id || ''));
  const title = hot ? '🔥 인기글이 나왔어요' : commentTitle(msg.kind, reason, msg.title);
  // 방해금지 창(디바이스 시간 기준)이면 소리·진동 없이 알림센터로만 조용히 내려보낸다.
  // userVisibleOnly 규약상 알림 자체는 계속 띄운다(발송 억제 시 브라우저가 일반 알림을
  // 대신 띄우거나 구독을 회수할 수 있어, 억제 대신 '조용한 알림'으로 처리).
  const quiet = inQuietHours(await dndConfig(), new Date());
  const opts = {
    // 제목에 글제목이 들어가므로 본문은 HOT(제목 미포함)에만 채운다.
    body: hot ? hotBody(msg) : '',
    tag: `${msg.kind || 'push'}-${msg.post_id || ''}`,   // 같은 글 알림은 1개로 겹침
    icon: '/icons/icon.svg',
    data: { path },   // ← 클릭 이동 목적지. silent 여부와 무관하게 항상 실린다.
  };
  if (quiet) {
    // silent 와 vibrate 를 함께 주면 TypeError → 조용한 알림은 vibrate 를 넣지 않는다.
    opts.silent = true;
  } else {
    opts.renotify = true;
    // 진동 패턴 명시(Android 8 미만·일부 기기에서 알림을 '소리·진동' 등급으로 취급).
    // Android 8+ 의 팝업(헤드업) 여부는 사이트 알림 채널 중요도라 코드로 못 올린다.
    opts.vibrate = [180, 80, 180];
  }
  await self.registration.showNotification(title, opts);
}

self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { /* 형식 오류 무시 */ }
  event.waitUntil(showPush(msg));
});

// 실기기 테스트용: 앱(프로필 화면)이 보낸 가짜 푸시를 실제 push 와 동일한 경로로 표시한다.
// 방해금지 무음 판정·클릭 딥링크(data.path)가 그대로 검증된다(실제 서버 발송 없이).
self.addEventListener('message', (event) => {
  const d = event.data;
  if (d && d.type === 'TEST_PUSH') event.waitUntil(showPush(d.msg || {}));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || '/';
  event.waitUntil((async () => {
    // 콜드스타트 보험: 목적지를 캐시에 남긴다 — openWindow/navigate 가 경로를
    // 무시하는 플랫폼에서도 앱이 부팅하며 회수해 이동한다(3분 TTL, 1회성).
    try {
      const c = await caches.open(META_CACHE);
      await c.put('/pending-nav', new Response(JSON.stringify({ path, ts: Date.now() })));
    } catch { /* 캐시 실패 시 아래 직접 이동에 의존 */ }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // 앱이 이미 떠 있으면: 포커스 + 앱 내 라우터로 이동(postMessage → PushNavigator).
    // client.navigate() 는 WebAPK·삼성 인터넷에서 조용히 실패하는 사례가 있어 쓰지 않는다.
    // 포커스가 실패하는 창(동결·죽은 클라이언트)은 건너뛰고 openWindow 로 새로 연다 —
    // 새 문서가 위 pending-nav 를 회수해 이동한다(그래서 focus 와 postMessage 를 한 try 로 묶는다).
    for (const c of wins) {
      try {
        await c.focus();
        c.postMessage({ type: 'PUSH_NAV', path });
        return;
      } catch { /* 이 창은 포커스 불가 — 다음 창/openWindow 로 폴백 */ }
    }
    await self.clients.openWindow(path);
  })());
});

// 푸시서비스가 구독을 회전/만료시킨 경우 재구독(브라우저 지원 편차가 있어 보험 수준 —
// 주 복구 경로는 앱 실행 시 syncPush 의 재등록이다).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription || (await self.registration.pushManager.getSubscription());
      const key = old && old.options && old.options.applicationServerKey;
      if (!key) return;
      await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      // 서버 재등록은 다음 앱 실행 때 syncPush 가 수행(여기선 세션 토큰이 없다)
    } catch { /* 다음 앱 실행 때 복구 */ }
  })());
});
