import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { promisify } from "node:util";

const SYSTEMD_RUN_PATH = "/usr/bin/systemd-run";
const SYSTEMCTL_PATH = "/usr/bin/systemctl";
const USER_WORKLOAD_SLICE_PATH = "/etc/systemd/user/matrix-terminal.slice";
const PROVIDER_SCOPE_PREFIX = "matrix-chat-provider-";
const PROVIDER_SCOPE_PATTERN = /^matrix-chat-provider-[a-f0-9]{32}\.scope$/;
const PROVIDER_MEMORY_HIGH = "1G";
const PROVIDER_MEMORY_MAX = "1536M";
const PROVIDER_TASKS_MAX = "1024";
const SYSTEMCTL_TIMEOUT_MS = 5_000;
const MAX_STALE_PROVIDER_SCOPES = 100;

export interface ProviderProcessLaunchInput {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ProviderProcessLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  isolated: boolean;
  unitName?: string;
}

interface IsolationProbe {
  platform?: NodeJS.Platform;
  uid?: number;
  unitName?: string;
  pathExists?: (path: string) => boolean;
}

type SystemctlRun = (
  command: string,
  args: string[],
  options: {
    env: Record<string, string>;
    timeout: number;
    encoding: "utf8";
    maxBuffer: number;
  },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile);
const defaultSystemctlRun: SystemctlRun = async (command, args, options) => {
  const result = await execFileAsync(command, args, options);
  return { stdout: result.stdout, stderr: result.stderr };
};

function userSystemdRuntimeDir(probe: IsolationProbe): string | null {
  const platform = probe.platform ?? process.platform;
  const uid = probe.uid ?? process.getuid?.();
  const pathExists = probe.pathExists ?? existsSync;
  const runtimeDir = typeof uid === "number" && uid > 0 ? `/run/user/${uid}` : null;
  return platform === "linux"
      && runtimeDir !== null
      && process.env.MATRIX_PROVIDER_PROCESS_ISOLATION !== "0"
      && pathExists(SYSTEMD_RUN_PATH)
      && pathExists(SYSTEMCTL_PATH)
      && pathExists(USER_WORKLOAD_SLICE_PATH)
      && pathExists(`${runtimeDir}/bus`)
    ? runtimeDir
    : null;
}

function userSystemdEnvironment(runtimeDir: string, env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    XDG_RUNTIME_DIR: runtimeDir,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
  };
}

export function buildIsolatedProviderLaunch(
  input: ProviderProcessLaunchInput,
  probe: IsolationProbe = {},
): ProviderProcessLaunch {
  const runtimeDir = userSystemdRuntimeDir(probe);
  if (runtimeDir === null) {
    return { ...input, isolated: false };
  }
  const unitName = probe.unitName ?? `${PROVIDER_SCOPE_PREFIX}${randomUUID().replaceAll("-", "")}`;

  return {
    command: SYSTEMD_RUN_PATH,
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      `--unit=${unitName}`,
      "--slice=matrix-terminal.slice",
      `--property=MemoryHigh=${PROVIDER_MEMORY_HIGH}`,
      `--property=MemoryMax=${PROVIDER_MEMORY_MAX}`,
      `--property=TasksMax=${PROVIDER_TASKS_MAX}`,
      "--",
      input.command,
      ...input.args,
    ],
    env: userSystemdEnvironment(runtimeDir, input.env),
    isolated: true,
    unitName,
  };
}

export async function cleanupStaleIsolatedProviderProcesses(options: IsolationProbe & {
  env?: Record<string, string>;
  runCommand?: SystemctlRun;
} = {}): Promise<number> {
  const runtimeDir = userSystemdRuntimeDir(options);
  if (runtimeDir === null) return 0;
  const env = userSystemdEnvironment(runtimeDir, options.env ?? process.env as Record<string, string>);
  const runCommand = options.runCommand ?? defaultSystemctlRun;
  const commandOptions = {
    env,
    timeout: SYSTEMCTL_TIMEOUT_MS,
    encoding: "utf8" as const,
    maxBuffer: 128 * 1024,
  };
  try {
    const listed = await runCommand(SYSTEMCTL_PATH, [
      "--user",
      "list-units",
      `${PROVIDER_SCOPE_PREFIX}*.scope`,
      "--all",
      "--no-legend",
      "--plain",
    ], commandOptions);
    const units = listed.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/, 1)[0])
      .filter((unit): unit is string => unit !== undefined && PROVIDER_SCOPE_PATTERN.test(unit))
      .slice(0, MAX_STALE_PROVIDER_SCOPES);
    if (units.length === 0) return 0;
    await runCommand(SYSTEMCTL_PATH, ["--user", "stop", ...units], commandOptions);
    return units.length;
  } catch (error: unknown) {
    console.warn(
      "[coding-agents] stale provider scope cleanup failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return 0;
  }
}

/**
 * Provider CLIs can be substantially larger than the Gateway itself. On a
 * customer VPS, move them into the bounded user workload slice so the
 * Gateway's MemoryMax cannot kill every active Chat when one CLI grows.
 *
 * The isolated launch gets its own process group. Cancellation targets that
 * group so the CLI and any tools it started cannot outlive the canonical Run.
 */
export function spawnIsolatedProviderProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    stdio: ["ignore", "pipe", "pipe"];
  },
): ChildProcessByStdio<null, Readable, Readable> {
  const launch = buildIsolatedProviderLaunch({ command, args, env: options.env });
  const child = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: launch.env,
    stdio: options.stdio,
    detached: launch.isolated,
  });
  if (!launch.isolated) return child;

  const directKill = child.kill.bind(child);
  child.kill = ((signal?: number | NodeJS.Signals) => {
    if (launch.unitName) {
      try {
        const stop = spawn(SYSTEMCTL_PATH, ["--user", "stop", `${launch.unitName}.scope`], {
          env: launch.env,
          stdio: "ignore",
        });
        stop.unref();
      } catch (error: unknown) {
        console.warn(
          "[coding-agents] provider scope stop failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal ?? "SIGTERM");
        return true;
      } catch (error: unknown) {
        // The wrapper may have already exited or changed process groups.
        console.warn(
          "[coding-agents] provider process group signal failed",
          error instanceof Error ? error.name : "UnknownError",
        );
      }
    }
    return directKill(signal);
  }) as typeof child.kill;
  return child;
}
