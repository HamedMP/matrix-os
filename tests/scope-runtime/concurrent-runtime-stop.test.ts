import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSystemdScopeRuntimeLauncher, type ScopeRuntimeCommandRunner } from '../../packages/scope-runtime/src/systemd-launcher.js';
import { createScopeRuntimeController } from '../../packages/scope-runtime/src/supervisor.js';
import { SCOPE_RUNTIME_BOT_PROFILE_ID, SCOPE_RUNTIME_BOT_PROFILE_VERSION, SCOPE_RUNTIME_BOT_PROFILE_DIGEST, SCOPE_RUNTIME_BOT_HARNESS_VERSION } from '../../packages/scope-runtime/src/bot-profile.js';
const handle = `runtime_${'a'.repeat(32)}`;
const unit = `matrix-scope-runtime-${'a'.repeat(32)}.service`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(timeoutMs: number) {
  const root = await mkdtemp(join(tmpdir(), 'concurrent-runtime-stop-')); roots.push(root);
  const stateRoot = join(root, 'state'), runtimeRoot = join(stateRoot, 'runtimes', 'a'.repeat(32));
  const cgroupRoot = join(root, 'cgroup'), group = join(cgroupRoot, 'system.slice', unit);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 }); await mkdir(group, { recursive: true });
  await writeFile(join(cgroupRoot, 'cgroup.controllers'), 'cpu memory pids\n');
  await writeFile(join(group, 'cgroup.events'), 'populated 0\n'); await writeFile(join(group, 'cgroup.procs'), '');
  const provenance = { version: 1, runtimeHandle: handle, profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
    profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION, profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
    workload: 'bot_agent', adapterId: 'matrix-bot', harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION, executionGeneration: '7' };
  const metadata = join(runtimeRoot, 'provenance.json');
  await writeFile(metadata, JSON.stringify(provenance), { mode: 0o600 });
  let onStop: () => Promise<void> = async () => undefined;
  const runCommand = vi.fn<ScopeRuntimeCommandRunner>(async (_command, args) => {
    if (args[0] === 'stop') { await onStop(); return { stdout: '' }; }
    if (args[0] !== 'show') throw new Error('Unexpected stop command');
    return { stdout: `Id=${unit}\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\nTasksCurrent=0\nControlGroup=/system.slice/${unit}\nJob=\n` };
  });
  const launcher = createSystemdScopeRuntimeLauncher({ stateRoot, sdkDirectory: root, nativeDirectory: root,
    workerFile: join(root, 'worker'), brokerSocket: join(root, 'broker'), runCommand, stopInspection: { cgroupRoot, timeoutMs, pollMs: 2 } });
  return { launcher, runCommand, metadata, provenance, onStop(fn: typeof onStop) { onStop = fn; } };
}

it.each(['explicit', 'lease'] as const)('shares exact stop proof and removal when %s cleanup starts first', async first => {
  const f = await fixture(2000);
  await writeFile(f.metadata, JSON.stringify({ ...f.provenance, profileId: SCOPE_RUNTIME_BOT_PROFILE_ID,
    profileVersion: SCOPE_RUNTIME_BOT_PROFILE_VERSION, profileDigest: SCOPE_RUNTIME_BOT_PROFILE_DIGEST,
    workload: 'bot_agent', adapterId: 'matrix-bot', harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION }));
  // Launch is a named fixture; stop uses the real launcher, provenance files and cgroup proof.
  const controller = await createScopeRuntimeController({ executionGeneration: '7', createRuntimeHandle: () => handle,
    launcher: { ...f.launcher, active: undefined, list: async () => [], start: async () => undefined,
      supportedAdapters: async () => [{ adapterId: 'matrix-bot', harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION, workloads: ['bot_agent'] }] } });
  const requestId = '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  f.onStop(async () => { entered = true; await gate; });
  const stops: Promise<unknown>[] = [];
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    await expect(controller.handle({ version: 1, type: 'runtime.create', requestId,
      scopeHandle: `scope_${'b'.repeat(32)}`, profileId: SCOPE_RUNTIME_BOT_PROFILE_ID, workload: 'bot_agent',
      adapterId: 'matrix-bot', harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
      sandbox: { version: 1, scopeHandle: `scope_${'b'.repeat(32)}`, actorId: 'owner',
        worktree: { hostPath: '/owned/project', mode: 'rw', fingerprint: 'c'.repeat(64) }, network: 'broker_only' },
    })).resolves.toMatchObject({ ok: true });
    if (first === 'lease') {
      vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 900_001);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(entered).toBe(true));
    }
    stops.push(controller.handle({ version: 1, type: 'runtime.stop', requestId, runtimeHandle: handle }));
    await vi.waitFor(() => expect(entered).toBe(true));
    if (first === 'explicit') await vi.advanceTimersByTimeAsync(30_000);
    stops.push(controller.handle({ version: 1, type: 'runtime.stop', requestId, runtimeHandle: handle }));
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.runCommand.mock.calls.filter(([, args]) => args[0] === 'stop')).toHaveLength(1);
    release();
    for (const stopped of stops) await expect(stopped).resolves.toMatchObject({ ok: true, state: 'stopped', executionGeneration: '7' });
    expect(controller.size()).toBe(0);
    await expect(readFile(f.metadata, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    release(); await Promise.allSettled(stops); await controller.close(); vi.restoreAllMocks(); vi.useRealTimers();
  }
});
