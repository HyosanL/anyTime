import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipTurnstile, verifyTurnstile } from '../src/lib/turnstile.js';

test('skip when no secret / "pending" / no token', () => {
  assert.equal(shouldSkipTurnstile('', 'tok'), true);
  assert.equal(shouldSkipTurnstile('pending', 'tok'), true);
  assert.equal(shouldSkipTurnstile('realsecret', ''), true);
  assert.equal(shouldSkipTurnstile('realsecret', null), true);
});

test('do not skip when a real secret and a token are both present', () => {
  assert.equal(shouldSkipTurnstile('realsecret', 'tok'), false);
});

test('verifyTurnstile allows whenever it would skip', async () => {
  assert.equal(await verifyTurnstile('', 'tok'), true);
  assert.equal(await verifyTurnstile('realsecret', null), true);
});
