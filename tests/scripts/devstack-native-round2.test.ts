import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createScopeRuntimeController, SCOPE_RUNTIME_PROFILE } from "../../packages/scope-runtime/src/supervisor.js";
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(process.cwd(), ".native-round2-")); scratch.push(value); return value; }
function supervisorState() { return { LoadState: "loaded", Description: "matrix-native-token", Transient: "yes", InvocationID: "1".repeat(32), MainPID: "41", ActiveState: "active", DefinitionIdentity: "same-definition", KillSignal: "9", RuntimeDirectoryPreserve: "yes", OnFailure: "", OnSuccess: "", ExecStop: "", ExecStopPost: "", BoundBy: "", ConsistsOf: "", RequiredBy: "", RequisiteOf: "", PropagatesStopTo: "", PartOf: "", BindsTo: "" }; }

it("never invokes the supervisor's real close drain against a replaced tracked worker", async () => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const config = { supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-", stateRoot: "/owned/state" };
  const handles = ["runtime_" + "a".repeat(32), "runtime_" + "b".repeat(32)], effects: string[] = [];
  const states: Record<string, Record<string, string>> = { [config.supervisorUnit]: supervisorState() };
  const launcher = { list: async () => [], start: async (request: {runtimeHandle: string}) => {
    states[config.workerUnitPrefix + request.runtimeHandle.slice(8) + ".service"] = { LoadState: "loaded", InvocationID: request.runtimeHandle.slice(8), MainPID: request.runtimeHandle === handles[0] ? "42" : "43", ActiveState: "active", DefinitionIdentity: "worker-definition", KillSignal: "15", BoundBy: "", ConsistsOf: "", RequiredBy: "", RequisiteOf: "", PropagatesStopTo: "", PartOf: "", BindsTo: "", OnFailure: "", OnSuccess: "", ExecStop: "", ExecStopPost: "" };
  }, runChat: async () => ({ text: "unused" }), stop: async (handle: string) => {
    const unit = config.workerUnitPrefix + handle.slice(8) + ".service";
    effects.push(`drain-stop:${unit}:${states[unit].InvocationID}`, `reset:${unit}`, `remove:${unit}`);
  } };
  const controller = await createScopeRuntimeController({ launcher, executionGeneration: "1", createRuntimeHandle: () => handles.shift()! });
  const ledger = createUnitLedger(config, "matrix-native-token", { observe: async (name: string) => states[name], mutate: async (action: string, name: string) => {
    if (name === config.supervisorUnit && action === "stop") await controller.close();
    else effects.push(`${action}:${name}:${states[name].InvocationID}`);
  } });
  ledger.submitted(); await ledger.captureSupervisor();
  try {
    for (const digit of ["1", "2"]) {
      const reply = await controller.handle({ version: 1, type: "runtime.create", requestId: "018f0ce5-7b4a-7f95-a7c8-acae0dc5c5d1", scopeHandle: `scope_${digit.repeat(32)}`, profileId: SCOPE_RUNTIME_PROFILE.profileId, workload: "chat_ai", adapterId: "claude-code", harnessVersion: "2.1.240" });
      if (!reply.ok || !("runtimeHandle" in reply)) throw Error("fixture_create_failed"); await ledger.recordWorker(reply);
    }
    const replaced = config.workerUnitPrefix + "a".repeat(32) + ".service";
    states[replaced].InvocationID = "f".repeat(32); states[replaced].MainPID = "99";
    await expect(ledger.supervisorAction("stop")).rejects.toThrow();
    const cleanup = await ledger.cleanup();
    expect(effects.some(value => value.includes(replaced))).toBe(false);
    expect(effects).toContain(`stop:${config.workerUnitPrefix}${"b".repeat(32)}.service:${"b".repeat(32)}`);
    expect(cleanup.some((entry: {state: string}) => entry.state === "failed")).toBe(true);
  } finally { launcher.stop = async () => {}; await controller.close(); }
});

it("records a conclusively owned expected restart independently of a failed capability probe", async () => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const config = { supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-", stateRoot: "/owned/state" }, state = supervisorState(), actions: string[] = [];
  const ledger = createUnitLedger(config, "matrix-native-token", { observe: async () => state, mutate: async (action: string) => { actions.push(action); } });
  ledger.submitted(); await ledger.captureSupervisor(); await ledger.supervisorAction("kill");
  state.InvocationID = "2".repeat(32); state.MainPID = "44";
  // Health is unavailable, so normal proof never calls captureSupervisor.
  const cleanup = await ledger.cleanup();
  expect(ledger.evidence().supervisor.invocationId).toBe("2".repeat(32));
  expect(actions).toContain("stop-cold"); expect(cleanup.every((entry: {state: string}) => entry.state === "passed")).toBe(true);
});

