// Calls the existing Cloudflare Pages Function `/api/push-fanout` (kept
// unchanged — design doc §5). That endpoint does the actual Web Push send;
// here we only resolve *who* to notify from Firestore and hand it a batch of
// {endpoint, p256dh, auth} targets, gated by the shared X-Push-Secret header
// (same contract the old pg_net trigger used).
const MAX_BATCH = 30; // matches the old trigger's chunking, respects Workers sub-request cap

export async function pushFanout(fanoutUrl, fanoutSecret, payload, targets) {
  if (!targets.length) return;
  for (let i = 0; i < targets.length; i += MAX_BATCH) {
    const batch = targets.slice(i, i + MAX_BATCH);
    try {
      await fetch(fanoutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Push-Secret': fanoutSecret },
        body: JSON.stringify({ ...payload, targets: batch }),
      });
    } catch (e) {
      // Fire-and-forget, same as the old pg_net trigger (errors swallowed —
      // a failed push must never fail the underlying write).
      console.error('[pushFanout] batch failed', e);
    }
  }
}
