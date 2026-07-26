import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('customer VPS terminal runtime services', () => {
  it('defines the dormant stable supervisor, aggregate slice, and fixed template', () => {
    const supervisor = read('distro/customer-vps/systemd/matrix-terminal-runtime.service');
    const slice = read('distro/customer-vps/systemd/matrix-terminal.slice');
    const session = read('distro/customer-vps/systemd/matrix-terminal-session@.service');

    expect(supervisor).toContain('ExecStart=/opt/matrix/bin/matrix-terminal-supervisor');
    expect(supervisor).toContain('RuntimeDirectory=matrix-terminal-runtime');
    expect(supervisor).toContain('RuntimeDirectoryMode=0750');
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
      expect(source).toContain('/opt/matrix/bin/matrix-terminal-runtime-op');
      expect(source).not.toContain('system(');
      expect(source).not.toContain('/bin/sh');
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('packages one immutable v1 generation and atomically switches current', () => {
    const build = read('scripts/build-host-bundle.sh');
    const updater = read('distro/customer-vps/host-bin/matrix-sync-agent');

    expect(build).toContain("pnpm --filter '@matrix-os/terminal-runtime' build");
    expect(build).toContain('packages/terminal-runtime/native/supervisor-acceptor.c');
    expect(build).toContain('$STAGE_DIR/libexec/terminal-runtime/v1');
    expect(build).toContain('libexec release.json');
    expect(updater).toContain('/opt/matrix/libexec/terminal-runtime/v1');
    expect(updater).toContain('/opt/matrix/libexec/terminal-runtime/current');
    expect(updater).toContain('ln -s');
    expect(updater).toContain('mv -T');
    expect(updater).toContain('systemctl daemon-reload');
    expect(updater).toContain('enable --now matrix-terminal-runtime.service');
    expect(updater).not.toContain('restart matrix-terminal-runtime.service');
    expect(updater).not.toContain('stop matrix-terminal-runtime.service');
    expect(updater).not.toContain('matrix-terminal-session@*');
  });
});
