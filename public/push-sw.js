// 웹푸시 서비스워커 핸들러 — vite.config.js 의 workbox.importScripts 로 sw.js 에 포함된다.
// ⚠️ 이 파일만 바뀌면 sw.js 는 그대로라 설치된 SW 가 갱신을 못 알아챈다.
//    내용 수정 시 vite.config.js importScripts 의 파일명 쿼리(?v=N)를 올려줄 것.
/* eslint-env serviceworker */

self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch { /* 형식 오류 무시 */ }
  event.waitUntil((async () => {
    const path = msg.post_id ? `/board/post/${msg.post_id}` : '/';
    // 해당 글을 지금 보고 있는 창이 있으면 알림 생략
    // (댓글 단 직후 본인에게 돌아오는 알림도 대부분 이 경로로 걸러진다)
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.some((c) => c.visibilityState === 'visible' && new URL(c.url).pathname === path)) return;
    const hot = msg.kind === 'hot';
    await self.registration.showNotification(hot ? '🔥 인기글이 나왔어요' : '💬 새 댓글이 달렸어요', {
      body: msg.title ? `"${msg.title}"` : '',
      tag: `${msg.kind || 'push'}-${msg.post_id || ''}`,   // 같은 글 알림은 1개로 겹침
      renotify: true,
      icon: '/icons/icon.svg',
      data: { path },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.path) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of wins) {
      try { await c.focus(); await c.navigate(path); return; } catch { /* 다음 창 시도 */ }
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
