import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildKeeperLaunch, directAgentProviderPid, isKeeperEntrypoint, keeperFailureCode, monitorKeeperOnce, paneOutcomeCode, stageAgentConfiguration, waitForKeeperReadiness } from '../../packages/terminal-runtime/src/keeper.js';
import {
  classifyRuntimeProcesses,
  createSystemdExecutor,
} from '../../packages/terminal-runtime/src/systemd.js';
import {
  unitNameForRuntimeId,
} from '../../packages/terminal-runtime/src/contracts.js';
import { buildProviderLaunch, paneExitLifecycleCode, runtimeIdFromCgroup, waitForChild } from '../../packages/terminal-runtime/src/pane.js';
import {
  decodePeerCredentials,
  handleSupervisorFrame,
} from '../../packages/terminal-runtime/src/supervisor.js';
import { decodeFrame, encodeFrame } from '../../packages/terminal-runtime/src/framing.js';
import { createRuntimeState } from '../../packages/terminal-runtime/src/runtime-state.js';
import { createSupervisorClient } from '../../packages/terminal-runtime/src/client.js';

const runtimeId = '0123456789abcdef0123456789abcdef';
const operationId = 'fedcba9876543210fedcba9876543210';

describe('terminal runtime service boundary', () => {
  it('retains recent idempotency records past the legacy listing ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-terminal-operation-cap-'));
    const now = Date.parse('2026-07-26T01:00:00.000Z');
    const state = await createRuntimeState({ durableRoot: join(root, 'durable'), runtimeRoot: join(root, 'run'), nowMs: () => now });
    try {
      for (let generation = 1; generation <= 1_026; generation += 1) {
        const id = generation.toString(16).padStart(32, '0');
        const accepted = { schemaVersion: 1 as const, operationId: id, runtimeId, generation,
          intent: 'recover' as const, status: 'accepted' as const, requestHash: generation.toString(16).padStart(64, '0'), committedAt: '2026-07-26T00:00:00.000Z' };
        await state.operations.commit(accepted);
        if (generation < 1_026) await state.operations.complete({ ...accepted, status: 'ready', result: { ok: true, value: {} } });
      }
      await expect(state.operations.nextGeneration()).resolves.toBe(1_027);
      await expect(state.operations.pruneCompleted(now + 8 * 86_400_000)).resolves.toBe(1_023);
      await expect(state.operations.read((1_026).toString(16).padStart(32, '0'))).resolves.toMatchObject({ status: 'accepted' });
    } finally { await state.close(); await rm(root, { recursive: true, force: true }); }
  });
  it('uses the readiness deadline for create requests', async () => {
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), setTimeout: vi.fn(),
      end: vi.fn(() => queueMicrotask(() => { socket.emit('data', encodeFrame({ version: 1,
        ok: true, operationId, result: { runtimeId, lifecycleState: 'starting' } })); socket.emit('end'); })) });
    await createSupervisorClient({ connect: () => (queueMicrotask(() => socket.emit('connect')),
      socket as unknown as Socket) }).request({ version: 1, operation: 'CreateStart', operationId,
      input: { displayName: 'accept-runtime', cwd: { kind: 'home-relative', path: '' }, launch: { kind: 'shell' } } });
    expect(socket.setTimeout).toHaveBeenCalledWith(40_000);
  });
  it('links Claude settings on fd 3 and removes them after exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matrix-claude-settings-'));
    const path = join(root, operationId), payload = '{"permissions":{}}';
    const child = Object.assign(new EventEmitter(), { stdin: null, stdio: [null, null, null, null], kill: vi.fn() });
    let inheritedFd = -1;
    const spawnChild = vi.fn((_file, _args, options) => (inheritedFd =
      Number((options?.stdio as unknown[])[3]), child)) as unknown as typeof spawn;
    try {
      const result = waitForChild({ file: 'claude', args: [], cwd: root, env: {}, stdin: null,
        fdPayload: payload, fdPayloadFile: true }, spawnChild, path);
      await vi.waitFor(() => expect(inheritedFd).toBeGreaterThan(2));
      const metadata = await lstat(path);
      expect([metadata.isFile(), metadata.mode & 0o777, await readFile(`/proc/self/fd/${inheritedFd}`, 'utf8')])
        .toEqual([true, 0o600, payload]); child.emit('exit', 0, null); await expect(result).resolves.toBe(0);
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
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
    const store = { claim: vi.fn(async () => configuration), publish: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined) };
    const descriptor = { schemaVersion: 1, runtimeId, operationId, intent: 'create',
      cwd: { kind: 'home-relative', path: 'projects/example' }, launch: { kind: 'agent', configurationRef: operationId }, createdAt: '2026-07-26T00:00:00.000Z' } as const;
    await stageAgentConfiguration(descriptor, runtimeId, store);
    expect(store.claim).toHaveBeenCalledWith(operationId);
    expect(store.publish).toHaveBeenCalledWith(runtimeId, configuration);
    store.publish.mockRejectedValueOnce(new Error('write_failed'));
    await expect(stageAgentConfiguration(descriptor, runtimeId, store)).rejects
      .toThrow('write_failed');
    expect(store.remove).toHaveBeenCalledWith(runtimeId);
  });
  it('derives the runtime identity only from the exact terminal unit cgroup', () => {
    expect(runtimeIdFromCgroup(`0::/system.slice/matrix-terminal.slice/matrix-terminal-session@${runtimeId}.service\n`)).toBe(runtimeId);
    for (const membership of [
      `0::/system.slice/matrix-terminal-session@${runtimeId}.service/child\n`,
      `0::/system.slice/matrix-terminal-session@../${runtimeId}.service\n`, `0::/evil.slice/matrix-terminal-session@${runtimeId}.service\n`,
      `1:name=systemd:/matrix-terminal-session@${runtimeId}.service\n`, `0::/matrix-terminal-session@${runtimeId}.service\n0::/matrix-terminal-session@${runtimeId}.service\n`,
    ]) expect(() => runtimeIdFromCgroup(membership)).toThrow('agent_cgroup_invalid');
  });
  it('requires a live direct provider child for agent readiness evidence', () => {
    const processes = [{ pid: 13, parentPid: 12, comm: 'node', args: ['/generation/pane.js', 'agent'] }, { pid: 14, parentPid: 1, comm: 'pi', args: ['pi'] }];
    expect(directAgentProviderPid(processes)).toBeUndefined();
    expect(directAgentProviderPid([...processes, { pid: 15, parentPid: 13,
      comm: 'pi', args: ['pi'] }])).toBe(15);
  });
  it('keeps idle runtime health monitoring referenced', async () => expect(await readFile(
    'packages/terminal-runtime/src/keeper.ts', 'utf8')).not.toContain('monitor.unref()'));
  it('reports only allowlisted keeper startup reasons', () => expect([keeperFailureCode(new Error('keeper_claim_failed')), keeperFailureCode(new Error('/home/matrix/private')), keeperFailureCode('private prompt')]).toEqual(['keeper_claim_failed', 'internal', 'non_error']));
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
      if (agent === 'pi') expect([launch.file, launch.args])
        .toEqual(['/opt/matrix/runtime/node/bin/pi', ['--offline']]);
    },
  );

  it('allocates a provider PTY for an interactive Pi session', () => {
    const launch = buildProviderLaunch({ schemaVersion: 1, agent: 'pi',
      cwd: { kind: 'home-relative', path: '' }, mode: 'default', approvalPolicy: 'never',
      sandbox: { enabled: false, mode: 'danger-full-access', writableRoots: [], denyWriteRoots: [] } });
    expect(launch).toMatchObject({ file: '/opt/matrix/runtime/node/bin/pi',
      args: ['--offline'], interactivePty: true, stdin: null, fdPayload: null });
  });
  it('launches an interactive provider with TTY stdin and stdout', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try { await expect(waitForChild({ file: process.execPath,
      args: ['-e', 'process.stdout.write(String(process.stdin.isTTY&&process.stdout.isTTY))'],
      cwd: process.cwd(), env: {}, stdin: null, fdPayload: null, interactivePty: true })).resolves.toBe(0);
      expect(write).toHaveBeenCalledWith('true');
    } finally { write.mockRestore(); }
  });

  it('emits only bounded generic lifecycle codes when an agent pane exits', () => {
    expect(paneExitLifecycleCode('agent', 0)).toBe('terminal_pane_agent_exit_0');
    expect(paneExitLifecycleCode('agent', 128)).toBe('terminal_pane_agent_exit_128');
    expect(paneExitLifecycleCode('shell', 0)).toBeNull();
    expect(paneOutcomeCode('\u001b[31msecret\u001b[0m terminal_pane_failed\r\n'))
      .toBe('terminal_keeper_observed_pane_failed');
    expect(paneOutcomeCode('terminal_pane_agent_exit_0'))
      .toBe('terminal_keeper_observed_pane_agent_exit_0');
    expect(paneOutcomeCode('terminal_pane_agent_exit_999')).toBeNull();
  });

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
    let reads = 0;
    const readEvidence = vi.fn(async () => sequence[Math.min(reads++, 1)]!);
    const evidence = await waitForKeeperReadiness({
      runtimeId,
      timeoutMs: 1_000,
      pollMs: 1,
      readEvidence,
      delay: vi.fn(async () => undefined),
      notifyReady,
    });

    expect(evidence.roles.shell).toBe(13);
    expect(readEvidence).toHaveBeenCalledTimes(6);
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
    let reads = 0;
    const readEvidence = vi.fn(async () => sequence[Math.min(reads++, 1)]!);
    await waitForKeeperReadiness({
      runtimeId,
      requiresConfirmation: true,
      timeoutMs: 1_000,
      pollMs: 1,
      readEvidence,
      delay: vi.fn(async () => undefined),
      notifyReady,
    });
    expect(readEvidence).toHaveBeenCalledTimes(6);
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
    await expect(monitorKeeperOnce({
      clientAlive: true,
      workloadAlive: false,
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
