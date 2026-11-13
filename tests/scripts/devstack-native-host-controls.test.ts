import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { waitFor } from "../../scripts/ops/devstack-native/control.mjs";
import { fileReadResult, validateDenials } from "../../scripts/ops/devstack-native/controls.mjs";
import { CASCADE_KEYS, createUnitLedger, observeUnit } from "../../scripts/ops/devstack-native/ownership.mjs";

const baseResult = { brokerPositive: true, noExternalInterface: true, noExternalRoute: true, tcp: "ECONNREFUSED", unix: [] };
const otherFiles = ["/opt/matrix/env/host.env", "/home/matrix/home", "/root"].map(path => ({ path, code: "EACCES" }));

it("distinguishes an existing mode-000 directory from a readable path as a non-root user", async () => {
  const base = await mkdtemp("/tmp/native-access-"), privatePath = join(base, "private"), missing = join(base, "missing");
  try {
    await chmod(base, 0o755); await mkdir(privatePath, { mode: 0 });
    const script = `import * as fs from 'node:fs/promises';
      const [privatePath, readable, missing] = process.argv.slice(1);
      await fs.access(privatePath, fs.constants.F_OK);
      const probe = ${fileReadResult.toString()};
      console.log(JSON.stringify({uid:process.getuid(), files:await Promise.all([privatePath,readable,missing].map(p=>probe(p,fs)))}));`;
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, privatePath, base, missing], {
      encoding: "utf8", timeout: 5000, ...(process.getuid!() === 0 ? { uid: 65534, gid: 65534 } : {}),
    }));
    expect(result.uid).not.toBe(0);
    expect(result.files).toEqual([{ path: privatePath, code: "EACCES" }, { path: base, code: "READABLE" }, { path: missing, code: "ENOENT" }]);
    for (const item of result.files) {
      const validate = () => validateDenials({ ...baseResult, files: [item, ...otherFiles] }, { targets: [], filePath: item.path });
      if (item.code === "READABLE") expect(validate).toThrow("worker_file_not_denied"); else expect(validate).not.toThrow();
    }
  } finally { await chmod(privatePath, 0o700); await rm(base, { recursive: true }); }
});

it.each([{ path: "/wrong", code: "EACCES" }, { path: "/fixture", code: "TIMEOUT" }, { path: "/fixture", code: "EIO" }])(
  "rejects an unbound or inconclusive file result %j", item => {
    expect(() => validateDenials({ ...baseResult, files: [item, ...otherFiles] }, { filePath: "/fixture", targets: [] })).toThrow("worker_file_not_denied");
  });

