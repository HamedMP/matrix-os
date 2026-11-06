import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createSingleUseCommandSocketSlot } from "../../packages/scope-runtime/src/worker.js";
import { hostConnection, startControls, validateDenials } from "../../scripts/ops/devstack-native/controls.mjs";
import { exchange, nativeProof } from "../../scripts/ops/devstack-native/proof.mjs";
import { CASCADE_KEYS, createUnitLedger } from "../../scripts/ops/devstack-native/ownership.mjs";
import { createJournal } from "../../scripts/ops/devstack-native/receipt.mjs";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function root() {
  const path = await mkdtemp("/tmp/ncs-"); cleanup.push(() => rm(path, { recursive: true, force: true })); return path;
}
async function listener(path: string, singleUse = true) {
  const slot = createSingleUseCommandSocketSlot<Socket>(), sockets = new Set<Socket>();
  const observed = { connections: 0, commands: 0 };
  const server = createServer({ allowHalfOpen: true }, socket => {
    observed.connections++; sockets.add(socket); socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    if (singleUse && !slot.claim(socket, close => socket.once("close", close))) return;
    let text = "";
    socket.on("data", chunk => {
      text += chunk; if (!text.includes("\n")) return;
      observed.commands++; socket.end(JSON.stringify({ text: "scope-sdk-ok" }) + "\n");
    });
    socket.once("end", () => socket.end());
  });
  await mkdir(join(path, ".."), { recursive: true });
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return observed;
}

it("reproduces empty positive-control connection consuming the real permanent slot", async () => {
  const path = join(await root(), "s"), observed = await listener(path);
  await hostConnection({ path });
  await expect(exchange(path, { command: "chat" }, 500)).rejects.toThrow(/socket_closed|socket_unavailable/);
  expect(observed).toEqual({ connections: 2, commands: 0 });
});

it("actively connects owned controls while installed/foreign command sentinels remain metadata-only negative targets", async () => {
  const base = await root(), owned = [join(base, "a"), join(base, "b")];
  const observations = await Promise.all(owned.map(path => listener(path)));
  const baseline = { sockets: {} as Record<string, { role: string }> };
  const external = [];
  for (const role of ["legacy_ipc", "legacy_command", "peer_ipc", "peer_command"]) {
    const path = join(base, role); baseline.sockets[path] = { role }; external.push(await listener(path, role.endsWith("command")));
  }
  const controls = await startControls({ appRoot: join(base, "app") }, baseline, owned);
  try {
    expect(observations.map(item => item.connections)).toEqual([1, 1]);
    expect(external.map(item => item.connections)).toEqual([1, 0, 1, 0]);
    expect(controls.targets.map((item: { role: string }) => item.role)).toEqual(["owned_peer_command_0", "owned_peer_command_1", "legacy_ipc", "legacy_command", "peer_ipc", "peer_command"]);
    for (const role of ["legacy_command", "peer_command"]) {
      expect(controls.hostPositive.sockets.find(item => item.role === role)).toMatchObject({ connected: false, evidence: "metadata_only" });
    }
    expect(controls.hostPositive.sockets.filter(item => item.connected).length).toBe(4);
  } finally { await controls.close(); }
});

