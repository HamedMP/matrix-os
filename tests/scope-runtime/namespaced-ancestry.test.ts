import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { cleanupOrphanedRuntimeDirectories, createRuntimeDirectories } from "../../packages/scope-runtime/src/runtime-directories.js";
import { createSystemdScopeRuntimeLauncher, nextExecutionGeneration } from "../../packages/scope-runtime/src/systemd-launcher.js";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
import { createScopeRuntimeHost } from "../../packages/gateway/src/scope-runtime-host/index.js";
import { createScopeRuntimeBrokerServer } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";
import { SHARED_AI_PROFILE_CATALOG } from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";

const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of clean.splice(0).reverse()) await fn(); });
it.each(["generation", "orphan sweep", "unit stop", "reconciliation", "supervisor", "broker", "gateway host"])(
  "rejects redirected namespace parent before %s and preserves peer data, sockets and units", async operation => {
    const root = await createUnixSocketTempDir(); clean.push(() => rm(root, { recursive: true, force: true }));
    const peer = join(root, "p"), own = join(root, "o"), suffix = "a".repeat(32);
    const data = join(peer, "s/runtimes", suffix, "data"), gen = join(peer, "s/generation");
    await mkdir(join(peer, "s/runtimes", suffix), { recursive: true }); await mkdir(join(peer, "c", suffix), { recursive: true });
    await writeFile(gen, "41\n"); await writeFile(data, "preserve"); await symlink(peer, own);
    const connections = vi.fn(), sockets: Record<string, bigint> = {};
    for (const name of ["supervisor", "broker"]) {
      const socket = join(peer, name), server = createServer(c => { connections(); c.destroy(); });
      await new Promise<void>(resolve => server.listen(socket, resolve));
      clean.push(() => new Promise<void>(resolve => server.close(() => resolve())));
      sockets[name] = (await lstat(socket, { bigint: true })).ino;
    }
    const namespaceTrust = { root, uid: process.getuid!() };
    const paths = { namespace: "own", namespaceTrust, stateRoot: join(own, "s"), commandSocketRoot: join(own, "c"), brokerSocket: join(own, "broker") };
    const runCommand = vi.fn(async () => ({ stdout: "" }));
    const launcher = createSystemdScopeRuntimeLauncher({ ...paths, sdkDirectory: root, nativeDirectory: root, workerFile: join(root, "worker"), runCommand });
    const controller = { handle: vi.fn(), close() {} };
    const supervisor = createScopeRuntimeServer({ socketPath: join(own, "supervisor"), namespaceTrust, controller });
    const broker = createScopeRuntimeBrokerServer({ socketPath: paths.brokerSocket, namespaceTrust, broker: { handle: vi.fn(), close() {} } });
    const action = async () => {
      if (operation === "generation") return nextExecutionGeneration(join(own, "s/generation"), namespaceTrust);
      if (operation === "orphan sweep") return cleanupOrphanedRuntimeDirectories(paths, new Set());
      if (operation === "unit stop") return launcher.stop("runtime_" + suffix);
      if (operation === "reconciliation") return launcher.list();
      if (operation === "supervisor") { await supervisor.start(); clean.push(() => supervisor.close()); return; }
      if (operation === "broker") { await broker.start(); clean.push(() => broker.close()); return; }
      const host = await createScopeRuntimeHost({ homePath: root, supervisorSocket: join(own, "supervisor"), brokerSocket: paths.brokerSocket, namespaceTrust, profileCatalog: SHARED_AI_PROFILE_CATALOG });
      clean.push(() => host.close());
    };
    const err = await action().then(() => undefined, error => error);
    expect.soft(await readFile(gen, "utf8")).toBe("41\n");
    expect.soft(await readFile(data, "utf8").catch(() => null)).toBe("preserve");
    for (const [name, ino] of Object.entries(sockets)) expect.soft((await lstat(join(peer, name), { bigint: true })).ino).toBe(ino);
    expect.soft(connections).not.toHaveBeenCalled(); expect.soft(runCommand).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(Error);
  });

it("rejects a real but group-writable namespace parent before any unit call", async () => {
  const root = await createUnixSocketTempDir(); clean.push(() => rm(root, { recursive: true, force: true }));
  const own = join(root, "own"); await mkdir(own); await chmod(own, 0o770);
  const runCommand = vi.fn(async () => ({ stdout: "" }));
  const launcher = createSystemdScopeRuntimeLauncher({ namespace: "own", namespaceTrust: { root, uid: process.getuid!() },
    stateRoot: join(own, "s"), commandSocketRoot: join(own, "c"), brokerSocket: join(own, "b"), sdkDirectory: root, nativeDirectory: root, workerFile: join(root, "w"), runCommand });
  await expect(launcher.stop("runtime_" + "a".repeat(32))).rejects.toThrow("Unsafe");
  expect(runCommand).not.toHaveBeenCalled();
});

it.each(["matrix_ipc", "wrong_group", "writable_parent"])("honors the IPC leaf group without granting it namespace ownership: %s", async kind => {
  const root = await createUnixSocketTempDir(); clean.push(() => rm(root, { recursive: true, force: true }));
  const namespaceRoot = join(root, "own"), ipc = join(namespaceRoot, "scope-runtime"), commands = join(namespaceRoot, "c");
  await mkdir(ipc, { recursive: true }); await mkdir(commands);
  await chmod(ipc, 0o770); await chmod(commands, 0o770);
  if (kind === "writable_parent") await chmod(namespaceRoot, 0o770);
  const namespaceTrust = { root, uid: process.getuid!(), ipcGid: (await lstat(ipc)).gid + (kind === "wrong_group" ? 1 : 0) };
  const runCommand = vi.fn(async () => ({ stdout: "" })), brokerSocket = join(ipc, "broker");
  const launcher = createSystemdScopeRuntimeLauncher({ namespace: "own", namespaceTrust,
    stateRoot: join(namespaceRoot, "state"), commandSocketRoot: commands, brokerSocket, sdkDirectory: root, nativeDirectory: root, workerFile: join(root, "w"), runCommand });
  const broker = createScopeRuntimeBrokerServer({ socketPath: brokerSocket, namespaceTrust, broker: { handle: vi.fn(), close() {} } });
  if (kind === "matrix_ipc") {
    await broker.start(); clean.push(() => broker.close());
    await expect(launcher.list()).resolves.toEqual([]);
    expect(runCommand).toHaveBeenCalledOnce();
    expect((await lstat(brokerSocket)).isSocket()).toBe(true);
    await createRuntimeDirectories({ stateRoot: join(namespaceRoot, "state"), commandSocketRoot: commands, namespaceTrust }, "runtime_" + "a".repeat(32));
    expect((await lstat(commands)).mode & 0o777).toBe(0o770);
  } else {
    await expect(broker.start()).rejects.toThrow("Unsafe");
    await expect(launcher.list()).rejects.toThrow("Unsafe");
    expect(runCommand).not.toHaveBeenCalled();
  }
});
