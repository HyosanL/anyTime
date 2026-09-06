// App Check enforcement toggle for every onCall in this codebase.
//
// enforceAppCheck is deliberately NOT set via setGlobalOptions: firebase-functions
// resolves it from global as a fallback for onRequest too (see
// node_modules/firebase-functions/lib/v2/providers/https.js), which would 401 the
// two secret-gated onRequest endpoints (boardReferencedKeys, pushPrune) that cron
// and the Cloudflare push-fanout call with an X-Push-Secret header and no App
// Check token. So each onCall opts in explicitly through this helper.
//
// ENFORCE_APP_CHECK stays false until App Check console metrics confirm that
// effectively all real traffic carries a valid attestation — then it is flipped
// to true in a one-line commit (git history is the audit trail). See
// docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md.
const ENFORCE_APP_CHECK = false;

export function callable(extra = {}) {
  return { enforceAppCheck: ENFORCE_APP_CHECK, ...extra };
}
