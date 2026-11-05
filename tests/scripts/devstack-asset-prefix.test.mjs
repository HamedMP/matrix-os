import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDevstackAssetPrefix } from '../../shell/devstack-asset-prefix.mjs';

test('leaves ordinary and production builds unchanged', () => {
  assert.equal(resolveDevstackAssetPrefix(undefined, 'development'), undefined);
  assert.equal(resolveDevstackAssetPrefix('/vm/devstack-user/~runtime/alpha', 'production'), undefined);
});
test('binds Next static and HMR URLs to an exact runtime route', () => {
  assert.equal(resolveDevstackAssetPrefix('/vm/devstack-user/~runtime/alpha', 'development'), '/vm/devstack-user/~runtime/alpha');
});
test('rejects URL, wildcard and noncanonical routing paths in development', () => {
  for (const raw of ['https://other.test', '/vm/user', '/vm/user/~runtime/alpha/', '/vm/user/~runtime/../beta', '/vm/user/~runtime/alpha?x=1', '/vm/*/~runtime/alpha', '/vm/user/~runtime/' + 'a'.repeat(33)]) {
    assert.throws(() => resolveDevstackAssetPrefix(raw, 'development'), /MATRIX_DEVSTACK_ASSET_PREFIX/);
  }
});
