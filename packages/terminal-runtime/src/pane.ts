import { spawn } from 'node:child_process';
import { type Stats } from 'node:fs';
import { type FileHandle, lstat, open, readFile, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { spawn as spawnPty } from 'node-pty';
import {
  AgentConfigurationSchema,
  RuntimeIdSchema,
  type AgentConfiguration,
} from './contracts.js';
import {
  createAgentConfigurationStore,
  defaultAgentConfigurationDirectory,
} from './agent-configurations.js';

const SAFE_ENVIRONMENT_KEYS = [
  'HOME',
  'LANG',
  'MATRIX_HOME',
  'PATH',
  'TERM',
] as const;
const DEFAULT_HOME = '/home/matrix/home';
const CODEX_RUNNER =
  '/opt/matrix/libexec/terminal-runtime/current/codex-app-server-runner.mjs';

export type ProviderLaunch = {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string | null;
  fdPayload: string | null;
  fdPayloadFile?: boolean;
  interactivePty?: boolean;
};

export function paneEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value) environment[key] = value;
  }
  environment.PATH = '/home/matrix/home/.local/bin:/opt/matrix/bin:/opt/matrix/runtime/node/bin:/usr/local/bin:/usr/bin:/bin';
  return environment;
}

function ownerPath(home: string, relativePath: string): string {
  const root = resolve(home);
  const target = resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error('agent_cwd_invalid');
  }
  return target;
}

function absoluteRoots(
  roots: AgentConfiguration['sandbox']['writableRoots'],
  home: string,
): string[] {
  return roots.map((root) => ownerPath(home, root.path));
}

function claudePermissionMode(
  configuration: AgentConfiguration,
): 'default' | 'dontAsk' | 'plan' | 'bypassPermissions' {
  if (configuration.approvalPolicy === 'on-failure') {
    throw new Error('claude_approval_policy_unsupported');
  }
  if (configuration.mode === 'plan' || configuration.mode === 'review') {
    return 'plan';
  }
  if (
    configuration.approvalPolicy === 'never' &&
    (
      configuration.sandbox.mode === 'danger-full-access' ||
      !configuration.sandbox.enabled
    )
  ) {
    return 'bypassPermissions';
  }
  if (
    configuration.sandbox.enabled &&
    configuration.sandbox.mode !== 'danger-full-access' &&
    ['on-request', 'never'].includes(configuration.approvalPolicy)
  ) {
    return 'dontAsk';
  }
  return 'default';
}

function claudeSettings(
  configuration: AgentConfiguration,
  home: string,
): Record<string, unknown> {
  return {
    permissions: {
      defaultMode: claudePermissionMode(configuration),
    },
    sandbox: {
      enabled: configuration.sandbox.enabled,
      failIfUnavailable: configuration.sandbox.enabled,
      allowUnsandboxedCommands: false,
      filesystem: {
        allowWrite: absoluteRoots(
          configuration.sandbox.writableRoots,
          home,
        ),
        denyWrite: absoluteRoots(
          configuration.sandbox.denyWriteRoots,
          home,
        ),
      },
    },
  };
}

export function buildProviderLaunch(
  rawConfiguration: AgentConfiguration,
  home = DEFAULT_HOME,
): ProviderLaunch {
  const configuration = AgentConfigurationSchema.parse(rawConfiguration);
  const cwd = ownerPath(home, configuration.cwd.path);
  const environment = paneEnvironment({
    ...process.env,
    HOME: home,
    MATRIX_HOME: home,
  });
  switch (configuration.agent) {
    case 'claude':
      return {
        file: 'claude',
        args: [
          '--setting-sources',
          '',
          '--settings',
          '/proc/self/fd/3',
          '--strict-mcp-config',
          '--no-chrome',
          ...(configuration.prompt ? ['--print'] : []),
        ],
        cwd,
        env: environment,
        stdin: configuration.prompt ?? null,
        fdPayload: JSON.stringify(claudeSettings(configuration, home)),
        fdPayloadFile: true,
      };
    case 'codex': {
      if (
        !configuration.prompt ||
        !configuration.providerEventPath ||
        !configuration.codexExpectedVersion
      ) {
        throw new Error('codex_configuration_invalid');
      }
      return {
        file: process.execPath,
        args: [CODEX_RUNNER, '--fd-config'],
        cwd,
        env: environment,
        stdin: null,
        fdPayload: JSON.stringify({
          ...(configuration.codexExecutable
            ? { command: configuration.codexExecutable }
            : {}),
          eventPath: ownerPath(home, configuration.providerEventPath),
          expectedVersion: configuration.codexExpectedVersion,
          config: {
            prompt: configuration.prompt,
            approvalPolicy: configuration.approvalPolicy === 'on-failure'
              ? 'on-request'
              : configuration.approvalPolicy,
            sandbox: configuration.sandbox.enabled
              ? configuration.sandbox.mode ?? 'workspace-write'
              : 'danger-full-access',
            writableRoots: absoluteRoots(
              configuration.sandbox.writableRoots,
              home,
            ),
          },
        }),
      };
    }
    case 'opencode':
      return {
        file: 'opencode',
        args: ['run'],
        cwd,
        env: environment,
        stdin: configuration.prompt ?? null,
        fdPayload: JSON.stringify(configuration),
      };
    case 'pi':
      return {
        file: '/opt/matrix/runtime/node/bin/pi',
        args: ['--offline'],
        cwd,
        env: environment,
        stdin: configuration.prompt ?? null,
        fdPayload: null,
        interactivePty: configuration.prompt === undefined,
      };
  }
}

