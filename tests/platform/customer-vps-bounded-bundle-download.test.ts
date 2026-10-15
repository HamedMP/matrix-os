import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('bounded host bundle download native regressions', () => {
  it('passes all bounded download and Linux filesystem cases', () => {
    const testFile = join(
      process.cwd(),
      'tests/platform/customer-vps-bounded-bundle-download.test.mjs',
    );
    const result = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=tap', testFile],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 256 * 1024,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    if (process.platform === 'linux') {
      expect(result.stdout).toMatch(/# tests 12(?:\r?\n|$)/);
      expect(result.stdout).toMatch(/# pass 12(?:\r?\n|$)/);
      expect(result.stdout).toMatch(/# skipped 0(?:\r?\n|$)/);
    }
  }, 65_000);
});