const supervisor = "matrix-devstack-proof-scope-runtime.service", prefix = "matrix-devstack-proof-scope-runtime-";
const handle = "runtime_" + "a".repeat(32), worker = prefix + handle.slice(8) + ".service";
const unitObject = "/org/freedesktop/systemd1/unit/matrix_2ddevstack_2dproof_2dscope_2druntime";
const objectPaths: Record<string, string> = { [supervisor]: unitObject + "_2eservice", [worker]: unitObject + "_2d" + handle.slice(8) + "_2eservice" };
const typedZero = "a(sasbttttuii) 0";
type Response = { code: number; stdout: string; stderrPresent?: boolean };
async function fixture(prepare?: (units: Record<string, Record<string, string>>) => void) {
  const calls: string[] = [], mutations: string[] = [];
  const units: Record<string, Record<string, string>> = Object.fromEntries([supervisor, worker].map((name, i) => [name, {
    ...Object.fromEntries(CASCADE_KEYS.map((k: string) => [k, ""])),
    Id: name, LoadState: "loaded", ActiveState: "active", SubState: "running", Description: "token", Transient: "yes",
    InvocationID: String(i + 1).repeat(32), MainPID: String(i + 100), FragmentPath: "/run/systemd/transient/" + name,
    KillSignal: "9", RuntimeDirectoryPreserve: "yes", RemainAfterExit: "yes", DynamicUser: "no", RootDirectory: "",
    Result: "success", ExecMainPID: String(i + 100), ExecMainCode: "0", ExecMainStatus: "0",
    StandardError: "journal", LimitFSIZE: "infinity", LimitFSIZESoft: "infinity",
  }]));
  prepare?.(units);
  const definitions: Record<string, string> = Object.fromEntries(Object.values(units).map(v => [v.FragmentPath, "sha256:1:2:3"]));
  const f = { calls, mutations, units, definitions, reply: (_name: string, _key: string): Response => ({ code: 0, stdout: typedZero }) };
  const run = async (binary: string, argv: string[]) => {
    if (binary === "/usr/bin/systemctl") {
      const [action, name, ...props] = argv; expect(action).toBe("show"); expect(units[name]).toBeDefined();
      return { code: 0, stderrPresent: false, stdout: Object.entries(units[name]).filter(([k]) => props.includes("--property=" + k)).map(([k, v]) => k + "=" + v).join("\n") };
    }
    const [flag, method, service, path, iface, key] = argv;
    expect(binary).toBe("/usr/bin/busctl"); expect(argv).toHaveLength(6);
    expect([flag, method, service, iface]).toEqual(["--system", "get-property", "org.freedesktop.systemd1", "org.freedesktop.systemd1.Service"]);
    const name = Object.keys(objectPaths).find(n => objectPaths[n] === path);
    if (!name || !["ExecStop", "ExecStopPost"].includes(key)) throw Error("unexpected_bus_query");
    calls.push(name + ":" + key); return { stderrPresent: false, ...f.reply(name, key) };
  };
  const observe = (name: string) => observeUnit(name, run, async (path: string) => definitions[path]);
  const ledger = createUnitLedger({ supervisorUnit: supervisor, workerUnitPrefix: prefix }, "token", { observe,
    mutate: async (action: string, name: string) => { mutations.push(action + ":" + name); } });
  ledger.submitted(); await ledger.captureSupervisor(); await ledger.recordWorker({ runtimeHandle: handle, executionGeneration: "1" });
  for (const v of Object.values(units)) { delete v.ExecStop; delete v.ExecStopPost; }
  return { f, ledger, observe };
}

it("uses typed empty arrays for both omitted hooks before stopping each recorded unit", async () => {
  const { f, ledger } = await fixture();
  expect(await ledger.cleanup()).toEqual([supervisor, worker].map(unit => ({ unit, state: "passed", outcome: "stopped" })));
  for (const name of [supervisor, worker]) for (const key of ["ExecStop", "ExecStopPost"]) expect(f.calls).toContain(name + ":" + key);
  expect(f.mutations).toEqual(["stop-cold:" + supervisor, "stop:" + worker]);
});

it.each(["nonempty", "wrong_type", "empty_output", "unknown_property", "unavailable", "trailing_data", "other_unit", "definition_change", "incarnation_change", "missing_dependency", "cli_hook"])(
  "preserves the worker and refuses planned transitions or cleanup on %s", async fault => {
    const { f, ledger } = await fixture();
    if (fault === "other_unit") f.units[worker].Id = supervisor;
    if (fault === "missing_dependency") delete f.units[worker].BoundBy;
    if (fault === "cli_hook") f.units[worker].ExecStop = "/bin/false";
    f.reply = (name, key) => {
      if (name !== worker || key !== "ExecStopPost") return { code: 0, stdout: typedZero };
      if (fault === "definition_change") f.definitions[f.units[worker].FragmentPath] += "!";
      if (fault === "incarnation_change") f.units[worker].MainPID = String(Number(f.units[worker].MainPID) + 1);
      const values: Record<string, Response> = { nonempty: { code: 0, stdout: 'a(sasbttttuii) 1 "/bin/false" 1 "/bin/false" false 0 0 0 0 0 0 0' },
        wrong_type: { code: 0, stdout: "as 0" }, empty_output: { code: 0, stdout: "" }, unknown_property: { code: 1, stdout: "" },
        unavailable: { code: -1, stdout: "" }, trailing_data: { code: 0, stdout: typedZero + " extra" } };
      return values[fault] ?? { code: 0, stdout: typedZero };
    };
    let dispatched = false;
    await expect(ledger.protocolAction(handle, async () => { dispatched = true; })).rejects.toThrow();
    await expect(ledger.supervisorAction("kill")).rejects.toThrow();
    await expect(ledger.supervisorAction("stop", async () => async () => ({}))).rejects.toThrow();
    expect(dispatched).toBe(false);
    const cleanup = await ledger.cleanup();
    expect(cleanup).toMatchObject([{ unit: supervisor, state: "passed" }, { unit: worker, state: "failed" }]);
    expect(f.mutations).toEqual(["stop-cold:" + supervisor]);
  });


