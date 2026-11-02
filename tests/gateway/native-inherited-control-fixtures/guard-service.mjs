// Fixed process-local guard fixtures only; no product authority/data dispatch.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { setImmediate as turn } from "node:timers/promises";
import { readdirSync, mkdtempSync, rmSync, fstatSync, readSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const native = createRequire(import.meta.url)(process.argv[2]), mode = process.argv[3];
assert.ok(["invalid-argument", "worker-attempt", "capacity127", "gc-role"].includes(mode));
const fdCount = () => readdirSync("/proc/self/fd").length;
let commands = 0;
async function tell(value) {
  assert.ok(process.connected && Buffer.byteLength(JSON.stringify(value)) <= 4096);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("guard IPC deadline")), 2000);
    process.send(value, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
  });
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 2000); })]); }
  finally { clearTimeout(timer); }
}
function attempt(call) {
  let handle, nativeUnavailable = false;
  try { handle = call(); } catch (error) { nativeUnavailable = error.message === "Terminal native proof unavailable"; }
  const result = { nativeUnavailable, unexpectedSuccess: !!handle };
  if (handle) native.close(handle); // An injected faulty success is still owned.
  return result;
}
async function fail(error) {
  await tell({ event: "fixture-error", phase: `guard-${mode}`, errorType: error.name }).catch(() => { writeSync(2, "guard IPC unavailable\n"); });
  process.exit(1);
}
process.on("message", async message => {
  try {
    assert.ok(++commands <= 3 && message && Object.keys(message).length === 1);
    if (message.command === "ping") await tell({ event: "pong", servicePID: process.pid });
    else if (message.command === "exit") process.exit(0);
    else throw new Error("unknown guard fixture command");
  } catch (error) { await fail(error); }
});
try {
  let result;
  if (mode === "invalid-argument") {
    const legacy = native.stdoutPair();
    try {
      for (const role of [legacy.receiver, legacy.writer, {}]) assert.throws(() => native.inheritedControlCurrent(role), "new current accepts only its exact role");
    } finally { native.close(legacy.receiver); native.close(legacy.writer); }
    const beforeFds = fdCount(), first = attempt(() => native.inheritedControl("invalid-fixture-argument"));
    const afterFds = fdCount(), retry = attempt(() => native.inheritedControl());
    result = { first, retry, beforeFds, afterFds, wrongRolesRejected: true };
  } else if (mode === "worker-attempt") {
    const worker = new Worker(new URL("./adoption-worker.mjs", import.meta.url), { workerData: { addonPath: process.argv[2] }, execArgv: [] });
    const actualThreadId = worker.threadId;
    const message = new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    const exited = new Promise((resolve, reject) => { worker.once("exit", resolve); worker.once("error", reject); });
    message.catch(() => {}); exited.catch(() => {}); // Original promises remain bounded/awaited below.
    let observation, workerExit;
    try { [observation, workerExit] = await bounded(Promise.all([message, exited]), "actual Worker attempt/exit"); }
    finally { if (worker.threadId !== -1) await bounded(worker.terminate(), "actual Worker cleanup"); }
    result = { worker: observation, actualThreadId, workerExit, exitObserved: worker.threadId === -1, retry: attempt(() => native.inheritedControl()) };
  } else if (mode === "capacity127") {
    const directory = mkdtempSync(join(tmpdir(), "matrix-inherited-cap-")), pairs = [];
    let listener;
    try {
      for (let n = 0; n < 63; n++) pairs.push(native.controlPair());
      listener = native.listen(join(directory, "control.sock")); // Existing cost1 primitive, own private path.
      const beforeFds = fdCount(), first = attempt(() => native.inheritedControl()), afterFds = fdCount();
      result = { pairs: pairs.length, listenerHeld: true, chargedSlots: 127, beforeFds, afterFds, first };
    } finally {
      if (listener) native.close(listener);
      for (const pair of pairs) { native.close(pair.channel); native.close(pair.child); }
      rmSync(directory, { recursive: true, force: true });
    }
    result.retryAfterRelease = attempt(() => native.inheritedControl()); result.temporaryRootRemoved = true;
  } else if (mode === "gc-role") {
    assert.equal(typeof global.gc, "function", "actual --expose-gc prerequisite");
    const beforeFds = fdCount();
    function adoptAndDrop() {
      const handle = native.inheritedControl(); assert.equal(native.inheritedControlCurrent(handle), true);
      for (const getter of [native.controlChildFd, native.stdoutWriterFd, native.stdoutReceive, native.childAlive]) assert.throws(() => getter(handle), "legacy getters cannot reveal/use new-role fd/proof");
      const bytes = Buffer.from("native-ready"); assert.equal(native.send(handle, bytes), bytes.length);
      return fdCount(); // No handle escapes or remains captured by the observation/IPC.
    }
    const duringFds = adoptAndDrop(), end = process.hrtime.bigint() + 2_000_000_000n;
    let afterFds = duringFds, iterations = 0;
    while (afterFds !== beforeFds && iterations < 64 && process.hrtime.bigint() < end) {
      global.gc(); await turn(); afterFds = fdCount(); iterations++;
    }
    fstatSync(0); fstatSync(1);
    let aliasReadBytes = null, aliasReadError = null, aliasWriteError = null;
    try { aliasReadBytes = readSync(0, Buffer.alloc(1), 0, 1, null); } catch (error) { aliasReadError = error.code; }
    try { writeSync(1, Buffer.from("forbidden-gc-alias")); } catch (error) { aliasWriteError = error.code; }
    result = { beforeFds, duringFds, afterFds, iterations, stdioOpen: true, aliasReadBytes, aliasReadError, aliasWriteError,
      retry: attempt(() => native.inheritedControl()), legacyGettersRejected: true };
  }
  await tell({ event: "guard-result", mode, result });
} catch (error) { await fail(error); }
