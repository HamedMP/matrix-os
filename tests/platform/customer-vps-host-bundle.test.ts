import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('customer VPS host bundle', () => {
  it('build script packages the systemd entrypoint binaries', () => {
    const root = process.cwd();
    const script = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');

    expect(script).toContain('matrix-host-bundle.tar.gz');
    expect(script).toContain('matrix-gateway');
    expect(script).toContain('matrix-shell');
    expect(script).toContain('matrix-code');
    expect(script).toContain('matrix-sync-agent');
    expect(script).toContain('sha256sum');
    expect(script).toContain('pnpm rebuild better-sqlite3 node-pty');
    expect(script).toContain('scripts/build-default-apps.mjs');
    expect(script).toContain('scripts/sync-matrix-agent-skills.sh');
    expect(script).toContain('scripts/host-bundle-release.mjs" write-release');
    expect(script).toContain('scripts/host-bundle-release.mjs" write-manifest');
    expect(script).toContain('bin app runtime release.json');
    expect(script).toContain('manifest.json');
    expect(script).toContain('release.json');
    expect(script).toContain('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY:?set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY before building the customer host bundle');
    expect(script).toContain('CODE_SERVER_VERSION="${HOST_BUNDLE_CODE_SERVER_VERSION:-4.116.0}"');
    expect(script).toContain('CODE_SERVER_URL="https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/${CODE_SERVER_ARCHIVE}"');
    expect(script).toContain('runtime/code-server');
    expect(script).toContain('/opt/matrix/runtime/code-server/bin/code-server "$@"');
    expect(script).toContain('chmod 0755 "$STAGE_DIR/bin/matrix-gateway"');
    expect(script).toContain('chmod -R g+rwX "$STAGE_DIR/runtime/node/lib/node_modules" "$STAGE_DIR/runtime/node/bin"');
    expect(script).toContain('find "$STAGE_DIR/runtime/node/lib/node_modules" "$STAGE_DIR/runtime/node/bin" -type d -exec chmod g+s {} +');
    expect(script).toContain('matrix-update');
  });

  it('update launcher triggers the sync agent update and rollback paths', () => {
    const root = process.cwd();
    const updater = readFileSync(join(root, 'distro/customer-vps/host-bin/matrix-update'), 'utf8');

    expect(updater).toContain('/opt/matrix/app/.update-available.json');
    expect(updater).toContain('touch /opt/matrix/app/.update-now');
    expect(updater).toContain('touch /opt/matrix/app/.rollback-now');
    expect(updater).toContain('journalctl -u matrix-sync-agent -f --no-pager -n 20');
    expect(updater).toContain('Usage: matrix-update [apply|rollback]');
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
    expect(launcher).toContain('/opt/matrix/app/node_modules/.bin');
    expect(launcher).toContain('export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:5432/${POSTGRES_DB}"');
    expect(launcher).toContain('sync_bundled_home_assets');
    expect(launcher).toContain('sync-matrix-agent-skills.sh');
    expect(launcher).toContain('MATRIX_SKILL_TARGETS=matrix,claude,codex');
    expect(launcher).toContain('$MATRIX_HOME/system/icons');
    expect(launcher).toContain('find "$bundled_home/apps" -type f -name matrix.json');
    expect(launcher).toContain('matrix.json package.json index.html vite.config.ts tsconfig.json src public dist .build-stamp');
    expect(launcher).toContain('cd "$APP_DIR"');
  });

  it('restore script resolves matrixctl from the installed host bin directory', () => {
    const root = process.cwd();
    const restore = readFileSync(join(root, 'distro/customer-vps/matrix-restore.sh'), 'utf8');

    expect(restore).toContain('/opt/matrix/bin/matrixctl r2 exists system/vps-meta.json');
    expect(restore).toContain('/opt/matrix/bin/matrixctl r2 get system/db/latest "$latest_file"');
  });
});
