/* Mandatory standalone Linux transport checks, not image/source/account proof.
 * Parent compiles actual addon/actor; run with --expose-gc --addon PATH
 * --fault-addon PATH --actor PATH. Fault addon reuses stdout recv-fault.c.
 * No product consumer or policy implementation is introduced by this fixture. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFile, readdir, readlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const option = name => {
  const index = process.argv.indexOf(name);
  assert.ok(index >= 0 && process.argv[index + 1], `required ${name}`);
  return resolve(process.argv[index + 1]);
};
const addonPath = option("--addon"), faultAddonPath = option("--fault-addon"), actorPath = option("--actor");
const results = [], cleanups = new Set();
let native;
async function check(name, run) {
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.stack ?? error) }); }
}
async function until(predicate, label = "condition", ms = 2500) {
  const deadline = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (!await predicate()) { assert.ok(process.hrtime.bigint() < deadline, `${label} deadline`); await delay(2); }
}
async function receive(api, handle) {
  let frame; await until(() => { frame = api.receive(handle); return frame !== null; }, "native receive"); return frame;
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), 2500); })]); }
  finally { clearTimeout(timer); }
}
async function fdCount() { return (await readdir("/proc/self/fd")).length; }
async function socketFds() {
  const values = new Set();
  for (const raw of await readdir("/proc/self/fd")) {
    try { if ((await readlink(`/proc/self/fd/${raw}`)).startsWith("socket:[")) values.add(Number(raw)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return values;
}
async function flags(fd) {
  const text = await readFile(`/proc/self/fdinfo/${fd}`, "utf8"), match = /^flags:\s*([0-7]+)$/m.exec(text);
  assert.ok(match, "actual kernel fdinfo flags"); return parseInt(match[1], 8);
}
async function fixture({ api = native, queued, command = actorPath, args = [], spawnChild = spawn } = {}) {
  const pair = api.controlPair(); let child, birth, exited, ack = 0, output = "", stderrBytes = 0;
  const events = []; let fault;
  const cleanup = async () => {
    api.close(pair.channel); api.close(pair.child);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (exited) await bounded(exited, "owned child cleanup");
    if (birth) api.close(birth); cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  try {
    if (queued) assert.equal(api.send(pair.channel, Buffer.from(queued)), Buffer.byteLength(queued));
    const fd = api.controlChildFd(pair.child);
    try { child = spawnChild(command, args, { stdio: ["pipe", "pipe", "pipe", fd], env: process.env }); }
    finally { api.close(pair.child); } // Also covers synchronous spawn throw.
    exited = new Promise(resolveExit => { child.once("error", () => {}); child.once("close", (code, signal) => resolveExit({ code, signal })); });
    if (child.pid) birth = api.retainChild(child.pid); // Actual returned child only.
    child.stdout.on("data", chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 32768) { fault = new Error("actor output cap"); child.kill("SIGKILL"); return; }
      let end;
      while ((end = output.indexOf("\n")) >= 0) {
        try { assert.ok(events.length < 64, "actor event cap"); events.push(JSON.parse(output.slice(0, end))); }
        catch (error) { fault = error; }
        output = output.slice(end + 1);
      }
    });
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > 8192) { fault = new Error("actor stderr cap"); child.kill("SIGKILL"); }
      ack += chunk.toString().split("ack\n").length - 1;
    });
  } catch (error) { await cleanup(); throw error; }
  const commandLine = async text => {
    assert.ok(text.length < 4096 && !text.includes("\n"), "bounded actor command");
    const wanted = ack + 1; child.stdin.write(text + "\n");
    if (text !== "exit") await until(() => { if (fault) throw fault; return ack >= wanted; }, "actor command");
  };
  return { api, pair, child, birth, exited, events, command: commandLine, cleanup,
    async started() { await until(() => { if (fault) throw fault; return events.some(event => event.event === "start"); }, "actor start"); return events.find(event => event.event === "start"); } };
}
try {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid(), 0, "nonroot required");
  native = createRequire(import.meta.url)(addonPath);
  await check("required native control API present; absence is APIabsence Red, no runtime pass", async () => {
    for (const name of ["controlPair", "controlChildFd", "receive", "send", "close", "retainChild", "childAlive"]) assert.equal(typeof native[name], "function", name);
  });
  if (results.every(result => result.ok)) {
    await check("pair owns exactly two CLOEXEC endpoints; parent nonblocking, child blocking and role restricted", async () => {
      const before = await socketFds(), pair = native.controlPair();
      try {
        assert.deepEqual(Object.keys(pair).sort(), ["channel", "child", "gid", "uid"]);
        assert.equal(pair.uid, process.getuid()); assert.equal(pair.gid, process.getgid());
        const childFd = native.controlChildFd(pair.child);
        assert.equal(native.controlChildFd(pair.child), childFd, "same fd, not a new consumer/dup");
        const added = [...await socketFds()].filter(fd => !before.has(fd)); assert.equal(added.length, 2);
        const parentFd = added.find(fd => fd !== childFd); assert.notEqual(parentFd, undefined);
        const childFlags = await flags(childFd), parentFlags = await flags(parentFd);
        assert.ok(childFlags & 0o2000000); assert.equal(childFlags & 0o4000, 0);
        assert.ok(parentFlags & 0o2000000); assert.ok(parentFlags & 0o4000);
        assert.equal(native.receive(pair.channel), null, "empty nonblocking receive");
        assert.throws(() => native.controlChildFd(pair.channel));
        assert.throws(() => native.receive(pair.child)); assert.throws(() => native.send(pair.child, Buffer.from("x")));
        assert.throws(() => native.stdoutReceive(pair.channel)); assert.throws(() => native.stdoutWriterFd(pair.child));
      } finally { native.close(pair.channel); native.close(pair.child); }
      assert.throws(() => native.controlChildFd(pair.child)); assert.throws(() => native.receive(pair.channel));
    });
    await check("queued pre-spawn bootstrap has real parent credentials; actual bidirectional writes carry each writer", async () => {
      const f = await fixture({ queued: "bootstrap-before-spawn" });
      const start = await f.started();
      assert.deepEqual(start, { event: "start", parent: process.pid, creator: process.pid, parentAlive: true, passcred: 1, blocking: true, cloexec: false }); // dup2(fd3) clears CLOEXEC.
      assert.equal(native.childAlive(f.birth), true); assert.throws(() => native.controlChildFd(f.pair.child));
      await f.command("recv"); const first = f.events.find(event => event.event === "received");
      assert.deepEqual(first, { event: "received", writer: { pid: process.pid, uid: process.getuid(), gid: process.getgid() }, parentAlive: true, hex: Buffer.from("bootstrap-before-spawn").toString("hex") });
      assert.equal(native.send(f.pair.channel, Buffer.from("later-parent")), 12); await f.command("recv");
      assert.equal(f.events.filter(event => event.event === "received")[1].writer.pid, process.pid);
      await f.command("emit genuine-child"); const message = await receive(native, f.pair.channel);
      assert.equal(message.data.toString(), "genuine-child");
      assert.deepEqual(message.writer, { pid: f.child.pid, uid: f.pair.uid, gid: f.pair.gid });
      assert.notEqual(message.writer.pid, start.creator, "socketpair creator cannot identify child sender"); await f.cleanup();
    });
    await check("same-UID copied writer and forged body PID never become the retained child's kernel writer", async () => {
      const f = await fixture(); await f.started();
      await f.command(`foreign {"pid":${f.child.pid}}`); const message = await receive(native, f.pair.channel);
      const foreign = f.events.find(event => event.event === "foreign");
      assert.equal(message.data.toString(), `{"pid":${f.child.pid}}`);
      assert.equal(message.writer.pid, foreign.pid); assert.notEqual(message.writer.pid, f.child.pid);
      assert.equal(message.writer.uid, f.pair.uid); assert.equal(message.writer.gid, f.pair.gid);
      assert.equal(native.childAlive(f.birth), true, "helper exit is not actual child exit"); await f.cleanup();
    });
    for (const count of [1, 253]) await check(`strict control rejects SCM_RIGHTS ${count}, closes delivered fds and control only`, async () => {
      const f = await fixture(); await f.started(); const before = await fdCount();
      await f.command(`rights ${count}`); await assert.rejects(receive(native, f.pair.channel));
      // Strict receive closes the channel itself: account for that -1, so one
      // leaked delivered descriptor cannot hide behind the closed socket.
      assert.throws(() => native.receive(f.pair.channel)); assert.ok(await fdCount() <= before - 1);
      assert.equal(native.childAlive(f.birth), true); assert.equal(f.child.exitCode, null); await f.cleanup();
    });
    for (const fault of ["missing", "truncated", "unexpected", "duplicate", "readerror"]) await check(`actual recvmsg return fault ${fault} strictly closes control`, async () => {
      const api = createRequire(import.meta.url)(faultAddonPath), f = await fixture({ api }); await f.started();
      await f.command("emit real-before-fault");
      try { process.env.MATRIX_STDOUT_TEST_FAULT = fault; await assert.rejects(receive(api, f.pair.channel)); }
      finally { delete process.env.MATRIX_STDOUT_TEST_FAULT; }
      assert.throws(() => api.receive(f.pair.channel)); assert.equal(api.childAlive(f.birth), true); await f.cleanup();
    });
    await check("control EOF closes handle while actual child remains alive", async () => {
      const f = await fixture(); await f.started(); await f.command("eof");
      assert.equal(await receive(native, f.pair.channel), false); assert.throws(() => native.receive(f.pair.channel));
      assert.equal(native.childAlive(f.birth), true); assert.equal(f.child.exitCode, null); await f.cleanup();
    });
    await check("parent control close gives child EOF without stopping actual child", async () => {
      const f = await fixture(); await f.started(); native.close(f.pair.channel); native.close(f.pair.channel);
      await f.command("recv"); assert.ok(f.events.some(event => event.event === "eof"));
      assert.equal(native.childAlive(f.birth), true); assert.equal(f.child.exitCode, null); await f.cleanup();
    });
    await check("authentic queued bytes require consumer's actual retained birth, including before Node exit delivery", async () => {
      const f = await fixture(); await f.started(); await f.command("emit authentic-queued"); f.child.stdin.write("exit\n");
      const cell = new Int32Array(new SharedArrayBuffer(4)), end = process.hrtime.bigint() + 1_000_000_000n;
      while (native.childAlive(f.birth) && process.hrtime.bigint() < end) Atomics.wait(cell, 0, 0, 5); // test-only bounded callback suppression
      assert.equal(native.childAlive(f.birth), false); assert.equal(f.child.exitCode, null);
      const frame = native.receive(f.pair.channel); assert.equal(frame.data.toString(), "authentic-queued"); assert.equal(frame.writer.pid, f.child.pid);
      assert.equal(frame.writer.pid === f.child.pid && native.childAlive(f.birth), false, "credential bytes alone do not pass birth guard");
      await bounded(f.exited, "actual child exit"); await f.cleanup();
    });
    await check("paired live consumer control; original monotonic operation budget never renewed by queued bytes", async () => {
      const f = await fixture(); await f.started();
      const originalDeadline = process.hrtime.bigint() + 750_000_000n; // <= approved five-second cap; captured once before sending.
      const current = frame => frame.writer.pid === f.child.pid && frame.writer.uid === f.pair.uid && frame.writer.gid === f.pair.gid && native.childAlive(f.birth) && process.hrtime.bigint() < originalDeadline;
      await f.command("emit live-before-expiry"); assert.equal(current(await receive(native, f.pair.channel)), true);
      await f.command("emit queued-before-expiry"); await until(() => process.hrtime.bigint() >= originalDeadline, "original expiry");
      const queued = await receive(native, f.pair.channel); assert.equal(queued.data.toString(), "queued-before-expiry");
      assert.equal(current(queued), false); assert.equal(native.childAlive(f.birth), true); await f.cleanup();
    });
    await check("synchronous spawn throw releases pair, and actual spawn error/early exit clean up without retry", async () => {
      const before = await fdCount(); let calls = 0;
      await assert.rejects(fixture({ spawnChild() { calls++; throw new Error("named synchronous spawn fault"); } }), /named synchronous spawn fault/);
      assert.equal(calls, 1); assert.ok(await fdCount() <= before);
      const missing = await fixture({ command: "/definitely-missing-native-control-actor" }); await bounded(missing.exited, "spawn error"); await missing.cleanup();
      const early = await fixture({ args: ["early"] }); assert.equal((await bounded(early.exited, "early actual child exit")).code, 7); assert.equal(native.childAlive(early.birth), false); await early.cleanup();
    });
    await check("control frame send bound and nonblocking backpressure retain existing kind2 semantics", async () => {
      const pair = native.controlPair();
      try {
        assert.throws(() => native.send(pair.channel, Buffer.alloc(131074)));
        let total = 0, written = 1;
        for (let n = 0; n < 1024 && written; n++) { written = native.send(pair.channel, Buffer.alloc(8192)); total += written; }
        assert.equal(written, 0, "bounded nonblocking backpressure"); assert.ok(total > 0 && total <= 8 * 1024 * 1024);
      } finally { native.close(pair.channel); native.close(pair.child); }
    });
    await check("shared 128-handle cap, idempotent close and unreachable pair GC reclaim actual descriptors", async () => {
      const before = await fdCount(), pairs = [];
      try { for (let n = 0; n < 64; n++) pairs.push(native.controlPair()); assert.throws(() => native.controlPair()); }
      finally { for (const pair of pairs) { native.close(pair.channel); native.close(pair.child); native.close(pair.channel); } }
      assert.ok(await fdCount() <= before); assert.equal(typeof global.gc, "function", "--expose-gc prerequisite");
      for (let n = 0; n < 20; n++) native.controlPair();
      global.gc(); await delay(20); global.gc(); await delay(20); assert.ok(await fdCount() <= before);
    });
    await check("legacy-held odd occupancy leaves only one shared slot; control pair requires two and reclaims release", async () => {
      const before = await fdCount(), legacy = native.stdoutPair(), controls = [];
      try {
        native.close(legacy.writer); // One legacy receiver + 63 control pairs = 127 shared handles.
        for (let n = 0; n < 63; n++) controls.push(native.controlPair());
        assert.throws(() => { controls.push(native.controlPair()); }, "controlPair must reserve two shared slots at odd occupancy127");
        native.close(legacy.receiver); controls.push(native.controlPair()); // Released legacy slot permits exactly128.
        assert.equal(controls.length, 64, "released legacy handle is reclaimed by control allocation");
        assert.throws(() => { controls.push(native.controlPair()); }, "combined exhaustion blocks another control pair");
        let unexpectedLegacy;
        try { assert.throws(() => { unexpectedLegacy = native.stdoutPair(); }, "control occupancy exhausts legacy stdout allocation too"); }
        finally { if (unexpectedLegacy) { native.close(unexpectedLegacy.receiver); native.close(unexpectedLegacy.writer); } }
      } finally {
        native.close(legacy.receiver); native.close(legacy.writer);
        for (const pair of controls) { native.close(pair.channel); native.close(pair.child); }
      }
      assert.ok(await fdCount() <= before, "mixed legacy/control descriptor cleanup");
    });
    await check("control-held odd occupancy shares legacy stdout cap and combined exhaustion in reverse", async () => {
      const before = await fdCount(), control = native.controlPair(), legacy = [];
      try {
        native.close(control.child); // One control channel + 63 stdout pairs = 127 shared handles.
        for (let n = 0; n < 63; n++) legacy.push(native.stdoutPair());
        assert.throws(() => { legacy.push(native.stdoutPair()); }, "stdoutPair sees control-held shared odd occupancy127");
        native.close(control.channel); legacy.push(native.stdoutPair());
        assert.equal(legacy.length, 64, "released control handle is reclaimed by legacy allocation");
        assert.throws(() => { legacy.push(native.stdoutPair()); }, "combined exhaustion blocks another stdout pair");
        let unexpectedControl;
        try { assert.throws(() => { unexpectedControl = native.controlPair(); }, "legacy occupancy exhausts control allocation too"); }
        finally { if (unexpectedControl) { native.close(unexpectedControl.channel); native.close(unexpectedControl.child); } }
      } finally {
        native.close(control.channel); native.close(control.child);
        for (const pair of legacy) { native.close(pair.receiver); native.close(pair.writer); }
      }
      assert.ok(await fdCount() <= before, "reverse mixed descriptor cleanup");
    });
  }
} catch (error) { results.push({ name: "setup", ok: false, error: String(error.stack ?? error) }); }
finally { for (const cleanup of [...cleanups]) { try { await cleanup(); } catch (error) { results.push({ name: "cleanup", ok: false, error: String(error) }); } } }
const files = [addonPath, faultAddonPath, actorPath, fileURLToPath(import.meta.url), fileURLToPath(new URL("./native-control-fixtures/actor.c", import.meta.url)), fileURLToPath(new URL("./native-stdout-fixtures/recv-fault.c", import.meta.url))];
const artifacts = await Promise.all(files.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, sourceEnabled: false, accountQualified: false, qualification: "transport-only", artifacts, results, cleanupPending: cleanups.size, passed: results.filter(result => result.ok).length, failed: results.filter(result => !result.ok).length }, null, 2));
process.exitCode = results.some(result => !result.ok) || cleanups.size ? 1 : 0;
