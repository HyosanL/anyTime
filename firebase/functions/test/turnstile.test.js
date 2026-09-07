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

test('do not skip when both present', () => {
  assert.equal(shouldSkipTurnstile('secret', 'tok'), false);
});
