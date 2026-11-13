import { spawn } from "node:child_process";
import { directoryChildArgs, waitForDirectoryChild, type DirectoryChildRunner } from "../../packages/scope-runtime/src/inherited-command-directory.js";
import type { RuntimeDirectoryOperations } from "../../packages/scope-runtime/src/runtime-directories.js";
import { chownSync } from "node:fs";
import { chmod, chown, link, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandSocketInodePinner } from "../../packages/scope-runtime/src/command-socket-pin.js";
import type { CommandIdentityBinding } from "../../packages/scope-runtime/src/command-host-identity.js";
import { createUnixSocketTempDir } from "./unix-socket-temp.js";

/** Owned macOS/Linux filesystem fixture, NOT root/DynamicUser or descriptor qualification. */
export function commandIdentityFixture(root: string) {
  chownSync(root, process.getuid!(), process.getgid!());
  return { namespaceTrust: { root, uid: process.getuid!(), ipcGid: process.getgid!() }, directoryOperations: portableDirectoryOperations,
    async resolveCommandTrust(binding: CommandIdentityBinding) { return { ...binding.parent, workloadUid: process.getuid!() }; } };
}

/** Real child + real exclusive mkdir. Only the Darwin setgid result and fd
 * pathname alias are explicitly modeled; this is not hardened Linux evidence. */
export const portableDirectoryChild: DirectoryChildRunner = async request => {
  const child = spawn(process.platform === "linux" ? "/usr/bin/mkdir" : "/bin/mkdir", directoryChildArgs(request,
    process.platform === "linux" ? "/proc/self/fd/3" : request.parentPath), {
    env: {}, cwd: "/", stdio: ["ignore", "pipe", "pipe", request.parentFd],
  });
  await waitForDirectoryChild(child);
  if (process.platform !== "linux") await chmod(join(request.parentPath, request.leaf), 0o2733);
};
export const portableDirectoryOperations: RuntimeDirectoryOperations = {
  async prepareAnchors(paths) {
    for (const [path, mode] of [[paths.stateRoot, 0o2700], [join(paths.stateRoot, "runtimes"), 0o2700],
      ...(paths.commandSocketRoot ? [[paths.commandSocketRoot, 0o2770] as const] : [])] as const) {
      try { await lstat(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(path, { recursive: true, mode }); await chmod(path, mode);
      }
    }
  },
  async createPrivate(path) {
    await mkdir(path, { mode: 0o700 });
    if (process.platform !== "linux") await chmod(path, 0o2700);
  },
  runChild: portableDirectoryChild,
};

/** Portable inode alias. Discount only this fixture's extra hardlink in policy checks. */
export const portablePublicationPin: CommandSocketInodePinner = async path => {
  const root = await createUnixSocketTempDir(), alias = join(root, "s");
  const parent = await lstat(dirname(path));
  try {
    await link(path, alias);
    return { path: alias, parentStat: async () => parent,
      async socketStat() { const value = await lstat(alias); value.nlink -= 1; return value; },
      async close() { await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
};
export async function commandPublicationFixture(path: string) {
  await chown(dirname(path), process.getuid!(), process.getgid!());
  await chmod(dirname(path), 0o2733);
  return { pin: portablePublicationPin, async createStaging(prefix: string) {
    const staging = await mkdtemp(prefix);
    // Darwin inherits parent GID but not setgid. Model Linux mkdir in this explicit fixture.
    await chmod(staging, 0o2700);
    return staging;
  } };
}

/** PID1 fixture for legacy lifecycle tests; the focused cleanup suite owns hostile observations. */
export function withCleanupUnitFixture(stateRoot: string, execute: (command: string, args: readonly string[]) => Promise<{ stdout: string }>) {
  const stopped = new Set<string>(); // Test-local, explicit128-entry cap.
  return async (command: string, args: readonly string[]) => {
    const result = await execute(command, args);
    if (command === "/usr/bin/systemd-run") stopped.delete(args.find(arg => arg.startsWith("--unit="))?.slice(7) ?? "");
    if (command !== "/usr/bin/systemctl") return result;
    if (args[0] === "stop") { if (stopped.size >= 128) throw new Error("Fixture capacity"); stopped.add(args[1]!); }
    if (args[0] !== "show" || !args.includes("--property=ControlGroup")) return result;
    const unit = args[1]!, suffix = /([a-f0-9]{32})\.service$/.exec(unit)?.[1];
    if (!suffix) throw new Error("Invalid fixture unit");
    const done = stopped.has(unit);
    return { stdout: Object.entries({ Id: unit, LoadState: "loaded", ActiveState: done ? "inactive" : "active", SubState: done ? "dead" : "running",
      MainPID: done ? "0" : "1234", ControlPID: "0", ControlGroup: done ? "" : `/system.slice/${unit}`, KillMode: "control-group",
      RootDirectory: join(stateRoot, "runtimes", suffix, "root") }).map(([key, value]) => `${key}=${value}`).join("\n") };
  };
}
