import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  buildKeeperLaunch,
  directAgentProviderPid,
  isKeeperEntrypoint,
  monitorKeeperOnce,
  stageAgentConfiguration,
  waitForKeeperReadiness,
} from '../../packages/terminal-runtime/src/keeper.js';
import {
  classifyRuntimeProcesses,
  createSystemdExecutor,
} from '../../packages/terminal-runtime/src/systemd.js';
import {
  unitNameForRuntimeId,
} from '../../packages/terminal-runtime/src/contracts.js';
import {
  buildProviderLaunch,
  runtimeIdFromCgroup,
} from '../../packages/terminal-runtime/src/pane.js';
import {
  decodePeerCredentials,
  handleSupervisorFrame,
} from '../../packages/terminal-runtime/src/supervisor.js';
import { decodeFrame, encodeFrame } from '../../packages/terminal-runtime/src/framing.js';

const runtimeId = '0123456789abcdef0123456789abcdef';
const operationId = 'fedcba9876543210fedcba9876543210';

describe('terminal runtime service boundary', () => {
  it('uses the exact verified v0.44.3 serialization options without forced commands', async () => {
    const config = await readFile(
      'packages/terminal-runtime/assets/config.kdl',
      'utf8',
    );
    expect(config).toContain('session_serialization true');
    expect(config).toContain('serialize_pane_viewport true');
    expect(config).toContain('scrollback_lines_to_serialize 10000');
    expect(config).toContain('serialization_interval 5');
    expect(config).not.toContain('--force-run-commands');
  });

  it('runs a keeper launched through the atomically switched generation symlink', () => {
    expect(isKeeperEntrypoint(
      'file:///opt/matrix/libexec/terminal-runtime/v1/abc/keeper.js',
      '/opt/matrix/libexec/terminal-runtime/current/keeper.js',
    )).toBe(true);
  });

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

  it('does not count transient Zellij inspection clients as runtime roles', () => {
    expect(classifyRuntimeProcesses([
      { comm: 'node', args: ['/generation/keeper.js'] },
      { comm: 'zellij', args: ['zellij', '--session', `matrix-t-${runtimeId}`] },
      { comm: 'zellij', args: ['zellij', 'list-sessions', '--no-formatting'] },
      { comm: 'bash', args: ['bash', '--login'] },
    ])).toEqual({
      keeper: true,
      zellijClient: false,
      zellijServer: false,
      shell: true,
    });
    expect(classifyRuntimeProcesses([
      { comm: 'node', args: ['/generation/keeper.js'] },
      { comm: 'zellij', args: ['zellij', '--session', `matrix-t-${runtimeId}`] },
      { comm: 'zellij', args: ['zellij', '--server', `matrix-t-${runtimeId}`] },
      { comm: 'node', args: ['/generation/pane.js', 'agent'] },
      { comm: 'codex', args: ['codex', 'app-server'] },
    ])).toEqual({
      keeper: true,
      zellijClient: true,
      zellijServer: true,
      shell: true,
    });
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
      '/opt/matrix/libexec/terminal-runtime/current/agent-layout.kdl',
    ]);
    expect(create.cwd).toBe('/home/matrix/home/projects/example');
    expect(JSON.stringify(create.args)).not.toContain('configurationRef');
    expect(recover.args).toEqual(['attach', `matrix-t-${runtimeId}`]);
    expect(recover.args).not.toContain('--force-run-commands');
    expect(create.env.ZELLIJ_CONFIG_FILE).toBe(
      '/opt/matrix/libexec/terminal-runtime/current/config.kdl',
    );
    expect(create.env).not.toHaveProperty('MATRIX_TERMINAL_CONFIGURATION_REF');
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

  it('re-keys one-shot agent configuration to the immutable runtime ID', async () => {
    const configuration = {} as Parameters<typeof buildProviderLaunch>[0];
    const store = { claim: vi.fn(async () => configuration),
      publish: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
    const descriptor = {
      schemaVersion: 1, runtimeId, operationId, intent: 'create',
      cwd: { kind: 'home-relative', path: 'projects/example' },
      launch: { kind: 'agent', configurationRef: operationId },
      createdAt: '2026-07-26T00:00:00.000Z',
    } as const;
    await stageAgentConfiguration(descriptor, runtimeId, store);
    expect(store.claim).toHaveBeenCalledWith(operationId);
    expect(store.publish).toHaveBeenCalledWith(runtimeId, configuration);
    store.publish.mockRejectedValueOnce(new Error('write_failed'));
    await expect(stageAgentConfiguration(descriptor, runtimeId, store)).rejects.toThrow('write_failed');
    expect(store.remove).toHaveBeenCalledWith(runtimeId);
  });
  it('derives the runtime identity only from the exact terminal unit cgroup', () => {
    expect(runtimeIdFromCgroup(`0::/system.slice/matrix-terminal.slice/matrix-terminal-session@${runtimeId}.service\n`)).toBe(runtimeId);
    for (const membership of [
      `0::/system.slice/matrix-terminal-session@${runtimeId}.service/child\n`,
      `0::/system.slice/matrix-terminal-session@../${runtimeId}.service\n`,
      `0::/evil.slice/matrix-terminal-session@${runtimeId}.service\n`, `1:name=systemd:/matrix-terminal-session@${runtimeId}.service\n`,
      `0::/matrix-terminal-session@${runtimeId}.service\n0::/matrix-terminal-session@${runtimeId}.service\n`,
    ]) expect(() => runtimeIdFromCgroup(membership)).toThrow('agent_cgroup_invalid');
  });
  it('requires a live direct provider child for agent readiness evidence', () => {
    const processes = [
      { pid: 13, parentPid: 12, comm: 'node', args: ['/generation/pane.js', 'agent'] },
      { pid: 14, parentPid: 1, comm: 'pi', args: ['pi'] }];
    expect(directAgentProviderPid(processes)).toBeUndefined();
    expect(directAgentProviderPid([...processes,
      { pid: 15, parentPid: 13, comm: 'pi', args: ['pi'] },
    ])).toBe(15);
  });
  it.each(['claude', 'codex', 'opencode', 'pi'] as const)(
    'builds a fixed %s provider launch with dynamic data on stdin or fd 3',
    (agent) => {
      const prompt = 'repair the private project';
      const launch = buildProviderLaunch({
        schemaVersion: 1,
        agent,
        cwd: { kind: 'home-relative', path: 'projects/private' },
        prompt,
        mode: 'plan',
        approvalPolicy: 'on-request',
        sandbox: {
          enabled: true,
          mode: 'workspace-write',
          writableRoots: [
            { kind: 'home-relative', path: 'projects/private' },
          ],
          denyWriteRoots: [
            { kind: 'home-relative', path: 'system' },
          ],
        },
        ...(agent === 'codex'
          ? {
              providerEventPath: 'system/session-output/example.jsonl',
              codexExpectedVersion: '0.145.0',
            }
          : {}),
      }, '/home/matrix/home');

      expect(JSON.stringify(launch.args)).not.toContain(prompt);
      expect(JSON.stringify(launch.args)).not.toContain('/home/matrix/home');
      expect(JSON.stringify(launch.args)).not.toContain('on-request');
      expect(JSON.stringify(launch.args)).not.toContain('workspace-write');
      expect(`${launch.stdin ?? ''}${launch.fdPayload ?? ''}`).toContain(prompt);
      expect(launch.cwd).toBe('/home/matrix/home/projects/private');
      if (agent === 'pi') {
        expect(launch.file).toBe('/opt/matrix/runtime/node/bin/pi');
      }
    },
  );

  it('rejects Claude on-failure approval in supervised mode', () => {
    expect(() => buildProviderLaunch({
      schemaVersion: 1,
      agent: 'claude',
      cwd: { kind: 'home-relative', path: 'projects/private' },
      prompt: 'repair the private project',
      mode: 'default',
      approvalPolicy: 'on-failure',
      sandbox: {
        enabled: true,
        mode: 'workspace-write',
        writableRoots: [],
        denyWriteRoots: [],
      },
    }, '/home/matrix/home')).toThrow('claude_approval_policy_unsupported');
  });

  it.each(['plan', 'review'] as const)(
    'rejects Claude on-failure approval in supervised %s mode',
    (mode) => {
      expect(() => buildProviderLaunch({
        schemaVersion: 1,
        agent: 'claude',
        cwd: { kind: 'home-relative', path: 'projects/private' },
        prompt: 'repair the private project',
        mode,
        approvalPolicy: 'on-failure',
        sandbox: {
          enabled: true,
          mode: 'workspace-write',
          writableRoots: [],
          denyWriteRoots: [],
        },
      }, '/home/matrix/home')).toThrow('claude_approval_policy_unsupported');
    },
  );

  it('hands the selected Codex executable to the runner through fd 3 only', () => {
    const codexExecutable = '/opt/matrix/runtime/node/bin/codex';
    const launch = buildProviderLaunch({
      schemaVersion: 1,
      agent: 'codex',
      cwd: { kind: 'home-relative', path: 'projects/private' },
      prompt: 'repair the private project',
      mode: 'default',
      approvalPolicy: 'never',
      sandbox: {
        enabled: true,
        mode: 'workspace-write',
        writableRoots: [],
        denyWriteRoots: [],
      },
      providerEventPath: 'system/session-output/example.jsonl',
      codexExpectedVersion: '0.145.0',
      codexExecutable,
    }, '/home/matrix/home');

    expect(JSON.parse(launch.fdPayload ?? '{}')).toMatchObject({
      command: codexExecutable,
    });
    expect(JSON.stringify([launch.file, ...launch.args]))
      .not.toContain(codexExecutable);
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

  it('withholds recovery readiness until native command confirmation is visible', async () => {
    const notifyReady = vi.fn(async () => undefined);
    const sequence = [
      {
        clientAlive: true,
        sessionResponsive: true,
        confirmationGated: false,
        roles: {
          keeper: 10,
          zellijClient: 11,
          zellijServer: 12,
          shell: 0,
        },
      },
      {
        clientAlive: true,
        sessionResponsive: true,
        confirmationGated: true,
        roles: {
          keeper: 10,
          zellijClient: 11,
          zellijServer: 12,
          shell: 0,
        },
      },
    ];
    const readEvidence = vi.fn(
      async () => sequence.shift() ?? sequence[0],
    );
    await waitForKeeperReadiness({
      runtimeId,
      requiresConfirmation: true,
      timeoutMs: 1_000,
      pollMs: 1,
      readEvidence,
      delay: vi.fn(async () => undefined),
      notifyReady,
    });
    expect(readEvidence).toHaveBeenCalledTimes(2);
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
