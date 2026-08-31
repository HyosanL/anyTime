import { defineSecret } from 'firebase-functions/params';

// Bind to a Cloud Function via `secrets: [actorHashSalt]` in its options, then
// read the value at call-time inside the handler with `actorHashSalt.value()`
// (secret values are not available at module-load time).
export const actorHashSalt = defineSecret('ACTOR_HASH_SALT');
export const pushFanoutUrl = defineSecret('PUSH_FANOUT_URL');
export const pushFanoutSecret = defineSecret('PUSH_FANOUT_SECRET');
