# GCP cost controls for anytime-rokafa

`budget.sh [USD]` creates the `billing-alerts` Pub/Sub topic and a monthly
budget ($10 default) with alerts at 50 / 90 / 100 %, published to that topic.
The `capBilling` Cloud Function (`firebase/functions/src/ops.js`) consumes it:
it records the breach in `config/ops` and pushes admins at ≥ 90 %.

**There is no hard spend cap on Blaze** (which this project is on only because
Cloud Functions v2 requires it). If `capBilling` fires, the manual response is
in `docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md` → "비상: 비용 폭주":
set `maxInstances` to 1 in `firebase/functions/src/lib/globalOptions.js`, commit,
let CI redeploy.

Create the `billing-alerts` topic **before** merging `hardening/capbilling` to
`main`, or that CI deploy fails (the function binds the topic). Console works
too — see `docs/runbooks/2026-09-07-abuse-dos-hardening-runbook.md` §3.
