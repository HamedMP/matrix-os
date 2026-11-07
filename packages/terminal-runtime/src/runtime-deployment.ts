import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, opendir, readFile, realpath } from "node:fs/promises";
import { userInfo, type UserInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createDevStackTerminalProfile,
  DEVSTACK_TERMINAL_CONTROLLERS,
  DEVSTACK_TERMINAL_LIMITS,
  DEVSTACK_TERMINAL_MASKED_PATHS,
  devStackDaemonEnvironment,
  renderPrivateTerminalUnits,
  type DevStackTerminalProfile,
} from "./devstack-profile.js";

const execFileAsync = promisify(execFile);

export function resolveTerminalRuntimeDeployment(env: NodeJS.ProcessEnv) {
  if (env.MATRIX_TERMINAL_RUNTIME_NAMESPACE === undefined) {
    return {
      mode: "installed" as const,
      homePath: resolve(env.MATRIX_HOME ?? env.HOME ?? "/home/matrix/home"),
      appDir: resolve(env.MATRIX_APP_DIR ?? "/opt/matrix/app"),
      terminalRuntimeRoot: resolve(env.MATRIX_TERMINAL_RUNTIME_ROOT ?? "/opt/matrix/terminal-runtime"),
      socketPath: env.MATRIX_TERMINAL_RUNTIME_SOCKET ?? "/run/matrix/terminal-runtime.sock",
      generationLockHelperPath: "/opt/matrix/bin/matrix-terminal-generation-gc.py",
    };
  }
  const profile = createDevStackTerminalProfile(env.MATRIX_TERMINAL_RUNTIME_NAMESPACE, env.USER ?? "");
  const environment = devStackDaemonEnvironment(profile);
  for (const [key, expected] of Object.entries(environment)) {
    if (env[key] !== expected) throw new Error("terminal_profile_environment_mismatch: " + key);
  }
  return {
    mode: "isolated" as const,
    profile,
    environment,
    homePath: profile.homePath,
    appDir: profile.appDir,
    terminalRuntimeRoot: profile.terminalRuntimeRoot,
    socketPath: profile.socketPath,
    generationLockHelperPath: profile.generationLockHelperPath,
  };
}

interface CgroupLimits {
  cpu: string;
  memory: string;
  tasks: string;
}

interface IsolatedTerminalProcess {
  platform: string;
  uid?: number;
  effectiveUid?: number;
  gid?: number;
  effectiveGid?: number;
  groups?: number[];
  user: UserInfo<string>;
  groupName: string;
  execPath: string;
  networkDevices: string;
  cgroup: string;
  cgroupLimits: {
    delegatedControllers: string;
    manager: CgroupLimits;
    aggregate: CgroupLimits;
  };
  status: string;
}

export function assertIsolatedTerminalProcess(
  profile: DevStackTerminalProfile,
  processInfo: IsolatedTerminalProcess,
): void {
  const { uid, effectiveUid, gid, effectiveGid, groups, user, groupName, execPath,
    networkDevices, cgroup, cgroupLimits, status } = processInfo;
  if (processInfo.platform !== "linux" || uid === undefined || uid <= 0 || uid !== effectiveUid
    || gid === undefined || gid <= 0 || gid !== effectiveGid || groups?.length !== 1 || groups[0] !== gid
    || user.uid !== uid || user.gid !== gid || user.username !== profile.account || groupName !== profile.account
    || user.homedir !== profile.homePath || !/^\/(?:usr\/)?sbin\/nologin$/.test(user.shell ?? "")) {
    throw new Error("terminal_profile_identity_invalid");
  }
  const deviceNames = Array.from(networkDevices.matchAll(/^\s*([^:\s]+):\s/gm), match => match[1]);
  const delegated = cgroupLimits.delegatedControllers.trim().split(/\s+/);
  if (execPath !== profile.nodeBinary || cgroup.trimEnd() !== "0::" + profile.daemonControlGroup
    || deviceNames.length !== 1 || deviceNames[0] !== "lo"
    || !/^CapBnd:\s+0+$/m.test(status) || !/^CapEff:\s+0+$/m.test(status)
    || !/^NoNewPrivs:\s+1$/m.test(status)
    || !DEVSTACK_TERMINAL_CONTROLLERS.every(controller => delegated.includes(controller))
    || !matchesKernelLimits(cgroupLimits.manager, DEVSTACK_TERMINAL_LIMITS.manager)
    || !matchesKernelLimits(cgroupLimits.aggregate, DEVSTACK_TERMINAL_LIMITS.aggregate)) {
    throw new Error("terminal_profile_placement_invalid");
  }
}

