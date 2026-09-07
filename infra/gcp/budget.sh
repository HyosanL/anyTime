#!/usr/bin/env bash
# Cloud Billing budget + Pub/Sub alert wiring for anytime-rokafa.
# Prereqs: gcloud auth login; billing account admin; project = anytime-rokafa.
set -euo pipefail

PROJECT="anytime-rokafa"
TOPIC="billing-alerts"
BUDGET_AMOUNT="${1:-10}" # USD/month; override: ./budget.sh 20
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')"

echo "Billing account: $BILLING_ACCOUNT   Budget: \$$BUDGET_AMOUNT/mo"

gcloud pubsub topics create "$TOPIC" --project "$PROJECT" 2>/dev/null || echo "topic exists"

gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT" \
  --display-name="anytime monthly cap" \
  --budget-amount="${BUDGET_AMOUNT}USD" \
  --filter-projects="projects/$PROJECT" \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 \
  --all-updates-rule-pubsub-topic="projects/$PROJECT/topics/$TOPIC"

echo "Done. capBilling (Cloud Function) consumes projects/$PROJECT/topics/$TOPIC."
