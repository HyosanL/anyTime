import { supabase } from '../supabase';

// 웹푸시 클라이언트 — 익명성 원칙: 서버에 보내는 식별자는 endpoint(브라우저가 발급한
// 임의 URL)뿐이고, 계정(uid)과는 어디서도 연결하지 않는다. "내가 지켜보는 글"의
// 목록·이유(작성/댓글/수동)는 이 기기(localStorage)만 안다 — reactions.js 와 같은 패턴.
const ENABLED_KEY = 'push:enabled';   // '1' = 이 기기에서 푸시 켬
const WATCHED_KEY = 'push:watched';   // { [postId]: reason } — 벨 토글 UI 상태(서버 조회 안 함)
                                      // reason: 'post'(내가 쓴 글)|'comment'(내가 댓글 단 글)|'watch'(수동 벨)
                                      // 구버전 값 1 은 'watch' 로 취급.
const HOT_KEY = 'push:hot';           // '0' = HOT 방송 끔(기본 켬)

// SW 와 공유하는 저장소(SW 는 localStorage 접근 불가 → Cache API 로 미러).
// push-sw.js 의 META_CACHE 와 키가 맞아야 한다.
const META_CACHE = 'push-meta';

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
  await supabase.rpc('push_subscribe', {
    p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
  });
  if (localStorage.getItem(HOT_KEY) === '0') {
    await supabase.rpc('push_set_hot', { p_endpoint: j.endpoint, p_on: false });
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
    return 'ON';
  } catch {
    return 'ERROR';
  }
}

export async function disablePush() {
  try { localStorage.removeItem(ENABLED_KEY); } catch { /* 무시 */ }
  try {
    const sub = await getSubscription();
    if (sub) {
      await supabase.rpc('push_unsubscribe', { p_endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
  } catch { /* 이미 해지됐으면 무시 */ }
}

// 앱 시작 시 자가치유(로그인 후 1회) — 구독이 살아있으면 서버에 재업서트(서버 유실·
// endpoint 회전 복구), 권한은 있는데 구독이 사라졌으면 조용히 재구독(프롬프트 안 뜸).
// 앱/SW 업데이트로 구독이 끊기는 문제를 사용자의 다음 방문 시점으로 바운드한다.
export async function syncPush() {
  if (!pushEnabled()) return;
  mirrorReasons(watchedMap());   // 구버전에서 넘어온 기기도 이유 맵을 SW 쪽에 채워둔다
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
  await supabase.rpc('push_watch', { p_endpoint: sub.endpoint, p_post_id: Number(postId) });
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
  await supabase.rpc('push_unwatch', { p_endpoint: sub.endpoint, p_post_id: Number(postId) });
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

// ── HOT 방송 수신(기기별 설정) ───────────────────────────────────────
export function hotAlertsOn() { return localStorage.getItem(HOT_KEY) !== '0'; }
export async function setHotAlerts(on) {
  try { localStorage.setItem(HOT_KEY, on ? '1' : '0'); } catch { /* 무시 */ }
  const sub = await getSubscription();
  if (!sub) return;
  await supabase.rpc('push_set_hot', { p_endpoint: sub.endpoint, p_on: !!on });
}
