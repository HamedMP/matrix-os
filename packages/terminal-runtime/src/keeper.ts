import { execFile as execFileCallback } from 'node:child_process';
import {
  readFile,
  realpath,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { spawn as spawnPty } from 'node-pty';
import {
  DescriptorSchema,
  RuntimeIdSchema,
  type Descriptor,
} from './contracts.js';
import { createAgentConfigurationStore } from './agent-configurations.js';
import { claimKeeperDescriptor } from './keeper-client.js';

const KEEPER_LAYOUT = '/opt/matrix/libexec/terminal-runtime/current/layout.kdl';
const AGENT_LAYOUT =
  '/opt/matrix/libexec/terminal-runtime/current/agent-layout.kdl';
const ZELLIJ_CONFIG =
  '/opt/matrix/libexec/terminal-runtime/current/config.kdl';
const ZELLIJ = '/opt/matrix/bin/zellij';
const DEFAULT_HOME = '/home/matrix/home';
const execFile = promisify(execFileCallback);

function recordKeeperFailure(error: unknown, code: string): void {
  const suffix = error instanceof Error ? '' : '_non_error';
  process.stderr.write(`${code}${suffix}\n`);
}

export type KeeperRoles = {
  keeper: number;
  zellijClient: number;
  zellijServer: number;
  shell: number;
};

export type KeeperEvidence = {
  clientAlive: boolean;
  sessionResponsive: boolean;
  confirmationGated?: boolean;
  roles: KeeperRoles | null;
};

export type KeeperLaunch = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

function ownerPath(home: string, relativePath: string): string {
  const root = resolve(home);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('keeper_cwd_invalid');
  }
  return target;
}

export async function validateKeeperCwd(
  home: string,
  relativePath: string,
): Promise<string> {
  try {
    const root = await realpath(home);
    const target = await realpath(ownerPath(root, relativePath));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error('keeper_cwd_invalid');
    }
    return target;
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'keeper_cwd_invalid') {
      throw error;
    }
    throw new Error('keeper_cwd_invalid', { cause: error });
  }
}

export function keeperEnvironment(
  home = DEFAULT_HOME,
  uid = process.getuid?.() ?? 1000,
): Record<string, string> {
  const stateRoot = join(home, 'system/terminal-runtime');
  return {
    HOME: home,
    MATRIX_HOME: home,
    PATH: `${home}/.local/bin:/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/bin:/bin`,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    XDG_CACHE_HOME: join(stateRoot, 'zellij-cache'),
    XDG_CONFIG_HOME: join(stateRoot, 'zellij-config-home'),
    XDG_DATA_HOME: join(stateRoot, 'zellij-data'),
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    ZELLIJ_CONFIG_DIR: '/opt/matrix/libexec/terminal-runtime/current',
    ZELLIJ_CONFIG_FILE: ZELLIJ_CONFIG,
  };
}

export function buildKeeperLaunch(
  rawDescriptor: Descriptor,
  home = DEFAULT_HOME,
): KeeperLaunch {
  const descriptor = DescriptorSchema.parse(rawDescriptor);
  const sessionName = `matrix-t-${descriptor.runtimeId}`;
  const environment = keeperEnvironment(home);
  return {
    file: ZELLIJ,
    args:
      descriptor.intent === 'recover' &&
      descriptor.recoveryMode !== 'fresh-shell'
      ? ['attach', sessionName]
      : [
          '--session',
          sessionName,
          '--new-session-with-layout',
          descriptor.launch.kind === 'agent' ? AGENT_LAYOUT : KEEPER_LAYOUT,
        ],
    cwd: ownerPath(home, descriptor.cwd.path),
    env: environment,
  };
}

export async function stageAgentConfiguration(
  rawDescriptor: Descriptor,
  runtimeIdInput: string,
  store: Pick<ReturnType<typeof createAgentConfigurationStore>,
    'claim' | 'publish' | 'remove'> = createAgentConfigurationStore(),
): Promise<void> {
  const descriptor = DescriptorSchema.parse(rawDescriptor);
  const runtimeId = RuntimeIdSchema.parse(runtimeIdInput);
  if (descriptor.runtimeId !== runtimeId)
    throw new Error('agent_configuration_identity_mismatch');
  if (descriptor.launch.kind !== 'agent') return;
  const configuration = await store.claim(descriptor.launch.configurationRef);
  try {
    await store.publish(runtimeId, configuration);
  } catch (error: unknown) {
    await store.remove(runtimeId);
    throw error;
  }
}

