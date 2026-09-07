import { defineSecret } from 'firebase-functions/params';

// Own secret param (CONVENTIONS.md forbids editing lib/secrets.js). Bind via
// `secrets: [turnstileSecret]` on signup; read with `.value()` in the handler.
export const turnstileSecret = defineSecret('TURNSTILE_SECRET');

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Soft by design: Turnstile here is a speed bump + telemetry, not the wall
// (that's the signup code + geofence + App Check). We verify a token when the
// client sends one — catching real bots that fail the challenge — but a request
// with NO token is allowed through, so a widget/CDN failure never locks a real
// person out of the only way to join. `shouldSkipTurnstile` also short-circuits
// while the secret is unset or the `"pending"` placeholder (rollout hatch).
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
    console.error('[turnstile] siteverify failed — allowing', e);
    return true;
  }
}
