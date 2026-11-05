import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function fixture() {
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
  const managers = namespaces.map((namespace, index) => {
    const stateRoot = join(root, `state-${index}`);
    let failNext = false;
    const launcher = createSystemdScopeRuntimeLauncher({
      namespace, stateRoot, sdkDirectory, nativeDirectory, workerFile, brokerSocket, nodeBinary: process.execPath, codexBinary,
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
        if (args[0] === "stop") units.delete(args[1]!);
        return { stdout: "" };
      },
    });
    return { namespace, launcher, stateRoot, fail() { failNext = true; } };
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
