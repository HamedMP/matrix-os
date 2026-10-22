import { constants, lstat, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { RuntimeHandleSchema } from './protocol.js';
import type { ScopeRuntimeCommandRunner } from './systemd-launcher.js';
import type { ScopeRuntimeReconciledRuntime } from './supervisor.js';
/** Host-only fixture seam. No request may choose these paths or deadlines. */
export interface SystemdStopInspection {
  cgroupRoot?: string;
  timeoutMs?: number;
  pollMs?: number;
}
const KEYS = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID', 'TasksCurrent', 'ControlGroup', 'Job'] as const;
class StopUnavailable extends Error {
  constructor() {
    super('Scope runtime stop unavailable');
    this.name = 'ScopeRuntimeStopUnavailable';
  }
}
function missing(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
async function directory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new StopUnavailable();
}
async function boundedFile(path: string, max: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    // cgroup virtual files report size zero; read a bounded buffer, never readFile().
    if (!stat.isFile() || stat.size > max)
      throw new StopUnavailable();
    const buffer = Buffer.alloc(max + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > max)
      throw new StopUnavailable();
    return buffer.subarray(0, bytesRead).toString('utf8');
  }
  finally {
    await file.close();
  }
}
async function emptyCgroup(root: string, unit: string): Promise<void> {
  await directory(root);
  const controllers = await boundedFile(join(root, 'cgroup.controllers'), 4096);
  if (!/^[a-z0-9_ \n]*$/.test(controllers))
    throw new StopUnavailable();
  try {
    await directory(join(root, 'system.slice'));
    const group = join(root, 'system.slice', unit);
    await directory(group);
    const events = await boundedFile(join(group, 'cgroup.events'), 4096);
    const populated = events.trim().split('\n').filter(line => line.startsWith('populated '));
    if (populated.length !== 1 || populated[0] !== 'populated 0'
      || (await boundedFile(join(group, 'cgroup.procs'), 4096)).trim() !== '')
      throw new StopUnavailable();
  }
  catch (error: unknown) {
    // Missing events/procs is NOT absence of a cgroup. Recheck the group itself.
    if (!missing(error))
      throw error;
    try {
      await lstat(join(root, 'system.slice', unit));
    }
    catch (absent: unknown) {
      if (!missing(absent))
        throw absent;
      await directory(root);
      await boundedFile(join(root, 'cgroup.controllers'), 4096);
      return;
    }
    throw new StopUnavailable();
  }
}
function snapshot(stdout: string, unit: string): Record<typeof KEYS[number], string> {
  if (Buffer.byteLength(stdout) > 8192 || /[^\x20-\x7e\n]/.test(stdout))
    throw new StopUnavailable();
  const rows = stdout.trimEnd().split('\n');
  const value: Record<string, string> = {};
  for (const row of rows) {
    const at = row.indexOf('=');
    const key = row.slice(0, at);
    if (at < 1 || !KEYS.includes(key as typeof KEYS[number]) || key in value)
      throw new StopUnavailable();
    value[key] = row.slice(at + 1);
  }
  if (Object.keys(value).length !== KEYS.length || value.Id !== unit
    || !['loaded', 'not-found'].includes(value.LoadState!)
    || !['', `/system.slice/${unit}`].includes(value.ControlGroup!))
    throw new StopUnavailable();
  return value as Record<typeof KEYS[number], string>;
}
function terminal(value: ReturnType<typeof snapshot>): boolean {
  return ((value.ActiveState === 'inactive' && value.SubState === 'dead')
    || (value.ActiveState === 'failed' && value.SubState === 'failed'))
    && value.MainPID === '0' && value.ControlPID === '0'
    && ['0', '[not set]'].includes(value.TasksCurrent) && ['', '0'].includes(value.Job);
}
/** A receipt is possible only for known private provenance and a drained cgroup v2 unit.
 * A missing supervisor record, is-active exit code, or failed unit alone is never proof. */
export async function stopSystemdRuntime(input: {
  runtimeHandle: string;
  expectedGeneration?: string;
  readProvenance(): Promise<ScopeRuntimeReconciledRuntime | undefined>;
  runCommand: ScopeRuntimeCommandRunner;
  inspection?: SystemdStopInspection;
}): Promise<void> {
  const handle = RuntimeHandleSchema.parse(input.runtimeHandle);
  const unit = `matrix-scope-runtime-${handle.slice('runtime_'.length)}.service`;
  const root = input.inspection?.cgroupRoot ?? '/sys/fs/cgroup';
  const timeout = input.inspection?.timeoutMs ?? 15000;
  const poll = input.inspection?.pollMs ?? 25;
  if (!isAbsolute(root) || /[\0\r\n]/.test(root) || !Number.isInteger(timeout) || timeout < 1 || timeout > 30000
    || !Number.isInteger(poll) || poll < 1 || poll > 1000)
    throw new StopUnavailable();
  const deadline = performance.now() + timeout;
  const current = () => {
    if (performance.now() >= deadline) throw new StopUnavailable();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = async () => {
    const provenance = await input.readProvenance();
    current();
    if (!provenance || provenance.runtimeHandle !== handle
      || (input.expectedGeneration !== undefined && provenance.executionGeneration !== input.expectedGeneration))
      throw new StopUnavailable();
    const assertIdentity = async () => {
      current();
      const latest = await input.readProvenance();
      current();
      if (!latest || latest.runtimeHandle !== handle || latest.executionGeneration !== provenance.executionGeneration
        || latest.profileId !== provenance.profileId)
        throw new StopUnavailable();
    };
    const show = async () => {
      current();
      const result = await input.runCommand('/usr/bin/systemctl', ['show', unit, '--all', `--property=${KEYS.join(',')}`]);
      current();
      return snapshot(result.stdout, unit);
    };
    await show();
    await assertIdentity();
    let stopFailed = false;
    try {
      await input.runCommand('/usr/bin/systemctl', ['stop', unit]);
    }
    catch (error: unknown) {
      if (!(error instanceof Error))
        throw new StopUnavailable();
      stopFailed = true;
    }
    current();
    while (true) {
      await assertIdentity();
      const state = await show();
      if (stopFailed && state.LoadState !== 'not-found')
        throw new StopUnavailable();
      if (terminal(state)) {
        await emptyCgroup(root, unit);
        await assertIdentity();
        // Recheck systemd after filesystem awaits: no activation job may have appeared.
        if (!terminal(await show()))
          throw new StopUnavailable();
        await assertIdentity();
        return;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(poll, Math.max(1, deadline - performance.now()))));
      current();
    }
  };
  try {
    await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StopUnavailable()), timeout);
      })]);
  }
  catch (error: unknown) {
    if (error instanceof StopUnavailable)
      throw error;
    throw new StopUnavailable();
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer);
  }
}
