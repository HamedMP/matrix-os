import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Keep the dependency-free command usable directly while collecting its real
// filesystem regressions in the repository's normal Vitest/CI lane as well.
it('runs every source-qualification initialization regression without skips', () => {
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap',
    resolve('tests/scripts/devstack-qualification.node-test.mjs'),
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^# tests 4$/m);
  expect(result.stdout).toMatch(/^# pass 4$/m);
  expect(result.stdout).toMatch(/^# fail 0$/m);
  expect(result.stdout).toMatch(/^# skipped 0$/m);
}, 35_000);