async function waitForInteractivePty(launch: ProviderLaunch): Promise<number> {
  return await new Promise<number>((resolveChild) => {
    const child = spawnPty(launch.file, launch.args, {
      name: 'xterm-256color', cols: process.stdout.columns || 120, rows: process.stdout.rows || 40, cwd: launch.cwd, env: launch.env,
    });
    const wasRaw = process.stdin.isRaw;
    const input = (data: Buffer): void => child.write(data.toString('utf8'));
    const resize = (): void => child.resize(process.stdout.columns || 120, process.stdout.rows || 40);
    const output = child.onData((data) => process.stdout.write(data));
    process.stdin.setRawMode?.(true); process.stdin.on('data', input); process.on('SIGWINCH', resize);
    child.onExit(({ exitCode }) => {
      output.dispose(); process.stdin.removeListener('data', input); process.removeListener('SIGWINCH', resize);
      process.stdin.setRawMode?.(wasRaw); resolveChild(exitCode);
    });
  });
}

async function removePayloadFile(
  path: string, identity: Pick<Stats, 'dev' | 'ino'>,
): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.dev === identity.dev && current.ino === identity.ino)
      await unlink(path);
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
}

export async function waitForChild(
  launch: ProviderLaunch,
  spawnChild = spawn,
  fdPayloadPath?: string,
): Promise<number> {
  if (launch.interactivePty) return await waitForInteractivePty(launch);
  let payloadHandle: FileHandle | null = null;
  let payloadIdentity: Stats | null = null;
  if (launch.fdPayloadFile) {
    if (launch.fdPayload === null || !fdPayloadPath) {
      throw new Error('agent_configuration_file_unavailable');
    }
    payloadHandle = await open(fdPayloadPath, 'wx+', 0o600);
    const bytes = Buffer.from(launch.fdPayload, 'utf8');
    payloadIdentity = await payloadHandle.stat();
    try {
      if (!payloadIdentity.isFile() || payloadIdentity.nlink !== 1)
        throw new Error('agent_configuration_file_invalid');
      await payloadHandle.write(bytes, 0, bytes.byteLength, 0);
      await payloadHandle.sync();
    } catch (error: unknown) {
      try {
        await payloadHandle.close();
      } finally {
        await removePayloadFile(fdPayloadPath, payloadIdentity);
      }
      throw error;
    }
  }
  return await new Promise<number>((resolveChild, rejectChild) => {
    const child = spawnChild(launch.file, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      shell: false,
      stdio: [
        launch.stdin === null ? 'inherit' : 'pipe',
        'inherit',
        'inherit',
        launch.fdPayload === null ? 'ignore' : payloadHandle?.fd ?? 'pipe',
      ],
    });
    child.once('error', (error: Error) => rejectChild(error));
    child.once('exit', (code, signal) => {
      if (signal !== null) resolveChild(128);
      else resolveChild(code ?? 1);
    });
    if (launch.stdin !== null) child.stdin?.end(launch.stdin);
    if (launch.fdPayload !== null && !payloadHandle) {
      const configurationPipe = child.stdio[3];
      if (
        configurationPipe &&
        'end' in configurationPipe &&
        typeof configurationPipe.end === 'function'
      ) {
        configurationPipe.end(launch.fdPayload);
      } else {
        child.kill('SIGTERM');
        rejectChild(new Error('agent_configuration_pipe_unavailable'));
      }
    }
  }).finally(async () => {
    try {
      await payloadHandle?.close();
    } finally {
      if (fdPayloadPath && payloadIdentity) {
        await removePayloadFile(fdPayloadPath, payloadIdentity);
      }
    }
  });
}

export async function runPane(kind: string | undefined): Promise<number> {
  if (kind === 'shell') {
    return await waitForChild({
      file: '/bin/bash',
      args: ['--login'],
      cwd: process.cwd(),
      env: paneEnvironment(),
      stdin: null,
      fdPayload: null,
    });
  }
  if (kind !== 'agent') return 64;
  const configurationRef = runtimeIdFromCgroup(
    await readFile('/proc/self/cgroup', 'utf8'),
  );
  const store = createAgentConfigurationStore();
  const configuration = await store.claim(configurationRef);
  const payloadPath = configuration.agent === 'claude'
    ? join(defaultAgentConfigurationDirectory(), configurationRef) : undefined;
  return await waitForChild(buildProviderLaunch(configuration), spawn, payloadPath);
}

export function paneExitLifecycleCode(
  kind: string | undefined,
  exitCode: number,
): string | null {
  if (kind !== 'agent' || !Number.isInteger(exitCode) || exitCode < 0 ||
    exitCode > 255) return null;
  return `terminal_pane_agent_exit_${exitCode}`;
}

export function runtimeIdFromCgroup(membership: string): string {
  const unified = membership.split(/\r?\n/)
    .filter((line) => line.startsWith('0::'));
  if (unified.length !== 1 || unified[0].includes('..')) {
    throw new Error('agent_cgroup_invalid');
  }
  const match = /(?:^|\/)matrix-terminal\.slice\/matrix-terminal-session@([0-9a-f]{32})\.service$/
    .exec(unified[0].slice(3));
  if (!match) throw new Error('agent_cgroup_invalid');
  return RuntimeIdSchema.parse(match[1]);
}

async function runPaneEntrypoint(kind: string | undefined): Promise<number> {
  try {
    const exitCode = await runPane(kind);
    const lifecycleCode = paneExitLifecycleCode(kind, exitCode);
    if (lifecycleCode) process.stderr.write(`${lifecycleCode}\n`);
    return exitCode;
  } catch (error: unknown) {
    const suffix = error instanceof Error ? '' : '_non_error';
    process.stderr.write(`terminal_pane_failed${suffix}\n`);
    return 16;
  }
}

if (process.argv[1]?.endsWith('/pane.js')) {
  process.exitCode = await runPaneEntrypoint(process.argv[2]);
}
