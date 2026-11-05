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
  await assertVacant(config, async (_binary: string, args: string[]) => ({ code: 0, stdout: args[0] === "show" ? "LoadState=not-found" : args[0] === "list-unit-files" ? "matrix-gateway.service enabled enabled" : "" }));
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
  const drain = qualifyGracefulDrain(f.config, ledger, handle, { timeout: 1000, beginClose: async () => async () => ({}) }).then((value: unknown) => { status = "passed"; return value; }, (error: Error) => { status = "failed"; throw error; });
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
  await expect(qualifyGracefulDrain(f.config, ledger, handle, { timeout: 150, socketAbsent: async () => true, beginClose: async () => async () => ({}) })).rejects.toThrow();
});


it.each(["own", "replaced"])("cleans only the unchanged %s retained exited supervisor", async kind => {
  const f = fixture(), actions: string[] = [];
  const ledger = await ledgerFor(f, async (action: string, name: string) => {
    actions.push(`${action}:${name}`); if (action === "stop") { f.terminal(supervisor); f.terminal(worker); }
  });
  await ledger.supervisorAction("stop", async () => async () => ({}));
  await expect(ledger.waitForGracefulDrain(handle, async () => true, 150)).resolves.toMatchObject({ supervisor: { processExited: true, unitRetained: true, originalPid: 41 } });
  actions.length = 0;
  if (kind === "replaced") f.states[supervisor].InvocationID = "f".repeat(32);
  const cleanup = await ledger.cleanup();
  expect(actions.includes(`stop-cold:${supervisor}`)).toBe(kind === "own");
  expect(cleanup.find((entry: {unit: string}) => entry.unit === supervisor).state).toBe(kind === "own" ? "passed" : "failed");
});

it.each(["warn_after_collection", "state_remains", "command_remains", "clean_with_adapter_diagnostics"])(
  "records real controller.close after collection: %s", async fault => {
    const { createScopeRuntimeController } = await import("../../packages/scope-runtime/src/supervisor.js");
    const { createJournal } = await import("../../scripts/ops/devstack-native/receipt.mjs");
    const { qualifyGracefulDrain } = await import("../../scripts/ops/devstack-native/proof.mjs");
    const { vi } = await import("vitest"), { appendFileSync } = await import("node:fs");
    const { createStderrCapture } = await import("../../scripts/ops/devstack-native/close-evidence.mjs");
    const f = fixture(), base = await mkdtemp(join(process.cwd(), ".native-close-")); scratch.push(base);
    const config = { ...f.config, commandSocketRoot: join(base, "c"), stateRoot: join(base, "state"), supervisorSocket: join(base, "socket") };
    const runtime = join(config.stateRoot, "runtimes", handle.slice(8)), command = join(config.commandSocketRoot, handle.slice(8));
    for (const path of [runtime, command]) await mkdir(path, { recursive: true, mode: 0o700 });
    const stderr = join(base, "fixture.stderr");
    Object.assign(f.states[supervisor], { StandardError: "append", LimitFSIZE: "65536", LimitFSIZESoft: "65536" });
    const capture = await createStderrCapture(stderr, async () => lstat(stderr, { bigint: true }));
    // A prior invocation writing to the same append target is outside the tested close interval.
    appendFileSync(stderr, "[scope-runtime] shutdown stop failed: PreviousInvocation\n");
    const controller = await createScopeRuntimeController({ executionGeneration: "1", launcher: {
      list: async () => [{ runtimeHandle: handle, executionGeneration: "1" }],
      start: async () => {}, runChat: async () => ({ text: "" }),
      async stop(stopped) {
        expect(stopped).toBe(handle);
        console.warn("[scope-runtime] Codex adapter disabled:", "Error");
        console.warn("[scope-runtime] bot profile disabled:", "Error");
        f.states[worker] = { LoadState: "not-found" };
        if (fault !== "command_remains") await rm(command, { recursive: true });
        if (fault !== "state_remains") await rm(runtime, { recursive: true });
        if (fault === "warn_after_collection") throw Error("fixture-private-message");
      },
    } });
    const warn = vi.spyOn(console, "warn").mockImplementation((...args) => appendFileSync(stderr, args.join(" ") + "\n"));
    try {
      const ledger = await ledgerFor(f, async () => { await controller.close(); f.terminal(supervisor); });
      const journal = createJournal();
      await journal.step("drain", () => qualifyGracefulDrain(config, ledger, handle, { timeout: 300, capture })).catch((error: Error) => journal.fail(error));
      const { gates } = journal.result();
      if (fault === "warn_after_collection") expect(warn).toHaveBeenCalledWith("[scope-runtime] shutdown stop failed:", "Error");
      if (fault === "clean_with_adapter_diagnostics") expect(gates.drain).toMatchObject({ state: "passed", evidence: { workers: [{ outcome: "collected_after_controller_close" }] } });
      else expect(gates.drain).toMatchObject({ state: "failed", code: fault === "warn_after_collection" ? "controller_shutdown_stop_failed" : "worker_teardown_incomplete" });
      expect(JSON.stringify(gates.drain)).not.toMatch(/PreviousInvocation|adapter disabled|fixture-private-message/);
    } finally { warn.mockRestore(); await capture.close(); }
  });

it.each(["missing", "replaced", "full", "partial", "rewritten", "wrong_fd", "wrong_setting", "unbounded"])(
  "refuses incomplete or unbound stderr evidence: %s", async fault => {
    const { createStderrCapture } = await import("../../scripts/ops/devstack-native/close-evidence.mjs");
    const { appendFile, rename, writeFile, unlink, readFile } = await import("node:fs/promises");
    const base = await mkdtemp(join(process.cwd(), ".native-stderr-")); scratch.push(base);
    const path = join(base, "log"), other = join(base, "other");
    await writeFile(other, "foreign", { mode: 0o600 });
    const capture = await createStderrCapture(path, async () => lstat(fault === "wrong_fd" ? other : path, { bigint: true }));
    const owner = { MainPID: "41", InvocationID: "1".repeat(32), StandardError: "append", LimitFSIZE: "65536", LimitFSIZESoft: "65536" };
    try {
      if (fault === "wrong_setting") owner.StandardError = "journal";
      if (fault === "unbounded") owner.LimitFSIZESoft = "infinity";
      if (["wrong_fd", "wrong_setting", "unbounded"].includes(fault)) { await expect(capture.begin(owner)).rejects.toThrow(/stderr_(fd|settings)_unproven/); return; }
      await writeFile(path, "first\n"); const result = await capture.begin(owner);
      if (fault === "missing") await unlink(path);
      if (fault === "replaced") await rename(other, path);
      if (fault === "full") await appendFile(path, Buffer.alloc(65536 - 6, 10));
      if (fault === "partial") await appendFile(path, "[scope-runtime] shut");
      if (fault === "rewritten") await writeFile(path, "other\n");
      await expect(result()).rejects.toThrow();
    } finally {
      if (["missing", "replaced"].includes(fault)) await expect(capture.close()).rejects.toThrow();
      else await capture.close();
      if (fault === "replaced") expect(await readFile(path, "utf8")).toBe("foreign");
    }
  });
