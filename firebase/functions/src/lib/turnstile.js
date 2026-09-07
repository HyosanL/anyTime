import { defineSecret } from 'firebase-functions/params';

// Own secret param (CONVENTIONS.md forbids editing lib/secrets.js). Bind via
// `secrets: [turnstileSecret]` on signup; read with `.value()` in the handler.
export const turnstileSecret = defineSecret('TURNSTILE_SECRET');

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Soft mode: skip verification unless the secret is a real configured value AND
// the client actually sent a token. Lets the server-side check ship before the
// client widget exists, then tighten automatically once both are in place.
// `"pending"` is the placeholder set at deploy time before the real widget
// secret is known — treated as "not configured" so a stray token can't wedge signup.
export function shouldSkipTurnstile(secret, token) {
  return !secret || secret === 'pending' || !token;
}

export async function verifyTurnstile(secret, token, remoteIp) {
  if (shouldSkipTurnstile(secret, token)) return true;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch(SITEVERIFY, { method: 'POST', body });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    console.error('[turnstile] siteverify failed — allowing (fail-open on infra error)', e);
    return true;
  }
}
