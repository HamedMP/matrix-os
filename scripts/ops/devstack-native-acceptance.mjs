#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assert, assertVacant, command, noSymlinkAncestors, parseOptions, preflight, readOwnerMarker,
  resolveConfig, sourceFacts, stat } from "./devstack-native/control.mjs";
import { compiledRuntimeInventory, verifyCompiledRuntime } from "./devstack-native/compiled.mjs";
import { createStderrCapture, stderrPath } from "./devstack-native/close-evidence.mjs";
import { buildFacts, hostSnapshot } from "./devstack-native/evidence.mjs";
import { createUnitLedger } from "./devstack-native/ownership.mjs";
import { createJournal, safeCode } from "./devstack-native/receipt.mjs";
import { preparePlacement } from "./devstack-native/placement.mjs";
import { verifyDependencies } from "./devstack-native/dependencies.mjs";
import { submitSupervisor } from "./devstack-native/submission.mjs";
import { nativeProof, observeWorkers } from "./devstack-native/proof.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function run(config, marker, identity, compiled, interrupted) {
  const base = dirname(config.appRoot); const token = `matrix-native-${randomUUID()}`;
  const lockPath = `${base}/.native-acceptance-active`;
  const receiptPath = `${base}/native-acceptance-receipt-${token}.json`;
  const journal = createJournal(), ledger = createUnitLedger(config, token);
  const receipt = { version: 1, status: "failed", purpose: marker.purpose, namespace: config.namespace,
    source: marker, compiled, host: { platform: process.platform, architecture: process.arch }, startedAt: new Date().toISOString(), receiptPath };
  const lock = await open(lockPath, "wx", 0o600); const ownedLock = await lock.stat();
  let capture;
  try {
    await lock.writeFile(`${token}\n`); await assertVacant(config, command, ownedLock);
    receipt.placement = await journal.step("placement", () => preparePlacement(config));
    // Before any native executable/version query, retain definitions, artifacts,
    // required service incarnations and all bounded peer/legacy command sockets.
    receipt.before = await journal.step("baseline", () => hostSnapshot(config));
    const dependencies = await journal.step("dependencies", () => verifyDependencies(config, marker));
    dependencies.workerFile = `${config.appRoot}/packages/scope-runtime/dist/worker.js`;
    receipt.build = await journal.step("build", () => buildFacts(config, dependencies, compiled));
    await verifyCompiledRuntime(config.appRoot, compiled);
    const profile = await import(pathToFileURL(`${config.appRoot}/packages/scope-runtime/dist/profile.js`).href);
    const templatePath = `${config.appRoot}/distro/customer-vps/systemd/matrix-scope-runtime.service`;
    await noSymlinkAncestors(templatePath, true); const template = await readFile(templatePath, "utf8");
    await verifyCompiledRuntime(config.appRoot, compiled);
    capture = await createStderrCapture(stderrPath(config, token));
    await journal.step("supervisor", () => submitSupervisor(config, token, template, ledger, command, receipt.placement));
    await nativeProof(config, identity, { journal, ledger, capture, dependencies, baseline: receipt.before,
      expectedProfile: { profileDigest: profile.SCOPE_RUNTIME_PROFILE_DIGEST } });
  } catch (error) { receipt.error = journal.fail(error); }
  finally {
    try {
      receipt.cleanup = await journal.step("cleanup", async () => {
        receipt.ownership = ledger.evidence();
        const checks = await ledger.cleanup(); receipt.cleanupChecks = checks; receipt.ownership = ledger.evidence();
        ledger.inventory(await observeWorkers(config)); receipt.quarantine = ledger.quarantine();
        assert(checks.every(item => item.state === "passed") && receipt.quarantine.length === 0, "cleanup_or_quarantine_unresolved"); return checks;
      });
    } catch (error) { receipt.cleanupError = journal.fail(error); }
    if (receipt.before) try {
      await journal.step("unchanged", async () => {
        receipt.after = await hostSnapshot(config);
        receipt.unchangedPeersAndInstalled = JSON.stringify(receipt.before) === JSON.stringify(receipt.after);
        assert(receipt.unchangedPeersAndInstalled, "peer_or_installed_state_changed"); return { identical: true };
      });
    } catch (error) { receipt.baselineError = journal.fail(error); }
    if (capture) try { await capture.close(); } catch (error) { receipt.captureCleanupError = journal.fail(error); }
    if (receipt.placement?.close) try { await receipt.placement.close(); } catch (error) { receipt.placementError = journal.fail(error); }
    await lock.close();
    const current = await stat(lockPath);
    if (current?.ino === ownedLock.ino && current.dev === ownedLock.dev) await unlink(lockPath);
    else receipt.lockError = journal.fail(Error("lock_ownership_lost"));
    if (interrupted()) receipt.error = journal.fail(Error("acceptance_interrupted"));
    Object.assign(receipt, journal.result()); receipt.finishedAt = new Date().toISOString();
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  return receipt;
}
export async function main(argv) {
  const input = parseOptions(argv);
  const blocked = code => ({ mode: input.mode, ready: false, blockers: [code] });
  let marker, config, identity, compiled;
  try {
    assert(scriptRoot === input["app-root"], "harness_source_mismatch");
    marker = await sourceFacts(input);
    await readOwnerMarker(`${dirname(input["app-root"])}/.native-acceptance-owner.json`, marker);
    const runtime = `${scriptRoot}/packages/scope-runtime/dist`;
    compiled = await compiledRuntimeInventory(scriptRoot);
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
  try { return await run(config, marker, identity, compiled, () => interrupted); }
  finally { process.removeListener("SIGTERM", interrupt); process.removeListener("SIGINT", interrupt); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    const output = result.receiptPath ? { status: result.status, receiptPath: result.receiptPath, sourceSha: result.source.sourceSha, error: result.error, gates: Object.fromEntries(Object.entries(result.gates).map(([name, value]) => [name, value.state])) } : result;
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = result.ready === true || result.status === "passed" ? 0 : 2;
  } catch (error) { process.stderr.write(`${safeCode(error)}\n`); process.exitCode = 2; }
}