it("reobserves an owned lifecycle-only hook race during expected restart without adopting the mixed snapshot", async () => {
  const { f, ledger } = await fixture();
  await ledger.supervisorAction("kill");
  const captured = ledger.evidence();
  f.calls.length = 0;
  f.reply = (name, key) => {
    if (name === supervisor && key === "ExecStopPost") Object.assign(f.units[name], {
      InvocationID: "3".repeat(32), MainPID: "103", ExecMainPID: "103", SubState: "running",
    });
    return { code: 0, stdout: typedZero };
  };
  await expect(ledger.captureExpectedRestart()).resolves.toBe(false);
  expect(ledger.evidence()).toEqual(captured);
  expect(f.mutations).toEqual(["kill:" + supervisor]);
  expect(f.calls).toEqual([supervisor + ":ExecStop", supervisor + ":ExecStopPost"]);
  await expect(ledger.captureExpectedRestart()).resolves.toEqual({ invocationId: "3".repeat(32), pid: 103 });
  expect(f.calls).toEqual(Array(2).fill([supervisor + ":ExecStop", supervisor + ":ExecStopPost"]).flat());
  expect(f.mutations).toEqual(["kill:" + supervisor]);
  expect(ledger.evidence().supervisor?.invocationId).toBe("3".repeat(32));
});


it.each([
  ["InvocationID", "3".repeat(32)], ["MainPID", "0"], ["ActiveState", "activating"], ["SubState", "auto-restart"],
  ["Result", "signal"], ["ExecMainPID", "103"], ["ExecMainCode", "2"], ["ExecMainStatus", "9"],
])("leaves ownership pending on a lifecycle-only %s change", async (key, value) => {
  const { f, ledger } = await fixture();
  await ledger.supervisorAction("kill"); const captured = ledger.evidence();
  f.reply = (name, hook) => {
    if (name === supervisor && hook === "ExecStopPost") f.units[name][key] = value;
    return { code: 0, stdout: typedZero };
  };
  await expect(ledger.captureExpectedRestart()).resolves.toBe(false);
  expect(ledger.evidence()).toEqual(captured);
  expect(f.mutations).toEqual(["kill:" + supervisor]);
});

it.each(["observe", "fresh", "protocol", "kill", "stop", "capture", "cleanup"])(
  "still rejects lifecycle inconsistency in ordinary %s paths", async action => {
    const { f, ledger, observe } = await fixture();
    if (action === "capture" || action === "cleanup") await ledger.supervisorAction("kill");
    f.mutations.length = 0; const captured = ledger.evidence();
    f.reply = (name, hook) => {
      if (name === supervisor && hook === "ExecStopPost") f.units[name].MainPID = String(Number(f.units[name].MainPID) + 1);
      return { code: 0, stdout: typedZero };
    };
    let dispatched = false;
    const actions: Record<string, () => Promise<unknown>> = {
      observe: () => observe(supervisor), fresh: () => ledger.freshSupervisor(),
      protocol: () => ledger.protocolAction(handle, async () => { dispatched = true; }),
      kill: () => ledger.supervisorAction("kill"), stop: () => ledger.supervisorAction("stop", async () => async () => ({})),
      capture: () => ledger.captureSupervisor({ restart: true }),
    };
    if (action === "cleanup") {
      expect(await ledger.cleanup()).toContainEqual({ unit: supervisor, state: "failed", code: "unit_changed_during_hook_observation" });
      expect(f.mutations).toEqual(["stop:" + worker]);
    } else {
      await expect(actions[action]()).rejects.toThrow("unit_changed_during_hook_observation");
      expect(f.mutations).toEqual([]);
    }
    expect(dispatched).toBe(false); expect(ledger.evidence()).toEqual(captured);
  });

