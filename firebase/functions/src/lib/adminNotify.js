import { pushFanout } from './pushFanout.js';

// Port of admin_push(): broadcasts to every admin's push subscription.
// Called synchronously from submitCorrection/reportReview/reportMemo/boardReact
// (design doc §5), never exposed as its own onCall.
export async function adminPush(db, { fanoutUrl, fanoutSecret }, { kind, title, body }) {
  const snap = await db.collection('adminPushSubscriptions').get();
  if (snap.empty) return;
  const targets = snap.docs.map((d) => ({
    endpoint: d.get('endpoint'),
    p256dh: d.get('p256dh'),
    auth: d.get('auth'),
  }));
  await pushFanout(fanoutUrl, fanoutSecret, { kind, title, body, path: '/admin/moderation' }, targets);
}