export async function waitForKeeperReadiness(options: {
  runtimeId: string;
  requiresConfirmation?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  readEvidence(): Promise<KeeperEvidence>;
  delay(ms: number): Promise<void>;
  notifyReady(evidence: { runtimeId: string; roles: KeeperRoles }): Promise<void>;
}): Promise<{ runtimeId: string; roles: KeeperRoles }> {
  const runtimeId = RuntimeIdSchema.parse(options.runtimeId);
  const timeoutMs = options.timeoutMs ?? 25_000;
  const pollMs = options.pollMs ?? 250;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('keeper_timeout_invalid');
  }
  if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000) {
    throw new Error('keeper_poll_invalid');
  }
  const deadline = Date.now() + timeoutMs;
  let readySamples = 0;
  while (Date.now() <= deadline) {
    const evidence = await options.readEvidence();
    if (!evidence.clientAlive) throw new Error('keeper_client_exited');
    if (
      evidence.sessionResponsive &&
      evidence.roles &&
      (!options.requiresConfirmation || evidence.confirmationGated === true)
    ) {
      if (++readySamples >= 5) {
        const ready = { runtimeId, roles: evidence.roles };
        await options.notifyReady(ready);
        return ready;
      }
    } else readySamples = 0;
    await options.delay(pollMs);
  }
  throw new Error('keeper_readiness_timeout');
}

export async function monitorKeeperOnce(options: {
  clientAlive: boolean;
  workloadAlive?: boolean;
  sessionResponds(): Promise<boolean>;
}): Promise<boolean> {
  return options.clientAlive && options.workloadAlive !== false &&
    await options.sessionResponds();
}

export function isKeeperEntrypoint(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  return moduleUrl.endsWith('/keeper.js') && argvPath.endsWith('/keeper.js');
}

async function exactSessionResponds(
  sessionName: string,
  environment: Record<string, string>,
): Promise<boolean> {
  try {
    const { stdout } = await execFile(
      ZELLIJ,
      ['list-sessions', '--no-formatting'],
      { env: environment, timeout: 2_000, maxBuffer: 64 * 1024 },
    );
    return stdout.split(/\r?\n/).some((line) =>
      line.trim().split(/\s+/, 1)[0] === sessionName);
  } catch (error: unknown) {
    if (error instanceof Error) return false;
    throw error;
  }
}

async function ownCgroup(runtimeId: string): Promise<string> {
  const membership = await readFile('/proc/self/cgroup', 'utf8');
  const unified = membership.split(/\r?\n/)
    .find((line) => line.startsWith('0::'));
  if (!unified) throw new Error('keeper_cgroup_invalid');
  const relative = unified.slice(3);
  const expected = `/matrix-terminal-session@${runtimeId}.service`;
  if (!relative.endsWith(expected) || relative.includes('..')) {
    throw new Error('keeper_cgroup_invalid');
  }
  return `/sys/fs/cgroup${relative}`;
}

export function directAgentProviderPid(
  processes: Array<{ pid: number; parentPid: number; args: string[] }>,
): number | undefined {
  const pane = processes.find((entry) =>
    entry.args.some((argument) => argument.endsWith('/pane.js')) &&
    entry.args.includes('agent'));
  return processes.find((entry) => entry.parentPid === pane?.pid)?.pid;
}

