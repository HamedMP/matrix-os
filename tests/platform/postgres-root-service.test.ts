import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const HELPER_GUARD = 'if [ -f /opt/matrix/bin/matrix-postgres-start ] && [ ! -L /opt/matrix/bin/matrix-postgres-start ] && [ -f /etc/systemd/system/matrix-postgres.service ]; then';

function cloudInitPostgresBlock(): string {
  const cloudInit = read('distro/customer-vps/cloud-init.yaml');
  const start = cloudInit.indexOf(`    ${HELPER_GUARD}`);
  expect(start).toBeGreaterThan(-1);
  const end = cloudInit.indexOf('\n    fi\n', start);
  expect(end).toBeGreaterThan(start);
  return cloudInit
    .slice(start, end + '\n    fi\n'.length)
    .split('\n')
    .map((line) => line.replace(/^ {4}/, ''))
    .join('\n')
    .replaceAll('/opt/matrix/', '$TEST_ROOT/opt/matrix/')
    .replaceAll('/etc/systemd/system/', '$TEST_ROOT/etc/systemd/system/')
    .replaceAll('/usr/local/libexec', '$TEST_ROOT/libexec');
}

function runCloudInitPostgresBlock(options: { helper: boolean; unit: boolean }) {
  const testRoot = mkdtempSync(join(tmpdir(), 'matrix-postgres-cloud-init-'));
  mkdirSync(join(testRoot, 'opt/matrix/bin'), { recursive: true });
  mkdirSync(join(testRoot, 'etc/systemd/system'), { recursive: true });
  if (options.helper) writeFileSync(join(testRoot, 'opt/matrix/bin/matrix-postgres-start'), '#!/bin/sh\n');
  if (options.unit) writeFileSync(join(testRoot, 'etc/systemd/system/matrix-postgres.service'), '[Unit]\n');
  const stubs = `
set -eu
calls="$TEST_ROOT/calls"
chmod() { printf 'chmod %s\\n' "$*" >>"$calls"; }
install() { printf 'install %s\\n' "$*" >>"$calls"; }
systemctl() { printf 'systemctl %s\\n' "$*" >>"$calls"; }
docker() { printf 'docker %s\\n' "$*" >>"$calls"; }
`;
  try {
    const result = spawnSync('bash', ['-c', `${stubs}\n${cloudInitPostgresBlock()}`], {
      encoding: 'utf8',
      env: { ...process.env, TEST_ROOT: testRoot },
    });
    const calls = existsSync(join(testRoot, 'calls')) ? readFileSync(join(testRoot, 'calls'), 'utf8') : '';
    return { result, calls };
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

function syncAgentHarnessSource(): string {
  const syncAgent = read('distro/customer-vps/host-bin/matrix-sync-agent');
  const recoveryLibrary = read('distro/customer-vps/host-bin/matrix-sync-agent-recovery');
  return syncAgent
    .slice(0, syncAgent.indexOf('# ── Main loop'))
    .replace('source /opt/matrix/env/host.env', ':')
    .replace(
      /# BEGIN update recovery library loader[\s\S]*?# END update recovery library loader/,
      recoveryLibrary,
    )
    .replace('readonly APP_DIR="/opt/matrix/app"', 'readonly APP_DIR="$TEST_ROOT/app"')
    .replace('readonly STAGING_DIR="/opt/matrix/staging"', 'readonly STAGING_DIR="$TEST_ROOT/staging"')
    .replace('readonly BIN_DIR="/opt/matrix/bin"', 'readonly BIN_DIR="$TEST_ROOT/bin"')
    .replace('readonly PROTECTED_LIBEXEC_DIR="/usr/local/libexec"', 'readonly PROTECTED_LIBEXEC_DIR="$TEST_ROOT/libexec"')
    .replace(
      'readonly POSTGRES_ROOT_UNIT="/etc/systemd/system/matrix-postgres.service"',
      'readonly POSTGRES_ROOT_UNIT="$TEST_ROOT/matrix-postgres.service"',
    );
}

function runPostgresRootServiceReconcile(options: {
  unit: boolean;
  bundleHelper: boolean;
  protectedHelper?: 'absent' | 'file' | 'symlink';
}) {
  const testRoot = mkdtempSync(join(tmpdir(), 'matrix-postgres-reconcile-'));
  mkdirSync(join(testRoot, 'bin'), { recursive: true });
  mkdirSync(join(testRoot, 'libexec'), { recursive: true });
  if (options.unit) writeFileSync(join(testRoot, 'matrix-postgres.service'), '[Unit]\n');
  if (options.bundleHelper) {
    writeFileSync(join(testRoot, 'bin/matrix-postgres-start'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(testRoot, 'bin/matrix-postgres-start'), 0o644);
  }
  const protectedHelper = join(testRoot, 'libexec/matrix-postgres-start');
  if (options.protectedHelper === 'file') writeFileSync(protectedHelper, '#!/bin/sh\nexit 7\n');
  if (options.protectedHelper === 'symlink') symlinkSync(join(testRoot, 'bin/matrix-postgres-start'), protectedHelper);
  const invocation = `
sudo() {
  local args=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o|-g) shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  printf 'sudo %s\\n' "\${args[*]}" >>"$TEST_ROOT/calls"
  [ "\${args[0]}" = systemctl ] && return 0
  "\${args[@]}"
}
reconcile_postgres_root_service
`;
  try {
    const result = spawnSync('bash', ['-c', `${syncAgentHarnessSource()}\n${invocation}`], {
      encoding: 'utf8',
      env: { ...process.env, TEST_ROOT: testRoot },
    });
    const calls = existsSync(join(testRoot, 'calls')) ? readFileSync(join(testRoot, 'calls'), 'utf8') : '';
    const helperExists = existsSync(protectedHelper);
    const helper = helperExists && options.protectedHelper !== 'symlink' ? readFileSync(protectedHelper, 'utf8') : '';
    const helperMode = helperExists && options.protectedHelper !== 'symlink' ? statSync(protectedHelper).mode & 0o777 : 0;
    return { result, calls, helper, helperMode };
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}

describe('customer VPS PostgreSQL privilege boundary', () => {
  it('starts the fixed PostgreSQL container through a root system service', () => {
    const unit = read('distro/customer-vps/systemd/matrix-postgres.service');
    expect(unit).toContain('User=root');
    expect(unit).toContain('ExecStart=/usr/local/libexec/matrix-postgres-start');
    expect(unit).toContain('Requires=docker.service');
    expect(unit).not.toContain('RemainAfterExit=yes');
    const helper = read('distro/customer-vps/host-bin/matrix-postgres-start');
    expect(helper).toContain('matrix-postgres');
    expect(helper).toContain('127.0.0.1:5432:5432');
  });

  it('runs the owner-scoped restore only after the root service, without Docker access', () => {
    const unit = read('distro/customer-vps/systemd/matrix-restore.service');
    expect(unit).toContain('User=matrix');
    expect(unit).toContain('Requires=matrix-postgres.service');
    expect(unit).toContain('After=matrix-postgres.service');
    expect(read('distro/customer-vps/host-bin/matrix-restore.sh')).not.toMatch(/\bdocker\s+(?:ps|start|run|volume)\b/);
  });

  it('wires first boot and golden snapshot activation to the new service', () => {
    const cloudInit = read('distro/customer-vps/cloud-init.yaml');
    expect(cloudInit).toContain('/usr/local/libexec/matrix-postgres-start');
    expect(cloudInit).toContain('systemctl start matrix-postgres.service');
    expect(cloudInit).not.toMatch(/for required_bin in [^;]*matrix-postgres-start/);
    // The inline restore unit applies only to bundles without shipped units,
    // which also predate the root service; shipped units replace it otherwise.
    const inlineRestoreUnit = cloudInit.slice(
      cloudInit.indexOf('path: /etc/systemd/system/matrix-restore.service'),
      cloudInit.indexOf('path: /etc/systemd/system/matrix-gateway.service'),
    );
    expect(inlineRestoreUnit).toContain('Requires=docker.service');
    expect(inlineRestoreUnit).not.toContain('matrix-postgres.service');
    const golden = read('distro/customer-vps/host-bin/matrix-golden-snapshot-activate');
    expect(golden).toContain('/usr/local/libexec/matrix-postgres-start');
    expect(golden).toContain('matrix-postgres.service.d/golden.conf');
    expect(golden).toContain('matrix-postgres.service matrix-restore.service');
  });

  it('backs up the protected helper when an update replaces it and restores it on rollback', () => {
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    expect(updater).toContain('record_update_file /usr/local/libexec/matrix-postgres-start postgres-helper');
    expect(updater).toContain('restore_update_file /usr/local/libexec/matrix-postgres-start postgres-helper');
    expect(updater).toContain('install -o root -g root -m 0755 "$source_dir/matrix-postgres-start"');
    expect(updater).toContain('if [ -f "$UPDATE_TRANSACTION_DIR/postgres-helper.present" ] || [ -f "$UPDATE_TRANSACTION_DIR/postgres-helper.missing" ]; then');
  });

  it('starts PostgreSQL through the root service when the bundle ships the helper', () => {
    const { result, calls } = runCloudInitPostgresBlock({ helper: true, unit: true });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toMatch(/install -o root -g root -m 0755 \S+\/opt\/matrix\/bin\/matrix-postgres-start \S+\/libexec\/matrix-postgres-start/);
    expect(calls).toContain('systemctl start matrix-postgres.service');
    expect(calls).not.toContain('docker ');
  });

  it('keeps first boot working for bundles without the PostgreSQL helper', () => {
    const { result, calls } = runCloudInitPostgresBlock({ helper: false, unit: false });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).not.toContain('matrix-postgres-start');
    expect(calls).not.toContain('systemctl start matrix-postgres.service');
    expect(calls).toContain('docker volume create matrix-postgres');
    expect(calls).toContain('docker run -d --name matrix-postgres --restart unless-stopped');
  });

  it('falls back to inline startup when the helper ships without its unit', () => {
    const { result, calls } = runCloudInitPostgresBlock({ helper: true, unit: false });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).not.toContain('systemctl start matrix-postgres.service');
    expect(calls).toContain('docker run -d');
  });

  it('installs the protected helper and starts PostgreSQL after a legacy updater installed the unit', () => {
    const { result, calls, helper, helperMode } = runPostgresRootServiceReconcile({ unit: true, bundleHelper: true });
    expect(result.status, result.stderr).toBe(0);
    expect(helper).toBe('#!/bin/sh\nexit 0\n');
    expect(helperMode).toBe(0o755);
    expect(calls).toContain('sudo systemctl start --no-block matrix-postgres.service');
  });

  it('leaves an installed protected helper to the update transaction', () => {
    const { result, calls, helper } = runPostgresRootServiceReconcile({ unit: true, bundleHelper: true, protectedHelper: 'file' });
    expect(result.status, result.stderr).toBe(0);
    expect(helper).toBe('#!/bin/sh\nexit 7\n');
    expect(calls).toBe('');
  });

  it('does nothing on releases without the root PostgreSQL unit', () => {
    const { result, calls } = runPostgresRootServiceReconcile({ unit: false, bundleHelper: true });
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toBe('');
  });

  it('refuses a symlinked protected helper destination', () => {
    const { result, calls } = runPostgresRootServiceReconcile({ unit: true, bundleHelper: true, protectedHelper: 'symlink' });
    expect(result.status).not.toBe(0);
    expect(calls).not.toContain('systemctl');
  });

  it('reconciles the protected helper at sync agent startup after interrupted-update recovery', () => {
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    const main = updater.slice(updater.indexOf('# ── Main loop'));
    expect(main.indexOf('reconcile_postgres_root_service')).toBeGreaterThan(main.indexOf('recover_interrupted_update'));
    expect(main.indexOf('reconcile_postgres_root_service')).toBeLessThan(main.indexOf('while true; do'));
  });
});
