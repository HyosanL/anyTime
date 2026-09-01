import { callFn } from './functions';

// 웹푸시 클라이언트 — 익명성 원칙: 서버에 보내는 식별자는 endpoint(브라우저가 발급한
// 임의 URL)뿐이고, 계정(uid)과는 어디서도 연결하지 않는다. "내가 지켜보는 글"의
// 목록·이유(작성/댓글/수동)는 이 기기(localStorage)만 안다 — reactions.js 와 같은 패턴.
const ENABLED_KEY = 'push:enabled';   // '1' = 이 기기에서 푸시 켬
const WATCHED_KEY = 'push:watched';   // { [postId]: reason } — 벨 토글 UI 상태(서버 조회 안 함)
                                      // reason: 'post'(내가 쓴 글)|'comment'(내가 댓글 단 글)|'watch'(수동 벨)
                                      // 구버전 값 1 은 'watch' 로 취급.
const HOT_KEY = 'push:hot';           // '0' = HOT 방송 끔(기본 켬)
const DND_KEY = 'push:dnd';           // 방해금지 시간(디바이스 시간 기준). { on, start, end }

// SW 와 공유하는 저장소(SW 는 localStorage 접근 불가 → Cache API 로 미러).
// push-sw.js 의 META_CACHE 와 키가 맞아야 한다. (nextClass.js 도 /next-class-schedule 미러에 재사용)
export const META_CACHE = 'push-meta';

// 방해금지 기본값 — 요청대로 기본 켬(22:30~08:00). push-sw.js 의 DND_DEFAULT 와 일치시킬 것.
export const DND_DEFAULT = { on: true, start: '22:30', end: '08:00' };

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
export function pushEnabled() {
  return pushSupported() && Notification.permission === 'granted'
    && localStorage.getItem(ENABLED_KEY) === '1';
}

function b64uToU8(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function subscribe(reg) {
  return reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64uToU8(import.meta.env.VITE_VAPID_PUBLIC_KEY),
  });
}

async function registerToServer(sub) {
  const j = sub.toJSON();
  await callFn('pushSubscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
  if (localStorage.getItem(HOT_KEY) === '0') {
    await callFn('pushSetHot', { endpoint: j.endpoint, on: false });
  }
}

// 푸시 켜기 — 반드시 사용자 제스처(버튼 클릭)에서 호출(권한 프롬프트 정책).
// 반환: 'ON' | 'DENIED' | 'UNSUPPORTED' | 'ERROR'
export async function enablePush() {
  if (!pushSupported()) return 'UNSUPPORTED';
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return 'DENIED';
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await subscribe(reg));
    await registerToServer(sub);
    localStorage.setItem(ENABLED_KEY, '1');
    mirrorDnd(getDnd());   // 켜자마자 방해금지 설정을 SW(Cache)로 내려둔다
    return 'ON';
  } catch {
    return 'ERROR';
  }
}

export async function disablePush() {
  try { localStorage.removeItem(ENABLED_KEY); } catch { /* 무시 */ }
  // 구독이 지워지면 서버 nextClassAlerts 필드도 문서와 함께 사라진다 — 재업로드 서명을
  // 비워, 다시 켰을 때(같은 endpoint·같은 설정이어도) nextClass.js 가 재업로드하게 한다.
  try { localStorage.removeItem('nextclass:sig'); } catch { /* 무시 */ }
  try {
    const sub = await getSubscription();
    if (sub) {
      await callFn('pushUnsubscribe', { endpoint: sub.endpoint });
      await callFn('adminPushUnsubscribe', { endpoint: sub.endpoint }); // 관리자 구독도 정리(관리자 아니면 무해)
      await sub.unsubscribe();
    }
  } catch { /* 이미 해지됐으면 무시 */ }
}

// 관리자 기기 등록 — 수정제안·신고삭제·자동반영 알림 대상. 일반 구독(완전 익명)과 별도 표에
// uid 와 함께 저장한다(관리자 기기만). 관리자 전용 화면 진입 시 호출한다.
// adminPushSubscribe CF는 비관리자면 permission-denied 를 던지지만 callFn 이 그 실패를
// {ok:false}로 삼켜 여기선 무해하게 무시된다(옛 admin_push_subscribe() 의 조용한 no-op과 같은 결과).
export async function syncAdminPush() {
  if (!pushEnabled()) return;
  try {
    const sub = await getSubscription();
    if (!sub) return;
    const j = sub.toJSON();
    await callFn('adminPushSubscribe', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
  } catch { /* 오프라인 등 — 다음 진입 때 재시도 */ }
}

// 앱 시작 시 자가치유(로그인 후 1회) — 구독이 살아있으면 서버에 재업서트(서버 유실·
// endpoint 회전 복구), 권한은 있는데 구독이 사라졌으면 조용히 재구독(프롬프트 안 뜸).
// 앱/SW 업데이트로 구독이 끊기는 문제를 사용자의 다음 방문 시점으로 바운드한다.
export async function syncPush() {
  if (!pushEnabled()) return;
  mirrorReasons(watchedMap());   // 구버전에서 넘어온 기기도 이유 맵을 SW 쪽에 채워둔다
  mirrorDnd(getDnd());           // 방해금지 설정도 SW(Cache)로 미러 — 조용한 알림 판정에 사용
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await subscribe(reg));
    await registerToServer(sub);
  } catch { /* 오프라인 등 — 다음 실행 때 재시도 */ }
}

