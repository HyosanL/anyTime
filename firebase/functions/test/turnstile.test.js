import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSkipTurnstile } from '../src/lib/turnstile.js';

test('skip when no secret configured', () => {
  assert.equal(shouldSkipTurnstile('', 'tok'), true);
});

test('skip when secret set but no token (client widget not deployed yet)', () => {
  assert.equal(shouldSkipTurnstile('secret', ''), true);
  assert.equal(shouldSkipTurnstile('secret', null), true);
});

test('skip when secret is the "pending" placeholder even with a token', () => {
  assert.equal(shouldSkipTurnstile('pending', 'tok'), true);
});

test('do not skip when a real secret and token are both present', () => {
  assert.equal(shouldSkipTurnstile('secret', 'tok'), false);
});
