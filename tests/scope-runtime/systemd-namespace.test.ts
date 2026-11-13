import { commandPublicationFixture } from "../helpers/command-ipc-fixture.js";
import { commandIdentityFixture } from "../helpers/command-ipc-fixture.js";
import { portableCommandSocketPin } from "../helpers/portable-command-socket-pin.js";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { startInferenceBridge } from "../../packages/scope-runtime/src/inference-bridge.js";
import { parseScopeRuntimeChatRequest } from "../../packages/scope-runtime/src/worker.js";
import { request as httpRequest } from "node:http";
import { startBotCommandServer } from "../../packages/scope-runtime/src/worker-bot.js";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUnixSocketTempDir } from "../helpers/unix-socket-temp.js";
import { createSystemdScopeRuntimeLauncher } from "../../packages/scope-runtime/src/systemd-launcher.js";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
import { createScopeRuntimeHost } from "../../packages/gateway/src/scope-runtime-host/index.js";
import { SHARED_AI_PROFILE_CATALOG } from "../../packages/gateway/src/collaboration/shared-ai-runtime.js";
import { createScopeRuntimeController } from "../../packages/scope-runtime/src/supervisor.js";
import { createScopeRuntimeUnitIdentity } from "../../packages/scope-runtime/src/systemd-unit-identity.js";
const suffix = "2".repeat(32);
const handle = `runtime_${suffix}`;
const request = { profileId: "scope-runtime-chat-v1", runtimeHandle: handle, scopeHandle: `scope_${"1".repeat(32)}`, workload: "chat_ai" as const,
  adapterId: "claude-code", harnessVersion: "2.1.240", executionGeneration: "7" };
const namespaces = [undefined, "eng432-stage2", "peer"] as const;
const unit = (ns: string | undefined, id = suffix) => `${ns ? `matrix-devstack-${ns}-scope-runtime-` : "matrix-scope-runtime-"}${id}.service`;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(managerNamespaces: readonly (string | undefined)[] = namespaces) {
  const root = await createUnixSocketTempDir();
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const sdkDirectory = join(root, "sdk"), nativeDirectory = join(root, "native"), workerFile = join(root, "worker.js");
  await mkdir(sdkDirectory); await mkdir(nativeDirectory);
  await writeFile(join(sdkDirectory, "sdk.mjs"), "export {};\n");
  await writeFile(join(nativeDirectory, "claude"), "#!/bin/sh\nexit 0\n");
  await chmod(join(nativeDirectory, "claude"), 0o755); await writeFile(workerFile, "export {};\n");
  const brokerSocket = join(root, "b.sock"), broker = createServer();
  await new Promise<void>((resolve, reject) => { broker.once("error", reject); broker.listen(brokerSocket, resolve); });
  cleanup.push(() => new Promise<void>((resolve) => broker.close(() => resolve())));
  const codexBinary = join(root, "bin/codex");
  await mkdir(join(root, "bin"));
  await writeFile(codexBinary, "#!/bin/sh\nexit 0\n");
  await chmod(codexBinary, 0o755);
  const units = new Map<string, string>();
  const calls: Array<{ owner: string | undefined; command: string; args: readonly string[] }> = [];
  const managers = managerNamespaces.map((namespace, index) => {
    const stateRoot = join(root, `state-${index}`);
    const commandSocketRoot = namespace === undefined ? undefined : join(root, namespace + "x".repeat(Math.max(0, 54 - Buffer.byteLength(root) - namespace.length)));
    let failNext = false;
    const launcher = createSystemdScopeRuntimeLauncher({
      ...commandIdentityFixture(root), pinCommandSocket: portableCommandSocketPin, namespace, commandSocketRoot, stateRoot, sdkDirectory, nativeDirectory, workerFile, brokerSocket, nodeBinary: process.execPath, codexBinary,
      async runCommand(command, args) {
        calls.push({ owner: namespace, command, args });
        if (command === codexBinary) return { stdout: "codex-cli 0.162.1\n" };
        if (command === "/usr/bin/systemd-run") {
          const name = args.find((arg) => arg.startsWith("--unit="))!.slice(7);
          units.set(name, "active");
          if (failNext) { failNext = false; throw new Error("Submitted launch failed"); }
          const root = args.find((arg) => arg.startsWith("--property=RootDirectory="))!.slice("--property=RootDirectory=".length);
          const id = root.split("/").at(-2)!;
          await writeFile(join(stateRoot, "runtimes", id, "ready"), `runtime_${id}\n`);
        }
        // Deliberately return unfiltered mixed output. No launcher may trust the glob alone.
        if (args[0] === "list-units") return { stdout: [...units].map(([name, state]) => `${name} loaded ${state} running`).join("\n") };
        if (args[0] === "show" && args.includes("--property=ControlGroup")) {
          const name = args[1]!, state = units.get(name), id = /([a-f0-9]{32})\.service$/.exec(name)![1]!;
          return { stdout: Object.entries({ Id: name, LoadState: state ? "loaded" : "not-found", ActiveState: state ?? "inactive",
            SubState: state === "failed" ? "failed" : state ? "running" : "dead", MainPID: state === "active" ? "1234" : "0", ControlPID: "0",
            ControlGroup: state ? `/system.slice/${name}` : "", KillMode: "control-group",
            RootDirectory: state ? join(stateRoot, "runtimes", id, "root") : "" }).map(([key, value]) => `${key}=${value}`).join("\n") };
        }
        if (args[0] === "stop") units.delete(args[1]!);
        return { stdout: "" };
      },
    });
    return { namespace, launcher, stateRoot, commandSocketRoot, fail() { failNext = true; } };
  });
  return { root, units, calls, managers };
}