function matchesKernelLimits(actual: CgroupLimits, expected: typeof DEVSTACK_TERMINAL_LIMITS.manager): boolean {
  const [quota, period, ...extra] = actual.cpu.trim().split(/\s+/).map(Number);
  return extra.length === 0 && Number.isSafeInteger(quota) && Number.isSafeInteger(period)
    && period > 0 && quota * 100 === expected.cpuPercent * period
    && actual.memory.trim() === String(expected.memoryMiB * 1024 * 1024)
    && actual.tasks.trim() === String(expected.tasks);
}

async function readCgroupLimits(root: string): Promise<CgroupLimits> {
  const [cpu, memory, tasks] = await Promise.all(
    ["cpu.max", "memory.max", "pids.max"].map(name => readFile(join(root, name), "utf8")),
  );
  return { cpu, memory, tasks };
}

async function assertHostPathsInaccessible(profile: DevStackTerminalProfile): Promise<void> {
  await Promise.all(DEVSTACK_TERMINAL_MASKED_PATHS.map(async (path) => {
    const canAccess = async (mode: number) => {
      try { await access(path, mode); }
      catch (error: unknown) {
        if (error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM"].includes(String(error.code))) return false;
        throw error;
      }
      return true;
    };
    if (await canAccess(constants.R_OK) || await canAccess(constants.W_OK) || await canAccess(constants.X_OK)) {
      throw new Error("terminal_profile_host_path_accessible: " + path);
    }
  }));
  const instances = await opendir(dirname(profile.instanceRoot));
  for await (const entry of instances) {
    if (entry.name !== profile.namespace) throw new Error("terminal_profile_peer_path_accessible");
  }
}

export async function assertPrivateTerminalUnitSelection(
  profile: DevStackTerminalProfile,
  showUnit: (unit: string) => Promise<string>,
): Promise<void> {
  // Query an instance: systemd applies template and instance drop-ins only when
  // loading an instance of a template.
  const definitions = [
    { unit: "matrix-zellij@rt_" + "0".repeat(32) + ".service", fragment: "matrix-zellij@.service",
      slice: "matrix-terminal.slice" },
    { unit: "matrix-terminal.slice", fragment: "matrix-terminal.slice" },
    { unit: profile.daemonUnit, fragment: profile.daemonUnit, slice: "matrix.slice",
      controlGroup: profile.daemonControlGroup },
    { unit: "default.target", fragment: "default.target" },
  ];
  await Promise.all(definitions.map(async ({ unit, fragment, slice, controlGroup }) => {
    const stdout = await showUnit(unit);
    const values = Object.fromEntries(stdout.split(/\r?\n/).map(line => line.split("=", 2)));
    if (values.LoadState !== "loaded" || values.NeedDaemonReload !== "no"
      || values.DropInPaths !== "" || values.FragmentPath !== join(profile.userUnitRoot, fragment)
      || (slice !== undefined && values.Slice !== slice)
      || (controlGroup !== undefined && values.ControlGroup !== controlGroup)) {
      throw new Error("terminal_profile_unit_mismatch: " + unit);
    }
  }));
}

async function requireCanonicalEntry(
  path: string,
  uid: number,
  kind: "directory" | "file" | "executable" | "socket",
  forbiddenMode: number,
) {
  const [stats, canonical] = await Promise.all([lstat(path), realpath(path)]);
  const matchesKind = kind === "directory" ? stats.isDirectory() : kind === "socket" ? stats.isSocket()
    : stats.isFile() && (kind !== "executable" || (stats.mode & 0o111) !== 0);
  if (!matchesKind || canonical !== path || stats.uid !== uid || (stats.mode & forbiddenMode) !== 0) {
    throw new Error("terminal_profile_path_invalid: " + path);
  }
  return stats;
}

/** Inspect the effective native placement before migration, restore or socket creation. */
export async function assertIsolatedTerminalPlacement(
  profile: DevStackTerminalProfile,
  environment: Record<string, string>,
  uid: number,
): Promise<void> {
  if (process.platform !== "linux") throw new Error("terminal_profile_identity_invalid");
  const gid = process.getgid?.();
  if (gid === undefined || gid <= 0) throw new Error("terminal_profile_identity_invalid");
  const managerRoot = "/sys/fs/cgroup" + profile.managerControlGroup;
  const [cgroup, status, networkDevices, group, delegatedControllers, manager, aggregate] = await Promise.all([
    readFile("/proc/self/cgroup", "utf8"), readFile("/proc/self/status", "utf8"),
    // The private manager allows only UNIX, IPv4 and IPv6 sockets. Reading procfs
    // avoids the NETLINK lookup that getifaddrs() uses on Linux.
    readFile("/proc/self/net/dev", "utf8"),
    execFileAsync("/usr/bin/getent", ["group", String(gid)], {
      env: environment, timeout: 2_000, maxBuffer: 4_096,
    }),
    readFile(join(managerRoot, "cgroup.subtree_control"), "utf8"),
    readCgroupLimits(managerRoot), readCgroupLimits(profile.cgroupRoot),
  ]);
  assertIsolatedTerminalProcess(profile, {
    platform: process.platform, uid, effectiveUid: process.geteuid?.(),
    gid, effectiveGid: process.getegid?.(), groups: process.getgroups?.(),
    user: userInfo(), groupName: group.stdout.split(":", 1)[0], execPath: process.execPath,
    networkDevices, cgroup, status,
    cgroupLimits: { delegatedControllers, manager, aggregate },
  });
  await assertHostPathsInaccessible(profile);
  const protectedDirectories = [
    dirname(profile.instanceRoot), profile.instanceRoot, profile.appDir,
    dirname(profile.nodePrefix), profile.nodePrefix, dirname(profile.nodeBinary),
    profile.terminalRuntimeRoot, join(profile.terminalRuntimeRoot, "generations"), profile.userUnitRoot,
  ];
  const [zellijRoot, zellijAlias] = await Promise.all([
    requireCanonicalEntry(profile.zellijSocketRoot, uid, "directory", 0o077),
    requireCanonicalEntry(profile.zellijSocketAlias, uid, "directory", 0o077),
    requireCanonicalEntry(profile.homePath, uid, "directory", 0o077),
    requireCanonicalEntry(profile.runtimeDirectory, uid, "directory", 0o077),
    requireCanonicalEntry(profile.socketDirectory, uid, "directory", 0o077),
    requireCanonicalEntry(profile.managerBus, uid, "socket", 0),
    requireCanonicalEntry(profile.nodeBinary, 0, "executable", 0o022),
    requireCanonicalEntry(profile.generationLockHelperPath, 0, "file", 0o022),
    requireCanonicalEntry(join(profile.appDir, "TERMINAL_RUNTIME_GENERATION"), 0, "file", 0o022),
    ...protectedDirectories.map(path => requireCanonicalEntry(path, 0, "directory", 0o022)),
  ]);
  if (zellijRoot.dev !== zellijAlias.dev || zellijRoot.ino !== zellijAlias.ino) {
    throw new Error("terminal_profile_placement_invalid");
  }
  await Promise.all(Object.entries(renderPrivateTerminalUnits(profile)).map(async ([name, expected]) => {
    const path = join(profile.userUnitRoot, name);
    const stats = await requireCanonicalEntry(path, 0, "file", 0o022);
    if (stats.size !== Buffer.byteLength(expected) || await readFile(path, "utf8") !== expected) {
      throw new Error("terminal_profile_unit_mismatch: " + name);
    }
  }));
  await assertPrivateTerminalUnitSelection(profile, async (unit) => {
    const { stdout } = await execFileAsync("/usr/bin/systemctl", [
      "--user", "show", "--all", "--no-pager",
      "--property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload,Slice,ControlGroup", unit,
    ], { env: environment, timeout: 10_000, maxBuffer: 64 * 1024 });
    return stdout;
  });
}

export async function assertIsolatedTerminalGeneration(
  profile: DevStackTerminalProfile,
  generation: string,
): Promise<void> {
  const directory = join(profile.terminalRuntimeRoot, "generations", generation);
  await Promise.all([
    requireCanonicalEntry(directory, 0, "directory", 0o022),
    requireCanonicalEntry(join(directory, "GENERATION"), 0, "file", 0o022),
    ...["zellij", "matrix-terminal-user-keeper.mjs", "matrix-terminal-attach.mjs"]
      .map(name => requireCanonicalEntry(join(directory, name), 0, "executable", 0o022)),
  ]);
}
