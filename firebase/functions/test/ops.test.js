import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBudgetAlert } from '../src/ops.js';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

test('parses a Cloud Billing budget notification', () => {
  const r = parseBudgetAlert(enc({ costAmount: 4.5, budgetAmount: 5, alertThresholdExceeded: 0.9 }));
  assert.equal(r.costAmount, 4.5);
  assert.equal(r.budgetAmount, 5);
  assert.ok(Math.abs(r.ratio - 0.9) < 1e-9);
});

test('null on garbage', () => {
  assert.equal(parseBudgetAlert('not base64 json!!!'), null);
});

test('null when budgetAmount is 0 or missing', () => {
  assert.equal(parseBudgetAlert(enc({ costAmount: 1 })), null);
});
