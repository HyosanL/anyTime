import { onMessagePublished } from 'firebase-functions/v2/pubsub';
import { db, FieldValue } from './lib/context.js';
import { pushFanoutUrl, pushFanoutSecret } from './lib/secrets.js';
import { adminPush } from './lib/adminNotify.js';

// Alert-only budget watchdog. A Cloud Billing budget publishes to the
// `billing-alerts` Pub/Sub topic at each threshold; this records the breach and
// pings admins. It deliberately does NOT touch function config — maxInstances:10
// (globalOptions.js) already bounds runaway cost, and auto-patching every
// function needs extra IAM/API surface for little gain. Manual response: set
// maxInstances to 1 in globalOptions.js and redeploy (see the hardening runbook).

export function parseBudgetAlert(pubsubData) {
  try {
    const json = JSON.parse(Buffer.from(pubsubData, 'base64').toString('utf8'));
    const costAmount = Number(json.costAmount);
    const budgetAmount = Number(json.budgetAmount);
    if (!Number.isFinite(costAmount) || !Number.isFinite(budgetAmount) || budgetAmount <= 0) return null;
    return {
      costAmount,
      budgetAmount,
      ratio: costAmount / budgetAmount,
      thresholds: json.alertThresholdExceeded ?? null,
    };
  } catch {
    return null;
  }
}

export const capBilling = onMessagePublished(
  { topic: 'billing-alerts', secrets: [pushFanoutUrl, pushFanoutSecret] },
  async (event) => {
    const alert = parseBudgetAlert(event.data?.message?.data ?? '');
    if (!alert) return;

    const opsRef = db.doc('config/ops');
    const prev = (await opsRef.get()).get('budgetRatio') ?? 0;
    await opsRef.set({
      budgetBreachedAt: FieldValue.serverTimestamp(),
      costAmount: alert.costAmount,
      budgetAmount: alert.budgetAmount,
      budgetRatio: alert.ratio,
    }, { merge: true });

    // Only push when crossing 0.9 upward — avoids spamming on every re-alert.
    if (alert.ratio >= 0.9 && prev < 0.9) {
      await adminPush(db, { fanoutUrl: pushFanoutUrl.value(), fanoutSecret: pushFanoutSecret.value() }, {
        kind: 'budget_alert',
        title: '⚠️ 클라우드 예산 경보',
        body: `사용액이 예산의 ${Math.round(alert.ratio * 100)}%에 도달했어요. 이상 트래픽인지 확인하세요.`,
      });
    }
  },
);
