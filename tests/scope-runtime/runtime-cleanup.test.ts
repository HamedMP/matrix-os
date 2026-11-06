import { chmod, lstat, mkdir, opendir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupOrphanedRuntimeDirectories } from "../../packages/scope-runtime/src/runtime-directories.js";
import { createSystemdScopeRuntimeLauncher } from "../../packages/scope-runtime/src/systemd-launcher.js";
import { commandIdentityFixture } from "../helpers/command-ipc-fixture.js";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
const clean: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const suffix = "a".repeat(32), handle = "runtime_" + suffix, unit = `matrix-devstack-owned-scope-runtime-${suffix}.service`;
async function fixture(options: { bad?: string; orphan?: boolean } = {}) {
  const root = await createUnixSocketTempDir(); clean.push(() => rm(root, { recursive: true, force: true }));
  const identity = commandIdentityFixture(root), stateRoot = join(root, "s"), commandSocketRoot = join(root, "c");
  const runtimeRoot = join(stateRoot, "runtimes", suffix), commandDirectory = join(commandSocketRoot, suffix);
  if (!options.orphan) await mkdir(join(runtimeRoot, "root"), { recursive: true });
  await mkdir(commandDirectory, { recursive: true }); await writeFile(join(commandDirectory, "worker.sock"), "retained-owner-data");
  let stopped = false;
  const execute = vi.fn(async (_command: string, args: readonly string[]) => {
    if (args[0] === "list-units") return { stdout: "" };
    if (args[0] === "is-active") throw Object.assign(new Error("deactivating"), { code: 3 });
    if (args[0] === "stop") {
      expect(await readFile(join(commandDirectory, "worker.sock"), "utf8")).toBe("retained-owner-data");
      if (options.bad === "stop-error") throw Object.assign(new Error("uncertain stop"), { code: 3 });
      stopped = true; return { stdout: "" };
    }
    if (args[0] === "show") {
      if (options.bad === "observe-error") throw new Error("PID1 unavailable");
      const missing = options.bad === "missing-live" || options.bad === "missing";
      const fields: Record<string, string> = { Id: unit, LoadState: missing ? "not-found" : "loaded", ActiveState: missing || stopped ? "inactive" : "deactivating",
        SubState: missing || stopped ? "dead" : "stop-sigterm", MainPID: missing || stopped ? "0" : "1234", ControlPID: "0",
        ControlGroup: missing || stopped ? "" : `/system.slice/${unit}`, KillMode: "control-group", RootDirectory: missing ? "" : join(runtimeRoot, "root") };
      if (options.bad === "wrong-unit") fields.Id = "foreign.service";
      if (options.bad === "wrong-root") fields.RootDirectory = "/foreign/root";
      if (options.bad === "wrong-kill-mode") fields.KillMode = "process";
      if (options.bad === "missing-live") fields.MainPID = "1234";
      if (stopped && options.bad === "still-live") fields.ControlGroup = `/system.slice/${unit}`;
      return { stdout: Object.entries(fields).map(([key, value]) => `${key}=${value}`).join("\n") };
    }
    return { stdout: "" };
  });
  const manager = createSystemdScopeRuntimeLauncher({ ...identity, namespace: "owned", stateRoot, commandSocketRoot,
    sdkDirectory: root, nativeDirectory: root, workerFile: join(root, "unused"), brokerSocket: join(root, "unused.sock"), runCommand: execute });
  return { root, manager, execute, runtimeRoot, commandDirectory, paths: { stateRoot, commandSocketRoot, namespaceTrust: identity.namespaceTrust } };
}
it.each(["wrong-unit", "wrong-root", "wrong-kill-mode", "missing-live", "observe-error", "stop-error", "still-live"])("preserves artifacts and failure evidence when unit closure is uncertain: %s", async bad => {
  const f = await fixture({ bad });
  await expect(f.manager.stop(handle)).rejects.toThrow();
  expect(await readFile(join(f.commandDirectory, "worker.sock"), "utf8")).toBe("retained-owner-data");
  expect(f.execute.mock.calls.some(([, args]) => args[0] === "reset-failed")).toBe(false);
  if (!["stop-error", "still-live"].includes(bad)) expect(f.execute.mock.calls.some(([, args]) => args[0] === "stop")).toBe(false);
});
it("awaits scoped stop and terminal observation for a deactivating unit before deleting retained artifacts", async () => {
  const f = await fixture(); const stage = join(f.commandDirectory, ".w-ABC123"); await mkdir(stage); await chmod(stage, 0o2700);
  await f.manager.stop(handle);
  expect(f.execute.mock.calls.map(([, args]) => args[0])).toEqual(["show", "stop", "show", "reset-failed"]);
  await expect(lstat(f.commandDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("uses explicit PID1 not-found/no-live-process evidence without signaling an absent unit", async () => {
  const f = await fixture({ bad: "missing" }); await f.manager.stop(handle);
  expect(f.execute.mock.calls.map(([, args]) => args[0])).toEqual(["show"]);
  await expect(lstat(f.commandDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("quiesces a command-only orphan even when the discovery snapshot omits its live unit", async () => {
  const f = await fixture({ orphan: true }); await f.manager.list();
  expect(f.execute.mock.calls.map(([, args]) => args[0])).toEqual(["list-units", "show", "stop", "show", "reset-failed"]);
  await expect(lstat(f.commandDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});
it("checks each suffix once across both roots and preserves a nonempty private staging directory", async () => {
  const f = await fixture(); const stage = join(f.commandDirectory, ".w-ABC123"); await mkdir(stage); await chmod(stage, 0o2700);
  await writeFile(join(stage, "owner-data"), "preserve");
  await expect(f.manager.list()).rejects.toThrow();
  expect(f.execute.mock.calls.filter(([, args]) => args[0] === "stop")).toHaveLength(1);
  expect(await readFile(join(stage, "owner-data"), "utf8")).toBe("preserve");
});

it("fails closed before orphan deletion when no quiescence callback is supplied", async () => {
  const f = await fixture({ orphan: true });
  await expect(cleanupOrphanedRuntimeDirectories(f.paths, new Set())).rejects.toThrow("authority unavailable");
  expect(await readFile(join(f.commandDirectory, "worker.sock"), "utf8")).toBe("retained-owner-data");
  expect(f.execute).not.toHaveBeenCalled();
});
it.each(["unexpected-directory", "staging-symlink"])("preserves unexpected command structure after unit closure: %s", async kind => {
  const f = await fixture(); const peer = join(f.root, "peer"); await mkdir(peer); await writeFile(join(peer, "sentinel"), "preserve");
  if (kind === "staging-symlink") await symlink(peer, join(f.commandDirectory, ".w-ABC123"));
  else await mkdir(join(f.commandDirectory, "unexpected"));
  await expect(f.manager.stop(handle)).rejects.toThrow("Unsafe");
  expect(await readFile(join(peer, "sentinel"), "utf8")).toBe("preserve");
  expect((await lstat(f.commandDirectory)).isDirectory()).toBe(true);
});

it("removes empty private staging through its parent without opening or chmodding the unreadable directory", async () => {
  const f = await fixture(); const stage = join(f.commandDirectory, ".w-ABC123"); await mkdir(stage); await chmod(stage, 0o2000);
  // This owned portable fixture models inaccessible02700 contents, not DynamicUser DAC.
  if (process.getuid?.() !== 0) await expect(opendir(stage)).rejects.toMatchObject({ code: "EACCES" });
  await f.manager.stop(handle);
  await expect(lstat(f.commandDirectory)).rejects.toMatchObject({ code: "ENOENT" });
});
