import { chownSync } from "node:fs";
import { chmod, chown, link, lstat, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandSocketInodePinner } from "../../packages/scope-runtime/src/command-socket-pin.js";
import type { CommandIdentityBinding } from "../../packages/scope-runtime/src/command-host-identity.js";
import { createUnixSocketTempDir } from "./unix-socket-temp.js";

/** Owned macOS/Linux filesystem fixture, NOT root/DynamicUser or descriptor qualification. */
export function commandIdentityFixture(root: string) {
  chownSync(root, process.getuid!(), process.getgid!());
  return { namespaceTrust: { root, uid: process.getuid!(), ipcGid: process.getgid!() },
    async resolveCommandTrust(binding: CommandIdentityBinding) { return { ...binding.parent, workloadUid: process.getuid!() }; } };
}

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
