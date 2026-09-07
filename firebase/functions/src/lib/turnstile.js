import { defineSecret } from 'firebase-functions/params';

// Own secret param (CONVENTIONS.md forbids editing lib/secrets.js). Bind via
// `secrets: [turnstileSecret]` on signup; read with `.value()` in the handler.
export const turnstileSecret = defineSecret('TURNSTILE_SECRET');

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Turnstile is "off" (rollout escape hatch) when the secret is unset or still
// the `"pending"` placeholder. Once a real secret is set, verification is HARD:
// a signup with no token, or a bad token, is rejected (the client always renders
// the widget and blocks submit until it has a token).
export function shouldSkipTurnstile(secret) {
  return !secret || secret === 'pending';
}

export async function verifyTurnstile(secret, token, remoteIp) {
  if (shouldSkipTurnstile(secret)) return true;
  if (!token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);
    const res = await fetch(SITEVERIFY, { method: 'POST', body });
    const data = await res.json();
    return data.success === true;
  } catch (e) {
    // siteverify unreachable — fail OPEN (an infra blip must not block all
    // signups). The signup-code + geofence + App Check gates still apply.
    console.error('[turnstile] siteverify failed — allowing', e);
    return true;
  }
}
