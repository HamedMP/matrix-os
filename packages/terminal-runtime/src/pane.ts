import { spawn } from 'node:child_process';
import { type Stats } from 'node:fs';
import { type FileHandle, lstat, open, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  AgentConfigurationSchema,
  OperationIdSchema,
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
};

export function paneEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value) environment[key] = value;
  }
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
        file: 'pi',
        args: [],
        cwd,
        env: environment,
        stdin: configuration.prompt ?? null,
        fdPayload: JSON.stringify(configuration),
      };
  }
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
  const configurationRef = OperationIdSchema.parse(
    process.env.MATRIX_TERMINAL_CONFIGURATION_REF,
  );
  const store = createAgentConfigurationStore();
  const configuration = await store.claim(configurationRef);
  const payloadPath = configuration.agent === 'claude'
    ? join(defaultAgentConfigurationDirectory(), configurationRef) : undefined;
  return await waitForChild(buildProviderLaunch(configuration), spawn, payloadPath);
}

if (process.argv[1]?.endsWith('/pane.js')) {
  process.exitCode = await runPane(process.argv[2]);
}
