import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The protected hosted refresh can select Ubuntu 26.04 even when PR CI uses 24.04.
// Exercise the actual browser installers without changing the host or downloading browsers.
describe('hosted E2E browser installation on Ubuntu 26.04', () => {
  it.each([
    ['terminal presentation', 'packages/mcp-browser/node_modules/playwright/cli.js'],
    ['shell Settings', 'shell/node_modules/@playwright/test/cli.js'],
  ])('%s supports Chromium dependencies', (_lane, cli) => {
    const result = spawnSync(process.execPath, [resolve(cli), 'install', '--with-deps', '--dry-run', 'chromium'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PLAYWRIGHT_HOST_PLATFORM_OVERRIDE: 'ubuntu26.04-x64' },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/cannot install dependencies|does not support chromium/i);
    expect(result.stdout).toContain('Install location:');
  });
});