describe("systemd manager namespace ownership", () => {
  it("gives legacy and two peers disjoint exact identities with the same suffix", () => {
    for (const namespace of namespaces) {
      const identity = createScopeRuntimeUnitIdentity(namespace);
      expect(identity.workerUnit(handle)).toBe(unit(namespace));
      expect(identity.discoveryGlob).toBe(unit(namespace, "*"));
      expect(identity.supervisorUnit).toBe(unit(namespace, "").replace("-.service", ".service"));
      expect(identity.parseWorkerUnit(unit(namespace))).toBe(handle);
      for (const peer of namespaces.filter((value) => value !== namespace)) expect(identity.parseWorkerUnit(unit(peer))).toBeUndefined();
      for (const invalid of [unit(namespace, "short"), `${unit(namespace)}.extra`, unit(namespace).replace(suffix, suffix.toUpperCase() + "a")]) {
        expect(identity.parseWorkerUnit(invalid)).toBeUndefined();
      }
    }
    expect(unit("peer")).not.toMatch(/^matrix-scope-runtime-.*\.service$/);
    expect(() => createScopeRuntimeUnitIdentity("bad*")).toThrow();
  });
  it("starts, discovers, reconciles and stops only its own units and roots across three actual launchers", async () => {
    const { managers, units, calls } = await fixture();
    for (const manager of managers) await manager.launcher.start(request);
    expect([...units.keys()].sort()).toEqual(namespaces.map((ns) => unit(ns)).sort());
    for (const manager of managers) {
      expect(await manager.launcher.active!()).toEqual(new Set([handle]));
      expect(await manager.launcher.list()).toEqual([{ runtimeHandle: handle, executionGeneration: "7" }]);
      expect(calls.filter((call) => call.owner === manager.namespace && call.args[0] === "list-units")
        .every((call) => call.args.at(-1) === unit(manager.namespace, "*"))).toBe(true);
    }
    // Foreign rows, even stale units without provenance, must be skipped before access/cleanup.
    units.set(unit("foreign", "3".repeat(32)), "failed");
    for (let index = 0; index < 130; index++) units.set(unit(`foreign-${index}`, "a".repeat(32)), "failed");
    const own = managers[1]!;
    await expect(own.launcher.active!()).resolves.toEqual(new Set([handle]));
    await own.launcher.list();
    await own.launcher.stop(handle);
    await expect(own.launcher.active!()).resolves.toEqual(new Set());
    expect(units.has(unit(own.namespace))).toBe(false);
    for (const peer of [managers[0]!, managers[2]!]) {
      expect(units.has(unit(peer.namespace))).toBe(true);
      expect(await readFile(join(peer.stateRoot, "runtimes", suffix, "ready"), "utf8")).toBe(`${handle}\n`);
    }
    expect(units.has(unit("foreign", "3".repeat(32)))).toBe(true);
    expect(calls.filter((call) => call.owner === own.namespace && ["stop", "reset-failed", "is-active"].includes(call.args[0]!))
      .every((call) => call.args[1] === "--quiet" ? call.args[2] === unit(own.namespace) : call.args[1] === unit(own.namespace))).toBe(true);
  });
  it("keeps peer and installed sentinels through failed launch, orphan cleanup, controller startup and shutdown", async () => {
    const { managers, units } = await fixture();
    for (const manager of managers) await manager.launcher.start(request);
    const own = managers[1]!, failedSuffix = "4".repeat(32);
    own.fail();
    await expect(own.launcher.start({ ...request, runtimeHandle: `runtime_${failedSuffix}` })).rejects.toThrow("Submitted launch failed");
    expect(units.has(unit(own.namespace, failedSuffix))).toBe(false);
    await expect(stat(join(own.stateRoot, "runtimes", failedSuffix))).rejects.toMatchObject({ code: "ENOENT" });
    // A failed own unit and root are removed; foreign roots/units are retained.
    units.set(unit(own.namespace, failedSuffix), "failed");
    await mkdir(join(own.stateRoot, "runtimes", failedSuffix), { recursive: true });
    const controller = await createScopeRuntimeController({ launcher: own.launcher, executionGeneration: "8" });
    cleanup.push(() => controller.close());
    expect(units.has(unit(own.namespace, failedSuffix))).toBe(false);
    await controller.close();
    expect(units.has(unit(own.namespace))).toBe(false);
    for (const peer of [managers[0]!, managers[2]!]) {
      expect(units.has(unit(peer.namespace))).toBe(true);
      expect((await stat(join(peer.stateRoot, "runtimes", suffix))).isDirectory()).toBe(true);
      expect(await peer.launcher.list()).toHaveLength(1);
    }
  });
});


