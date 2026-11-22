import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSystemdScopeRuntimeLauncher, type ScopeRuntimeCommandRunner } from '../../packages/scope-runtime/src/systemd-launcher.js';
import { createScopeRuntimeController } from '../../packages/scope-runtime/src/supervisor.js';
import { SCOPE_RUNTIME_PROFILE_ID, SCOPE_RUNTIME_PROFILE_VERSION, SCOPE_RUNTIME_PROFILE_DIGEST, SCOPE_RUNTIME_HARNESS_VERSION } from '../../packages/scope-runtime/src/profile.js';
const handle = `runtime_${'a'.repeat(32)}`;
const unit = `matrix-scope-runtime-${'a'.repeat(32)}.service`;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'systemd-stop-proof-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state');
  const runtimeRoot = join(stateRoot, 'runtimes', 'a'.repeat(32));
  const cgroupRoot = join(root, 'cgroup');
  const group = join(cgroupRoot, 'system.slice', unit);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await mkdir(group, { recursive: true });
  await writeFile(join(cgroupRoot, 'cgroup.controllers'), 'cpu memory pids\n');
  await writeFile(join(group, 'cgroup.events'), 'populated 0\nfrozen 0\n');
  await writeFile(join(group, 'cgroup.procs'), '');
  const provenance = { version: 1, runtimeHandle: handle, profileId: SCOPE_RUNTIME_PROFILE_ID, profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST, workload: 'chat_ai', adapterId: 'claude-code', harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION, executionGeneration: '7' };
  const metadata = join(runtimeRoot, 'provenance.json');
  await writeFile(metadata, JSON.stringify(provenance), { mode: 0o600 });
  let status: Record<string, string> = { Id: unit, LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlPID: '0', TasksCurrent: '0', ControlGroup: `/system.slice/${unit}`, Job: '' };
  let onStop: () => Promise<void> = async () => undefined;
  const runCommand = vi.fn<ScopeRuntimeCommandRunner>(async (_command, args) => {
    if (args[0] === 'is-active')
      throw Object.assign(new Error('not active'), { code: 3 });
    if (args[0] === 'stop') {
      await onStop();
      return { stdout: '' };
    }
    if (args[0] === 'show')
      return { stdout: Object.entries(status).map(([key, value]) => `${key}=${value}`).join('\n') + '\n' };
    return { stdout: '' };
  });
  const launcher = createSystemdScopeRuntimeLauncher({ stateRoot, sdkDirectory: root, nativeDirectory: root, workerFile: join(root, 'worker'), brokerSocket: join(root, 'broker'),
    runCommand, stopInspection: { cgroupRoot, timeoutMs: 100, pollMs: 2 } });
  return { launcher, runCommand, stateRoot, runtimeRoot, group, cgroupRoot, metadata, provenance,
    status(value: Partial<typeof status>) { status = { ...status, ...value }; }, onStop(fn: typeof onStop) { onStop = fn; } };
}
it.each(['activating', 'deactivating', 'failed'])('unconditionally stops a known %s unit and waits for actual quiescence', async (initial) => {
  const f = await fixture();
  f.status({ ActiveState: initial, SubState: initial === 'failed' ? 'failed' : 'stop-sigterm', MainPID: '123', TasksCurrent: '1' });
  await writeFile(join(f.group, 'cgroup.events'), 'populated 1\n');
  await writeFile(join(f.group, 'cgroup.procs'), '123\n');
  f.onStop(async () => { f.status({ ActiveState: 'inactive', SubState: 'dead', MainPID: '0', TasksCurrent: '0' }); await writeFile(join(f.group, 'cgroup.events'), 'populated 0\n'); await writeFile(join(f.group, 'cgroup.procs'), ''); });
  await f.launcher.stop(handle, '7');
  expect(f.runCommand).toHaveBeenCalledWith('/usr/bin/systemctl', ['stop', unit]);
  await expect(readFile(f.metadata, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['activating', 'deactivating', 'failed_process', 'remaining_tasks', 'remaining_descendant', 'pending_job', 'unknown', 'foreign_unit'])('refuses %s after stop and preserves private runtime metadata', async (kind) => {
  const f = await fixture();
  if (kind === 'activating' || kind === 'deactivating')
    f.status({ ActiveState: kind, SubState: 'start' });
  if (kind === 'failed_process')
    f.status({ ActiveState: 'failed', SubState: 'failed', MainPID: '12' });
  if (kind === 'remaining_tasks')
    f.status({ TasksCurrent: '1' });
  if (kind === 'remaining_descendant')
    await writeFile(join(f.group, 'cgroup.events'), 'populated 1\n');
  if (kind === 'pending_job')
    f.status({ Job: '123' });
  if (kind === 'unknown')
    f.status({ ActiveState: 'unknown' });
  if (kind === 'foreign_unit')
    f.status({ Id: 'other.service' });
  await expect(f.launcher.stop(handle, '7')).rejects.toThrow();
  expect(await readFile(f.metadata, 'utf8')).toContain('executionGeneration');
  if (kind === 'foreign_unit')
    expect(f.runCommand.mock.calls.some(([, args]) => args[0] === 'stop')).toBe(false);
});
it('only accepts a genuinely absent unit when exact prior provenance and cgroup absence are verified', async () => {
  const f = await fixture();
  f.status({ LoadState: 'not-found', ControlGroup: '', TasksCurrent: '[not set]' });
  await rm(f.group, { recursive: true });
  f.onStop(async () => { throw new Error('not found'); });
  await expect(f.launcher.stop(handle, '7')).resolves.toBeUndefined();
  const unknown = await fixture();
  await rm(unknown.metadata);
  await expect(unknown.launcher.stop(handle, '7')).rejects.toThrow();
  expect(unknown.runCommand).not.toHaveBeenCalled();
});
it.each(['generation', 'provenance_change', 'missing_v2', 'group_symlink', 'unknown_group'])('denies %s without erasing evidence', async (kind) => {
  const f = await fixture();
  if (kind === 'generation')
    await writeFile(f.metadata, JSON.stringify({ ...f.provenance, executionGeneration: '8' }));
  if (kind === 'provenance_change')
    f.onStop(async () => { await writeFile(f.metadata, JSON.stringify({ ...f.provenance, executionGeneration: '8' })); });
  if (kind === 'missing_v2')
    await rm(join(f.cgroupRoot, 'cgroup.controllers'));
  if (kind === 'group_symlink') {
    await rm(f.group, { recursive: true });
    await symlink(f.runtimeRoot, f.group);
  }
  if (kind === 'unknown_group')
    f.status({ ControlGroup: '/system.slice/unrelated.service' });
  await expect(f.launcher.stop(handle, '7')).rejects.toThrow();
  expect(await readFile(f.metadata, 'utf8')).toContain('executionGeneration');
});
it('does not issue a supervisor stopped ACK when the launcher cannot verify task absence', async () => {
  const f = await fixture();
  await writeFile(join(f.group, 'cgroup.events'), 'populated 1\n');
  const controller = await createScopeRuntimeController({ launcher: { ...f.launcher, supportedAdapters: undefined, active: undefined, list: async () => [{ runtimeHandle: handle, executionGeneration: '7' }] }, executionGeneration: '8' });
  const result = await controller.handle({ version: 1, type: 'runtime.stop', requestId: '018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1', runtimeHandle: handle });
  expect(result).toMatchObject({ ok: false, error: 'runtime_unavailable' });
  expect(controller.size()).toBe(1);
});
it('bounds a hung stop and never erases metadata after the late command returns', async () => {
  const f = await fixture();
  let release!: () => void;
  f.onStop(() => new Promise<void>(resolve => { release = resolve; }));
  await expect(f.launcher.stop(handle, '7')).rejects.toThrow('Scope runtime stop unavailable');
  expect(await readFile(f.metadata, 'utf8')).toContain('executionGeneration');
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(await readFile(f.metadata, 'utf8')).toContain('executionGeneration');
});
it.each(['missing_events', 'missing_procs', 'cgroup_tasks', 'duplicate_property', 'unknown_tasks'])('refuses incomplete or inconsistent %s proof', async (kind) => {
  const f = await fixture();
  if (kind === 'missing_events')
    await rm(join(f.group, 'cgroup.events'));
  if (kind === 'missing_procs')
    await rm(join(f.group, 'cgroup.procs'));
  if (kind === 'cgroup_tasks')
    await writeFile(join(f.group, 'cgroup.procs'), '42\n');
  if (kind === 'unknown_tasks')
    f.status({ TasksCurrent: 'unknown' });
  if (kind === 'duplicate_property')
    f.status({ Job: '\nId=' + unit });
  await expect(f.launcher.stop(handle, '7')).rejects.toThrow();
  expect(await readFile(f.metadata, 'utf8')).toContain('executionGeneration');
});
it('accepts a failed unit only after unconditional stop and confirmed task absence', async () => {
  const f = await fixture();
  f.status({ ActiveState: 'failed', SubState: 'failed', TasksCurrent: '[not set]', Job: '0' });
  await expect(f.launcher.stop(handle, '7')).resolves.toBeUndefined();
  expect(f.runCommand).toHaveBeenCalledWith('/usr/bin/systemctl', ['stop', unit]);
});
