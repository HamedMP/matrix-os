import { mkdir, copyFile, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { expect, it, afterEach, vi } from "vitest";
import { supervisorArgs, createTrackedWorker } from "../../scripts/ops/devstack-native/proof.mjs";
import { inspectWorkerPair } from "../../scripts/ops/devstack-native/evidence.mjs";
import { assertNoUnits } from "../../scripts/ops/devstack-native/control.mjs";
import { preparePlacement } from "../../scripts/ops/devstack-native/placement.mjs";
import { submitSupervisor } from "../../scripts/ops/devstack-native/submission.mjs";
import { createUnitLedger, CASCADE_KEYS } from "../../scripts/ops/devstack-native/ownership.mjs";
import { createJournal } from "../../scripts/ops/devstack-native/receipt.mjs";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const scratch = async () => { const path = await mkdtemp(join(process.cwd(), ".native-fix-")); dirs.push(path); return path; };
const config = { namespace: "proof", supervisorUnit: "matrix-devstack-proof-scope-runtime.service", workerUnitPrefix: "matrix-devstack-proof-scope-runtime-" };
const handle = "runtime_" + "a".repeat(32), unit = config.workerUnitPrefix + handle.slice(8) + ".service";
const template = "[Service]\nProtectSystem=strict\nPrivateNetwork=yes";
const installed = "/opt/matrix/runtime/node/bin/codex";
const positive = "matrix-gateway.service enabled enabled";
function owner(pid: string) { return { MainPID: pid, InvocationID: pid.padStart(32, "a"), LoadState: "loaded", ActiveState: "active", SubState: "running", DefinitionIdentity: "definition", Description: "matrix-native-proof", Transient: "yes", KillSignal: "9", RuntimeDirectoryPreserve: "yes", ...Object.fromEntries(CASCADE_KEYS.map((key: string) => [key, ""])) }; }
function ledgerFor(check = () => {}) {
  const mutate = vi.fn(async () => {}), ledger = createUnitLedger(config, "matrix-native-proof", { check, observe: async (name: string) => owner(name === unit ? "42" : "41"), mutate });
  return { ledger, mutate };
}
it("refuses to enter supervisor discovery while a present installed Codex executable is accessible", async () => {
  const root = await scratch(), sentinel = join(root, "codex"), marker = join(root, "invoked"), main = join(root, "main.mjs");
  await writeFile(sentinel, "#!/bin/sh\necho ran > \"$1\"\n", { mode: 0o755 });
  await writeFile(main, `import { execFileSync } from 'node:child_process'; execFileSync(${JSON.stringify(sentinel)}, [${JSON.stringify(marker)}]);`);
  const helpers = join(root, "scripts/ops/devstack-native");
  await mkdir(helpers, { recursive: true });
  await copyFile(new URL("../../scripts/ops/devstack-native/codex-mask-preload.mjs", import.meta.url), join(helpers, "codex-mask-preload.mjs"));
  await writeFile(join(helpers, "security.mjs"), "export const CODEX_BINARY = " + JSON.stringify(sentinel) + ";");
  const ownedNode = { root: "/var/lib/matrix-devstack/proof/runtime/node", binary: "/var/lib/matrix-devstack/proof/runtime/node/bin/node" };
  const args = supervisorArgs({ ...config, ownedNode, appRoot: root, runtimeDirectory: root, commandSocketRoot: root }, "matrix-native-proof", template);
  // Run the generated Node command with the host path and runtime entry mapped into this private fixture.
  const node = args.indexOf(ownedNode.binary);
  const argv = args.slice(node + 1).map((arg: string) => arg.replaceAll(installed, sentinel).replace(root + "/packages/scope-runtime/dist/main.js", main));
  const result = await promisify(execFile)(process.execPath, argv).then(() => "entered", () => "refused");
  expect.soft(await readFile(marker, "utf8").catch(() => null)).toBeNull();
  expect.soft(args).toContain("--property=InaccessiblePaths=-" + installed);
  expect(result).toBe("refused");
  await rm(sentinel);
  await writeFile(main, 'import { pathToFileURL } from "node:url"; if (pathToFileURL(process.argv[1]).href !== import.meta.url) throw Error("wrong_main"); process.stdout.write("entered");');
  await expect(promisify(execFile)(process.execPath, argv)).resolves.toMatchObject({ stdout: "entered" });
});
it("proves vacancy with complete successful unit-file inventory even on a manager returning 1 for unmatched globs", async () => {
  await expect(assertNoUnits(config, async (_: string, argv: string[]) => {
    if (argv[0] === "show") return { code: 0, stdout: "LoadState=not-found" };
    if (argv[0] === "list-units") return { code: 0, stdout: "" };
    return argv.some(s => s.includes("*")) ? { code: 1, stdout: "" } : { code: 0, stdout: positive };
  })).resolves.toBeUndefined();
});
it.each(["empty", "failed", "malformed", "own"])("refuses %s full unit-file inventory", async kind => {
  const rows = { empty: "", failed: positive, malformed: positive + "\n???", own: positive + "\n" + unit + " disabled enabled" };
  await expect(assertNoUnits(config, async (_: string, argv: string[]) => ({ code: argv[0] === "list-unit-files" && kind === "failed" ? 1 : 0,
    stdout: argv[0] === "show" ? "LoadState=not-found" : argv[0] === "list-unit-files" ? rows[kind as keyof typeof rows] : "" }))).rejects.toThrow();
});
it("interrupt before actual submission leaves the supervisor unsubmitted", async () => {
  const root = await scratch(), cfg = { ...config, runtimeDirectory: join(root, "run/s"), commandSocketRoot: join(root, "run/c"), stateRoot: join(root, "state/s"), appRoot: join(root, "app") };
  const placement = await preparePlacement(cfg), submit = vi.fn(), run = vi.fn(async (bin: string, args: string[]) => {
    if (bin.endsWith("/systemd-run")) submit();
    return { code: 0, stdout: args[0] === "show" ? "LoadState=not-found" : args[0] === "list-unit-files" && !args.at(-1)?.includes("*") ? positive : "" };
  });
  const { ledger } = ledgerFor(); let halted = false;
  try { await expect(submitSupervisor(cfg, "matrix-native-proof", template, ledger, run, { ...placement, verify: async () => { await placement.verify(); halted = true; } }, () => { if (halted) throw Error("acceptance_interrupted"); })).rejects.toThrow("acceptance_interrupted"); }
  finally { await placement.close(); }
  expect(submit).not.toHaveBeenCalled();
});
it("finishes the in-flight create on interrupt and cleans it without submitting another create or crash", async () => {
  let halted = false; const check = () => { if (halted) throw Error("acceptance_interrupted"); };
  const { ledger, mutate } = ledgerFor(check); ledger.submitted(); await ledger.captureSupervisor();
  const journal = createJournal(), profile = { executionGeneration: "7", adapter: {} };
  const request = vi.fn(async () => { halted = true; return { runtimeHandle: handle, executionGeneration: "7", state: "running" }; });
  await journal.step("isolation", async () => {
    await createTrackedWorker(config, profile, ledger, async () => {}, { request, inventory: async () => [], check });
    await createTrackedWorker(config, profile, ledger, async () => {}, { request, inventory: async () => [], check });
  }).catch((error: Error) => journal.fail(error));
  expect(ledger.evidence().workers).toMatchObject([{ handle }]); expect.soft(ledger.quarantine()).toEqual([]);
  expect.soft(request).toHaveBeenCalledTimes(1);
  await expect(ledger.supervisorAction("kill")).rejects.toThrow("acceptance_interrupted");
  const protocol = vi.fn();
  await expect(ledger.protocolAction(handle, protocol)).rejects.toThrow("acceptance_interrupted");
  await expect(ledger.supervisorAction("stop", async () => async () => ({}))).rejects.toThrow("acceptance_interrupted");
  expect(protocol).not.toHaveBeenCalled();
  expect(mutate).not.toHaveBeenCalled();
  expect(journal.result()).toMatchObject({ status: "failed", gates: { isolation: { state: "failed", code: "acceptance_interrupted" } } });
  expect(await ledger.cleanup()).toContainEqual({ unit, state: "passed", outcome: "stopped" });
});
it.each(["net", "mnt", "user", "root", "cgroup", "none"])("requires simultaneous pairwise isolation with shared %s", async fault => {
  const handles = ["1", "2"], freshWorker = vi.fn(async (id: string) => owner(id));
  const result = inspectWorkerPair({ freshWorker }, handles, async (id: string) => ({
    properties: { MainPID: id }, namespaces: { user: "user:[" + (fault === "user" ? "3" : id) + "]", net: "net:[" + (fault === "net" ? "3" : id) + "]", mnt: "mnt:[" + (fault === "mnt" ? "3" : id) + "]" },
    rootIdentity: { device: "1", inode: fault === "root" ? "3" : id }, uid: 61200, cgroup: "0::/system.slice/" + (fault === "cgroup" ? "same" : id) + ".service",
  }));
  if (fault === "none") { await expect(result).resolves.toBeDefined(); expect(freshWorker).toHaveBeenCalledTimes(4); }
  else await expect(result).rejects.toThrow(/worker_pair/);
});
it("retains the worker claim when a stop response carries the restarted manager generation", async () => {
  const { ledger } = ledgerFor(); ledger.submitted(); await ledger.captureSupervisor();
  await ledger.recordWorker({ runtimeHandle: handle, executionGeneration: "7" });
  expect(() => ledger.releaseWorker(handle, { state: "stopped", runtimeHandle: handle, executionGeneration: "8" })).toThrow("runtime_stop_generation_mismatch");
  expect(() => ledger.releaseWorker(handle, { state: "stopped", runtimeHandle: handle, executionGeneration: "7" })).not.toThrow();
});

it("keeps repeated interrupts latched while a bounded operation and its cleanup finish", async () => {
  const module = new URL("../../scripts/ops/devstack-native-acceptance.mjs", import.meta.url).href;
  const program = `
    import { withInterruption } from ${JSON.stringify(module)};
    import { once } from "node:events";
    const initial = process.listenerCount("SIGTERM");
    const send = async () => { const event = once(process, "SIGTERM"); process.kill(process.pid, "SIGTERM"); await event; };
    const keepAlive = setInterval(() => {}, 1000);
    try { await withInterruption(async halted => {
      await send();
      try { if (!halted()) throw Error("first_signal_lost"); }
      finally {
        if (process.listenerCount("SIGTERM") !== initial + 1) throw Error("cleanup_handler_lost");
        await send(); if (!halted()) throw Error("second_signal_lost");
      }
    }); } finally { clearInterval(keepAlive); }
    if (process.listenerCount("SIGTERM") !== initial) throw Error("handler_leaked");
    process.stdout.write("cleanup_completed");`;
  await expect(promisify(execFile)(process.execPath, ["--input-type=module", "--eval", program], { timeout: 5000 }))
    .resolves.toMatchObject({ stdout: "cleanup_completed" });
});
