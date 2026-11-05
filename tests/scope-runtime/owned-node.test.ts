import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { resolveScopeRuntimeHostConfig } from "../../packages/scope-runtime/src/host-config.js";
import * as runtime from "../../packages/scope-runtime/src/node-runtime.js";
import { assertProtectedNodeRoot, nodeProfileDigest } from "../../packages/scope-runtime/src/node-runtime.js";
import { buildFixedSystemdRunArgs, buildBotSystemdRunArgs, createSystemdScopeRuntimeLauncher } from "../../packages/scope-runtime/src/systemd-launcher.js";
import { SCOPE_RUNTIME_PROFILE_DIGEST } from "../../packages/scope-runtime/src/profile.js";

const base = "/var/lib/matrix-devstack/proof";
const env = { MATRIX_SCOPE_RUNTIME_NAMESPACE: "proof", MATRIX_SCOPE_RUNTIME_APP_ROOT: base + "/app", MATRIX_HOME: base + "/home" };
const root = base + "/runtime/node", guest = "/opt/matrix/runtime/node";
const resolve = (environment: typeof process.env) => resolveScopeRuntimeHostConfig({ env: environment });
const owned = () => resolve({ ...env, MATRIX_SCOPE_RUNTIME_NODE_ROOT: root }).ownedNode!;

it("opts into only the canonical namespaced source with both isolated roots", () => {
  expect(resolve({}).ownedNode).toBeUndefined();
  expect(resolve(env).ownedNode).toBeUndefined();
  expect(owned()).toEqual({ root, binary: root + "/bin/node", workerRoot: guest, workerBinary: guest + "/bin/node" });
  for (const value of ["", guest, root + "/", base + "/r/../runtime/node", "/var/lib/matrix-devstack/peer/runtime/node"]) {
    expect(() => resolve({ ...env, MATRIX_SCOPE_RUNTIME_NODE_ROOT: value })).toThrow();
  }
  expect(() => resolve({ MATRIX_SCOPE_RUNTIME_NODE_ROOT: root })).toThrow();
  expect(() => resolve({ ...env, MATRIX_HOME: undefined, MATRIX_SCOPE_RUNTIME_NODE_ROOT: root })).toThrow();
});

const scratch: string[] = [];
afterEach(async () => { for (const path of scratch.splice(0)) await rm(path, { recursive: true, force: true }); });
it("requires a protected existing executable and complete directory ancestry", async () => {
  const anchor = await mkdtemp(join(tmpdir(), "owned-node-")); scratch.push(anchor);
  const source = join(anchor, "runtime/node"), bin = join(source, "bin"), binary = join(bin, "node");
  const trust = { root: anchor, uid: process.getuid!() };
  const verify = () => assertProtectedNodeRoot(source, trust);
  await expect(verify()).rejects.toThrow();
  await mkdir(bin, { recursive: true, mode: 0o755 }); await writeFile(binary, "fixture", { mode: 0o755 });
  await expect(verify()).resolves.toBeUndefined();
  await expect(assertProtectedNodeRoot(source, { ...trust, uid: trust.uid + 1 })).rejects.toThrow();
  for (const path of [join(anchor, "runtime"), source, bin, binary]) {
    await chmod(path, 0o775); await expect(verify()).rejects.toThrow(); await chmod(path, 0o755);
    await rename(path, path + "-real"); await symlink(path + "-real", path);
    await expect(verify()).rejects.toThrow(); await rm(path); await rename(path + "-real", path);
  }
  await chmod(binary, 0o644); await expect(verify()).rejects.toThrow();
  await rm(binary); await mkdir(binary); await expect(verify()).rejects.toThrow();
});

it("changes only the Node mount in both worker profiles and attests its distinct source", () => {
  const paths = { scopeRoot: "/root", sdkDirectory: "/sdk", nativeDirectory: "/native", workerFile: "/worker",
    botRuntimeDirectory: "/bot", brokerSocket: "/broker", readinessFile: "/ready", commandDirectory: "/command", nodeBinary: guest + "/bin/node" };
  const common = { runtimeHandle: "runtime_" + "a".repeat(32), scopeHandle: "scope_" + "a".repeat(32), executionGeneration: "1" };
  const args = (useOwnedNode: boolean) => {
    const options = { namespace: "proof", useOwnedNode, sandboxProperties: ["PrivateNetwork=yes"] };
    return [buildFixedSystemdRunArgs({ ...common, workload: "chat_ai", adapterId: "claude-code", harnessVersion: "2.1.240" }, paths, options),
      ...["scope-runtime-bot-v1", "scope-runtime-managed-pi-v1"].map(profileId => buildBotSystemdRunArgs({ ...common, profileId, workload: "bot_agent", adapterId: "matrix-bot", harnessVersion: "1.0.0" }, paths, options))];
  };
  const legacy = args(false);
  args(true).forEach((unit, i) => {
    expect(legacy[i]).toContain("--property=BindReadOnlyPaths=" + guest);
    expect(unit).toEqual(legacy[i]!.map(value => value === "--property=BindReadOnlyPaths=" + guest ? value.replace(guest, root + ":" + guest) : value));
    expect(unit.slice(unit.indexOf("--"))).toContain(guest + "/bin/node");
  });
  expect(nodeProfileDigest(SCOPE_RUNTIME_PROFILE_DIGEST)).toBe(SCOPE_RUNTIME_PROFILE_DIGEST);
  expect(nodeProfileDigest(SCOPE_RUNTIME_PROFILE_DIGEST, owned())).not.toBe(SCOPE_RUNTIME_PROFILE_DIGEST);
});

