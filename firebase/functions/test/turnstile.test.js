import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipTurnstile, verifyTurnstile } from '../src/lib/turnstile.js';

test('shouldSkipTurnstile: off when secret unset or "pending"', () => {
  assert.equal(shouldSkipTurnstile(''), true);
  assert.equal(shouldSkipTurnstile(undefined), true);
  assert.equal(shouldSkipTurnstile('pending'), true);
});

test('shouldSkipTurnstile: on when a real secret is set', () => {
  assert.equal(shouldSkipTurnstile('0x4AAA...real'), false);
});

test('verifyTurnstile: skips (allows) while off', async () => {
  assert.equal(await verifyTurnstile('', 'anything'), true);
  assert.equal(await verifyTurnstile('pending', null), true);
});

test('verifyTurnstile: real secret + no token -> reject', async () => {
  assert.equal(await verifyTurnstile('realsecret', null), false);
  assert.equal(await verifyTurnstile('realsecret', ''), false);
});
