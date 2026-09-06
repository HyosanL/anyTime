import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateWindow, LIMITS } from '../src/lib/rateLimit.js';

const P = { limit: 3, windowMs: 1000 };

test('no doc -> reset', () => {
  assert.deepEqual(evaluateWindow(null, 5000, P), { action: 'reset' });
});

test('window elapsed -> reset', () => {
  assert.deepEqual(evaluateWindow({ count: 3, windowStartMs: 1000 }, 2000, P), { action: 'reset' });
});

test('inside window, under limit -> increment', () => {
  assert.deepEqual(evaluateWindow({ count: 2, windowStartMs: 1000 }, 1500, P), { action: 'increment' });
});

test('inside window, at limit -> reject', () => {
  assert.deepEqual(evaluateWindow({ count: 3, windowStartMs: 1000 }, 1500, P), { action: 'reject' });
});

test('every known action has a positive limit and window', () => {
  for (const [name, cfg] of Object.entries(LIMITS)) {
    assert.ok(cfg.limit > 0, `${name}.limit`);
    assert.ok(cfg.windowSec > 0, `${name}.windowSec`);
  }
});
