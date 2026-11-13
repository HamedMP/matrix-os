#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assert, assertVacant, command, noSymlinkAncestors, parseOptions, preflight, readOwnerMarker,
  resolveConfig, sourceFacts, stat } from "./devstack-native/control.mjs";
import { compiledRuntimeInventory, verifyCompiledRuntime } from "./devstack-native/compiled.mjs";
import { createStderrCapture, stderrPath } from "./devstack-native/close-evidence.mjs";
import { attestRunningNode, verifyExecutableEvidence } from "./devstack-native/node-evidence.mjs";
import { buildFacts, hostSnapshot } from "./devstack-native/evidence.mjs";
import { createUnitLedger } from "./devstack-native/ownership.mjs";
import { createJournal, safeCode } from "./devstack-native/receipt.mjs";
import { preparePlacement } from "./devstack-native/placement.mjs";
import { verifyDependencies } from "./devstack-native/dependencies.mjs";
import { submitSupervisor } from "./devstack-native/submission.mjs";
import { nativeProof, observeWorkers } from "./devstack-native/proof.mjs";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function run(config, marker, identity, compiled, harnessNode, interrupted) {
  const base = dirname(config.appRoot); const token = `matrix-native-${randomUUID()}`;
  const lockPath = `${base}/.native-acceptance-active`;
  const receiptPath = `${base}/native-acceptance-receipt-${token}.json`;
  const check = () => assert(!interrupted(), "acceptance_interrupted");
  const journal = createJournal(), ledger = createUnitLedger(config, token, { check });
  const receipt = { version: 1, status: "failed", purpose: marker.purpose, namespace: config.namespace,
    source: marker, compiled, harnessNode, host: { platform: process.platform, architecture: process.arch }, startedAt: new Date().toISOString(), receiptPath };
  check();
  await verifyExecutableEvidence(config.ownedNode.binary, harnessNode);
  const lock = await open(lockPath, "wx", 0o600); const ownedLock = await lock.stat();
  let capture;
  try {
    await lock.writeFile(`${token}\n`); await assertVacant(config, command, ownedLock);
    receipt.placement = await journal.step("placement", () => preparePlacement(config, { check }));
    // Before any native executable/version query, retain definitions, artifacts,
    // required service incarnations and all bounded peer/legacy command sockets.
    receipt.before = await journal.step("baseline", () => hostSnapshot(config));
    const dependencies = await journal.step("dependencies", () => verifyDependencies(config, marker));
    dependencies.workerFile = `${config.appRoot}/packages/scope-runtime/dist/worker.js`;
    receipt.build = await journal.step("build", () => buildFacts(config, dependencies, compiled, harnessNode, check));
    await verifyCompiledRuntime(config.appRoot, compiled);
    const { nodeProfileDigest } = await import(pathToFileURL(`${config.appRoot}/packages/scope-runtime/dist/node-runtime.js`).href);
    const profile = await import(pathToFileURL(`${config.appRoot}/packages/scope-runtime/dist/profile.js`).href);
    const templatePath = `${config.appRoot}/distro/customer-vps/systemd/matrix-scope-runtime.service`;
    await noSymlinkAncestors(templatePath, true); const template = await readFile(templatePath, "utf8");
    await verifyCompiledRuntime(config.appRoot, compiled);
    check();
    capture = await createStderrCapture(stderrPath(config, token), undefined, check);
    await journal.step("supervisor", () => submitSupervisor(config, token, template, ledger, command, receipt.placement, check));
    await nativeProof(config, identity, { journal, ledger, check, capture, dependencies, node: receipt.build.node, baseline: receipt.before,
      expectedProfile: { profileDigest: nodeProfileDigest(profile.SCOPE_RUNTIME_PROFILE_DIGEST, config.ownedNode) } });
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
  let marker, config, identity, compiled, harnessNode;
  try {
    assert(scriptRoot === input["app-root"], "harness_source_mismatch");
    marker = await sourceFacts(input);
    await readOwnerMarker(`${dirname(input["app-root"])}/.native-acceptance-owner.json`, marker);
    const runtime = `${scriptRoot}/packages/scope-runtime/dist`;
    compiled = await compiledRuntimeInventory(scriptRoot);
    const { resolveScopeRuntimeHostConfig } = await import(pathToFileURL(`${runtime}/host-config.js`).href);
    const { createScopeRuntimeUnitIdentity } = await import(pathToFileURL(`${runtime}/systemd-unit-identity.js`).href);
    config = { ...resolveConfig(input, resolveScopeRuntimeHostConfig), home: input.home };
    const { assertProtectedNodeRoot } = await import(pathToFileURL(`${runtime}/node-runtime.js`).href);
    assert(process.execPath === config.ownedNode.binary, "harness_node_mismatch");
    identity = createScopeRuntimeUnitIdentity(input.namespace);
    const readiness = await preflight(config, async root => {
      await assertProtectedNodeRoot(root);
      return attestRunningNode(config.ownedNode.binary, "/proc/self/exe");
    });
    harnessNode = readiness.harnessNode;
    if (input.mode === "preflight" || !readiness.ready) return { ...readiness, mode: input.mode };
  } catch (error) { return blocked(safeCode(error)); }
  return withInterruption(interrupted => run(config, marker, identity, compiled, harnessNode, interrupted));
}

export async function withInterruption(action) {
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  // Repeated signals remain latched until ownership resolution and cleanup finish.
  process.on("SIGTERM", interrupt); process.on("SIGINT", interrupt);
  try { return await action(() => interrupted); }
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
