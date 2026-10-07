import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewSourceHash } from './preview-source-hash.mjs';

test('a shared default-app style correction changes source provenance without changing the app source tree', () => {
 const inputs = { sourceTree: 'unchanged-entrypoint', sharedStyle: 'old-shared-CSS', definition: 'same-manifest', adapter: 'same-adapter', packager: 'same-packager' };
 assert.notEqual(previewSourceHash(inputs), previewSourceHash({ ...inputs, sharedStyle: 'corrected-shared-CSS' }));
 assert.equal(previewSourceHash(inputs), previewSourceHash({ ...inputs }));
});