it("discovery uses the selected host binary and never executes an optional installed CLI", async () => {
  const { createUnixSocketTempDir } = await import("../helpers/unix-socket-temp.js");
  const dir = await createUnixSocketTempDir(); scratch.push(dir);
  const source = join(dir, "runtime/node"), bin = join(source, "bin");
  const trust = { root: dir, uid: process.getuid!() };
  await mkdir(bin, { recursive: true });
  const binary = join(bin, "node"); await writeFile(binary, "node", { mode: 0o755 });
  const codex = join(dir, "codex"); await writeFile(codex, "present", { mode: 0o755 });
  await writeFile(join(dir, "sdk.mjs"), "sdk"); await writeFile(join(dir, "claude"), "native", { mode: 0o755 });
  const selected = { ...owned(), root: source, binary };
  const originalValidate = runtime.assertProtectedNodeRoot;
  // Only the unit fixture remaps the canonical selection and its trust anchor.
  const select = vi.spyOn(runtime, "ownedNodeForNamespace").mockReturnValue(selected);
  const validate = vi.spyOn(runtime, "assertProtectedNodeRoot").mockImplementation(path => originalValidate(path, trust));
  try {
    const pin = vi.fn(async () => { throw Error("dispatch pin reached"); });
    const execute = vi.fn(async () => ({ stdout: "codex-cli 0.162.1" }));
    const manager = createSystemdScopeRuntimeLauncher({ namespace: "proof", namespaceTrust: trust, useOwnedNode: true,
      commandSocketRoot: join(dir, "c"), stateRoot: join(dir, "s"), brokerSocket: join(dir, "b"),
      workerFile: join(dir, "sdk.mjs"), nativeDirectory: dir, sdkDirectory: dir, nodeBinary: process.execPath, codexBinary: codex, runCommand: execute, pinCommandSocket: pin });
    await expect(manager.supportedAdapters?.()).resolves.toEqual([{ adapterId: "claude-code", harnessVersion: "2.1.240", workloads: ["chat_ai"] }]);
    await rm(binary);
    await expect(manager.supportedAdapters?.()).rejects.toThrow();
    await expect(manager.active?.()).rejects.toThrow();
    const suffix = "a".repeat(32);
    await mkdir(join(dir, "c", suffix), { recursive: true });
    const ref = { runtimeHandle: "runtime_" + suffix, executionGeneration: "1" };
    await expect(manager.runChat({ ...ref, model: "test", prompt: "test" })).rejects.toMatchObject({ code: "ENOENT" });
    await expect(manager.runBot!({ ...ref, command: { version: 1, kind: "bot.cancel", runId: "run_test" } })).rejects.toMatchObject({ code: "ENOENT" });
    expect(pin).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  } finally { validate.mockRestore(); select.mockRestore(); }
});

it("refuses the owned capability through the installed Gateway catalog before dispatch", async () => {
  const { createScopeRuntimeController, SCOPE_RUNTIME_PROFILE } = await import("../../packages/scope-runtime/src/supervisor.js");
  const { createScopeRuntimeServer } = await import("../../packages/scope-runtime/src/server.js");
  const { createScopeRuntimeHost } = await import("../../packages/gateway/src/scope-runtime-host/index.js");
  const { SHARED_AI_PROFILE_CATALOG } = await import("../../packages/gateway/src/collaboration/shared-ai-runtime.js");
  const { createUnixSocketTempDir } = await import("../helpers/unix-socket-temp.js");
  const dir = await createUnixSocketTempDir(); scratch.push(dir);
  const source = createSystemdScopeRuntimeLauncher({ namespace: "proof", useOwnedNode: true,
    commandSocketRoot: dir, stateRoot: dir, brokerSocket: dir, workerFile: dir, nativeDirectory: dir, sdkDirectory: dir });
  let started = 0;
  const controller = await createScopeRuntimeController({ executionGeneration: "1", launcher: {
    ...source, list: async () => [], start: async () => { started++; },
    supportedAdapters: async id => id === SCOPE_RUNTIME_PROFILE.profileId ? SCOPE_RUNTIME_PROFILE.adapters.slice(0, 1) : [],
  } });
  const reply = await controller.handle({ version: 1, type: "capability.get", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1" });
  expect(reply).toMatchObject({ profile: { profileDigest: nodeProfileDigest(SCOPE_RUNTIME_PROFILE_DIGEST, owned()) } });
  const supervisorSocket = join(dir, "s"), brokerSocket = join(dir, "b");
  const server = createScopeRuntimeServer({ socketPath: supervisorSocket, controller });
  await server.start();
  try {
    const host = await createScopeRuntimeHost({ supervisorSocket, brokerSocket, homePath: dir, profileCatalog: SHARED_AI_PROFILE_CATALOG });
    try {
      expect(host.available).toBe(false);
      expect(host.client.capability()).toEqual({ available: false, reason: "unsupported_profile" });
      await expect(host.client.createRuntime({ scopeHandle: "scope_" + "a".repeat(32), workload: "chat_ai",
        adapterId: "claude-code", harnessVersion: "2.1.240" })).rejects.toMatchObject({ code: "runtime_unavailable" });
      expect(started).toBe(0);
    } finally { await host.close(); }
  } finally { await server.close(); }
});
