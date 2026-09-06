import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callable } from '../src/lib/opts.js';

test('callable() carries the enforce flag and it is false in the plan baseline', () => {
  assert.equal(callable().enforceAppCheck, false);
});

test('callable() merges extra options and extra wins on conflict', () => {
  const o = callable({ secrets: ['A'], region: 'asia-northeast3' });
  assert.deepEqual(o.secrets, ['A']);
  assert.equal(o.region, 'asia-northeast3');
  assert.equal(o.enforceAppCheck, false);
});
