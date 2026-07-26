import { describe, expect, it, vi } from 'vitest';
import {
  buildKeeperLaunch,
  monitorKeeperOnce,
  waitForKeeperReadiness,
} from '../../packages/terminal-runtime/src/keeper.js';
import {
  createSystemdExecutor,
  unitNameForRuntimeId,
} from '../../packages/terminal-runtime/src/systemd.js';
import {
  decodePeerCredentials,
  handleSupervisorFrame,
} from '../../packages/terminal-runtime/src/supervisor.js';
import { decodeFrame, encodeFrame } from '../../packages/terminal-runtime/src/framing.js';

const runtimeId = '0123456789abcdef0123456789abcdef';
const operationId = 'fedcba9876543210fedcba9876543210';

describe('terminal runtime service boundary', () => {
  it('derives only the fixed template instance after validating the runtime ID', () => {
    expect(unitNameForRuntimeId(runtimeId))
      .toBe(`matrix-terminal-session@${runtimeId}.service`);

    for (const value of [
      '../matrix-gateway',
      '--system',
      `${runtimeId}.service`,
      `${runtimeId}\nmatrix-gateway`,
      'matrix-terminal-session@other.service',
    ]) {
      expect(() => unitNameForRuntimeId(value)).toThrow();
    }
  });

  it('never invokes systemctl for invalid runtime identities or accepts arbitrary properties', async () => {
    const runFile = vi.fn(async () => ({ stdout: '', stderr: '' }));
    const executor = createSystemdExecutor({
      runFile,
      readFile: vi.fn(async () => 'populated 0\n'),
      inspectProcesses: vi.fn(async () => ({
        keeper: true,
        zellijClient: true,
        zellijServer: true,
        shell: true,
      })),
      sessionResponds: vi.fn(async () => true),
    });

    await expect(executor.start('--system')).rejects.toThrow();
    await expect(executor.stop('../matrix-gateway')).rejects.toThrow();
    await expect(executor.inspect(`${runtimeId}.service`)).rejects.toThrow();
    expect(runFile).not.toHaveBeenCalled();

    await executor.start(runtimeId);
    expect(runFile).toHaveBeenCalledWith('/usr/bin/systemctl', [
      'start',
      `matrix-terminal-session@${runtimeId}.service`,
    ], expect.objectContaining({ timeout: 30_000 }));
  });

  it('keeps all user-derived launch data out of keeper argv and preserves command gating', () => {
    const create = buildKeeperLaunch({
      schemaVersion: 1,
      runtimeId,
      operationId,
      intent: 'create',
      cwd: { kind: 'home-relative', path: 'projects/example' },
      launch: { kind: 'agent', configurationRef: operationId },
      createdAt: '2026-07-26T00:00:00.000Z',
    }, '/home/matrix/home');
    const recover = buildKeeperLaunch({
      schemaVersion: 1,
      runtimeId,
      operationId,
      intent: 'recover',
      cwd: { kind: 'home-relative', path: '' },
      launch: { kind: 'shell' },
      createdAt: '2026-07-26T00:00:00.000Z',
    }, '/home/matrix/home');

    expect(create.file).toBe('/opt/matrix/bin/zellij');
    expect(create.args).toEqual([
      '--session',
      `matrix-t-${runtimeId}`,
      '--new-session-with-layout',
      '/opt/matrix/libexec/terminal-runtime/v1/layout.kdl',
    ]);
    expect(create.cwd).toBe('/home/matrix/home/projects/example');
    expect(JSON.stringify(create.args)).not.toContain('configurationRef');
    expect(recover.args).toEqual(['attach', `matrix-t-${runtimeId}`]);
    expect(recover.args).not.toContain('--force-run-commands');
    expect(Object.keys(create.env).sort()).toEqual([
      'HOME',
      'LANG',
      'MATRIX_HOME',
      'PATH',
      'TERM',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_RUNTIME_DIR',
      'ZELLIJ_CONFIG_DIR',
      'ZELLIJ_CONFIG_FILE',
    ]);
  });

  it('notifies readiness only after exact session and complete cgroup evidence pass', async () => {
    const notifyReady = vi.fn(async () => undefined);
    const sequence = [
      { clientAlive: true, sessionResponsive: false, roles: null },
      {
        clientAlive: true,
        sessionResponsive: true,
        roles: {
          keeper: 10,
          zellijClient: 11,
          zellijServer: 12,
          shell: 13,
        },
      },
    ];
    const evidence = await waitForKeeperReadiness({
      runtimeId,
      timeoutMs: 1_000,
      pollMs: 1,
      readEvidence: vi.fn(async () => sequence.shift() ?? sequence[0]),
      delay: vi.fn(async () => undefined),
      notifyReady,
    });

    expect(evidence.roles.shell).toBe(13);
    expect(notifyReady).toHaveBeenCalledTimes(1);
  });

  it('fails readiness and monitoring when the foreground client or server disappears', async () => {
    const notifyReady = vi.fn(async () => undefined);
    await expect(waitForKeeperReadiness({
      runtimeId,
      timeoutMs: 20,
      pollMs: 1,
      readEvidence: vi.fn(async () => ({
        clientAlive: false,
        sessionResponsive: true,
        roles: {
          keeper: 10,
          zellijClient: 11,
          zellijServer: 12,
          shell: 13,
        },
      })),
      delay: vi.fn(async () => undefined),
      notifyReady,
    })).rejects.toThrow('keeper_client_exited');
    expect(notifyReady).not.toHaveBeenCalled();

    await expect(monitorKeeperOnce({
      clientAlive: true,
      sessionResponds: vi.fn(async () => false),
    })).resolves.toBe(false);
    await expect(monitorKeeperOnce({
      clientAlive: false,
      sessionResponds: vi.fn(async () => true),
    })).resolves.toBe(false);
  });

  it('authenticates the peer before parsing or dispatching a bounded protocol frame', async () => {
    const peerBytes = Buffer.alloc(12);
    peerBytes.writeUInt32LE(1234, 0);
    peerBytes.writeUInt32LE(1001, 4);
    peerBytes.writeUInt32LE(1001, 8);
    expect(decodePeerCredentials(peerBytes)).toEqual({
      pid: 1234,
      uid: 1001,
      gid: 1001,
    });

    const handler = vi.fn(async () => ({
      version: 1 as const,
      ok: true as const,
      operationId,
      result: [],
    }));
    const request = encodeFrame({
      version: 1,
      operation: 'List',
      operationId,
      input: {},
    });
    const rejected = await handleSupervisorFrame({
      peer: { pid: 99, uid: 2000, gid: 2000 },
      matrixUid: 1001,
      request,
      handler,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(decodeFrame(rejected)).toMatchObject({
      version: 1,
      ok: false,
      error: { code: 'invalid_request' },
    });

    const accepted = await handleSupervisorFrame({
      peer: { pid: 1234, uid: 1001, gid: 1001 },
      matrixUid: 1001,
      request,
      handler,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(decodeFrame(accepted)).toMatchObject({ ok: true, operationId });
  });
});
