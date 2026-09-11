import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('customer VPS production runtime loader', () => {
  it('loads the compiled gateway with the package-aware production launcher', () => {
    const root = process.cwd();
    const buildScript = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');
    const launcher = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-gateway'), 'utf8');
    const smokePath = join(root, 'scripts/smoke-gateway-production-loader.mjs');
    const smoke = readFileSync(smokePath, 'utf8');

    expect(launcher).toContain(
      '"$NODE_BIN" --import=tsx "$APP_DIR/packages/gateway/dist/main.js" &',
    );
    expect(buildScript).toContain(
      'node --import=tsx "$ROOT_DIR/scripts/smoke-gateway-production-loader.mjs"',
    );
    expect(smoke).toContain('await import("../packages/gateway/dist/server.js")');
    expect(smoke).toContain('await import("@matrix-os/terminal-runtime")');
    expect(smoke).toContain(
      'await import("@matrix-os/terminal-runtime/user-systemd-capacity")',
    );

    const build = spawnSync(
      'pnpm',
      ['--filter', '@matrix-os/gateway', 'build'],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    expect(build.status, build.stderr || build.stdout).toBe(0);

    const result = spawnSync('node', ['--import=tsx', smokePath], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 120_000);
});
