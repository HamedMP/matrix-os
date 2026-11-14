// Fixed-role fixture IPC is test orchestration only, never product identity.
// Do not touch process.stdin/stdout: native owner exclusively consumes 0/1.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fstatSync, readSync, writeSync, readdirSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fixtureErrorKind, logFixtureFailure } from "./fixture-errors.mjs";
const native = createRequire(import.meta.url)(process.argv[2]);
const pidfdMode = process.argv[3] === "--pidfd-ancillary";
const closedStderrMode = process.argv[3] === "--closed-stderr";
assert.ok(process.argv.length === 3 || pidfdMode && process.argv.length === 5 || closedStderrMode && process.argv.length === 4);
let handle, busy = false, count = 0;
let baselineFds, startupPhase = "adopt";
async function tell(value) {
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 4096 && process.connected);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture IPC deadline")), 2000);
    process.send(value, error => { clearTimeout(timer); error ? reject(error) : resolve(); });
  });
}
async function fail(phase, error) {
  await tell({ event: "fixture-error", phase, errorType: fixtureErrorKind(error), code: ["EPIPE", "EBADF"].includes(error.code) ? error.code : "none" }).catch(ipcError => {
    if (!closedStderrMode) logFixtureFailure("service failure IPC", ipcError); // No stderr diagnostics after owned fd2 close.
  });
  try { if (handle) native.close(handle); }
  finally { process.exit(1); }
}
process.on("message", async message => {
  try {
    assert.ok(!busy && ++count <= 8 && message && Object.keys(message).length === 1);
    busy = true;
    switch (message.command) {
      case "receive-copied-writer": {
        assert.equal(native.inheritedControlCurrent(handle), true);
        const end = process.hrtime.bigint() + 2_000_000_000n;
        let refused = false, frame;
        while (!refused) {
          try { frame = native.receive(handle); } catch (error) { refused = true; break; }
          if (frame !== null) break;
          assert.ok(process.hrtime.bigint() < end, "copied writer original deadline"); await delay(2);
        }
        const observation = { event: "copied-writer", refused, currentClosedError: false, readoptionRefused: false,
          acceptedWriter: frame?.writer ?? null, acceptedHex: frame?.data?.toString("hex") ?? null };
        if (frame?.data) assert.ok(frame.data.length <= 256);
        try { native.inheritedControlCurrent(handle); } catch (error) { observation.currentClosedError = true; }
        try { native.inheritedControl(); } catch (error) { observation.readoptionRefused = true; }
        await tell(observation); // Preserve actual result; host is the assertion oracle.
        break;
      }
      case "control-loss-current": {
        const current = native.inheritedControlCurrent(handle); // FIRST operation after host peer close.
        const observation = { event: "control-loss", current, debugProbeAttempted: false, queuedBytesCouldBeFetched: null,
          receiveClosedError: false, sendClosedError: false, stdioOpen: false, aliasReadBytes: null, aliasWriteError: null, readoptionRefused: false };
        if (current === true) {
          // Diagnostics only on the broken path: consume fixed fixture bytes,
          // never parse or dispatch them as an action. Preserve original oracle.
          observation.debugProbeAttempted = true;
          try { const frame = native.receive(handle); observation.queuedBytesCouldBeFetched = !!frame?.data?.length; }
          catch (error) { observation.queuedBytesCouldBeFetched = false; }
        } else if (current === false) {
          try { native.receive(handle); } catch (error) { observation.receiveClosedError = true; }
          try { native.send(handle, Buffer.from("must-not-write")); } catch (error) { observation.sendClosedError = true; }
          observation.aliasReadBytes = readSync(0, Buffer.alloc(1), 0, 1, null);
          try { writeSync(1, Buffer.from("forbidden-control-loss-alias")); } catch (error) { observation.aliasWriteError = error.code; }
          try { native.inheritedControl(); } catch (error) { observation.readoptionRefused = true; }
        }
        fstatSync(0); fstatSync(1); observation.stdioOpen = true;
        await tell(observation);
        break;
      }
      case "receive-pidfd-ancillary": {
        assert.ok(pidfdMode && Number.isInteger(baselineFds));
        const beforeFds = readdirSync("/proc/self/fd").length;
        const end = process.hrtime.bigint() + 2_000_000_000n;
        let refused = false, frame;
        while (!refused) {
          try { frame = native.receive(handle); } catch (error) { refused = true; break; }
          if (frame !== null) break;
          assert.ok(process.hrtime.bigint() < end, "pidfd receive original deadline"); await delay(2);
        }
        const afterFds = readdirSync("/proc/self/fd").length; // No async-fs descriptor noise.
        assert.equal(refused, true, "unknown PIDFD metadata remains strict refusal");
        assert.throws(() => native.inheritedControlCurrent(handle));
        fstatSync(0); fstatSync(1);
        const aliasReadBytes = readSync(0, Buffer.alloc(1), 0, 1, null);
        let aliasWriteError;
        try { writeSync(1, Buffer.from("forbidden-pidfd-alias-write")); } catch (error) { aliasWriteError = error.code; }
        await tell({ event: "pidfd-refused", refused, beforeFds, afterFds, stdioOpen: true, aliasReadBytes, aliasWriteError });
        break;
      }
      case "receive": {
        assert.equal(native.inheritedControlCurrent(handle), true);
        const end = process.hrtime.bigint() + 2_000_000_000n;
        let frame;
        while ((frame = native.receive(handle)) === null) {
          assert.ok(process.hrtime.bigint() < end, "native receive original deadline"); await delay(2);
        }
        assert.ok(frame && frame.data.length <= 256);
        assert.equal(native.inheritedControlCurrent(handle), true);
        await tell({ event: "received", hex: frame.data.toString("hex"), writer: frame.writer, current: true });
        break;
      }
      case "send": {
        assert.equal(native.inheritedControlCurrent(handle), true);
        const bytes = Buffer.from("native-reply");
        assert.equal(native.send(handle, bytes), bytes.length);
        await tell({ event: "sent", current: native.inheritedControlCurrent(handle) });
        break;
      }
      case "close": {
        native.close(handle);
        assert.throws(() => native.inheritedControlCurrent(handle));
        assert.throws(() => native.receive(handle));
        fstatSync(0); fstatSync(1); // Native owner must not close process-owned raw stdio.
        const aliasReadBytes = readSync(0, Buffer.alloc(1), 0, 1, null);
        assert.equal(aliasReadBytes, 0, "SHUT_RDWR fences inherited read alias");
        let writeCode;
        try { writeSync(1, Buffer.from("forbidden-alias-write")); } catch (error) { writeCode = error.code; }
        assert.equal(writeCode, "EPIPE", "SHUT_RDWR fences inherited write alias");
        assert.throws(() => native.inheritedControl(), "one adoption attempt requires relaunch");
        await tell({ event: "closed", stdioOpen: true, aliasReadBytes, aliasWriteError: writeCode, readoptionRefused: true });
        break;
      }
      case "ping":
        await tell({ event: "pong", servicePID: process.pid });
        break;
      case "exit":
        if (handle) native.close(handle);
        process.exit(0);
        break;
      default:
        throw new Error("unknown fixed fixture command");
    }
    busy = false;
  } catch (error) { await fail(message?.command ?? "command", error); }
});
if (closedStderrMode) {
  try {
    startupPhase = "closed-stderr-constructor";
    closeSync(2); // Only this actual service process's own inherited stderr.
    const beforeFds = readdirSync("/proc/self/fd").length;
    let initiallyClosed = false;
    try { fstatSync(2); } catch (error) { initiallyClosed = error.code === "EBADF"; }
    assert.equal(initiallyClosed, true, "fd2 really is absent immediately before adoption");
    let nativeUnavailable = false;
    try { handle = native.inheritedControl(); }
    catch (error) { nativeUnavailable = error.message === "Terminal native proof unavailable"; }
    const afterFds = readdirSync("/proc/self/fd").length;
    let fd2Closed = false;
    try { fstatSync(2); } catch (error) { fd2Closed = error.code === "EBADF"; }
    fstatSync(0); fstatSync(1);
    let readoptionRefused = false;
    try { native.inheritedControl(); }
    catch (error) { readoptionRefused = error.message === "Terminal native proof unavailable"; }
    await tell({ event: "closed-stderr-attempt", nativeUnavailable, unexpectedSuccess: !!handle, beforeFds, afterFds, fd2Closed, stdioOpen: true, readoptionRefused });
  } catch (error) { await fail(startupPhase, error); }
} else try {
  handle = native.inheritedControl();
  assert.equal(native.inheritedControlCurrent(handle), true);
  const bytes = Buffer.from("native-ready");
  assert.equal(native.send(handle, bytes), bytes.length);
  await tell({ event: "adopted", current: true, actualParentPID: process.ppid });
  if (pidfdMode) {
    startupPhase = "required-SO_PASSPIDFD-prerequisite";
    const setup = spawnSync(process.argv[4], [], { stdio: [0, 1, 2], timeout: 2000 });
    assert.ifError(setup.error);
    assert.equal(setup.status, 0, "actual kernel SO_PASSPIDFD is required, never skipped");
    assert.equal(setup.signal, null);
    baselineFds = readdirSync("/proc/self/fd").length;
    await tell({ event: "pidfd-ancillary-ready", baselineFds, requiredOptionEnabled: true });
  }
} catch (error) { await fail(startupPhase, error); }
