import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
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
async function fixture() {
  const calls: string[] = [], mutations: string[] = [];
  const units: Record<string, Record<string, string>> = Object.fromEntries([supervisor, worker].map((name, i) => [name, {
    ...Object.fromEntries(CASCADE_KEYS.map((k: string) => [k, ""])),
    Id: name, LoadState: "loaded", ActiveState: "active", SubState: "running", Description: "token", Transient: "yes",
    InvocationID: String(i + 1).repeat(32), MainPID: String(i + 100), FragmentPath: "/run/systemd/transient/" + name,
    KillSignal: "9", RuntimeDirectoryPreserve: "yes",
  }]));
  const definitions: Record<string, string> = Object.fromEntries(Object.values(units).map(v => [v.FragmentPath, "original"]));
  const f = { calls, mutations, units, definitions, reply: (_name: string, _key: string): Response => ({ code: 0, stdout: typedZero }) };
  const run = async (binary: string, argv: string[]) => {
    if (binary === "/usr/bin/systemctl") {
      const [action, name, ...props] = argv; expect(action).toBe("show"); expect(units[name]).toBeDefined();
      return { code: 0, stdout: Object.entries(units[name]).filter(([k]) => props.includes("--property=" + k)).map(([k, v]) => k + "=" + v).join("\n") };
    }
    const [flag, method, service, path, iface, key] = argv;
    expect(binary).toBe("/usr/bin/busctl"); expect(argv).toHaveLength(6);
    expect([flag, method, service, iface]).toEqual(["--system", "get-property", "org.freedesktop.systemd1", "org.freedesktop.systemd1.Service"]);
    const name = Object.keys(objectPaths).find(n => objectPaths[n] === path);
    if (!name || !["ExecStop", "ExecStopPost"].includes(key)) throw Error("unexpected_bus_query");
    calls.push(name + ":" + key); return f.reply(name, key);
  };
  const observe = (name: string) => observeUnit(name, run, async (path: string) => definitions[path]);
  const ledger = createUnitLedger({ supervisorUnit: supervisor, workerUnitPrefix: prefix }, "token", { observe,
    mutate: async (action: string, name: string) => { mutations.push(action + ":" + name); } });
  ledger.submitted(); await ledger.captureSupervisor(); await ledger.recordWorker({ runtimeHandle: handle, executionGeneration: "1" });
  for (const v of Object.values(units)) { delete v.ExecStop; delete v.ExecStopPost; }
  return { f, ledger };
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
