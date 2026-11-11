import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
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
const SCOPE_CLOSE_PROBE_TIMEOUT_MS = 1_250;
const CGROUP_ROOT = "/sys/fs/cgroup";

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

function populated(events: string): "0" | "1" | undefined {
  const entries = events.match(/^populated [01]$/gm);
  if (entries?.length !== 1) return undefined;
  return entries[0] === "populated 0" ? "0" : "1";
}

/** Require both the exact manager unit and kernel subtree to be drained before releasing recovery ownership. */
export async function probeProviderScopeClosed(input: { unitName: string; uid: number }, dependencies: {
  runCommand?: SystemctlRun;
  readEvents?: (path: string) => Promise<string>;
} = {}): Promise<boolean> {
  const scopeName = `${input.unitName}.scope`;
  if (!PROVIDER_SCOPE_PATTERN.test(scopeName) || !Number.isSafeInteger(input.uid) || input.uid <= 0) return false;
  const managerGroup = `/user.slice/user-${input.uid}.slice/user@${input.uid}.service`;
  const scopeGroup = `${managerGroup}/matrix.slice/matrix-terminal.slice/${scopeName}`;
  const run = dependencies.runCommand ?? defaultSystemctlRun;
  const read = dependencies.readEvents ?? (path => readFile(path, {
    encoding: "utf8", signal: AbortSignal.timeout(SCOPE_CLOSE_PROBE_TIMEOUT_MS),
  }));

  try {
    const shown = await run(SYSTEMCTL_PATH, ["--user", "show", "--all",
      "--property=Id,LoadState,ActiveState,SubState,Slice,ControlGroup", "--", scopeName], {
      env: userSystemdEnvironment(`/run/user/${input.uid}`, {}),
      timeout: SCOPE_CLOSE_PROBE_TIMEOUT_MS, encoding: "utf8", maxBuffer: 4_096,
    });
    if (shown.stderr.trim()) return false;
    const properties = new Map<string, string>();
    for (const line of shown.stdout.trim().split("\n")) {
      const separator = line.indexOf("=");
      const name = line.slice(0, separator);
      if (separator < 1 || properties.has(name)) return false;
      properties.set(name, line.slice(separator + 1));
    }
    if (properties.get("Id") !== scopeName || properties.get("ActiveState") !== "inactive"
      || properties.get("SubState") !== "dead") return false;
    const load = properties.get("LoadState"), slice = properties.get("Slice"), group = properties.get("ControlGroup");
    if (!(load === "loaded" && slice === "matrix-terminal.slice"
      || load === "not-found" && !slice) || group && group !== scopeGroup) return false;
    if (populated(await read(`${CGROUP_ROOT}${managerGroup}/cgroup.events`)) === undefined) return false;
    try {
      return populated(await read(`${CGROUP_ROOT}${scopeGroup}/cgroup.events`)) === "0";
    } catch (error: unknown) {
      // A collected group may disappear after systemctl returns. The readable
      // owner cgroup above distinguishes that from an unavailable cgroup mount.
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
      throw error;
    }
  } catch (error: unknown) {
    console.warn("[coding-agents] provider scope close proof unavailable", typeof error);
    return false;
  }
}

type ProviderStdio<In extends "ignore" | "pipe"> = [In, "pipe", "pipe"] | readonly [In, "pipe", "pipe", "pipe"];
type ProviderSpawnOptions<In extends "ignore" | "pipe"> = {
  cwd: string; env: Record<string, string>; stdio: ProviderStdio<In>; requireIsolation?: boolean;
};
type ScopedProviderProcess<In extends Writable | null> = ChildProcessByStdio<In, Readable, Readable> & {
  confirmScopeClosed?(): Promise<boolean>;
};

/**
 * Provider CLIs can be substantially larger than the Gateway itself. On a
 * customer VPS, move them into the bounded user workload slice so the
 * Gateway's MemoryMax cannot kill every active Chat when one CLI grows.
 *
 * The isolated launch gets its own process group. Cancellation targets that
 * group so the CLI and any tools it started cannot outlive the canonical Run.
 */
export function spawnIsolatedProviderProcess(
  command: string, args: string[],
  options: ProviderSpawnOptions<"ignore">,
): ScopedProviderProcess<null>;
export function spawnIsolatedProviderProcess(
  command: string, args: string[],
  options: ProviderSpawnOptions<"pipe">,
): ScopedProviderProcess<Writable>;
export function spawnIsolatedProviderProcess(
  command: string, args: string[],
  options: ProviderSpawnOptions<"ignore" | "pipe">,
): ScopedProviderProcess<Writable | null>;
export function spawnIsolatedProviderProcess(
  command: string,
  args: string[],
  options: ProviderSpawnOptions<"ignore" | "pipe">,
): ScopedProviderProcess<Writable | null> {
  const launch = buildIsolatedProviderLaunch({ command, args, env: options.env });
  if (options.requireIsolation && !launch.isolated) throw new Error("Provider process isolation unavailable");
  const spawnOptions = { cwd: options.cwd, env: launch.env, detached: launch.isolated };
  const child: ScopedProviderProcess<Writable | null> = options.stdio[0] === "pipe"
    ? spawn(launch.command, launch.args, { ...spawnOptions, stdio: options.stdio.length === 4 ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] })
    : spawn(launch.command, launch.args, { ...spawnOptions, stdio: options.stdio.length === 4 ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"] }) as ChildProcessByStdio<null, Readable, Readable>;
  if (!launch.isolated) return child;

  const uid = process.getuid?.();
  if (uid !== undefined && launch.unitName) {
    const identity = { unitName: launch.unitName, uid };
    let closed = false;
    child.once("close", () => { closed = true; });
    child.confirmScopeClosed = async () => {
      if (!closed) return false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (await probeProviderScopeClosed(identity)) return true;
        if (attempt < 2) await delay(100);
      }
      return false;
    };
  }

  const directKill = child.kill.bind(child);
  child.kill = ((signal?: number | NodeJS.Signals) => {
    if (uid !== undefined && launch.unitName) {
      try {
        const stop = spawn(SYSTEMCTL_PATH, ["--user", "stop", `${launch.unitName}.scope`], {
          env: userSystemdEnvironment(`/run/user/${uid}`, {}),
          stdio: "ignore",
        });
        stop.on("error", (error: unknown) => {
          console.warn("[coding-agents] provider scope stop failed", typeof error);
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