async function workflow(failAt = 0, denialFault?: string) {
  const base = await root(), config = { appRoot: join(base, "app"), commandSocketRoot: join(base, "c"), runtimeDirectory: join(base, "runtime"), supervisorSocket: join(base, "supervisor"), brokerSocket: join(base, "broker"), supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-" };
  const profile = { profileId: "scope-runtime-chat-v1", profileVersion: 3, profileDigest: "a".repeat(64), executionGeneration: "1", adapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240" }] };
  const states: Record<string, any> = {}, observations: Record<string, any> = {}, events: string[] = [], stopped: string[] = [];
  const unit = (handle: string) => config.workerUnitPrefix + handle.slice(8) + ".service";
  const state = (index: number) => ({ LoadState: "loaded", InvocationID: String(index).repeat(32), MainPID: String(40 + index), ActiveState: "active", SubState: "running", DefinitionIdentity: "definition", Transient: "yes", Description: "token", KillSignal: "9", RuntimeDirectoryPreserve: "yes", ...Object.fromEntries(CASCADE_KEYS.map(key => [key, ""])) });
  states[config.supervisorUnit] = state(1);
  const ledger = createUnitLedger(config, "token", { observe: async (name: string) => states[name], mutate: async (action: string, name: string) => {
    events.push(action + ":" + name);
    if (action === "kill") states[name] = { ...states[name], InvocationID: "f".repeat(32), MainPID: "99" };
    else stopped.push(name);
  } });
  ledger.submitted(); await ledger.captureSupervisor(); const journal = createJournal();
  const baselinePath = join(base, "legacy"); await listener(baselinePath, false);
  let created = 0, inference = 0, controls: any;
  const request = async (_config: unknown, type: string, payload: any = {}) => {
    if (type === "capability.get") return { profile: { ...profile, executionGeneration: states[config.supervisorUnit].MainPID === "99" ? "2" : "1" } };
    if (type === "runtime.create") {
      const handle = "runtime_" + String(++created).repeat(32); states[unit(handle)] = state(created + 1);
      observations[handle] = await listener(join(config.commandSocketRoot, handle.slice(8), "worker.sock"));
      events.push("create:" + handle); return { runtimeHandle: handle, state: "running", executionGeneration: payload.scopeHandle && (created === 4 ? "2" : "1") };
    }
    if (type === "runtime.chat") {
      events.push("chat:" + payload.runtimeHandle);
      const result = await exchange(join(config.commandSocketRoot, payload.runtimeHandle.slice(8), "worker.sock"), payload, 500); inference++;
      return { ...result, runtimeHandle: payload.runtimeHandle, executionGeneration: payload.executionGeneration };
    }
    if (type === "runtime.stop") {
      events.push("reconcile:" + payload.runtimeHandle); return { runtimeHandle: payload.runtimeHandle, state: "stopped", executionGeneration: "1" };
    }
    throw Error("unexpected_request");
  };
  const workerConfiguration = async (_config: any, handle: string) => {
    events.push("configuration:" + handle);
    if (failAt && Number(handle.slice(-1)) === failAt) throw Error("security_property_drift");
    const value = states[unit(handle)];
    return { properties: { ...value }, namespaces: { net: "net:" + handle, mnt: "mnt:" + handle, user: "user:" + handle }, rootIdentity: { device: "1", inode: handle }, cgroup: handle, node: { sha256: "frozen-node" } };
  };
  const io = {
    request, inventory: async () => Object.keys(states).filter(name => name !== config.supervisorUnit),
    workerConfiguration, supervisorConfiguration: async () => ({ node: "frozen-node", properties: {}, credentials: {} }),
    commandCleanup: async () => ({ removed: true }),
    socketStat: async () => ({ isSocket: () => true }),
    brokerStart: async () => ({ requests: () => inference, close: async () => { events.push("broker-close"); } }),
    controlsStart: async (...args: any[]) => { controls = await startControls(...args); return controls; },
    workerIsolation: async (configuration: any, targets: any) => {
      const handle = configuration.cgroup; events.push("denials:" + handle);
      if (handle.endsWith("3")) expect(targets.targets.every((target: any) => !target.path.includes(handle.slice(8)))).toBe(true);
      const unix = targets.targets.map((target: any) => ({ ...target, code: handle.endsWith("3") ? denialFault ?? "ENOENT" : "ENOENT" }));
      const files = [targets.filePath, "/opt/matrix/env/host.env", "/home/matrix/home", "/root"].map(path => ({ path, code: "EACCES" }));
      return { ...configuration, workerControls: validateDenials({ brokerPositive: true, noExternalInterface: true, noExternalRoute: true, tcp: "ECONNREFUSED", unix, files }, targets) };
    },
    brokerExchange: async () => ({ ok: false, error: "action_denied" }),
    gracefulDrain: async (_config: any, own: any, handle: string) => {
      events.push("drain:" + handle); await own.supervisorAction("stop", async (_owner: any, handles: string[]) => {
        expect(handles).toEqual([handle]); return async () => ({});
      }); return { stubDrain: true };
    },
  };
  const context = { journal, ledger, dependencies: { sdk: { claudeCodeVersion: "2.1.240" } }, baseline: { sockets: { [baselinePath]: { role: "legacy_ipc" } } }, expectedProfile: profile, node: {}, check() {} };
  const run = () => nativeProof(config, { workerUnit: unit }, context, io);
  return { run, ledger, journal, observations, events, stopped, config, base, states, unit, io, context, controls: () => controls };
}

it("qualifies the fresh SDK worker itself then sends its first and only command; reconciles every pre-crash worker", async () => {
  const f = await workflow(); await f.run();
  const handles = Object.keys(f.observations), [first, peer, sdk, drain] = handles;
  expect(handles).toHaveLength(4);
  expect([first, peer].map(handle => f.observations[handle])).toEqual([{ connections: 1, commands: 0 }, { connections: 1, commands: 0 }]);
  expect(f.observations[sdk]).toEqual({ connections: 1, commands: 1 });
  expect(f.observations[drain]).toEqual({ connections: 0, commands: 0 });
  expect(f.events.filter(value => value.startsWith("denials:"))).toEqual(["denials:" + first, "denials:" + sdk]);
  expect(f.events.indexOf("denials:" + sdk)).toBeLessThan(f.events.indexOf("chat:" + sdk));
  expect(f.journal.result().gates.isolation).toMatchObject({ state: "passed", evidence: { pair: [{ handle: first }, { handle: peer }] } });
  expect(f.events.filter(value => value.startsWith("reconcile:"))).toEqual([first, peer, sdk].map(handle => "reconcile:" + handle));
  expect(f.journal.result().gates.sdk_isolation).toMatchObject({ state: "passed", evidence: { handle: sdk, node: { sha256: "frozen-node" } } });
  expect(Object.values(f.journal.result().resources).map((item: any) => item.role)).toEqual(["isolation_control", "peer_control", "sdk", "drain"]);
  expect(f.ledger.evidence().workers.map((item: any) => item.handle)).toEqual(handles);
  expect((await f.ledger.cleanup()).every((item: any) => item.state === "passed")).toBe(true);
});

it("requires the fresh SDK worker to remain live before its denial probe and command", async () => {
  const f = await workflow(), original = f.io.workerConfiguration;
  f.io.workerConfiguration = async (...args: Parameters<typeof original>) => {
    const configuration = await original(...args);
    if (args[1].endsWith("3")) f.states[f.unit(args[1])].ActiveState = "deactivating";
    return configuration;
  };
  await expect(f.run()).rejects.toThrow("worker_sdk_not_live");
  expect(f.events.some(value => value.startsWith("chat:"))).toBe(false); await f.ledger.cleanup();
});

it("rejects an SDK worker incarnation changed during its own denial probe before dispatch", async () => {
  const f = await workflow(), original = f.io.workerIsolation;
  f.io.workerIsolation = async (configuration: any, targets: any) => {
    const evidence = await original(configuration, targets);
    if (configuration.cgroup.endsWith("3")) f.states[f.unit(configuration.cgroup)].InvocationID = "e".repeat(32);
    return evidence;
  };
  await expect(f.run()).rejects.toThrow("worker_incarnation_changed");
  expect(f.events.some(value => value.startsWith("chat:"))).toBe(false);
  expect(f.journal.result().gates.sdk_isolation.state).toBe("failed");
  const result = await f.ledger.cleanup();
  expect(result.filter((item: any) => item.state === "failed")).toHaveLength(1);
  expect(f.stopped.includes(f.unit("runtime_" + "3".repeat(32)))).toBe(false);
});

it.each([1, 2, 3, 4])("retains every registered worker for bounded cleanup after configuration failure %s", async index => {
  const f = await workflow(index); await expect(f.run()).rejects.toThrow("security_property_drift");
  expect(f.ledger.evidence().workers).toHaveLength(index);
  expect(Object.values(f.journal.result().resources).at(-1)).toMatchObject({ state: "failed" });
  const results = await f.ledger.cleanup();
  expect(results).toHaveLength(index + 1); expect(results.every((item: any) => item.state === "passed")).toBe(true);
  expect(f.stopped).toHaveLength(index + 1);
  expect((await readdir(f.base)).some(name => name.startsWith(".boundary-"))).toBe(false);
});

it.each([1, 2, 3, 4])("cleans all owned workers when interrupted immediately after registration %s", async index => {
  const f = await workflow();
  f.context.check = () => { if (f.ledger.evidence().workers.length === index) throw Error("proof_interrupted"); };
  await expect(f.run()).rejects.toThrow("proof_interrupted");
  expect(f.ledger.evidence().workers).toHaveLength(index);
  expect(f.ledger.quarantine()).toEqual([]);
  const results = await f.ledger.cleanup();
  expect(results).toHaveLength(index + 1); expect(results.every((item: any) => item.state === "passed")).toBe(true);
  expect((await readdir(f.base)).some(name => name.startsWith(".boundary-"))).toBe(false);
});

it.each(["CONNECTED", "TIMEOUT", "EIO"])("keeps failed/inconclusive %s SDK denial evidence from dispatching", async code => {
  // Let sacrificial isolation pass, then fail only the new SDK worker.
  const f = await workflow(0, code);
  await expect(f.run()).rejects.toThrow("worker_peer_socket_not_denied");
  expect(f.events.some(value => value.startsWith("chat:"))).toBe(false);
  expect(f.journal.result().status).toBe("failed"); await f.ledger.cleanup();
});

it("requires all four distinct resource roles and the fresh SDK isolation gate for a passing receipt", async () => {
  const f = await workflow(); await f.run();
  for (const gate of ["placement", "baseline", "dependencies", "build", "supervisor", "cleanup", "unchanged"]) await f.journal.step(gate, async () => ({}));
  expect(f.journal.result().status).toBe("passed");
  const receipt = createJournal();
  for (const [index, role] of ["isolation_control", "peer_control", "sdk", "drain"].entries()) await receipt.resourceStep("runtime_" + String(index + 1).repeat(32), role, async () => ({}));
  await expect(receipt.resourceStep("runtime_" + "5".repeat(32), "unknown", async () => ({}))).rejects.toThrow("receipt_resource_invalid");
  expect(receipt.result().status).toBe("failed"); await f.ledger.cleanup();
});

it.each(["missing_control", "duplicate_role", "missing_sdk_isolation"])("refuses an otherwise complete receipt with %s", async fault => {
  const journal = createJournal();
  const roles = fault === "missing_control" ? ["sdk", "peer_control", "drain"]
    : fault === "duplicate_role" ? ["sdk", "peer_control", "drain", "sdk"] : ["isolation_control", "peer_control", "sdk", "drain"];
  for (const [index, role] of roles.entries()) await journal.resourceStep("runtime_" + String(index + 1).repeat(32), role, async () => ({}));
  for (const gate of Object.keys(journal.result().gates)) {
    if (gate !== "sdk_isolation" || fault !== "missing_sdk_isolation") await journal.step(gate, async () => ({}));
  }
  expect(journal.result().status).toBe("failed");
});

it("retains SDK success but refuses cleanup claims when pre-stop publication observation fails", async () => {
  const f = await workflow(), original = f.io.workerConfiguration;
  f.io.workerConfiguration = async (...args: Parameters<typeof original>) => {
    if (f.events.includes("chat:" + args[1])) throw Error("command_staging_not_empty");
    return original(...args);
  };
  await expect(f.run()).rejects.toThrow("command_staging_not_empty");
  expect(f.events.some(value => value.startsWith("reconcile:"))).toBe(false);
  expect(f.journal.result().gates.sdk.state).toBe("passed");
  expect(f.journal.result().gates.command_cleanup).toMatchObject({ state: "failed", code: "command_staging_not_empty" });
  expect(f.journal.result().status).toBe("failed"); await f.ledger.cleanup();
});

it("fails the cleanup gate if the supervisor credential proof changes across retained-staging removal", async () => {
  const f = await workflow(); let observations = 0;
  f.io.supervisorConfiguration = async () => ({ node: "frozen-node", properties: {}, credentials: { uids: [++observations > 3 ? 1 : 0] } }) as any;
  await expect(f.run()).rejects.toThrow("process_evidence_changed");
  expect(f.journal.result().gates.reconcile.state).toBe("passed");
  expect(f.journal.result().gates.command_cleanup.state).toBe("failed");
  expect(f.journal.result().status).toBe("failed"); await f.ledger.cleanup();
});
