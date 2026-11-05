import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAllowedDevOrigins } from '../../shell/dev-origins.mjs';

const defaults = ['staging.matrix-os.com', 'dev.matrix-os.com', 'localhost', '127.0.0.1'];
test('preserves defaults for unset and empty input', () => {
  for (const raw of [undefined, '', '   ']) assert.deepEqual(resolveAllowedDevOrigins(raw), defaults);
});
test('appends scoped hostnames and collapses duplicates', () => {
  assert.deepEqual(resolveAllowedDevOrigins(' app.local.matrix.test,localhost,APP.local.matrix.test '), [...defaults, 'app.local.matrix.test']);
});
test('rejects unsafe or malformed hostnames', () => {
  for (const raw of ['*.matrix.test', 'https://app.matrix.test', 'app.matrix.test:443', 'app.matrix.test/path', 'app .test', 'bad_label.test', '-bad.test', 'bad-.test', 'a..test', 'a.'.repeat(127) + 'a', 'a'.repeat(64) + '.test', 'a.test,,b.test']) {
    assert.throws(() => resolveAllowedDevOrigins(raw), /MATRIX_ALLOWED_DEV_ORIGINS/);
  }
});
test('accepts 32 additional entries and rejects 33', () => {
  const entries = Array.from({ length: 32 }, (_, i) => `app-${i}.test`);
  assert.equal(resolveAllowedDevOrigins(entries.join(',')).length, 36);
  assert.throws(() => resolveAllowedDevOrigins([...entries, 'extra.test'].join(',')), /MATRIX_ALLOWED_DEV_ORIGINS/);
});
