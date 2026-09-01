import test from 'node:test';
import assert from 'node:assert/strict';
import { safeJson } from './types';

test('redacts tokens, credentials and authorization values from snapshots', () => {
  const serialized = safeJson({
    apiToken: 'secret-token',
    tunnelToken: 'tunnel-secret',
    headers: { Authorization: 'Bearer abc.def.ghi', Cookie: 'session=x' },
    privateKey: 'pem',
    safe: 'resource-id',
  });
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('Bearer abc'), false);
  assert.equal(serialized.includes('session=x'), false);
  assert.equal(serialized.includes('pem'), false);
  assert.equal(serialized.includes('resource-id'), true);
});
