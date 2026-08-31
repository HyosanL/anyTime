# Cloud Functions — conventions for this migration

Full architecture: `docs/superpowers/specs/2026-08-31-firebase-migration-design.md`.
Read it before writing any function — it has the full Firestore collection map
(§3), the anonymity/security redesign (§4), and the webhook/trigger mapping (§5).

## Runtime & style
- Node 22, ESM (`"type": "module"` — use `import`/`export`, no `require`).
- `firebase-functions/v2` only (`onCall`, `onRequest`, `onDocumentCreated`,
  `onDocumentUpdated`, `onSchedule` from their respective `firebase-functions/v2/*`
  entry points). Do not use v1 (`functions.https.onCall` etc).
- No comments explaining WHAT code does. Only comment non-obvious WHY (a ported
  invariant, a subtle Firestore limitation, a security reason) — this matches
  the rest of the codebase's style.
- Korean for user-facing error messages (`HttpsError` messages), English for
  code/identifiers, matching [[chat-korean-work-english]].

## Shared helpers (`src/lib/`) — use these, don't reinvent them
- `context.js` — `db` (Firestore), `auth` (Admin Auth), `FieldValue`, `Timestamp`,
  `requireAuth(request)` → uid or throws `unauthenticated`,
  `requireAdmin(request)` → uid or throws `permission-denied`, `invalid(msg)`.
  **Every onCall handler's first line must be `requireAuth(request)` or
  `requireAdmin(request)`** unless it's a deliberately-public function (signup) —
  if so, add a comment saying so explicitly. Cloud Functions onCall defaults to
  "any signed-in user may call this," the opposite of the old Postgres
  REVOKE-by-default model — there is no automatic backstop here.
- `secrets.js` — `actorHashSalt`, `pushFanoutUrl`, `pushFanoutSecret` (Secret
  Manager params). Bind via `{ secrets: [actorHashSalt] }` in the function's
  options object, read via `actorHashSalt.value()` inside the handler (never
  at module scope — the value isn't available until the function actually runs).
- `hash.js` — `actorHash(salt, uid, kind, targetId)` → hex string. Use as the
  **document ID** under a `reactions` subcollection for 1-reaction-per-person
  dedup (write to that doc ID; a second write from the same actor overwrites,
  it doesn't duplicate — check existence first if you need "already reacted"
  semantics rather than idempotent overwrite).
- `password.js` — `hashPassword(plain)` / `verifyPassword(plain, hash)`
  (bcryptjs). `hash === null` means "anyone can delete, no password required."
- `archive.js` — `archiveDeleted(tx, db, {type, origId, label, text,
  reportCount, reason, snapshot})` — call inside a `db.runTransaction()` right
  before hard-deleting content that breached a report threshold.
- `pushFanout.js` — `pushFanout(fanoutUrl, fanoutSecret, payload, targets)` —
  resolve target subscriptions from Firestore yourself (query
  `pushSubscriptions` or `adminPushSubscriptions`, batches handled internally),
  then call this with `payload = {kind, post_id, title, board, path, body}`
  matching `functions/api/push-fanout.js`'s existing contract exactly (that
  Cloudflare Pages Function is unchanged — do not modify it except where the
  migration plan says so for `push_prune`).

## Firestore conventions
- Timestamps: always `FieldValue.serverTimestamp()` on write, never client-supplied.
- Counters (`likeCount`, `commentCount`, `viewCount`, `postCount` on `/users/{uid}`):
  always `FieldValue.increment(n)`, never read-modify-write.
- Cross-document invariants (uniqueness, caps, overlap checks) that a Security
  Rule can't express: do the check-then-write inside `db.runTransaction()`,
  never a bare `.set()`/`.update()` — Rules already deny direct client writes
  to these paths, so the Cloud Function's transaction is the only integrity
  guarantee.
- Password hash fields live ONLY in `{doc}/_private/auth` (subcollection),
  never as a field on the public document — Rules deny all client access to
  `_private/*` unconditionally. Read/write it with `docRef.collection('_private').doc('auth')`.
- IDs: prefer natural composite keys as document IDs (e.g. `sections`:
  `${courseCode}_${year}_${term}_${sectionNo}`) over auto-IDs when the old
  schema had a meaningful composite/unique key — it gives you existence checks
  and dedup for free instead of needing a query.

## What NOT to do
- Don't add a generic "backend API" abstraction layer — port each RPC/trigger
  fairly literally into one exported Cloud Function, matching the design doc's
  collection map. Simplicity and traceability back to the old function name
  matters more than DRY here (each function is independently reviewable).
- Don't call `initializeApp()` — `context.js` already does it once.
- Don't introduce new client-facing features (realtime listeners, etc.) —
  design doc §10 explicitly scopes this migration to strict feature parity.