// Real Unix-socket boundaries: no mocked supervisor/client/broker transport.
it("closes two native host stacks independently and denies foreign handle/generation authorization", async () => {
  const { root, managers, units } = await fixture();
  const legacy = managers[0]!;
  await legacy.launcher.start(request);
  const stacks = [];
  for (const [index, manager] of [managers[1]!, managers[2]!].entries()) {
    const generation = String(7 + index);
    await manager.launcher.start({ ...request, executionGeneration: generation });
    const controller = await createScopeRuntimeController({ launcher: manager.launcher, executionGeneration: generation });
    const supervisorSocket = join(root, `s${index}.sock`), brokerSocket = join(root, `b${index}.sock`);
    const server = createScopeRuntimeServer({ socketPath: supervisorSocket, controller });
    await server.start(); cleanup.push(() => server.close());
    const host = await createScopeRuntimeHost({ homePath: root, profileCatalog: SHARED_AI_PROFILE_CATALOG, supervisorSocket, brokerSocket });
    cleanup.push(() => host.close());
    expect(host.available).toBe(true);
    expect(host.client.capability()).toMatchObject({ available: true, executionGeneration: generation });
    host.registerAuthorizer({ id: "shared_ai", owns: (input) => input.runtimeHandle === handle && input.executionGeneration === generation,
      async authorize() { return { allowed: true, allowedModelIds: [], allowedEgressOrigins: [] }; } });
    stacks.push({ host, server, supervisorSocket, brokerSocket, generation });
  }
  const probe = (socketPath: string, runtimeHandle: string, executionGeneration: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let output = ""; socket.setEncoding("utf8"); socket.setTimeout(2000, () => socket.destroy(new Error("Probe timed out")));
    socket.once("error", reject); socket.on("data", (chunk) => { output += chunk; });
    socket.once("close", () => { try { resolve(JSON.parse(output)); } catch (error) { reject(error); } });
    socket.once("connect", () => socket.end(`${JSON.stringify({ version: 1, action: "inference.messages",
      requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", runtimeHandle, executionGeneration,
      method: "HEAD", path: "/api/hello", headers: {}, body: "" })}\n`));
  });
  for (const stack of stacks) {
    await expect(probe(stack.brokerSocket, handle, stack.generation)).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(probe(stack.brokerSocket, `runtime_${"f".repeat(32)}`, stack.generation)).resolves.toMatchObject({ ok: false, error: "action_denied" });
    await expect(probe(stack.brokerSocket, handle, "999")).resolves.toMatchObject({ ok: false, error: "action_denied" });
    await expect(stack.host.client.runChat({ runtimeHandle: handle, executionGeneration: "999", model: "claude-sonnet-5", prompt: "blocked" }))
      .rejects.toMatchObject({ code: "runtime_unavailable" });
  }
  const [first, peer] = stacks;
  await first!.host.close(); await first!.server.close();
  await expect(stat(first!.brokerSocket)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(first!.supervisorSocket)).rejects.toMatchObject({ code: "ENOENT" });
  expect(units.has(unit(managers[1]!.namespace))).toBe(false);
  expect(units.has(unit(managers[2]!.namespace))).toBe(true);
  expect(units.has(unit(legacy.namespace))).toBe(true);
  expect((await stat(peer!.brokerSocket)).isSocket()).toBe(true);
  expect(await peer!.host.client.refreshCapability()).toMatchObject({ available: true });
  await expect(probe(peer!.brokerSocket, handle, first!.generation)).resolves.toMatchObject({ ok: false, error: "action_denied" });
  await expect(probe(peer!.brokerSocket, handle, peer!.generation)).resolves.toMatchObject({ ok: true, status: 200 });
  await peer!.host.client.stopRuntime({ runtimeHandle: handle });
  expect(units.has(unit(managers[2]!.namespace))).toBe(false);
  expect(units.has(unit(legacy.namespace))).toBe(true);
  expect(await legacy.launcher.list()).toHaveLength(1);
});


