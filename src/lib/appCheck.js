import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

// App Check attests that a Firebase call comes from the real app, not a script
// wielding the (public) API key. reCAPTCHA v3 runs invisibly, $0 unlimited.
//
// No key configured -> no-op: the code ships before the key exists, and the app
// keeps working (enforcement is off until the key is set AND the console toggle
// is flipped — see docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md).
export function initAppCheck(app) {
  const siteKey = import.meta.env.VITE_APPCHECK_RECAPTCHA_V3_KEY;
  if (!siteKey) return null;
  if (import.meta.env.DEV) {
    // Prints a debug token to the console on first run — register it under
    // Firebase console -> App Check -> Apps -> Manage debug tokens.
    self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
  try {
    return initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (e) {
    console.warn('[appCheck] init failed — continuing without attestation', e);
    return null;
  }
}
