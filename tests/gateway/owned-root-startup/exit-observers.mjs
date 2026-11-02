/* One additional real running-D resource-bound case. No product implicit stop. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { bounded, command, now, until, waited } from "./support.mjs";

function observe(promise, records) {
  const record = { state: "pending" };
  // Attach both handlers immediately, before any assertions/microtask barriers.
  record.done = promise.then(value => { record.state = "fulfilled"; record.value = value; },
    error => { record.state = "rejected"; record.error = error; });
  records.push(record); return record;
}
function coarse(error, work) {
  assert.ok(error instanceof Error); assert.ok(error.message.length > 0 && error.message.length <= 160);
  assert.ok(!error.message.includes(work), "observer rejection cannot expose owned filesystem path");
}

export async function boundedExitObservers(s, binary, f, rows) {
  const records = [], operation = s.operation;
  let daemon;
  try {
    assert.deepEqual(await bounded(operation.start(), s.options.deadlineNs + 400_000_000n, "real observer-case startup"),
      { disposition: "first_frame_complete" });
    await Promise.all(s.executions);
    for (const row of rows) if (row.observationError) throw row.observationError;
    assert.deepEqual(rows.map(row => row.role), ["initializer", "daemon"]); daemon = rows[1];
    const readyEnd = now() + 8_000_000_000n;
    assert.deepEqual(await operation.waitForExit("initializer", readyEnd), { code: 0, signal: null });
    await waited(rows[0], readyEnd);
    // Settle the bounded synthetic pane before any failure cleanup may explicitly
    // kill D. This is actual Screen/native wait evidence, not a ready marker.
    await until(async () => {
      try {
        const witness = await readFile(f.witness); assert.ok(witness.length <= 65536);
        const result = await command(binary, ["--session", f.sessionName, "action", "list-panes", "--all", "--json"], f.expected, f.cwd, readyEnd);
        assert.equal(result.code, 0);
        const terminals = JSON.parse(result.stdout).filter(row => !row.is_plugin);
        return terminals.length === 1 && terminals[0].exited && terminals[0].exit_status === 0;
      } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }, readyEnd, "actual bounded pane wait before explicit owner D exit probe");
    assert.equal(daemon.birthLife.alive(), true);
    const firstDeadline = now() + 200_000_000n;
    const first = observe(operation.waitForExit("daemon", firstDeadline), records);
    const second = observe(operation.waitForExit("daemon", now() + 3_000_000_000n), records);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(second.state, "rejected", "one pending exit observer per role: second rejects within two microtasks");
    coarse(second.error, f.work);
    assert.equal(daemon.birthLife.alive(), true, "observer refusal cannot stop or infer D exit");
    await bounded(first.done, firstDeadline + 400_000_000n, "first actual observer deadline");
    assert.equal(first.state, "rejected", "observation timeout is not synthetic process exit"); coarse(first.error, f.work);
    assert.equal(daemon.birthLife.alive(), true, "first observer timeout does not signal D");
    const actualExitEnd = now() + 4_000_000_000n;
    const next = observe(operation.waitForExit("daemon", actualExitEnd), records);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(next.state, "pending", "timed-out observer releases role capacity while D is still running");
    assert.equal(daemon.birthLife.alive(), true);
    const stop = await command(binary, ["kill-session", f.sessionName], f.expected, f.cwd, actualExitEnd);
    assert.equal(stop.code, 0, "explicit fixture canonical stop ACK, separate from observed D exit");
    await bounded(next.done, actualExitEnd, "replacement observer actual D exit");
    assert.equal(next.state, "fulfilled"); assert.deepEqual(next.value, { code: 0, signal: null });
    assert.deepEqual(await waited(daemon, actualExitEnd), { code: 0, signal: null });
    assert.equal(operation.observe().daemon, "exited");
    return { onePendingObserverPerRole: true, concurrentRejectedWithinTwoMicrotasks: true, firstTimeoutReleasedCapacity: true,
      timeoutDidNotStopDaemon: true, canonicalStopAck: true, replacementObservedActualDaemonWait0: true };
  } finally {
    // On old-source Red, settle observers through an explicit fixture-owned
    // actual exit before general cleanup. This is not module stop behavior or
    // a claim that a signal request proves workload/process termination.
    operation.fence();
    if (daemon && !daemon.closed) daemon.child.kill("SIGKILL");
    if (daemon) await bounded(daemon.wait, now() + 3_000_000_000n, "actual D wait after explicit owner failure cleanup");
    await bounded(Promise.allSettled(records.map(record => record.done)), now() + 3_000_000_000n, "settle all attached fixture exit observers");
  }
}
