import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
test('decorative artwork has the exact 4x2 sprite layout and landscape shape expected by the UI', () => {
  for (const [file, width, height] of [['matrix-app-objects-v1.png', 1774, 887], ['weather-coast-demo-v1.png', 1672, 941]]) {
    const bytes = readFileSync(new URL(`../public/${file}`, import.meta.url));
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(bytes.readUInt32BE(16), width);
    assert.equal(bytes.readUInt32BE(20), height);
    assert.ok(bytes.length < 4_000_000);
  }
});
