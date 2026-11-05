import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The protected hosted refresh can select Ubuntu 26.04 even when PR CI uses 24.04.
// Exercise dependency selection without changing the host or downloading browsers.
describe('hosted E2E browser installation on Ubuntu 26.04', () => {
  it.each([
    ['terminal presentation', 'packages/mcp-browser/node_modules/playwright/cli.js'],
    ['shell Settings', 'shell/node_modules/@playwright/test/cli.js'],
  ])('%s selects Chromium dependencies', (_lane, cli) => {
    const result = spawnSync(process.execPath, [resolve(cli), 'install-deps', '--dry-run', 'chromium'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'ubuntu26.04-x64' },
    });

    expect(result.error).toBeUndefined();
    const output = `${result.stdout}\n${result.stderr}`;
    // The simulated host may lack packages from Ubuntu 26.04, so apt can exit 1.
    // Playwright 1.60.0 instead reports this unsupported platform and exits 0.
    expect(output).toContain('ubuntu26.04-x64');
    expect(output).not.toMatch(/cannot install dependencies for ubuntu26\.04-x64/i);
  });
});
