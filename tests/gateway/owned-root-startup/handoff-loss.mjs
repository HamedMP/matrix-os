/* Post-implementation audit: fixture-controlled actual I loss after positive
 * real birth-send. No fake75, mocked IO, product signal or session-ready claim. */
import assert from "node:assert/strict";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { access } from "node:fs/promises";
import { bounded, now, waited } from "./support.mjs";

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function stoppedStatus(row) {
  assert.equal(row.birthLife.alive(), true);
  const fd = openSync(`/proc/${row.child.pid}/status`, constants.O_RDONLY | constants.O_CLOEXEC);
  const bytes = Buffer.alloc(4096); let size;
  try { size = readSync(fd, bytes, 0, bytes.length, null); } finally { closeSync(fd); }
  assert.equal(row.birthLife.alive(), true);
  return /^State:\s+T(?:\s|$)/m.test(bytes.subarray(0, size).toString("utf8"));
}

export function loseInitializerAtRealHandoff(native, rows) {
  const state = { deadlineNs: 0n, calls: 0, positiveBytes: 0, targetBytes: 0, stopVerified: false, stopVerificationNs: 0n };
  const api = Object.create(null);
  for (const name of ["controlPair", "controlChildFd", "receive", "send", "close", "retainChild", "childAlive", "controlSendChildBirth"]) {
    api[name] = (...args) => native[name](...args); // Every call is the actual addon, unchanged.
  }
  api.controlSendChildBirth = (...args) => {
    state.calls += 1; assert.equal(state.calls, 1, "exactly one target/birth send attempt, never replay");
    const initializer = rows.find(row => row.role === "initializer"), daemon = rows.find(row => row.role === "daemon");
    assert.ok(initializer && daemon); assert.equal(initializer.birthLife.alive(), true); assert.equal(daemon.birthLife.alive(), true);
    assert.ok(now() < state.deadlineNs, "first target remains under original startup budget");
    assert.equal(initializer.child.kill("SIGSTOP"), true, "fixture requests stop on actual returned I only");
    const stopStarted = now(), stopEnd = stopStarted + 100_000_000n;
    while (!stoppedStatus(initializer)) {
      assert.ok(now() < stopEnd, "actual I did not enter stopped state within100ms; fixture prerequisite failure");
      Atomics.wait(sleepCell, 0, 0, 1); // Synchronous fixture observation only, bounded1ms turns.
    }
    state.stopVerificationNs = now() - stopStarted;
    assert.ok(now() < stopEnd && now() < state.deadlineNs, "bounded stop observation cannot renew target deadline");
    state.stopVerified = true;
    // I is now actually stopped before any target bytes. Original opaque D
    // birth/channel/payload pass through to the real NAPI call without edits.
    const count = native.controlSendChildBirth(...args);
    assert.ok(Number.isInteger(count) && count > 0 && count <= args[1].length, "required real positive physical handoff byte count");
    state.positiveBytes = count; state.targetBytes = args[1].length;
    assert.equal(initializer.birthLife.alive(), true); assert.equal(daemon.birthLife.alive(), true);
    assert.equal(initializer.child.kill("SIGKILL"), true, "fixture loses the actual stopped I after positive handoff");
    return count;
  };
  return { api, state };
}

export async function auditHandoffLoss(s, f, rows, state) {
  const operation = s.operation; state.deadlineNs = s.options.deadlineNs;
  const first = operation.start(), duplicate = operation.start();
  assert.equal(first, duplicate);
  try {
    const outcome = await bounded(first, s.options.deadlineNs + 400_000_000n, "actual I loss after handoff settles");
    assert.deepEqual(outcome, { disposition: "unknown" }, "positive genuine handoff plus actual I loss must remain Unknown");
    assert.equal(Object.isFrozen(outcome), true);
    assert.equal(state.calls, 1); assert.equal(state.stopVerified, true); assert.ok(state.positiveBytes > 0);
    assert.deepEqual(rows.map(row => row.role), ["initializer", "daemon"]);
    await Promise.all(s.executions);
    for (const row of rows) if (row.observationError) throw row.observationError;
    const initializer = rows[0], daemon = rows[1], end = now() + 3_000_000_000n;
    assert.deepEqual(await operation.waitForExit("initializer", end), { code: null, signal: "SIGKILL" });
    assert.deepEqual(await waited(initializer, end), { code: null, signal: "SIGKILL" });
    assert.equal(initializer.stdout.length, 0); assert.equal(initializer.stderr.length, 0);
    assert.equal(daemon.birthLife.alive(), true, "Unknown did not implicitly stop retained actual D");
    assert.deepEqual(operation.observe(), { initializer: "exited", daemon: "running", fenced: true });
    operation.fence(); operation.fence(); assert.equal(daemon.birthLife.alive(), true, "idempotent fence does not stop D");
    assert.equal(operation.start(), first); assert.deepEqual(await first, outcome); assert.equal(rows.length, 2); assert.equal(state.calls, 1);
    await assert.rejects(access(f.witness), { code: "ENOENT" }); // No observed synthetic pane, never general effect absence.
    // Explicit fixture-owned preinit-D cleanup, separate from the product result.
    assert.equal(daemon.child.kill("SIGKILL"), true);
    assert.deepEqual(await operation.waitForExit("daemon", end), { code: null, signal: "SIGKILL" });
    assert.deepEqual(await waited(daemon, end), { code: null, signal: "SIGKILL" });
    return { fixtureControlledInitializerSignal: "SIGKILL", actualRootExit75: false, stopVerifiedBeforeFirstTarget: true,
      stopVerificationNs: String(state.stopVerificationNs), positivePhysicalTargetBytes: state.positiveBytes, targetFrameBytes: state.targetBytes,
      unknownImmutable: true, daemonRetainedAliveBeforeExplicitOwnerCleanup: true, actualDaemonCleanupSignal: "SIGKILL",
      actualDaemonWait: true, noImplicitStopOrRetry: true, actualStockFrameEffectsMeasured: false, sessionReadyQualified: false };
  } finally {
    // Covers stopped-I prerequisite/send failures as well. Only direct actual
    // children are signalled; no body PID, reopen, process search or product kill.
    operation.fence();
    const cleanupEnd = now() + 3_000_000_000n;
    for (const row of [...rows].reverse()) {
      if (!row.closed) row.child.kill("SIGKILL");
      await bounded(row.wait, cleanupEnd, "actual direct child wait after owner handoff-loss cleanup");
    }
  }
}
