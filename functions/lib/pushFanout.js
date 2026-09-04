// Calls the existing Cloudflare Pages Function `/api/push-fanout` (kept
// unchanged in contract — design doc §5). That endpoint does the actual Web
// Push send; here we only resolve *who* to notify from Firestore and hand it a
// batch of {endpoint, p256dh, auth} targets, gated by the shared X-Push-Secret
// header (same contract the old pg_net trigger used).
const MAX_BATCH = 30; // matches the old trigger's chunking, respects Workers sub-request cap

// opts.sync — ask push-fanout to run synchronously and echo back the
// push-service HTTP status per target ([{ endpoint, status }]). Used by
// sendSelfTestPush so the test button can report a dead/rejected subscription.
// Without it: fire-and-forget, returns undefined (unchanged for the callers in
// nextClass.js / board.js).
export async function pushFanout(fanoutUrl, fanoutSecret, payload, targets, { sync = false } = {}) {
  if (!targets.length) return sync ? [] : undefined;
  const results = [];
  for (let i = 0; i < targets.length; i += MAX_BATCH) {
    const batch = targets.slice(i, i + MAX_BATCH);
    try {
      const res = await fetch(fanoutUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Push-Secret': fanoutSecret },
        body: JSON.stringify({ ...payload, targets: batch, ...(sync ? { sync: true } : {}) }),
      });
      if (sync) {
        const data = await res.json().catch(() => null);
        if (data && Array.isArray(data.results)) results.push(...data.results);
        else batch.forEach((t) => results.push({ endpoint: t.endpoint, status: 0 }));
      }
    } catch (e) {
      // Fire-and-forget, same as the old pg_net trigger (errors swallowed —
      // a failed push must never fail the underlying write).
      console.error('[pushFanout] batch failed', e);
      if (sync) batch.forEach((t) => results.push({ endpoint: t.endpoint, status: 0 }));
    }
  }
  return sync ? results : undefined;
}
