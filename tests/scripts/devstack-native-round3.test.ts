import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createScopeRuntimeServer } from "../../packages/scope-runtime/src/server.js";
const scratch: string[] = [];
afterEach(async () => { await Promise.all(scratch.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const supervisor = "matrix-devstack-proof-scope-runtime.service", handle = "runtime_" + "a".repeat(32), worker = "matrix-devstack-proof-scope-runtime-" + "a".repeat(32) + ".service";
function fixture() {
  const config = { supervisorUnit: supervisor, workerUnitPrefix: "matrix-devstack-proof-scope-runtime-", supervisorSocket: "unused" };
  const common = { LoadState: "loaded", ActiveState: "active", SubState: "running", DefinitionIdentity: "original-definition", KillSignal: "9", RuntimeDirectoryPreserve: "yes", RemainAfterExit: "yes", Description: "matrix-native-token", Transient: "yes", BoundBy: "", ConsistsOf: "", RequiredBy: "", RequisiteOf: "", PropagatesStopTo: "", PartOf: "", BindsTo: "", OnFailure: "", OnSuccess: "", ExecStop: "", ExecStopPost: "", Result: "success", ExecMainCode: "0", ExecMainStatus: "0" };
  const states: Record<string, Record<string, string>> = { [supervisor]: { ...common, InvocationID: "1".repeat(32), MainPID: "41", ExecMainPID: "41" }, [worker]: { ...common, InvocationID: "2".repeat(32), MainPID: "42", ExecMainPID: "42" } };
  const terminal = (name: string) => Object.assign(states[name], { ActiveState: name === supervisor ? "active" : "inactive", SubState: name === supervisor ? "exited" : "dead", MainPID: "0", ExecMainCode: "1" });
  return { config, states, terminal };
}
async function ledgerFor(f: ReturnType<typeof fixture>, mutate = async (_action: string, _name: string) => {}) {
  const { createUnitLedger } = await import("../../scripts/ops/devstack-native/ownership.mjs");
  const ledger = createUnitLedger(f.config, "matrix-native-token", { observe: async (name: string) => f.states[name], mutate });
  ledger.submitted(); await ledger.captureSupervisor(); await ledger.recordWorker({ runtimeHandle: handle, executionGeneration: "1" }); return ledger;
}
it.each(["foreign", "missing"])("refuses runtime.stop before its callback with %s BoundBy evidence", async kind => {
  const f = fixture(), ledger = await ledgerFor(f); let submitted = 0;
  if (kind === "foreign") f.states[worker].BoundBy = "unowned.service"; else delete f.states[worker].BoundBy;
  await expect(ledger.protocolAction(handle, async () => { submitted++; })).rejects.toThrow(/dependency|quarantined/);
  expect(submitted).toBe(0);
});
it.each(["runtimeDirectory", "commandSocketRoot", "stateRoot"])("does not acquire a concurrently precreated protected %s leaf", async leaf => {
  const { assertVacant } = await import("../../scripts/ops/devstack-native/control.mjs");
  const { preparePlacement } = await import("../../scripts/ops/devstack-native/placement.mjs");
  const base = await mkdtemp(join(process.cwd(), ".native-round3-")); scratch.push(base);
  const config = { ...fixture().config, runtimeDirectory: join(base, "run", "scope-runtime"), commandSocketRoot: join(base, "run", "c"), stateRoot: join(base, "state", "scope-runtime") };
  await assertVacant(config, async (_binary: string, args: string[]) => ({ code: 0, stdout: args[0] === "show" ? "LoadState=not-found" : "" }));
  const path = config[leaf as keyof typeof config]; await mkdir(path, { recursive: true, mode: 0o700 }); const foreign = await lstat(path);
  const outcome = await preparePlacement(config).catch((error: Error) => error);
  if (!(outcome instanceof Error)) await outcome.close();
  expect(outcome).toBeInstanceOf(Error); expect((await lstat(path)).ino).toBe(foreign.ino);
});
it("waits beyond real server socket close for delayed worker drain and successful tracked supervisor exit", async () => {
  const { qualifyGracefulDrain } = await import("../../scripts/ops/devstack-native/proof.mjs");
  const f = fixture(), base = await mkdtemp(join(await realpath(tmpdir()), "native-drain-")); scratch.push(base); f.config.supervisorSocket = join(base, "s");
  let releaseWorker!: () => void, releaseSupervisor!: () => void;
  const workerGate = new Promise<void>(resolve => { releaseWorker = resolve; }), supervisorGate = new Promise<void>(resolve => { releaseSupervisor = resolve; });
  const server = createScopeRuntimeServer({ socketPath: f.config.supervisorSocket, controller: { handle: async () => { throw Error("not_used"); }, close: async () => { await workerGate; f.terminal(worker); await supervisorGate; } } });
  await server.start(); let closing: Promise<void> | undefined;
  const ledger = await ledgerFor(f, async () => { f.states[supervisor].ActiveState = "deactivating"; closing = server.close().then(() => { f.terminal(supervisor); }); });
  let status = "pending";
  const drain = qualifyGracefulDrain(f.config, ledger, handle, { timeout: 1000, workerState: async () => `ActiveState=${f.states[worker].ActiveState}` }).then((value: unknown) => { status = "passed"; return value; }, (error: Error) => { status = "failed"; throw error; });
  // Observe rejection immediately to keep the deliberate baseline failure contained.
  void drain.catch(() => undefined);
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    await expect(lstat(f.config.supervisorSocket)).rejects.toMatchObject({ code: "ENOENT" }); expect(status).toBe("pending");
    releaseWorker(); await new Promise(resolve => setTimeout(resolve, 150)); expect(status).toBe("pending");
    // A worker collected after observed terminal success is legitimate.
    f.states[worker] = { LoadState: "not-found" }; releaseSupervisor();
    await expect(drain).resolves.toMatchObject({ ownSupervisorStopped: true, workerInactive: true, supervisorSocketAbsent: true });
  } finally { releaseWorker(); releaseSupervisor(); await closing; await server.close(); await drain.catch(() => undefined); }
});
it.each(["failed_exit", "collected_without_success", "changed_incarnation", "changed_exec_pid"])("refuses graceful success on %s", async fault => {
  const { qualifyGracefulDrain } = await import("../../scripts/ops/devstack-native/proof.mjs");
  const f = fixture();
  const ledger = await ledgerFor(f, async () => {
    f.terminal(supervisor); f.terminal(worker);
    if (fault === "failed_exit") Object.assign(f.states[supervisor], { Result: "exit-code", ExecMainStatus: "1" });
    if (fault === "collected_without_success") f.states[supervisor] = { LoadState: "not-found", MainPID: "0", InvocationID: "", Result: "success", ExecMainCode: "0", ExecMainStatus: "0" };
    if (fault === "changed_incarnation") f.states[supervisor].InvocationID = "3".repeat(32);
    if (fault === "changed_exec_pid") f.states[supervisor].ExecMainPID = "99";
  });
  await expect(qualifyGracefulDrain(f.config, ledger, handle, { timeout: 150, socketAbsent: async () => true, workerState: async () => "ActiveState=inactive" })).rejects.toThrow();
});


it.each(["own", "replaced"])("cleans only the unchanged %s retained exited supervisor", async kind => {
  const f = fixture(), actions: string[] = [];
  const ledger = await ledgerFor(f, async (action: string, name: string) => {
    actions.push(`${action}:${name}`); if (action === "stop") { f.terminal(supervisor); f.terminal(worker); }
  });
  await ledger.supervisorAction("stop");
  await expect(ledger.waitForGracefulDrain(handle, async () => true, 150)).resolves.toMatchObject({ supervisor: { processExited: true, unitRetained: true, originalPid: 41 } });
  actions.length = 0;
  if (kind === "replaced") f.states[supervisor].InvocationID = "f".repeat(32);
  const cleanup = await ledger.cleanup();
  expect(actions.includes(`stop-cold:${supervisor}`)).toBe(kind === "own");
  expect(cleanup.find((entry: {unit: string}) => entry.unit === supervisor).state).toBe(kind === "own" ? "passed" : "failed");
});
