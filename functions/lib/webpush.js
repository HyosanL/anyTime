// Web Push 발송 공통 모듈 — RFC 8030(전송)·8291(aes128gcm 암호화)·8292(VAPID).
// WebCrypto 만 사용: Cloudflare Pages Functions(Workers)·Node 18+ 어디서든 동작.
// npm web-push 는 Node 전용이라 못 쓰고, Workers 용 서드파티는 구식 aesgcm 이라
// Apple 푸시서버(web.push.apple.com)가 거부 → 표준 aes128gcm 을 직접 구현했다.
// 정확성은 RFC 8291 Appendix A 공식 테스트 벡터로 바이트 단위 검증했다.

const te = new TextEncoder();

export function b64uToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...arrs) {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

// RFC 8291: 구독자의 p256dh(공개키)·auth(시크릿)로 평문을 aes128gcm 봉인.
// 반환 = 푸시서비스로 보낼 본문(헤더블록 ‖ 암호문). __test 는 RFC 벡터 검증용 키 주입.
export async function encryptPayload(p256dh, auth, plaintext, __test) {
  const uaPub = b64uToBytes(p256dh);          // 65B uncompressed P-256 point
  const authSecret = b64uToBytes(auth);       // 16B
  let asPriv, asPub;
  if (__test) {
    asPub = b64uToBytes(__test.asPublic);
    asPriv = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256', d: __test.asPrivate,
      x: bytesToB64u(asPub.slice(1, 33)), y: bytesToB64u(asPub.slice(33, 65)),
    }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  } else {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    asPriv = kp.privateKey;
    asPub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPriv, 256));
  const ikm = await hkdf(authSecret, ecdhSecret, concat(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = __test ? b64uToBytes(__test.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
  const record = concat(te.encode(plaintext), new Uint8Array([2]));   // 0x02 = 마지막 레코드 패딩 구분자
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));
  // 본문 헤더블록: salt(16) ‖ record size 4096(4B BE) ‖ keyid 길이(1B=65) ‖ AS 공개키(65B)
  return concat(salt, new Uint8Array([0, 0, 16, 0, asPub.length]), asPub, ciphertext);
}

// RFC 8292: VAPID Authorization 헤더. JWT 는 푸시서비스 origin 단위로 유효 →
// 같은 호출 안에서는 Map 캐시로 서명을 1회만 수행(FCM·Apple·Mozilla 각 1개).
export async function vapidAuthorization(endpoint, vapid, cache) {
  const aud = new URL(endpoint).origin;
  const hit = cache?.get(aud);
  if (hit) return hit;
  const pub = b64uToBytes(vapid.publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: vapid.privateKey,
    x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const enc = (o) => bytesToB64u(te.encode(JSON.stringify(o)));
  const input = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject,
  })}`;
  // WebCrypto ECDSA 서명은 raw r‖s(64B) — ES256 JWT 형식 그대로.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te.encode(input)));
  const value = `vapid t=${input}.${bytesToB64u(sig)}, k=${vapid.publicKey}`;
  cache?.set(aud, value);
  return value;
}

// 구독 1건에 발송. 반환 = HTTP status(201 접수 / 404·410 구독 사망 → 정리 대상).
export async function sendPush(target, data, { ttl = 86400, urgency = 'normal', topic } = {}, vapid, jwtCache) {
  const body = await encryptPayload(target.p256dh, target.auth, JSON.stringify(data));
  const headers = {
    Authorization: await vapidAuthorization(target.endpoint, vapid, jwtCache),
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
  };
  if (topic) headers.Topic = topic;   // 같은 topic 미전달분은 최신 것으로 대체(중복 알림 억제)
  const res = await fetch(target.endpoint, { method: 'POST', headers, body });
  try { await res.body?.cancel(); } catch { /* 본문 미사용 — 커넥션 반환만 */ }
  return res.status;
}
