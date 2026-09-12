import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SYNC_AGENT_PATH = 'distro/customer-vps/host-bin/matrix-sync-agent';
const RECOVERY_LIBRARY_PATH = 'distro/customer-vps/host-bin/matrix-sync-agent-recovery';

function syncAgentHarnessSource(): string {
  const root = process.cwd();
  const syncAgent = readFileSync(join(root, SYNC_AGENT_PATH), 'utf8');
  const recoveryLibrary = readFileSync(join(root, RECOVERY_LIBRARY_PATH), 'utf8');
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
    .replace('readonly RELEASE_FILE="/opt/matrix/release.json"', 'readonly RELEASE_FILE="$TEST_ROOT/release.json"')
    .replace(
      'readonly RELEASE_ROLLBACK_FILE="/opt/matrix/release.json.rollback"',
      'readonly RELEASE_ROLLBACK_FILE="$TEST_ROOT/release.json.rollback"',
    )
    .replace(
      'readonly TERMINAL_RUNTIME_ROOT="/opt/matrix/terminal-runtime"',
      'readonly TERMINAL_RUNTIME_ROOT="$TEST_ROOT/terminal-runtime"',
    );
}

function runInterruptedLegacyUpdateRecovery(options: {
  installedReleaseVersion: string;
  rollbackAppVersion: string;
  rollbackStatus?: number;
}) {
  const root = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'matrix-interrupted-update-'));
  const appDir = join(tempDir, 'app');
  const rollbackDir = `${appDir}.rollback`;
  const stagingDir = join(tempDir, 'staging');
  mkdirSync(appDir, { recursive: true });
  mkdirSync(rollbackDir, { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(appDir, 'BUNDLE_VERSION'), 'v2026.09.11-pr-test\n');
  writeFileSync(join(rollbackDir, 'BUNDLE_VERSION'), `${options.rollbackAppVersion}\n`);
  writeFileSync(
    join(tempDir, 'release.json'),
    `${JSON.stringify({ version: options.installedReleaseVersion })}\n`,
  );
  writeFileSync(join(stagingDir, 'update-phase'), 'health\n');

  const invocation = `
do_rollback() { printf 'rollback:%s\\n' "${'$'}{1:-true}"; return "${'$'}{ROLLBACK_STATUS:-0}"; }
write_update_error() { printf 'error:%s:%s\\n' "${'$'}1" "${'$'}{3:-}"; }
recover_interrupted_update
`;

  try {
    return spawnSync('bash', ['-c', `${syncAgentHarnessSource()}\n${invocation}`], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        TEST_ROOT: tempDir,
        ROLLBACK_STATUS: String(options.rollbackStatus ?? 0),
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runLegacyManualRollback() {
  const root = process.cwd();
  const tempDir = mkdtempSync(join(tmpdir(), 'matrix-manual-rollback-'));
  const appDir = join(tempDir, 'app');
  const rollbackDir = `${appDir}.rollback`;
  mkdirSync(appDir, { recursive: true });
  mkdirSync(rollbackDir, { recursive: true });
  mkdirSync(join(tempDir, 'staging'), { recursive: true });
  writeFileSync(join(appDir, 'BUNDLE_VERSION'), 'v2026.09.11-pr-test\n');
  writeFileSync(join(rollbackDir, 'BUNDLE_VERSION'), 'v2026.09.08-1195\n');
  writeFileSync(
    join(tempDir, 'release.json'),
    `${JSON.stringify({ version: 'v2026.09.08-1195' })}\n`,
  );
  const invocation = `
stop_runtime_services() { :; }
activate_terminal_runtime_generation() { :; }
cleanup_terminal_runtime_generations() { :; }
sudo() {
  case "${'$'}1" in
    chown|systemctl) return 0 ;;
    *) "${'$'}@" ;;
  esac
}
curl() { :; }
do_rollback true
printf 'active-version:'
current_version
`;

  try {
    return spawnSync('bash', ['-c', `${syncAgentHarnessSource()}\n${invocation}`], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, TEST_ROOT: tempDir },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('customer VPS update recovery', () => {
  it('keeps recovery and rollback behavior in a focused sourced library', () => {
    const root = process.cwd();
    const syncAgent = readFileSync(join(root, SYNC_AGENT_PATH), 'utf8');
    const recoveryLibrary = readFileSync(join(root, RECOVERY_LIBRARY_PATH), 'utf8');
    const buildScript = readFileSync(join(root, 'scripts/build-host-bundle.sh'), 'utf8');

    expect(syncAgent).toContain('source "$BIN_DIR/matrix-sync-agent-recovery"');
    expect(syncAgent).not.toContain('recover_interrupted_update() {');
    expect(recoveryLibrary).toContain('recover_interrupted_update() {');
    expect(recoveryLibrary).toContain('do_rollback() {');
    expect(recoveryLibrary).toContain('sudo mv "$APP_DIR" "$STAGING_DIR/failed-$(date +%s)"');
    expect(recoveryLibrary).toContain('sudo mv "$APP_DIR.rollback" "$APP_DIR"');
    expect(buildScript).toContain('scripts/inline-sync-agent-recovery.mjs"');
  });

  it('inlines recovery into the shipped agent so legacy helper installation stays self-contained', () => {
    const root = process.cwd();
    const syncAgent = readFileSync(join(root, SYNC_AGENT_PATH), 'utf8');
    const recoveryLibrary = readFileSync(join(root, RECOVERY_LIBRARY_PATH), 'utf8');
    const tempDir = mkdtempSync(join(tmpdir(), 'matrix-recovery-inline-'));
    const stagedAgent = join(tempDir, 'matrix-sync-agent');
    const stagedLibrary = join(tempDir, 'matrix-sync-agent-recovery');
    writeFileSync(stagedAgent, syncAgent);
    writeFileSync(stagedLibrary, recoveryLibrary);

    try {
      const inline = spawnSync('node', [
        join(root, 'scripts/inline-sync-agent-recovery.mjs'),
        stagedAgent,
        stagedLibrary,
      ], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(inline.status, inline.stderr || inline.stdout).toBe(0);
      const staged = readFileSync(stagedAgent, 'utf8');
      expect(staged).toContain('recover_interrupted_update() {');
      expect(staged).not.toContain('source "$BIN_DIR/matrix-sync-agent-recovery"');
      const syntax = spawnSync('bash', ['-n', stagedAgent], { encoding: 'utf8' });
      expect(syntax.status, syntax.stderr || syntax.stdout).toBe(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rolls back an interrupted legacy update when installed metadata identifies the rollback app', () => {
    const result = runInterruptedLegacyUpdateRecovery({
      installedReleaseVersion: 'v2026.09.08-1195',
      rollbackAppVersion: 'v2026.09.08-1195',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('rollback:false');
    expect(result.stdout).toContain('error:apply_interrupted:v2026.09.11-pr-test');
  });

  it('fails closed when interrupted legacy update metadata does not identify the rollback app', () => {
    const result = runInterruptedLegacyUpdateRecovery({
      installedReleaseVersion: 'v2026.09.07-unrelated',
      rollbackAppVersion: 'v2026.09.08-1195',
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).not.toContain('rollback:');
    expect(result.stdout).toContain('error:post_install_rollback_failed:v2026.09.11-pr-test');
  });

  it('persists a bounded recovery error when interrupted legacy rollback fails', () => {
    const result = runInterruptedLegacyUpdateRecovery({
      installedReleaseVersion: 'v2026.09.08-1195',
      rollbackAppVersion: 'v2026.09.08-1195',
      rollbackStatus: 1,
    });

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('rollback:false');
    expect(result.stdout).toContain('error:post_install_rollback_failed:v2026.09.11-pr-test');
  });

  it('allows manual rollback when current release metadata identifies the rollback app', () => {
    const result = runLegacyManualRollback();

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('Installed release metadata already identifies the rollback app');
    expect(result.stdout).toContain('active-version:v2026.09.08-1195');
  });
});