const protectedDrifts = [
  ["Description", "foreign-token"], ["Transient", "no"], ["DynamicUser", "yes"], ["RootDirectory", "/foreign"],
  ["KillSignal", "15"], ["RuntimeDirectoryPreserve", "no"], ["RemainAfterExit", "no"],
  ["StandardError", "null"], ["LimitFSIZE", "1"], ["LimitFSIZESoft", "1"],
  ...CASCADE_KEYS.map((key: string) => [key, "foreign.service"]),
  ["DefinitionIdentity", "different-sha256:1:2:3"], ["DefinitionIdentity", "sha256:9:2:3"],
  ["DefinitionIdentity", "sha256:1:9:3"], ["DefinitionIdentity", "sha256:1:2:9"],
];
it.each(protectedDrifts)("never retries or adopts protected drift %s=%s", async (key, value) => {
  for (const timing of ["during", "before", "stable"]) {
    const { f, ledger } = await fixture();
    await ledger.supervisorAction("kill"); const captured = ledger.evidence();
    const drift = () => {
      if (key === "DefinitionIdentity") f.definitions[f.units[supervisor].FragmentPath] = value;
      else f.units[supervisor][key] = value;
    };
    if (timing !== "during") drift();
    if (timing === "stable") Object.assign(f.units[supervisor], { InvocationID: "3".repeat(32), MainPID: "103" });
    f.reply = (name, hook) => {
      if (name === supervisor && timing !== "stable" && (hook === "ExecStopPost" || hook === "ExecStop" && f.units[name].ExecStopPost !== undefined)) {
        if (timing === "during") drift();
        Object.assign(f.units[name], { InvocationID: "3".repeat(32), MainPID: "103" });
      }
      return { code: 0, stdout: typedZero };
    };
    await expect(ledger.captureExpectedRestart(), timing).rejects.toThrow();
    expect(ledger.evidence(), timing).toEqual(captured);
    expect(f.mutations, timing).toEqual(["kill:" + supervisor]);
  }
});

it.each([["Id", worker], ["LoadState", "not-found"], ["FragmentPath", "/foreign"]])(
  "rejects changed unit identity %s during the hook window", async (key, value) => {
    const { f, ledger } = await fixture(); await ledger.supervisorAction("kill"); const captured = ledger.evidence();
    f.reply = (name, hook) => {
      if (name === supervisor && hook === "ExecStopPost") f.units[name][key] = value;
      return { code: 0, stdout: typedZero };
    };
    await expect(ledger.captureExpectedRestart()).rejects.toThrow();
    expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
  });

it("cannot treat a foreign unit's lifecycle error as the captured supervisor's pending restart", async () => {
  const { f, ledger } = await fixture(); await ledger.supervisorAction("kill");
  const other = await fixture();
  other.f.reply = (name, key) => {
    if (name === worker && key === "ExecStopPost") other.f.units[name].MainPID = "999";
    return { code: 0, stdout: typedZero };
  };
  let foreignError: unknown;
  try { await other.observe(worker); } catch (error) { foreignError = error; }
  expect(foreignError).toBeInstanceOf(Error);
  f.reply = () => { throw foreignError; };
  await expect(ledger.captureExpectedRestart()).rejects.toBe(foreignError);
  expect(f.mutations).toEqual(["kill:" + supervisor]);
});

it.each(["unit_changed_during_hook_observation", "unexpected_observation_error"])(
  "does not retry an unclassified error %s", async code => {
    const { f, ledger } = await fixture(); await ledger.supervisorAction("kill");
    const error = Error(code); f.calls.length = 0; f.reply = () => { throw error; };
    await expect(waitFor(() => ledger.captureExpectedRestart(), "own_restart_identity_unavailable", 300)).rejects.toBe(error);
    expect(f.calls).toHaveLength(1); expect(f.mutations).toEqual(["kill:" + supervisor]);
  });

it("requires new typed empty-hook proof after an unaccepted lifecycle window", async () => {
  const { f, ledger } = await fixture(); await ledger.supervisorAction("kill"); const captured = ledger.evidence();
  f.reply = (name, key) => {
    if (name === supervisor && key === "ExecStopPost") Object.assign(f.units[name], { InvocationID: "3".repeat(32), MainPID: "103" });
    return { code: 0, stdout: typedZero };
  };
  await expect(ledger.captureExpectedRestart()).resolves.toBe(false);
  f.calls.length = 0; f.reply = () => ({ code: 0, stdout: "as 0" });
  await expect(ledger.captureExpectedRestart()).rejects.toThrow("unit_dependency_or_stop_hook_quarantined");
  expect(f.calls).toEqual([supervisor + ":ExecStop"]);
  expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
});

