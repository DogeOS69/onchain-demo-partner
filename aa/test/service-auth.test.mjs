import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizedServiceRequest } from '../lib/service-auth.mjs';

test('a configured gateway token rejects missing, malformed and incorrect credentials', () => {
  const token = 'a'.repeat(64);
  for (const value of [undefined, [], [token], '', 'a'.repeat(63), 'b'.repeat(64)]) {
    assert.equal(authorizedServiceRequest(value, token), false);
  }
  assert.equal(authorizedServiceRequest(token, token), true);
});

test('existing private deployments can keep token authentication disabled', () => {
  assert.equal(authorizedServiceRequest(undefined, undefined), true);
});
