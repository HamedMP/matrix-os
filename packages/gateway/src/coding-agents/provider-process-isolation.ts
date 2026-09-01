import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";

const SYSTEMD_RUN_PATH = "/usr/bin/systemd-run";
const USER_WORKLOAD_SLICE_PATH = "/etc/systemd/user/matrix-terminal.slice";
const PROVIDER_MEMORY_HIGH = "1G";
const PROVIDER_MEMORY_MAX = "1536M";
const PROVIDER_TASKS_MAX = "1024";

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
}

interface IsolationProbe {
  platform?: NodeJS.Platform;
  uid?: number;
  pathExists?: (path: string) => boolean;
}

export function buildIsolatedProviderLaunch(
  input: ProviderProcessLaunchInput,
  probe: IsolationProbe = {},
): ProviderProcessLaunch {
  const platform = probe.platform ?? process.platform;
  const uid = probe.uid ?? process.getuid?.();
  const pathExists = probe.pathExists ?? existsSync;
  const runtimeDir = typeof uid === "number" && uid > 0 ? `/run/user/${uid}` : null;
  const canUseUserSystemd = platform === "linux"
    && runtimeDir !== null
    && process.env.MATRIX_PROVIDER_PROCESS_ISOLATION !== "0"
    && pathExists(SYSTEMD_RUN_PATH)
    && pathExists(USER_WORKLOAD_SLICE_PATH)
    && pathExists(`${runtimeDir}/bus`);

  if (!canUseUserSystemd) {
    return { ...input, isolated: false };
  }

  return {
    command: SYSTEMD_RUN_PATH,
    args: [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--slice=matrix-terminal.slice",
      `--property=MemoryHigh=${PROVIDER_MEMORY_HIGH}`,
      `--property=MemoryMax=${PROVIDER_MEMORY_MAX}`,
      `--property=TasksMax=${PROVIDER_TASKS_MAX}`,
      "--",
      input.command,
      ...input.args,
    ],
    env: {
      ...input.env,
      XDG_RUNTIME_DIR: runtimeDir,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
    },
    isolated: true,
  };
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
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal ?? "SIGTERM");
        return true;
      } catch {
        // The wrapper may have already exited or changed process groups.
      }
    }
    return directKill(signal);
  }) as typeof child.kill;
  return child;
}