it.each([
  { InvocationID: "invalid", MainPID: "103" }, { InvocationID: "", MainPID: "103" },
  { InvocationID: "1".repeat(32), MainPID: "103" }, { InvocationID: "3".repeat(32), MainPID: "invalid" },
])("does not adopt an unproven stable replacement %j", async replacement => {
  const { f, ledger } = await fixture(); await ledger.supervisorAction("kill"); const captured = ledger.evidence();
  Object.assign(f.units[supervisor], replacement);
  await expect(ledger.captureExpectedRestart()).rejects.toThrow(/incarnation_unproven/);
  expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
});

it("does not observe or adopt a replacement without an explicitly pending own restart", async () => {
  const { f, ledger } = await fixture(); const captured = ledger.evidence();
  Object.assign(f.units[supervisor], { InvocationID: "3".repeat(32), MainPID: "103" }); f.calls.length = 0;
  await expect(ledger.captureExpectedRestart()).resolves.toBe(false);
  expect(f.calls).toEqual([]); expect(f.mutations).toEqual([]); expect(ledger.evidence()).toEqual(captured);
});

it.each([false, true])("keeps the real restart wait bounded (continuous movement=%s)", async continuous => {
  vi.useFakeTimers();
  try {
    const { f, ledger } = await fixture(); await ledger.supervisorAction("kill"); const captured = ledger.evidence();
    f.calls.length = 0; let attempts = 0;
    f.reply = (name, key) => {
      if (name === supervisor && key === "ExecStopPost" && (++attempts === 1 || continuous)) {
        Object.assign(f.units[name], { InvocationID: "3".repeat(32), MainPID: String(102 + attempts) });
      }
      return { code: 0, stdout: typedZero };
    };
    const waiting = waitFor(() => ledger.captureExpectedRestart(), "own_restart_identity_unavailable", 300);
    const assertion = continuous ? expect(waiting).rejects.toThrow("own_restart_identity_unavailable")
      : expect(waiting).resolves.toEqual({ invocationId: "3".repeat(32), pid: 103 });
    await vi.advanceTimersByTimeAsync(0);
    expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
    await vi.advanceTimersByTimeAsync(300); await assertion;
    expect(attempts).toBe(continuous ? 3 : 2); expect(f.calls).toHaveLength(continuous ? 6 : 4);
    if (continuous) expect(ledger.evidence()).toEqual(captured);
    expect(f.mutations).toEqual(["kill:" + supervisor]);
  } finally { vi.useRealTimers(); }
});


it.each(["DynamicUser", "RootDirectory", "BoundBy", "Description", "Transient"])(
  "rejects missing protected %s before old-incarnation and zero-PID shortcuts", async key => {
    for (const pid of ["100", "0"]) {
      const { f, ledger } = await fixture(); await ledger.supervisorAction("kill"); const captured = ledger.evidence();
      delete f.units[supervisor][key]; f.units[supervisor].MainPID = pid;
      await expect(ledger.captureExpectedRestart()).rejects.toThrow("supervisor_restart_incarnation_unproven");
      expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
    }
  });

it("keeps a zero-PID own supervisor pending but rejects a changed definition in that state", async () => {
  const { f, ledger } = await fixture(); await ledger.supervisorAction("kill"); const captured = ledger.evidence();
  f.units[supervisor].MainPID = "0";
  await expect(ledger.captureExpectedRestart()).resolves.toBe(false);
  f.definitions[f.units[supervisor].FragmentPath] = "sha256:1:2:9";
  await expect(ledger.captureExpectedRestart()).rejects.toThrow("supervisor_restart_incarnation_unproven");
  expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
});

