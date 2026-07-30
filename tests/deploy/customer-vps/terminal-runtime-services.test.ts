import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');
function extractShellFunction(script: string, name: string): string {
  const lines = script.split('\n');
  const start = lines.findIndex((line) => line === `${name}() {`);
  const end = lines.findIndex((line, index) => index > start && line === '}');
  if (start < 0 || end < 0) throw new Error('shell_function_missing');
  return lines.slice(start, end + 1).join('\n');
}
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('customer VPS terminal runtime services', () => {
  it('defines the dormant stable supervisor, aggregate slice, and fixed template', () => {
    const supervisor = read('distro/customer-vps/systemd/matrix-terminal-runtime.service');
    const slice = read('distro/customer-vps/systemd/matrix-terminal.slice');
    const session = read('distro/customer-vps/systemd/matrix-terminal-session@.service');

    expect(supervisor).toContain('ExecStart=/opt/matrix/bin/matrix-terminal-supervisor');
    expect(supervisor).toContain('RuntimeDirectory=matrix-terminal-runtime');
    expect(supervisor).toContain('RuntimeDirectoryMode=0750');
    expect(supervisor).toContain('Type=notify');
    expect(supervisor).toContain('NotifyAccess=main');
    expect(supervisor).toContain('WantedBy=multi-user.target');
    expect(supervisor).not.toContain('matrix-terminal-session@');

    expect(slice).toContain('MemoryAccounting=yes');
    expect(slice).toContain('TasksAccounting=yes');
    expect(slice).toContain('CPUAccounting=yes');
    expect(slice).toContain('IOAccounting=yes');
    expect(slice).toContain('MemoryHigh=75%');
    expect(slice).toContain('TasksMax=2048');
    expect(slice).toContain('CPUWeight=80');
    expect(slice).toContain('IOWeight=80');

    expect(session).toContain('Type=notify');
    expect(session).toContain('User=matrix');
    expect(session).toContain('Group=matrix');
    expect(session).toContain('Slice=matrix-terminal.slice');
    expect(session).toContain('ExecStart=/opt/matrix/bin/matrix-terminal-keeper %i');
    expect(session).toContain('KillMode=control-group');
    expect(session).toContain('TimeoutStartSec=30');
    expect(session).toContain('TimeoutStopSec=30');
    expect(session).toContain('Restart=no');
    expect(session).toContain('MemoryHigh=50%');
    expect(session).toContain('TasksMax=512');
    expect(session).toContain('StandardOutput=null');
    for (const forbidden of [
      'EnvironmentFile',
      '[Install]',
      'WantedBy',
      'RequiredBy',
      'Requires=',
      'PartOf=',
    ]) {
      expect(session).not.toContain(forbidden);
    }
  });

  it('ships fixed stable wrappers that cannot select another executable or generation', () => {
    const wrappers = [
      ['matrix-terminal-supervisor', 'supervisor-acceptor'],
      ['matrix-terminal-keeper', 'keeper.js'],
      ['matrix-terminal-pane', 'pane.js'],
      ['matrix-terminal-runtime-op', 'runtime-op.js'],
    ] as const;
    for (const [name, target] of wrappers) {
      const script = read(`distro/customer-vps/host-bin/${name}`);
      expect(script).toContain('/opt/matrix/libexec/terminal-runtime/current/');
      expect(script).toContain(target);
      expect(script).not.toContain('eval ');
      expect(script).not.toContain('/opt/matrix/app');
    }
  });

  it('restricts the one-shot legacy migration operation to the root updater', () => {
    const runtimeOp = read('packages/terminal-runtime/src/runtime-op.ts');
    const wrapper = read(
      'distro/customer-vps/host-bin/matrix-terminal-runtime-op',
    );

    expect(runtimeOp).toContain("mode === 'migrate-legacy'");
    expect(runtimeOp).toContain('process.getuid?.() !== 0');
    expect(runtimeOp).toContain("throw new Error('migration_unauthorized')");
    expect(wrapper).toContain(
      'serve-peer|serve-keeper|maintenance|migrate-legacy|probe',
    );
    expect(runtimeOp).toContain("mode === 'probe'");
    expect(runtimeOp).toContain("operation: 'List'");
    expect(runtimeOp).toContain("throw new Error('probe_unauthorized')");
  });

  it('compiles a warning-free SO_PEERCRED acceptor with fixed socket and worker paths', () => {
    const sourcePath = join(
      root,
      'packages/terminal-runtime/native/supervisor-acceptor.c',
    );
    const source = readFileSync(sourcePath, 'utf8');
    const outputDir = mkdtempSync(join(tmpdir(), 'matrix-terminal-acceptor-'));
    try {
      const result = spawnSync('cc', [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-O2',
        sourcePath,
        '-o',
        join(outputDir, 'supervisor-acceptor'),
      ], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(source).toContain('SO_PEERCRED');
      expect(source).toContain('getsockopt');
      expect(source).toContain('/run/matrix-terminal-runtime/supervisor.sock');
      expect(source).toContain('/run/matrix-terminal-runtime/keeper.sock');
      expect(source).toContain('/proc/self/exe');
      expect(source).toContain('/opt/matrix/runtime/node/bin/node');
      expect(source).toContain('runtime-op.js');
      expect(source).not.toContain('/opt/matrix/bin/matrix-terminal-runtime-op');
      expect(source).toContain('NOTIFY_SOCKET');
      expect(source).toContain('READY=1');
      expect(source).toContain('#define MAX_WORKERS 128');
      expect(source).toContain('workers >= MAX_WORKERS');
      expect(source).not.toContain('system(');
      expect(source).not.toContain('/bin/sh');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('packages one immutable v1 generation and atomically switches current', () => {
    const build = read('scripts/build-host-bundle.sh');
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    const cloudInit = read('distro/customer-vps/cloud-init.yaml');
    const installer = read('scripts/install-server.sh');

    expect(build).toContain("pnpm --filter '@matrix-os/terminal-runtime' build");
    expect(build).toContain('packages/terminal-runtime/native/supervisor-acceptor.c');
    expect(build).toContain('$STAGE_DIR/libexec/terminal-runtime/v1');
    expect(build).toContain('terminal_runtime_package_manifest_invalid');
    expect(build).toContain('runtime-manifest.sha256');
    expect(updater).toContain('/opt/matrix/libexec/terminal-runtime/v1');
    expect(updater).toContain('/opt/matrix/libexec/terminal-runtime/current');
    expect(updater).toContain('ln -s');
    expect(updater).toContain('mv -T');
    expect(updater).toContain('systemctl daemon-reload');
    expect(updater).toContain('systemctl enable matrix-terminal-runtime.service');
    expect(updater).toContain('systemctl start matrix-terminal-runtime.service');
    expect(updater).not.toContain(
      'systemctl enable --now matrix-terminal-runtime.service',
    );
    expect(updater).not.toContain('restart matrix-terminal-runtime.service');
    expect(updater).not.toContain('matrix-terminal-session@*');
    expect(cloudInit).toContain('chown -R root:root /opt/matrix/libexec');
    expect(cloudInit).toContain('/opt/matrix/systemd/*.slice');
    expect(cloudInit).toContain(
      'systemctl enable --now matrix-terminal-runtime.service',
    );
    expect(cloudInit).not.toContain(
      'systemctl enable matrix-terminal-session@',
    );
    expect(installer).toContain('matrix-terminal-runtime.service');
    expect(installer).toContain('matrix-terminal-session@.service');
    expect(installer).toContain('matrix-terminal.slice');
    expect(installer).not.toContain(
      'systemctl enable matrix-terminal-session@',
    );
  });

  it('runs disposable-VPS spikes only through a preview-only typed root helper', () => {
    const build = read('scripts/build-host-bundle.sh');
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    const workflow = read('.github/workflows/terminal-runtime-spikes.yml');
    const helper = read(
      'distro/customer-vps/host-bin/matrix-terminal-spike-control',
    );
    const launch = read('scripts/spikes/terminal-runtime/launch-remote.sh');
    const pack = read('scripts/spikes/terminal-runtime/pack-evidence.sh');
    const runner = read('scripts/spikes/terminal-runtime/run-remote.sh');

    expect(build).toContain('MATRIX_TERMINAL_RUNTIME_SPIKE');
    expect(build).toContain('$terminal_generation_build/spikes');
    expect(build).toContain(
      '$STAGE_DIR/bin/matrix-terminal-spike-control',
    );
    expect(build).not.toContain(
      '$STAGE_DIR/app/scripts/spikes/terminal-runtime',
    );
    expect(updater).toContain('matrix-terminal-spike-control');
    expect(updater).toContain(
      'rm -f -- "$BIN_DIR/matrix-terminal-spike-control"',
    );
    expect(updater).toContain(
      '/opt/matrix/bin/matrix-terminal-spike-control *',
    );
    expect(workflow).toContain(
      '"/opt/matrix/bin/matrix-terminal-spike-control",',
    );
    expect(workflow).toContain('"launch",');
    expect(workflow).toContain('"pack",');
    expect(workflow).not.toContain(
      '/opt/matrix/app/scripts/spikes/terminal-runtime',
    );
    expect(helper).toContain(
      '/opt/matrix/libexec/terminal-runtime/current/spikes/',
    );
    expect(helper).toContain('activation-watch-arm | activation-watch-run | activation-watch-status');
    expect(helper).toContain('matrix-terminal-activation-watch.service');
    expect(helper).toContain('systemctl restart matrix-update-runtime.service');
    expect(helper).toContain('/opt/matrix/bin/matrix-update rollback');
    expect(helper).not.toContain('--force-run-commands');
    expect(helper).not.toContain('eval ');
    expect(helper).not.toContain('/opt/matrix/app');
    expect(launch).not.toContain('/opt/matrix/app');
    expect(pack).not.toContain('/opt/matrix/app');
    expect(runner).not.toContain('/opt/matrix/app');
  });

  it('rejects untyped spike helper operations and malformed exact-head SHAs', () => {
    const helper = join(
      root,
      'distro/customer-vps/host-bin/matrix-terminal-spike-control',
    );
    for (const args of [
      [],
      ['launch'],
      ['pack', 'main'],
      ['acceptance-launch', 'main'],
      ['acceptance-launch', 'a'.repeat(40)],
      ['acceptance-launch', 'a'.repeat(40), 'latest'],
      ['acceptance-shell', 'a'.repeat(40)],
      ['delete', 'a'.repeat(40)],
      ['launch', 'a'.repeat(40), 'extra'],
      ['launch', '../' + 'a'.repeat(37)],
    ]) {
      const result = spawnSync('bash', [helper, ...args], {
        encoding: 'utf8',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('spike_control_invalid_request');
    }
  });

  it('terminates only a newly introduced supervisor before failed-start rollback', () => {
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    const cleanup = extractShellFunction(
      updater,
      'terminate_new_terminal_runtime_supervisor_after_failed_start',
    );
    const startFailure = updater.slice(
      updater.indexOf(
        '! systemctl start matrix-terminal-runtime.service; then',
      ),
      updater.indexOf('log "Terminal runtime supervisor ready"'),
    );
    const rollbackBody = updater.slice(
      updater.indexOf('do_rollback() {'),
      updater.indexOf('# Claims one root-published protocol request'),
    );

    expect(updater).toContain(
      'systemctl is-active --quiet matrix-terminal-runtime.service',
    );
    expect(updater).toContain('supervisor-was-active');
    expect(cleanup).toContain(
      '[ ! -f "$snapshot/supervisor-was-active" ] || return 0',
    );
    expect(cleanup).toContain(
      'if ! systemctl is-active --quiet matrix-terminal-runtime.service; then',
    );
    expect(cleanup).toContain(
      'systemctl stop matrix-terminal-runtime.service',
    );
    expect(cleanup).toContain(
      'systemctl reset-failed matrix-terminal-runtime.service',
    );
    expect(cleanup).toContain(
      'if systemctl is-active --quiet matrix-terminal-runtime.service; then',
    );
    expect(startFailure.indexOf(
      'terminate_new_terminal_runtime_supervisor_after_failed_start',
    )).toBeGreaterThan(startFailure.indexOf(
      'terminal_runtime_supervisor_start_failed',
    ));
    expect(startFailure.indexOf('restore_staged_runtime_after_failed_update')).toBeGreaterThan(
      startFailure.indexOf(
        'terminate_new_terminal_runtime_supervisor_after_failed_start',
      ),
    );
    const cleanupFailure = startFailure.slice(
      startFailure.indexOf(
        'if ! terminate_new_terminal_runtime_supervisor_after_failed_start; then',
      ),
      startFailure.indexOf('restore_staged_runtime_after_failed_update'),
    );
    expect(cleanupFailure).not.toContain(
      'restore_staged_runtime_after_failed_update',
    );
    expect(cleanupFailure).toContain(
      'terminal_runtime_supervisor_cleanup_preserved_host_layer',
    );
    expect(
      updater.match(/systemctl stop matrix-terminal-runtime\.service/g),
    ).toHaveLength(1);
    expect(rollbackBody).toContain(
      'terminate_new_terminal_runtime_supervisor_after_failed_start',
    );
    expect(rollbackBody.indexOf(
      'terminate_new_terminal_runtime_supervisor_after_failed_start',
    )).toBeLessThan(rollbackBody.indexOf('mv "$APP_DIR.rollback" "$APP_DIR"'));
    expect(updater).not.toContain('systemctl stop matrix-terminal-session@');
  });

  it('rejects a hard-linked immutable generation before privileged install', () => {
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    const generation = mkdtempSync(join(tmpdir(), 'matrix-generation-hardlink-'));
    try {
      writeFileSync(join(generation, 'keeper.js'), 'keeper');
      linkSync(join(generation, 'keeper.js'), join(generation, 'alias.js'));
      const fileHash = sha256('keeper');
      const manifest = `${fileHash}  alias.js\n${fileHash}  keeper.js\n`;
      writeFileSync(join(generation, 'runtime-manifest.sha256'), manifest);
      const generationId = sha256(manifest);
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        extractShellFunction(updater, 'verify_terminal_runtime_generation'),
        'verify_terminal_runtime_generation "$1" "$2"',
      ].join('\n'), 'verify-generation', generation, generationId], {
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
    } finally {
      rmSync(generation, { recursive: true, force: true });
    }
  });

  it('rejects incomplete runtime bundles before privileged install', () => {
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    const bundle = mkdtempSync(join(tmpdir(), 'matrix-runtime-preflight-'));
    const generationRoot = join(bundle, 'libexec', 'terminal-runtime');
    const generation = join(generationRoot, 'v1', 'placeholder');
    const bin = join(bundle, 'bin');
    const systemd = join(bundle, 'systemd');
    try {
      mkdirSync(generation, { recursive: true });
      mkdirSync(bin);
      mkdirSync(systemd);
      writeFileSync(join(generation, 'keeper.js'), 'keeper');
      const manifest = `${sha256('keeper')}  keeper.js\n`;
      writeFileSync(join(generation, 'runtime-manifest.sha256'), manifest);
      const generationId = sha256(manifest);
      const finalGeneration = join(generationRoot, 'v1', generationId);
      mkdirSync(finalGeneration);
      for (const name of ['keeper.js', 'runtime-manifest.sha256']) {
        writeFileSync(
          join(finalGeneration, name),
          readFileSync(join(generation, name)),
        );
      }
      rmSync(generation, { recursive: true });
      symlinkSync(`v1/${generationId}`, join(generationRoot, 'current'));

      const shell = [
        'set -euo pipefail',
        'terminal_runtime_candidate=""',
        'terminal_runtime_generation_id=""',
        extractShellFunction(updater, 'verify_terminal_runtime_generation'),
        extractShellFunction(updater, 'prepare_terminal_runtime_candidate'),
        'prepare_terminal_runtime_candidate "$1"',
      ].join('\n');
      const incomplete = spawnSync(
        'bash',
        ['-c', shell, 'runtime-preflight', bundle],
        { encoding: 'utf8' },
      );
      expect(incomplete.status).not.toBe(0);

      for (const name of [
        'matrix-terminal-supervisor',
        'matrix-terminal-keeper',
        'matrix-terminal-pane',
        'matrix-terminal-runtime-op',
      ]) {
        writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      }
      for (const name of [
        'matrix-terminal-runtime.service',
        'matrix-terminal-session@.service',
        'matrix-terminal.slice',
      ]) {
        writeFileSync(join(systemd, name), '[Unit]\n');
      }
      const complete = spawnSync(
        'bash',
        ['-c', shell, 'runtime-preflight', bundle],
        { encoding: 'utf8' },
      );
      expect(complete.status, complete.stderr).toBe(0);
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
  });

  it('restores stable host artifacts only for failed update rollback', () => {
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');

    expect(updater).toContain('backup_terminal_runtime_for_failed_update()');
    expect(updater).toContain('restore_terminal_runtime_after_failed_update()');
    expect(updater).toContain('backup_terminal_runtime_for_failed_update');
    expect(updater).toContain('do_rollback failed-update');
    expect(updater).toContain('do_rollback explicit');
    expect(updater).toContain('local rollback_kind="${1:-explicit}"');
    expect(updater).toContain(
      'if [ "$rollback_kind" = "failed-update" ]; then',
    );
    expect(updater).toContain(
      'restore_terminal_runtime_after_failed_update',
    );
    expect(updater).toContain(
      'rm -rf -- "$TERMINAL_RUNTIME_FAILED_UPDATE_SNAPSHOT"',
    );
    expect(updater).not.toContain(
      'systemctl stop matrix-terminal-session@',
    );
    expect(updater).toContain('terminal_runtime_supervisor_start_failed');
  });

  it('migrates legacy metadata before starting the activated gateway without touching live terminal units', () => {
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');
    const activation = read('distro/customer-vps/terminal-runtime-activation');
    const migration = updater.indexOf(
      '/opt/matrix/bin/matrix-terminal-runtime-op migrate-legacy',
    );
    const gatewayStart = updater.indexOf(
      'systemctl start matrix-gateway matrix-shell',
      migration,
    );
    const supervisorEnable = updater.indexOf(
      'systemctl enable matrix-terminal-runtime.service',
      migration,
    );
    const supervisorStart = updater.indexOf(
      'systemctl start matrix-terminal-runtime.service',
      migration,
    );

    expect(activation).toBe('supervised-v1\n');
    expect(migration).toBeGreaterThan(-1);
    expect(gatewayStart).toBeGreaterThan(migration);
    expect(supervisorEnable).toBeGreaterThan(migration);
    expect(supervisorStart).toBeGreaterThan(supervisorEnable);
    expect(supervisorStart).toBeLessThan(gatewayStart);
    expect(updater).not.toContain('systemctl stop matrix-terminal-session@');
    expect(updater).not.toContain('systemctl restart matrix-terminal-runtime.service');
    expect(updater).not.toContain('systemctl restart matrix-terminal.slice');
  });
});
