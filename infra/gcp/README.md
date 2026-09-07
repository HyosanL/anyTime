# GCP cost controls for anytime-rokafa

**Applied 2026-09-07 via the Cloud Billing Budget REST API:**
- Pub/Sub topic `projects/anytime-rokafa/topics/billing-alerts`
  (Cloud Billing auto-granted `billing-budget-alert@system.gserviceaccount.com`
  the publisher role on it).
- Budget "anytime monthly cap" — **₩15,000/month** (the billing account is KRW),
  thresholds 50 / 90 / 100 %, notifications → the topic.

`capBilling` (`firebase/functions/src/ops.js`) consumes the topic: records the
breach in `config/ops` and pushes admins at ≥ 90 %.

`budget.sh [USD]` is the gcloud equivalent, kept for reference / other machines.
Note it hardcodes USD — edit to your billing account's currency (KRW here).

**There is no hard spend cap on Blaze.** If `capBilling` fires: set `maxInstances`
to 1 in `firebase/functions/src/lib/globalOptions.js`, commit, let CI redeploy
(see the hardening runbook → "비상: 비용 폭주").