// ── 글 지켜보기(댓글 알림 단위) ──────────────────────────────────────
function watchedMap() {
  try { return JSON.parse(localStorage.getItem(WATCHED_KEY)) || {}; } catch { return {}; }
}
// SW 가 알림 문구("내가 쓴 글"/"내가 댓글 단 글")를 만들 수 있게 이유 맵을 미러링.
async function mirrorReasons(all) {
  try {
    const c = await caches.open(META_CACHE);
    await c.put('/watch-reasons', new Response(JSON.stringify(all)));
  } catch { /* 미러 실패 시 일반 문구로 표시될 뿐 — 무시 */ }
}
function saveWatched(all) {
  try { localStorage.setItem(WATCHED_KEY, JSON.stringify(all)); } catch { /* 무시 */ }
  mirrorReasons(all);
}
export function isWatched(postId) { return !!watchedMap()[postId]; }

// reason: 'post'(내가 쓴 글)|'comment'(내가 댓글 단 글)|'watch'(수동 벨)
export async function watchPost(postId, reason = 'watch') {
  const sub = await getSubscription();
  if (!sub) return;
  // postId 는 이제 Firestore 문서ID(문자열) — 옛 bigint 라 걸었던 Number() 변환은 버린다.
  await callFn('pushWatch', { endpoint: sub.endpoint, postId });
  const all = watchedMap();
  all[postId] = reason;
  saveWatched(all);
}

export async function unwatchPost(postId) {
  const all = watchedMap();
  delete all[postId];
  saveWatched(all);
  const sub = await getSubscription();
  if (!sub) return;
  await callFn('pushUnwatch', { endpoint: sub.endpoint, postId });
}

// ── 알림 클릭 딥링크 ─────────────────────────────────────────────────
// SW 가 notificationclick 때 캐시에 남긴 목적지를 회수(1회성). openWindow 가
// 경로를 무시하는 플랫폼에서도 앱 부팅 시 여기로 목적지가 전달된다.
export async function consumePendingNav() {
  if (!('caches' in window)) return null;
  try {
    const c = await caches.open(META_CACHE);
    const r = await c.match('/pending-nav');
    if (!r) return null;
    await c.delete('/pending-nav');
    const { path, ts } = await r.json();
    if (typeof path !== 'string' || !path.startsWith('/')) return null;
    if (!ts || Date.now() - ts > 3 * 60 * 1000) return null;  // 오래된 클릭은 무시
    return path;
  } catch { return null; }
}

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

// ── HOT 방송 수신(기기별 설정) ───────────────────────────────────────
export function hotAlertsOn() { return localStorage.getItem(HOT_KEY) !== '0'; }
export async function setHotAlerts(on) {
  try { localStorage.setItem(HOT_KEY, on ? '1' : '0'); } catch { /* 무시 */ }
  const sub = await getSubscription();
  if (!sub) return;
  await callFn('pushSetHot', { endpoint: sub.endpoint, on: !!on });
}

// ── 방해금지 시간(디바이스 시간 기준, 기기별 설정) ────────────────────
// 서버는 관여하지 않는다 — 창 판정·조용한 알림 처리는 전부 이 기기의 SW 가 한다
// (익명성 유지: 서버에 시간대·수면패턴 같은 정보를 남기지 않는다). SW 는 localStorage
// 를 못 읽으므로 Cache API(META_CACHE '/dnd-config')로 미러해 push 핸들러가 읽는다.
export function getDnd() {
  try {
    const v = JSON.parse(localStorage.getItem(DND_KEY));
    if (v && typeof v === 'object') return { ...DND_DEFAULT, ...v };
  } catch { /* 파싱 실패 → 기본값 */ }
  return { ...DND_DEFAULT };
}
async function mirrorDnd(cfg) {
  try {
    const c = await caches.open(META_CACHE);
    await c.put('/dnd-config', new Response(JSON.stringify(cfg)));
  } catch { /* 미러 실패 시 SW 는 자체 기본값(기본 켬)으로 폴백 — 무시 */ }
}
export async function setDnd(patch) {
  const next = { ...getDnd(), ...patch };
  try { localStorage.setItem(DND_KEY, JSON.stringify(next)); } catch { /* 무시 */ }
  await mirrorDnd(next);
  return next;
}

// 실기기 테스트: 실제 서버 발송 없이 SW 의 showPush 를 그대로 태워 알림을 띄운다.
// 방해금지 무음 판정과 클릭 딥링크(data.path)가 실제 푸시와 동일하게 검증된다.
// msg 예: { kind:'hot', title:'…', board:'…', path:'/board/hot' }
export async function sendTestPush(msg) {
  const reg = await navigator.serviceWorker.ready;
  const sw = reg.active || navigator.serviceWorker.controller;
  if (!sw) throw new Error('SW_NOT_READY');
  sw.postMessage({ type: 'TEST_PUSH', msg });
}
