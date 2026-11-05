#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assert, assertVacant, command, must, noSymlinkAncestors, parseOptions, preflight, readOwnerMarker,
  resolveConfig, sourceFacts, stat, withOwnedSupervisor } from "./devstack-native/control.mjs";
import { buildFacts, hostSnapshot, inspectWorker, show } from "./devstack-native/evidence.mjs";
import { nativeProof, supervisorArgs } from "./devstack-native/proof.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const safeCode = error => /^[a-z][a-z0-9_]{0,95}$/.test(error?.message) ? error.message : "native_acceptance_failed";

async function cleanupWorkers(config, identity) {
  const listing = await must("/usr/bin/systemctl", ["list-units", "--all", "--no-legend", "--plain", identity.discoveryGlob], "owned_worker_inventory_failed");
  const units = listing.split("\n").map(line => line.trim().split(/\s+/)[0]).filter(Boolean);
  assert(units.length <= 32, "owned_worker_capacity");
  for (const unit of units) {
    const handle = identity.parseWorkerUnit(unit); assert(handle, "cleanup_worker_identity_invalid");
    const evidence = await show(unit, ["Transient", "RootDirectory", "DynamicUser"]);
    assert(evidence.Transient === "yes" && evidence.DynamicUser === "yes"
      && evidence.RootDirectory === `${config.stateRoot}/runtimes/${handle.slice(8)}/root`, "cleanup_worker_ownership_unproven");
    await must("/usr/bin/systemctl", ["stop", unit], "owned_worker_cleanup_failed");
  }
  return { workersChecked: units.length, exactNamesOnly: true };
}
async function run(config, marker, identity, interrupted) {
  const base = dirname(config.appRoot); const token = `matrix-native-${randomUUID()}`;
  const lockPath = `${base}/.native-acceptance-active`;
  const receiptPath = `${base}/native-acceptance-receipt-${token}.json`;
  const receipt = { version: 1, status: "failed", purpose: marker.purpose, namespace: config.namespace,
    source: marker, host: { platform: process.platform, architecture: process.arch }, startedAt: new Date().toISOString(), receiptPath };
  const lock = await open(lockPath, "wx", 0o600); const ownedLock = await lock.stat();
  try {
    await lock.writeFile(`${token}\n`);
    await assertVacant(config, command, ownedLock);
    receipt.build = await buildFacts(config);
    receipt.before = await hostSnapshot(config);
    const templatePath = `${config.appRoot}/distro/customer-vps/systemd/matrix-scope-runtime.service`;
    await noSymlinkAncestors(templatePath, true);
    const template = await readFile(templatePath, "utf8");
    // This exclusive lock reserves a previously vacant namespace. No installed unit is changed.
    await withOwnedSupervisor(config, token, command, async () => {
      await must("/usr/bin/systemd-run", supervisorArgs(config, token, template), "owned_supervisor_start_failed", 30_000);
    }, async () => {
      receipt.native = await nativeProof(config, identity, unit => inspectWorker(config, unit));
    }, async () => { receipt.cleanup = await cleanupWorkers(config, identity); });
    receipt.status = "passed";
  } catch (error) { receipt.error = safeCode(error); }
  finally {
    try {
      if (receipt.before) {
        receipt.after = await hostSnapshot(config);
        receipt.unchangedPeersAndInstalled = JSON.stringify(receipt.before) === JSON.stringify(receipt.after);
        assert(receipt.unchangedPeersAndInstalled, "peer_or_installed_state_changed");
      }
    } catch (error) { receipt.status = "failed"; receipt.cleanupError = safeCode(error); }
    await lock.close();
    const current = await stat(lockPath);
    if (current?.ino === ownedLock.ino && current.dev === ownedLock.dev) await unlink(lockPath);
    else { receipt.status = "failed"; receipt.cleanupError = "lock_ownership_lost"; }
    if (interrupted()) { receipt.status = "failed"; receipt.error = "acceptance_interrupted"; }
    receipt.finishedAt = new Date().toISOString();
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return receipt;
}
export async function main(argv) {
  const input = parseOptions(argv);
  const blocked = code => ({ mode: input.mode, ready: false, blockers: [code] });
  let marker, config, identity;
  try {
    assert(scriptRoot === input["app-root"], "harness_source_mismatch");
    marker = await sourceFacts(input);
    await readOwnerMarker(`${dirname(input["app-root"])}/.native-acceptance-owner.json`, marker);
    const runtime = `${scriptRoot}/packages/scope-runtime/dist`;
    for (const name of ["host-config.js", "systemd-unit-identity.js", "protocol.js"]) await noSymlinkAncestors(`${runtime}/${name}`, true);
    const { resolveScopeRuntimeHostConfig } = await import(pathToFileURL(`${runtime}/host-config.js`).href);
    const { createScopeRuntimeUnitIdentity } = await import(pathToFileURL(`${runtime}/systemd-unit-identity.js`).href);
    config = { ...resolveConfig(input, resolveScopeRuntimeHostConfig), home: input.home };
    identity = createScopeRuntimeUnitIdentity(input.namespace);
    const readiness = await preflight(config);
    if (input.mode === "preflight" || !readiness.ready) return { ...readiness, mode: input.mode };
  } catch (error) { return blocked(safeCode(error)); }
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  // Finish the current bounded operation, then clean owned resources and write a failed receipt.
  process.once("SIGTERM", interrupt); process.once("SIGINT", interrupt);
  try { return await run(config, marker, identity, () => interrupted); }
  finally { process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.ready === true || result.status === "passed" ? 0 : 2;
  } catch (error) { process.stderr.write(`${safeCode(error)}\n`); process.exitCode = 2; }
}