it("round-trips real worker commands at the 32-character namespace socket limit without touching a same-handle peer", async () => {
  const { managers } = await fixture(["a".repeat(32), "b".repeat(32)]);
  const workers = [];
  for (const manager of managers) {
    await manager.launcher.start(request);
    const commandDirectory = join(manager.commandSocketRoot!, suffix);
    expect(await stat(commandDirectory).catch(() => undefined), "namespaced commands must live in the short owned root").toBeDefined();
    const socketPath = join(commandDirectory, "worker.sock");
    expect(Buffer.byteLength(socketPath)).toBe(100);
    const inferenceSocket = join(commandDirectory, "inference.sock");
    expect(Buffer.byteLength(inferenceSocket)).toBe(103);
    const bridge = await startInferenceBridge({ socketPath: inferenceSocket, brokerSocket: join(commandDirectory, "unused-broker.sock"),
      runtimeHandle: handle, executionGeneration: "7", actionFor: () => undefined });
    cleanup.push(() => bridge.close());
    await expect(new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest({ socketPath: inferenceSocket, path: "/denied", timeout: 2000 }, (response) => { response.resume(); resolve(response.statusCode); });
      request.once("error", reject); request.once("timeout", () => request.destroy(new Error("Timed out"))); request.end();
    })).resolves.toBe(404);
    const worker = await startBotCommandServer({ publication: await commandPublicationFixture(socketPath), socketPath,
      invocation: { runtimeHandle: handle, scopeHandle: request.scopeHandle, workload: "bot_agent", adapterId: "matrix-bot", harnessVersion: "1.0.0", executionGeneration: "7" },
      handler: { async handle() { return { namespace: manager.namespace }; } } });
    cleanup.push(() => worker.close()); workers.push(worker);
    await expect(manager.launcher.runBot!({ runtimeHandle: handle, executionGeneration: "7", command: { version: 1, kind: "bot.cancel", runId: "run_test" } }))
      .resolves.toMatchObject({ ok: true, reply: { namespace: manager.namespace } });
  }
  const [own, peer] = managers;
  await workers[0]!.close();
  await own!.launcher.stop(handle);
  await expect(stat(join(own!.commandSocketRoot!, suffix))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(peer!.launcher.runBot!({ runtimeHandle: handle, executionGeneration: "7", command: { version: 1, kind: "bot.cancel", runId: "run_test" } }))
    .resolves.toMatchObject({ ok: true, reply: { namespace: peer!.namespace } });
});

