/* First actual Linux vertical slice only. Fixture IPC is NOT product identity.
 * Parent compiles unchanged addon for APIabsence Red, then owns actual Green.
 * node FILE --addon PATH --pidfd-setter PATH (non-PID1/cap0 topology). */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { readdirSync, fstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const index = process.argv.indexOf("--addon"); assert.ok(index >= 0 && process.argv[index + 1]);
const addonPath = resolve(process.argv[index + 1]);
const setterIndex = process.argv.indexOf("--pidfd-setter"); assert.ok(setterIndex >= 0 && process.argv[setterIndex + 1]);
const setterPath = resolve(process.argv[setterIndex + 1]);
const relayPath = fileURLToPath(new URL("./native-inherited-control-fixtures/relay.mjs", import.meta.url));
const servicePath = fileURLToPath(new URL("./native-inherited-control-fixtures/service.mjs", import.meta.url));
const writerPath = fileURLToPath(new URL("./native-inherited-control-fixtures/copied-writer.mjs", import.meta.url));
const guardPath = fileURLToPath(new URL("./native-inherited-control-fixtures/guard-service.mjs", import.meta.url));
const workerPath = fileURLToPath(new URL("./native-inherited-control-fixtures/adoption-worker.mjs", import.meta.url));
const results = [], evidence = [], cleanups = new Set(); let native;
async function until(predicate, label) {
  const end = process.hrtime.bigint() + 3_000_000_000n;
  while (!predicate()) { assert.ok(process.hrtime.bigint() < end, `${label} original deadline`); await delay(2); }
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), 3000); })]); }
  finally { clearTimeout(timer); }
}
async function check(name, run) {
  const previous = new Set(cleanups);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.stack ?? error) }); }
  finally {
    for (const cleanup of [...cleanups]) if (!previous.has(cleanup)) {
      try { await cleanup(); } catch (error) { results.push({ name: `${name}: cleanup`, ok: false, error: String(error) }); }
    }
  }
}
function stableFixtureFDs() {
  // Transport construction ONLY, never process identity/proof. Listing fd is
  // already closed when readdirSync returns; fstat excludes that transient fd.
  const entries = readdirSync("/proc/self/fd"); assert.ok(entries.length <= 256, "fixture descriptor snapshot cap");
  return new Set(entries.map(Number).filter(fd => {
    try { fstatSync(fd); return true; } catch (error) { if (error.code === "EBADF") return false; throw error; }
  }));
}
async function fixture({ pidfdAncillary = false, closedStderr = false, copiedWriter = false, guardMode = null } = {}) {
  const beforePair = copiedWriter ? stableFixtureFDs() : null;
  const pair = native.controlPair(), messages = [], writerMessages = [];
  let relay, birth, exited, writer, writerBirth, writerExited, fault, stderrBytes = 0;
  const send = async command => {
    assert.ok(relay.connected);
    await bounded(new Promise((resolveSend, reject) => relay.send({ command }, error => error ? reject(error) : resolveSend())), "parent fixture IPC");
  };
  const cleanup = async () => {
    native.close(pair.channel); native.close(pair.child);
    if (writer && writer.exitCode === null && writer.signalCode === null) writer.kill("SIGKILL");
    if (writerExited) await bounded(writerExited, "actual copied writer cleanup");
    if (writerBirth) { assert.equal(native.childAlive(writerBirth), false); native.close(writerBirth); }
    let forced = false;
    if (relay && relay.exitCode === null && relay.signalCode === null) {
      try { await send("cleanup"); await bounded(exited, "relay-owned cleanup"); }
      catch (error) {
        forced = true;
        try { process.kill(-relay.pid, "SIGKILL"); } catch (killError) { if (killError.code !== "ESRCH") throw killError; }
        await bounded(exited, "owned group forced cleanup");
      }
    }
    if (exited) await bounded(exited, "actual relay exit");
    if (birth) { assert.equal(native.childAlive(birth), false); native.close(birth); }
    cleanups.delete(cleanup);
    assert.equal(forced, false, "forced group cleanup is failure, not normal child ownership evidence");
  };
  cleanups.add(cleanup);
  try {
    const fd = native.controlChildFd(pair.child);
    let parentFixtureFD;
    if (copiedWriter) {
      const added = [...stableFixtureFDs()].filter(value => !beforePair.has(value));
      assert.equal(added.length, 2, "only this synchronous native.controlPair added descriptors");
      assert.ok(added.includes(fd), "known public child endpoint is one of the two");
      const candidates = added.filter(value => value !== fd);
      assert.equal(candidates.length, 1, "exact one opposite parent endpoint, no guessed fd");
      parentFixtureFD = candidates[0]; assert.equal(fstatSync(parentFixtureFD).isSocket(), true);
    }
    assert.ok([pidfdAncillary, closedStderr, copiedWriter, !!guardMode].filter(Boolean).length <= 1);
    assert.ok(guardMode === null || ["invalid-argument", "worker-attempt", "capacity127", "gc-role"].includes(guardMode));
    const extra = pidfdAncillary ? ["--pidfd-ancillary", setterPath] : closedStderr ? ["--closed-stderr"] : guardMode ? ["--guard-mode", guardMode] : [];
    try { relay = spawn(process.execPath, [relayPath, addonPath, ...extra], { stdio: [fd, fd, "pipe", "ipc"], detached: true, env: process.env }); }
    finally { native.close(pair.child); }
    exited = new Promise((resolveExit, reject) => { relay.once("error", reject); relay.once("close", (code, signal) => resolveExit({ code, signal })); });
    exited.catch(() => {}); // Original exit promise is still awaited and reported.
    birth = native.retainChild(relay.pid);
    relay.on("message", message => {
      if (Buffer.byteLength(JSON.stringify(message)) > 4096 || messages.length >= 64) { fault = new Error("fixture IPC cap"); return; }
      if (message?.event === "relay-error" || message?.message?.event === "fixture-error") fault = new Error(`fixture failed at ${message.phase ?? message.message.phase}`);
      messages.push(message);
    });
    relay.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) fault = new Error("fixture stderr cap"); });
    if (copiedWriter) {
      writer = spawn(process.execPath, [writerPath, String(process.pid)], { stdio: [parentFixtureFD, "ignore", "pipe", "ipc"], env: process.env });
      writerExited = new Promise((resolveExit, reject) => { writer.once("error", reject); writer.once("close", (code, signal) => resolveExit({ code, signal })); });
      writerExited.catch(() => {}); // Actual original promise is bounded/awaited on every exit path.
      writerBirth = native.retainChild(writer.pid); // Independently retained actual returned child.
      writer.on("message", message => {
        if (Buffer.byteLength(JSON.stringify(message)) > 1024 || writerMessages.length >= 8) { fault = new Error("writer IPC cap"); return; }
        if (message?.event === "writer-error") fault = new Error("actual copied writer fixture failed");
        writerMessages.push(message);
      });
      writer.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) fault = new Error("fixture stderr cap"); });
    }
  } catch (error) { await cleanup(); throw error; }
  const wait = async predicate => {
    let found;
    await until(() => {
      if (fault) throw fault;
      const n = messages.findIndex(predicate);
      if (n >= 0) { found = messages.splice(n, 1)[0]; return true; }
      return false;
    }, "fixture observation"); return found;
  };
  const receive = async () => {
    let frame; await until(() => { frame = native.receive(pair.channel); return frame !== null; }, "outer native recvmsg"); return frame;
  };
  const sendWriter = async command => {
    assert.ok(writer?.connected);
    await bounded(new Promise((resolveSend, reject) => writer.send({ command }, error => error ? reject(error) : resolveSend())), "copied writer IPC");
  };
  const waitWriter = async event => {
    let found; await until(() => {
      if (fault) throw fault;
      const n = writerMessages.findIndex(message => message.event === event);
      if (n >= 0) { found = writerMessages.splice(n, 1)[0]; return true; } return false;
    }, "actual copied writer observation"); return found;
  };
  return { pair, relay, birth, send, wait, receive, cleanup, writer, writerBirth, writerExited, sendWriter, waitWriter };
}
try {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid(), 0);
  native = createRequire(import.meta.url)(addonPath);
  await check("required inherited-control APIs present; APIabsence is not behavioral success", async () => {
    for (const name of ["inheritedControl", "inheritedControlCurrent", "controlPair", "controlChildFd", "retainChild", "childAlive", "receive", "send", "close"]) assert.equal(typeof native[name], "function", name);
  });
  if (results.every(item => item.ok)) await check("indirect actual service adopts creator-bound control; close fences all aliases without native exit or readoption", async () => {
    const f = await fixture(), spawned = await f.wait(m => m.event === "spawned");
    assert.equal(spawned.relayPID, f.relay.pid); assert.equal(spawned.retainedServiceAlive, true);
    assert.ok(spawned.actualServicePID > 1 && spawned.actualServicePID !== f.relay.pid && spawned.actualServicePID !== process.pid);
    const adopted = await f.wait(m => m.event === "service" && m.message.event === "adopted");
    assert.equal(adopted.message.actualParentPID, f.relay.pid); assert.notEqual(adopted.message.actualParentPID, process.pid, "creator is not service getppid");
    assert.equal(adopted.message.current, true); assert.equal(adopted.retainedServiceAlive, true);
    const ready = await f.receive(); assert.equal(ready.data.toString(), "native-ready");
    assert.deepEqual(ready.writer, { pid: spawned.actualServicePID, uid: process.getuid(), gid: process.getgid() }, "actual kernel writer matches relay's retained spawn return");
    const body = Buffer.from(JSON.stringify({ pid: f.relay.pid, verified: true })); // Wrong payload identity is irrelevant.
    assert.equal(native.send(f.pair.channel, body), body.length); await f.send("receive");
    const received = await f.wait(m => m.event === "service" && m.message.event === "received");
    assert.equal(received.message.hex, body.toString("hex")); assert.equal(received.message.current, true);
    assert.deepEqual(received.message.writer, { pid: process.pid, uid: process.getuid(), gid: process.getgid() });
    assert.equal(received.retainedServiceAlive, true);
    await f.send("send"); const sent = await f.wait(m => m.event === "service" && m.message.event === "sent");
    assert.equal(sent.message.current, true); assert.equal(sent.retainedServiceAlive, true);
    const reply = await f.receive(); assert.equal(reply.data.toString(), "native-reply"); assert.equal(reply.writer.pid, spawned.actualServicePID);
    await f.send("close"); const closed = await f.wait(m => m.event === "service" && m.message.event === "closed");
    assert.deepEqual(closed.message, { event: "closed", stdioOpen: true, aliasReadBytes: 0, aliasWriteError: "EPIPE", readoptionRefused: true });
    assert.equal(closed.relayAliasesOpen, true, "relay still retains copied original endpoint aliases");
    assert.equal(closed.retainedServiceAlive, true); assert.equal(await f.receive(), false, "shutdown, not closing one dup, causes outer EOF");
    await f.send("ping"); const pong = await f.wait(m => m.event === "service" && m.message.event === "pong");
    assert.equal(pong.message.servicePID, spawned.actualServicePID); assert.equal(pong.retainedServiceAlive, true);
    assert.equal(native.childAlive(f.birth), true, "separate intermediary lifetime is still live too");
    await f.send("exit"); const exit = await f.wait(m => m.event === "service-exit");
    assert.equal(exit.code, 0); assert.equal(exit.signal, null); assert.equal(exit.retainedServiceAlive, false, "only actual child exit settles native lifetime");
    await f.cleanup();
  });
  if (results[0]?.ok) await check("actual SO_PASSPIDFD refusal closes installed pidfd plus two owned role descriptors while service remains alive", async () => {
    const f = await fixture({ pidfdAncillary: true });
    const spawned = await f.wait(m => m.event === "spawned");
    const ready = await f.wait(m => m.event === "service" && m.message.event === "pidfd-ancillary-ready");
    assert.equal(ready.message.requiredOptionEnabled, true); assert.equal(ready.retainedServiceAlive, true);
    const initial = await f.receive(); assert.equal(initial.data.toString(), "native-ready"); assert.equal(initial.writer.pid, spawned.actualServicePID);
    const payload = Buffer.from("actual-parent-bytes-trigger-kernel-PIDFD");
    assert.equal(native.send(f.pair.channel, payload), payload.length);
    await f.send("receive-pidfd-ancillary");
    const refused = await f.wait(m => m.event === "service" && m.message.event === "pidfd-refused");
    assert.equal(refused.message.refused, true); assert.equal(refused.retainedServiceAlive, true);
    assert.equal(refused.message.stdioOpen, true); assert.equal(refused.message.aliasReadBytes, 0); assert.equal(refused.message.aliasWriteError, "EPIPE");
    assert.equal(await f.receive(), false, "strict refusal also fences every shared alias");
    await f.send("ping"); const pong = await f.wait(m => m.event === "service" && m.message.event === "pong");
    assert.equal(pong.message.servicePID, spawned.actualServicePID); assert.equal(pong.retainedServiceAlive, true);
    assert.equal(refused.message.beforeFds, ready.message.baselineFds, "independent synchronous pre-recv baseline");
    assert.equal(refused.message.afterFds, refused.message.beforeFds - 2, "all installed SCM_PIDFD rights AND owned socket/proof must be released");
    await f.send("exit"); const exit = await f.wait(m => m.event === "service-exit");
    assert.equal(exit.code, 0); assert.equal(exit.retainedServiceAlive, false); await f.cleanup();
  });
  if (results[0]?.ok) await check("peer control close fences current despite live creator and unread genuine queued bytes", async () => {
    const f = await fixture(), spawned = await f.wait(m => m.event === "spawned");
    const adopted = await f.wait(m => m.event === "service" && m.message.event === "adopted");
    assert.equal(adopted.message.current, true); assert.equal(adopted.retainedServiceAlive, true);
    const ready = await f.receive(); assert.equal(ready.data.toString(), "native-ready"); assert.equal(ready.writer.pid, spawned.actualServicePID);
    const queued = Buffer.from("genuine-queued-before-control-close");
    assert.equal(native.send(f.pair.channel, queued), queued.length, "actual bytes queued before peer close");
    native.close(f.pair.channel); // Only parent endpoint: original host process remains alive.
    await f.send("control-loss-current");
    const observed = await f.wait(m => m.event === "service" && m.message.event === "control-loss");
    evidence.push({ case: "peer-control-loss", ...observed.message });
    await f.send("ping"); const pong = await f.wait(m => m.event === "service" && m.message.event === "pong");
    assert.equal(pong.message.servicePID, spawned.actualServicePID); assert.equal(pong.retainedServiceAlive, true);
    assert.equal(native.childAlive(f.birth), true, "intermediary also remains alive; creator host is executing this assertion");
    assert.equal(observed.message.current, false, "control loss must fence even when retained creator birth is live");
    assert.equal(observed.message.debugProbeAttempted, false); assert.equal(observed.message.queuedBytesCouldBeFetched, null);
    assert.equal(observed.message.receiveClosedError, true); assert.equal(observed.message.sendClosedError, true);
    assert.equal(observed.message.stdioOpen, true); assert.equal(observed.message.aliasWriteError, "EPIPE");
    // aliasReadBytes is diagnostic only: the fixed one-byte raw read may see queued data after shutdown.
    assert.equal(observed.message.readoptionRefused, true);
    await f.send("exit"); const exit = await f.wait(m => m.event === "service-exit");
    assert.equal(exit.code, 0); assert.equal(exit.retainedServiceAlive, false); await f.cleanup();
  });
  if (results[0]?.ok) await check("rejected constructor releases kernel-allocated fd2 with stderr closed while actual service stays alive", async () => {
    const f = await fixture({ closedStderr: true });
    const spawned = await f.wait(m => m.event === "spawned");
    const attempt = await f.wait(m => m.event === "service" && m.message.event === "closed-stderr-attempt");
    evidence.push({ case: "closed-stderr-constructor", ...attempt.message });
    assert.equal(attempt.message.nativeUnavailable, true, "must be actual native unavailable, not missing API");
    assert.equal(attempt.message.unexpectedSuccess, false, "this case must not promote a newly accepted constructor mode");
    assert.equal(attempt.message.stdioOpen, true); assert.equal(attempt.message.readoptionRefused, true);
    assert.equal(attempt.retainedServiceAlive, true);
    await f.send("ping"); const pong = await f.wait(m => m.event === "service" && m.message.event === "pong");
    assert.equal(pong.message.servicePID, spawned.actualServicePID); assert.equal(pong.retainedServiceAlive, true);
    assert.equal(attempt.message.afterFds, attempt.message.beforeFds, "failed adoption must release its newly installed proof fd2");
    assert.equal(attempt.message.fd2Closed, true, "fstat2 independently confirms EBADF after refusal");
    await f.send("exit"); const exit = await f.wait(m => m.event === "service-exit");
    assert.equal(exit.code, 0); assert.equal(exit.retainedServiceAlive, false); await f.cleanup();
  });
  if (results[0]?.ok) await check("same-UID copied writer cannot impersonate live socket creator through a forged PID body", async () => {
    const f = await fixture({ copiedWriter: true }), spawned = await f.wait(m => m.event === "spawned");
    await f.waitWriter("writer-ready");
    const adopted = await f.wait(m => m.event === "service" && m.message.event === "adopted");
    assert.equal(adopted.message.current, true); assert.equal(adopted.retainedServiceAlive, true);
    const ready = await f.receive(); assert.equal(ready.data.toString(), "native-ready"); assert.equal(ready.writer.pid, spawned.actualServicePID);
    assert.notEqual(f.writer.pid, process.pid); assert.notEqual(f.writer.pid, spawned.actualServicePID);
    assert.equal(native.childAlive(f.writerBirth), true);
    await f.sendWriter("emit"); const emitted = await f.waitWriter("writer-emitted");
    const forgedBody = Buffer.from(JSON.stringify({ pid: process.pid, verified: true }));
    assert.equal(emitted.bytes, forgedBody.length); assert.equal(emitted.hex, forgedBody.toString("hex"));
    await f.send("receive-copied-writer");
    const observed = await f.wait(m => m.event === "service" && m.message.event === "copied-writer");
    evidence.push({ case: "same-UID-copied-writer", ...observed.message, actualWriterPID: f.writer.pid, creatorPID: process.pid,
      actualServicePID: spawned.actualServicePID, writerBirthAlive: native.childAlive(f.writerBirth), serviceBirthAlive: observed.retainedServiceAlive });
    await f.send("ping"); const pong = await f.wait(m => m.event === "service" && m.message.event === "pong");
    assert.equal(pong.message.servicePID, spawned.actualServicePID); assert.equal(pong.retainedServiceAlive, true);
    await f.sendWriter("ping"); await f.waitWriter("writer-pong");
    assert.equal(native.childAlive(f.writerBirth), true); assert.equal(native.childAlive(f.birth), true);
    assert.equal(observed.message.refused, true, "kernel copied-writer PID differs despite same UID and claimed creator PID");
    assert.equal(observed.message.acceptedWriter, null); assert.equal(observed.message.acceptedHex, null);
    assert.equal(observed.message.currentClosedError, true); assert.equal(observed.message.readoptionRefused, true);
    assert.equal(await f.receive(), false, "writer mismatch fences the shared control endpoint");
    await f.sendWriter("exit"); const writerExit = await bounded(f.writerExited, "actual writer explicit exit");
    assert.equal(writerExit.code, 0); assert.equal(writerExit.signal, null); assert.equal(native.childAlive(f.writerBirth), false);
    await f.send("exit"); const serviceExit = await f.wait(m => m.event === "service-exit");
    assert.equal(serviceExit.code, 0); assert.equal(serviceExit.retainedServiceAlive, false); await f.cleanup();
  });
  for (const mode of ["invalid-argument", "worker-attempt", "capacity127", "gc-role"]) if (results[0]?.ok) {
    await check(`process-local inherited guard: ${mode}`, async () => {
      const f = await fixture({ guardMode: mode }), spawned = await f.wait(m => m.event === "spawned");
      const observed = await f.wait(m => m.event === "service" && m.message.event === "guard-result" && m.message.mode === mode);
      const value = observed.message.result; evidence.push({ case: mode, ...value });
      await f.send("ping"); const pong = await f.wait(m => m.event === "service" && m.message.event === "pong");
      assert.equal(pong.message.servicePID, spawned.actualServicePID); assert.equal(pong.retainedServiceAlive, true);
      assert.equal(observed.retainedServiceAlive, true); assert.equal(native.childAlive(f.birth), true);
      if (mode === "invalid-argument") {
        assert.equal(value.first.nativeUnavailable, true); assert.equal(value.first.unexpectedSuccess, false);
        assert.equal(value.retry.nativeUnavailable, true, "invalid call atomically burned process-wide adoption"); assert.equal(value.retry.unexpectedSuccess, false);
        assert.equal(value.afterFds, value.beforeFds); assert.equal(value.wrongRolesRejected, true);
      } else if (mode === "worker-attempt") {
        assert.equal(value.worker.nativeUnavailable, true); assert.equal(value.worker.unexpectedSuccess, false); assert.equal(value.worker.cleanupError, false);
        assert.ok(value.actualThreadId > 0); assert.equal(value.worker.threadId, value.actualThreadId);
        assert.equal(value.workerExit, 0); assert.equal(value.exitObserved, true, "actual owned Worker exit, not a PID label");
        assert.equal(value.retry.nativeUnavailable, true, "off-main-thread attempt must burn the same global admission"); assert.equal(value.retry.unexpectedSuccess, false);
      } else if (mode === "capacity127") {
        assert.equal(value.pairs, 63); assert.equal(value.listenerHeld, true); assert.equal(value.chargedSlots, 127);
        assert.equal(value.first.nativeUnavailable, true, "new inherited role requires two shared slots at127"); assert.equal(value.first.unexpectedSuccess, false);
        assert.equal(value.afterFds, value.beforeFds, "capacity refusal installs no leaked descriptors");
        assert.equal(value.retryAfterRelease.nativeUnavailable, true); assert.equal(value.retryAfterRelease.unexpectedSuccess, false); assert.equal(value.temporaryRootRemoved, true);
      } else if (mode === "gc-role") {
        assert.equal(value.duringFds, value.beforeFds + 2, "opaque inherited owner holds socket duplicate and creator pidfd");
        assert.equal(value.afterFds, value.beforeFds, "actual GC finalizer releases exactly2 without process death");
        assert.ok(value.iterations > 0 && value.iterations <= 64); assert.equal(value.stdioOpen, true);
        assert.equal(value.aliasWriteError, "EPIPE", "actual GC shutdown fences copied endpoint aliases");
        assert.equal(value.aliasReadBytes, 0); assert.equal(value.aliasReadError, null); // No incoming bytes queued in this case.
        assert.equal(value.retry.nativeUnavailable, true); assert.equal(value.retry.unexpectedSuccess, false); assert.equal(value.legacyGettersRejected, true);
        const ready = await f.receive(); assert.equal(ready.data.toString(), "native-ready"); assert.equal(ready.writer.pid, spawned.actualServicePID);
        assert.equal(observed.relayAliasesOpen, true); assert.equal(await f.receive(), false, "outer EOF while service/relay aliases remain owned");
      }
      await f.send("exit"); const exit = await f.wait(m => m.event === "service-exit");
      assert.equal(exit.code, 0); assert.equal(exit.retainedServiceAlive, false); await f.cleanup();
    });
  }
} catch (error) { results.push({ name: "setup", ok: false, error: String(error.stack ?? error) }); }
finally { for (const cleanup of [...cleanups]) { try { await cleanup(); } catch (error) { results.push({ name: "cleanup", ok: false, error: String(error) }); } } }
const paths = [addonPath, setterPath, fileURLToPath(import.meta.url), relayPath, servicePath, writerPath, guardPath, workerPath, fileURLToPath(new URL("./native-inherited-control-fixtures/enable-pidfd.c", import.meta.url))];
const artifacts = await Promise.all(paths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, scope: "actual inherited-control transport slices; fixture IPC is not product proof", sourceEnabled: false, accountQualified: false, artifacts, results, evidence, cleanupPending: cleanups.size, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, null, 2));
process.exitCode = results.some(r => !r.ok) || cleanups.size ? 1 : 0;
