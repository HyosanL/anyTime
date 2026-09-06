import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isYoung } from '../src/lib/accountAge.js';

const DAY = 24 * 60 * 60 * 1000;

test('legacy account (no createdAt) is not young', () => {
  assert.equal(isYoung(0, 1_000_000), false);
  assert.equal(isYoung(undefined, 1_000_000), false);
});

test('account created 1h ago is young', () => {
  const now = 100 * DAY;
  assert.equal(isYoung(now - 3600_000, now), true);
});

test('account created 25h ago is not young', () => {
  const now = 100 * DAY;
  assert.equal(isYoung(now - 25 * 3600_000, now), false);
});