async function cgroupRoles(
  path: string,
  workloadKind: 'shell' | 'agent',
  requireWorkload: boolean,
): Promise<KeeperRoles | null> {
  const pids = (await readFile(`${path}/cgroup.procs`, 'utf8'))
    .split(/\s+/)
    .filter(Boolean)
    .map((value) => Number.parseInt(value, 10));
  const processes = (await Promise.all(pids.map(async (pid) => {
    try {
      const [comm, cmdline, status] = await Promise.all([
        readFile(`/proc/${pid}/comm`, 'utf8'),
        readFile(`/proc/${pid}/cmdline`),
        readFile(`/proc/${pid}/status`, 'utf8'),
      ]);
      const parentPid = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
      if (!parentPid) return null;
      return {
        pid,
        parentPid: Number.parseInt(parentPid, 10),
        comm: comm.trim(),
        args: cmdline.toString('utf8').split('\0').filter(Boolean),
      };
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }))).filter((value) => value !== null);
  const keeper = processes.find((entry) =>
    entry.args.some((argument) => argument.endsWith('/keeper.js')));
  const zellij = processes.filter((entry) =>
    entry.comm === 'zellij' && !entry.args.includes('list-sessions'))
    .sort((left, right) => left.pid - right.pid);
  const workloadPid = workloadKind === 'agent'
    ? directAgentProviderPid(processes)
    : processes.find((entry) => entry.comm === 'bash')?.pid;
  if (!keeper || zellij.length < 2 || (requireWorkload && !workloadPid)) {
    return null;
  }
  return {
    keeper: keeper.pid,
    zellijClient: zellij[0].pid,
    zellijServer: zellij[1].pid,
    shell: workloadPid ?? 0,
  };
}

async function notifySystemdReady(): Promise<void> {
  await execFile(
    '/usr/bin/systemd-notify',
    ['--ready', `--pid=${process.pid}`, '--status=terminal-runtime-ready'],
    { timeout: 2_000, maxBuffer: 16 * 1024 },
  );
}

export async function runKeeper(runtimeIdInput: string | undefined): Promise<number> {
  const runtimeId = RuntimeIdSchema.parse(runtimeIdInput);
  const descriptor = await claimKeeperDescriptor({ runtimeId });
  const launch = {
    ...buildKeeperLaunch(descriptor),
    cwd: await validateKeeperCwd(DEFAULT_HOME, descriptor.cwd.path),
  };
  const cgroup = await ownCgroup(runtimeId);
  const agentConfigurationStore = descriptor.launch.kind === 'agent'
    ? createAgentConfigurationStore()
    : null;
  if (agentConfigurationStore)
    await stageAgentConfiguration(descriptor, runtimeId, agentConfigurationStore);
  const sessionName = `matrix-t-${runtimeId}`;
  let clientAlive = true;
  let stopping = false;
  let exitCode = 0;
  let renderWindow = '';
  const requiresConfirmation =
    descriptor.intent === 'recover' &&
    descriptor.recoveryMode !== 'fresh-shell';
  const startsFresh =
    descriptor.intent === 'create' ||
    descriptor.recoveryMode === 'fresh-shell';
  let confirmationGated = !requiresConfirmation;
  let pty: ReturnType<typeof spawnPty> | null = null;
  try {
    pty = spawnPty(launch.file, launch.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: launch.cwd,
      env: launch.env,
    });
    pty.onData((data) => {
      // Inspect a bounded in-memory window only; never copy terminal contents
      // to journals or durable supervisor state.
      renderWindow = `${renderWindow}${data}`.slice(-16_384);
      if (
        !confirmationGated &&
        stripVTControlCharacters(renderWindow).includes('<ENTER> run')
      ) {
        confirmationGated = true;
      }
    });
    pty.onExit(() => {
      clientAlive = false;
      if (!stopping) exitCode = 17;
    });
    await waitForKeeperReadiness({
      runtimeId,
      requiresConfirmation,
      readEvidence: async () => ({
        clientAlive,
        confirmationGated,
        sessionResponsive: await exactSessionResponds(
          sessionName,
          launch.env,
        ),
        roles: await cgroupRoles(cgroup, descriptor.launch.kind, startsFresh),
      }),
      delay: async (milliseconds) =>
        await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
      notifyReady: async () => await notifySystemdReady(),
    });
    return await new Promise<number>((resolveKeeper) => {
      let checking = false;
      const monitor = setInterval(async () => {
        if (stopping || checking) return;
        checking = true;
        try {
          if (!await monitorKeeperOnce({
            clientAlive,
            workloadAlive: !startsFresh ||
              await cgroupRoles(cgroup, descriptor.launch.kind, true) !== null,
            sessionResponds: async () =>
              await exactSessionResponds(sessionName, launch.env),
          })) {
            stopping = true;
            clearInterval(monitor);
            resolveKeeper(exitCode || 18);
          }
        } catch (error: unknown) {
          recordKeeperFailure(error, 'terminal_keeper_monitor_failed');
          exitCode = 19;
          stopping = true;
          clearInterval(monitor);
          resolveKeeper(exitCode);
        } finally {
          checking = false;
        }
      }, 1_000);
      monitor.unref();
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        clearInterval(monitor);
        try {
          pty?.kill();
        } catch (error: unknown) {
          recordKeeperFailure(error, 'terminal_keeper_stop_failed');
          exitCode = 1;
        }
        resolveKeeper(exitCode);
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    });
  } finally {
    stopping = true;
    try {
      pty?.kill();
    } catch (error: unknown) {
      recordKeeperFailure(error, 'terminal_keeper_cleanup_failed');
      exitCode = 1;
    }
    if (agentConfigurationStore) {
      try {
        await agentConfigurationStore.remove(runtimeId);
      } catch (error: unknown) {
        recordKeeperFailure(error, 'terminal_keeper_configuration_cleanup_failed');
      }
    }
  }
}

if (isKeeperEntrypoint(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await runKeeper(process.argv[2]);
  } catch (error: unknown) {
    recordKeeperFailure(error, 'terminal_keeper_start_failed');
    process.exitCode = 16;
  }
}