it.each(["replace", "sentinel"])("refuses %s in a reserved leaf before submission without touching it", async mutation => {
  const { preparePlacement } = await import("../../scripts/ops/devstack-native/placement.mjs");
  const { submitSupervisor } = await import("../../scripts/ops/devstack-native/submission.mjs");
  const base = await root(), config = { namespace: "proof", appRoot: join(base, "app"), home: join(base, "home"), supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-", runtimeDirectory: join(base, "run", "scope-runtime"), commandSocketRoot: join(base, "run", "c"), stateRoot: join(base, "state", "scope-runtime") };
  const placement = await preparePlacement(config);
  if (mutation === "replace") { await rename(config.commandSocketRoot, `${config.commandSocketRoot}.old`); await mkdir(config.commandSocketRoot, { mode: 0o700 }); }
  else await writeFile(join(config.stateRoot, "foreign"), "untouched");
  const identity = await lstat(config.commandSocketRoot); let submissions = 0;
  await expect(submitSupervisor(config, "matrix-native-token", "[Service]\nProtectSystem=strict\nPrivateNetwork=yes", { submitted() {}, captureSupervisor: async () => ({}) }, async (_: string, argv: string[]) => {
    if (_.endsWith("systemd-run")) submissions++; return { code: 0, stdout: argv[0] === "show" ? "LoadState=not-found" : "" };
  }, placement)).rejects.toThrow(/placement/);
  expect(submissions).toBe(0); expect((await lstat(config.commandSocketRoot)).ino).toBe(identity.ino); await placement.close();
  if (mutation === "sentinel") expect(await readFile(join(config.stateRoot, "foreign"), "utf8")).toBe("untouched");
});

it("inventories omitted compiled imports before loading and refuses writable/linked/replaced server.js", async () => {
  const { compiledRuntimeInventory, verifyCompiledRuntime } = await import("../../scripts/ops/devstack-native/compiled.mjs");
  const base = await root(), dist = join(base, "packages/scope-runtime/dist"); await mkdir(dist, { recursive: true });
  for (const name of ["main.js", "worker.js", "host-config.js", "protocol.js", "systemd-unit-identity.js", "profile.js", "server.js", "supervisor.js", "systemd-launcher.js"]) await writeFile(join(dist, name), "export const checked = true;\n");
  const inventory = await compiledRuntimeInventory(base); expect(inventory.files["server.js"].sha256).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(join(dist, "server.js"), "export const tampered = true;\n"); await expect(verifyCompiledRuntime(base, inventory)).rejects.toThrow(/compiled/);
  await chmod(join(dist, "server.js"), 0o666); await expect(compiledRuntimeInventory(base)).rejects.toThrow(/compiled/);
  await rm(join(dist, "server.js")); const outside = join(base, "foreign.js"); await writeFile(outside, "export const foreign = true;\n"); await symlink(outside, join(dist, "server.js"));
  await expect(compiledRuntimeInventory(base)).rejects.toThrow(/compiled/);
});

it("captures changed installed scope/gateway runtime bytes despite identical service metadata", async () => {
  const { installedArtifactEvidence } = await import("../../scripts/ops/devstack-native/baseline.mjs");
  const base = await root(); const files = ["matrix-scope-runtime", "scope-main.js", "gateway-main.js"].map(name => join(base, name));
  for (const file of files) await writeFile(file, "before");
  const before = await installedArtifactEvidence(files.map(path => ({ path, required: true })));
  expect(Object.keys(before)).toEqual(files);
  for (const file of files) {
    await writeFile(file, "after");
    expect({ service: { MainPID: "42", InvocationID: "same" }, artifacts: await installedArtifactEvidence(files.map(path => ({ path, required: true }))) }).not.toEqual({ service: { MainPID: "42", InvocationID: "same" }, artifacts: before });
    await writeFile(file, "before");
  }
  const missing = join(base, "missing");
  expect((await installedArtifactEvidence([{ path: missing, required: false }]))[missing]).toEqual({ classification: "optional_absent" });
  await expect(installedArtifactEvidence([{ path: missing, required: true }])).rejects.toThrow(/missing/);
});

it("attests LockPersonality and rejects its degraded supervisor value", async () => {
  const { SUPERVISOR_SECURITY_KEYS, validateSupervisorProperties } = await import("../../scripts/ops/devstack-native/security.mjs");
  const config = { namespace: "proof", runtimeDirectory: "/run/matrix-devstack/proof/scope-runtime", commandSocketRoot: "/run/matrix-devstack/proof/c", home: "/var/lib/matrix-devstack/proof/home" };
  const observed: Record<string, string> = Object.fromEntries(SUPERVISOR_SECURITY_KEYS.map((key: string) => [key, "yes"]));
  Object.assign(observed, { Type: "simple", User: "root", Group: "matrix", DynamicUser: "no", PrivateUsers: "no", PrivateTmp: "no", ProtectHome: "tmpfs", RootDirectory: "", MemoryMax: "268435456", TasksMax: "64", UMask: "0007", RuntimeDirectoryMode: "0700", StateDirectoryMode: "0700", NotifyAccess: "all", Restart: "on-failure", KillMode: "control-group", KillSignal: "9", RuntimeDirectoryPreserve: "yes", ProtectProc: "invisible", ProcSubset: "pid", ProtectSystem: "strict", CapabilityBoundingSet: "", AmbientCapabilities: "", RestrictNamespaces: "yes", SystemCallArchitectures: "native", RestrictAddressFamilies: "AF_UNIX", RuntimeMaxUSec: "3min", TimeoutStopUSec: "45s", WatchdogUSec: "1min", RestartUSec: "5s", ReadWritePaths: `${config.runtimeDirectory} ${config.commandSocketRoot}`, RuntimeDirectory: "matrix-devstack/proof/scope-runtime matrix-devstack/proof/c", StateDirectory: "matrix-devstack/proof/scope-runtime", BindPaths: "", BindReadOnlyPaths: ["bots", "agent-workspaces", "projects", "worktrees"].map(name => `-${config.home}/${name}`).join(" ") });
  expect(SUPERVISOR_SECURITY_KEYS).toContain("LockPersonality");
  expect(() => validateSupervisorProperties(observed, config)).not.toThrow();
  expect(() => validateSupervisorProperties({ ...observed, LockPersonality: "no" }, config)).toThrow();
  expect(() => validateSupervisorProperties({ ...observed, KillSignal: "15" }, config)).toThrow();
});


it.each(["cascade", "runtime_removal"])("blocks partial-create drain and unsafe %s cold stop while cleaning known workers", async fault => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const config = { supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-" }, state = supervisorState(), actions: string[] = [];
  const handle = "runtime_" + "a".repeat(32), workerName = config.workerUnitPrefix + "a".repeat(32) + ".service";
  const worker = { ...supervisorState(), InvocationID: "3".repeat(32), MainPID: "45", DefinitionIdentity: "worker-definition" };
  const ledger = createUnitLedger(config, "matrix-native-token", { observe: async (name: string) => name === config.supervisorUnit ? state : worker, mutate: async (_: string, name: string) => { actions.push(name); } });
  ledger.submitted(); await ledger.captureSupervisor(); await ledger.recordWorker({ runtimeHandle: handle, executionGeneration: "1" });
  ledger.partialCreate("scope_" + "b".repeat(32), Error("create_reply_lost"));
  await expect(ledger.supervisorAction("stop")).rejects.toThrow(/unproved/);
  if (fault === "cascade") state.BoundBy = "foreign-worker.service";
  else state.RuntimeDirectoryPreserve = "no";
  const cleanup = await ledger.cleanup();
  expect(actions).toEqual([workerName]);
  expect(cleanup.find((entry: {unit: string}) => entry.unit === config.supervisorUnit).state).toBe("failed");
});

it("does not adopt an unrelated restart with changed transient definition", async () => {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const config = { supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-" }, state = supervisorState(), actions: string[] = [];
  const ledger = createUnitLedger(config, "matrix-native-token", { observe: async () => state, mutate: async (action: string) => { actions.push(action); } });
  ledger.submitted(); await ledger.captureSupervisor(); await ledger.supervisorAction("kill");
  state.InvocationID = "4".repeat(32); state.MainPID = "46"; state.DefinitionIdentity = "foreign-definition";
  await expect(ledger.captureExpectedRestart()).rejects.toThrow(/unproven/);
  const cleanup = await ledger.cleanup();
  expect(actions).toEqual(["kill"]); expect(cleanup.some((entry: {state: string}) => entry.state === "failed")).toBe(true);
});