it("cleans only owned short command directories after failure and reconciliation, refusing foreign symlinks", async () => {
  const { managers, root } = await fixture();
  const own = managers[1]!, peer = managers[2]!;
  await peer.launcher.start(request);
  own.fail();
  await expect(own.launcher.start(request)).rejects.toThrow("Submitted launch failed");
  await expect(stat(join(own.commandSocketRoot!, suffix))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await stat(join(peer.commandSocketRoot!, suffix))).isDirectory()).toBe(true);
  const orphan = join(own.commandSocketRoot!, "3".repeat(32));
  await mkdir(orphan, { recursive: true }); await writeFile(join(orphan, "sentinel"), "orphan");
  await own.launcher.list();
  await expect(stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
  const foreign = join(root, "foreign"); await mkdir(foreign); await writeFile(join(foreign, "sentinel"), "preserve");
  await symlink(foreign, join(own.commandSocketRoot!, suffix));
  await expect(own.launcher.start(request)).rejects.toThrow();
  expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("preserve");
  await expect(own.launcher.list()).rejects.toThrow();
  await expect(own.launcher.stop(handle)).rejects.toThrow();
  expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("preserve");
  expect((await stat(join(peer.commandSocketRoot!, suffix))).isDirectory()).toBe(true);
});


it("dispatches Chat commands through the 100-byte short path for same-handle namespace peers", async () => {
  const { managers } = await fixture(["a".repeat(32), "b".repeat(32)]);
  for (const manager of managers) {
    await manager.launcher.start(request);
    const socketPath = join(manager.commandSocketRoot!, suffix, "worker.sock");
    expect(Buffer.byteLength(socketPath)).toBe(100);
    const worker = createServer({ allowHalfOpen: true }, (socket) => {
      let frame = ""; socket.setEncoding("utf8"); socket.on("data", (chunk) => { frame += chunk; });
      socket.once("end", () => {
        const command = parseScopeRuntimeChatRequest(JSON.parse(frame), request);
        socket.end(`${JSON.stringify({ version: 1, type: "runtime.chat.result", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1",
          ok: true, runtimeHandle: handle, executionGeneration: "7", text: `${manager.namespace}:${command.prompt}` })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { worker.once("error", reject); worker.listen(socketPath, resolve); });
    cleanup.push(() => new Promise<void>((resolve) => worker.close(() => resolve())));
    await expect(manager.launcher.runChat({ runtimeHandle: handle, executionGeneration: "7", model: "test", prompt: "roundtrip" }))
      .resolves.toEqual({ text: `${manager.namespace}:roundtrip` });
  }
});

it("refuses a symlinked short command root before writing through it or submitting any unit", async () => {
  const { managers, root, calls } = await fixture();
  const own = managers[1]!;
  const foreign = join(root, "foreign-root"); await mkdir(foreign); await writeFile(join(foreign, "sentinel"), "preserve");
  await symlink(foreign, own.commandSocketRoot!);
  await expect(own.launcher.start(request)).rejects.toThrow("Unsafe");
  expect(calls).toHaveLength(0);
  expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("preserve");
  await expect(stat(join(foreign, suffix))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["root", "runtime", "socket"])("refuses dispatch through a foreign %s symlink even when the peer has the same handle and generation", async (target) => {
  const { managers } = await fixture(); const own = managers[1]!, peer = managers[2]!;
  await own.launcher.start(request); await peer.launcher.start(request);
  const peerWorker = await startBotCommandServer({ publication: await commandPublicationFixture(join(peer.commandSocketRoot!, suffix, "worker.sock")), socketPath: join(peer.commandSocketRoot!, suffix, "worker.sock"),
    invocation: { runtimeHandle: handle, scopeHandle: request.scopeHandle, workload: "bot_agent", adapterId: "matrix-bot", harnessVersion: "1.0.0", executionGeneration: "7" },
    handler: { async handle() { return { namespace: "peer" }; } } });
  cleanup.push(() => peerWorker.close());
  const ownPath = target === "root" ? own.commandSocketRoot! : target === "runtime" ? join(own.commandSocketRoot!, suffix) : join(own.commandSocketRoot!, suffix, "worker.sock");
  const peerPath = target === "root" ? peer.commandSocketRoot! : target === "runtime" ? join(peer.commandSocketRoot!, suffix) : join(peer.commandSocketRoot!, suffix, "worker.sock");
  await rm(ownPath, { recursive: true, force: true }); await symlink(peerPath, ownPath);
  await expect(own.launcher.runBot!({ runtimeHandle: handle, executionGeneration: "7", command: { version: 1, kind: "bot.cancel", runId: "run_test" } }))
    .rejects.toThrow("Unsafe");
  await expect(peer.launcher.runBot!({ runtimeHandle: handle, executionGeneration: "7", command: { version: 1, kind: "bot.cancel", runId: "run_test" } }))
    .resolves.toMatchObject({ ok: true, reply: { namespace: "peer" } });
});
