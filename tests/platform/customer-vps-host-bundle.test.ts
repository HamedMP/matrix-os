import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('customer VPS host bundle', () => {
  it('build script packages the three systemd entrypoint binaries', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');

    expect(script).toContain('matrix-host-bundle.tar.gz');
    expect(script).toContain('matrix-gateway');
    expect(script).toContain('matrix-shell');
    expect(script).toContain('matrix-sync-agent');
    expect(script).toContain('sha256sum');
    expect(script).toContain('pnpm rebuild better-sqlite3 node-pty');
  });

  it('gateway launcher performs the customer VPS registration callback', () => {
    const root = process.cwd();
    const launcher = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-gateway'), 'utf8');

    expect(launcher).toContain('MATRIX_PLATFORM_REGISTER_URL');
    expect(launcher).toContain('/hetzner/v1/metadata/instance-id');
    expect(launcher).toContain('/hetzner/v1/metadata/public-ipv4');
    expect(launcher).toContain('/vps/register');
    expect(launcher).toContain('curl --fail --silent --show-error --max-time 10');
    expect(launcher).toContain('MATRIX_REGISTRATION_TOKEN');
    expect(launcher).toContain('cd "$APP_DIR"');
  });

  it('restore script resolves matrixctl from the installed host bin directory', () => {
    const root = process.cwd();
    const restore = readFileSync(join(root, 'distro/customer-vps/matrix-restore.sh'), 'utf8');

    expect(restore).toContain('/opt/matrix/bin/matrixctl r2 exists system/vps-meta.json');
    expect(restore).toContain('/opt/matrix/bin/matrixctl r2 get system/db/latest "$latest_file"');
  });
});