it("does not authorize actions from an unaccepted replacement observation", async () => {
  const { f, ledger } = await fixture(); await ledger.supervisorAction("kill"); const captured = ledger.evidence();
  f.reply = (name, key) => {
    if (name === supervisor && key === "ExecStopPost") Object.assign(f.units[name], { InvocationID: "3".repeat(32), MainPID: "103" });
    return { code: 0, stdout: typedZero };
  };
  await expect(ledger.captureExpectedRestart()).resolves.toBe(false);
  await expect(ledger.supervisorAction("kill")).rejects.toThrow("supervisor_incarnation_changed");
  let dispatched = false;
  await expect(ledger.protocolAction(handle, async () => { dispatched = true; })).rejects.toThrow("supervisor_incarnation_changed");
  expect(dispatched).toBe(false); expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
});


it.each(["mixed", "stable"])("rejects %s restart observation when DynamicUser was absent from the captured baseline", async phase => {
  const { f, ledger } = await fixture(units => { delete units[supervisor].DynamicUser; });
  await ledger.supervisorAction("kill"); const captured = ledger.evidence();
  const replace = () => Object.assign(f.units[supervisor], { InvocationID: "3".repeat(32), MainPID: "103" });
  if (phase === "stable") replace();
  f.reply = (name, key) => {
    if (phase === "mixed" && name === supervisor && key === "ExecStopPost") replace();
    return { code: 0, stdout: typedZero };
  };
  await expect(ledger.captureExpectedRestart()).rejects.toThrow();
  expect(ledger.evidence()).toEqual(captured);
  expect(f.mutations).toEqual(["kill:" + supervisor]);
});


it.each(["DynamicUser", "RootDirectory", "RemainAfterExit", "StandardError", "LimitFSIZE", "LimitFSIZESoft", "KillSignal", "RuntimeDirectoryPreserve"])(
  "rejects missing baseline %s even when later snapshots supply that field", async key => {
    const { f, ledger } = await fixture(units => { delete units[supervisor][key]; });
    await ledger.supervisorAction("kill"); const captured = ledger.evidence();
    // A complete new observation cannot retroactively prove the captured owner.
    const complete = await fixture(); f.units[supervisor][key] = complete.f.units[supervisor][key];
    f.reply = (name, hook) => {
      if (name === supervisor && hook === "ExecStopPost") Object.assign(f.units[name], { InvocationID: "3".repeat(32), MainPID: "103" });
      return { code: 0, stdout: typedZero };
    };
    await expect(ledger.captureExpectedRestart()).rejects.toThrow("unit_changed_during_hook_observation");
    await expect(ledger.captureExpectedRestart()).rejects.toThrow("supervisor_restart_incarnation_unproven");
    expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
  });

it.each(["", "no\r", "no\0"])("rejects malformed protected metadata from real observer snapshots (%#)", async value => {
  const { f, ledger } = await fixture(units => { units[supervisor].DynamicUser = value; });
  await ledger.supervisorAction("kill"); const captured = ledger.evidence();
  f.reply = (name, hook) => {
    if (name === supervisor && hook === "ExecStopPost") Object.assign(f.units[name], { InvocationID: "3".repeat(32), MainPID: "103" });
    return { code: 0, stdout: typedZero };
  };
  await expect(ledger.captureExpectedRestart()).rejects.toThrow("unit_changed_during_hook_observation");
  await expect(ledger.captureExpectedRestart()).rejects.toThrow("supervisor_restart_incarnation_unproven");
  expect(ledger.evidence()).toEqual(captured); expect(f.mutations).toEqual(["kill:" + supervisor]);
});

it.each([["ExecStop"], ["ExecStopPost"], ["ExecStop", "ExecStopPost"]])(
  "accepts only freshly typed empty-hook omissions in the captured baseline (%j)", async (...hooks) => {
    const { f, ledger } = await fixture(units => { for (const hook of hooks) delete units[supervisor][hook]; });
    for (const hook of hooks) expect(f.calls).toContain(supervisor + ":" + hook);
    await ledger.supervisorAction("kill");
    f.reply = (name, hook) => {
      if (name === supervisor && hook === "ExecStopPost") Object.assign(f.units[name], { InvocationID: "3".repeat(32), MainPID: "103" });
      return { code: 0, stdout: typedZero };
    };
    await expect(ledger.captureExpectedRestart()).resolves.toBe(false);
    await expect(ledger.captureExpectedRestart()).resolves.toEqual({ invocationId: "3".repeat(32), pid: 103 });
    expect(f.mutations).toEqual(["kill:" + supervisor]);
  });
