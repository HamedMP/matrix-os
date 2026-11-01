/* Actual Linux pidfd-right handoff tests, transport-only; no product recipient,
 * executable/source/manager/account proof. Parent owns all actual compilation.
 * node --expose-gc FILE --addon PATH --receiver PATH */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const option = name => { const n = process.argv.indexOf(name); assert.ok(n >= 0 && process.argv[n + 1], `required ${name}`); return resolve(process.argv[n + 1]); };
const addonPath = option("--addon"), receiverPath = option("--receiver");
const results = [], cleanups = new Set(); let native;
async function until(predicate, label, ms = 2500) {
  const deadline = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (!await predicate()) { assert.ok(process.hrtime.bigint() < deadline, `${label} deadline`); await delay(2); }
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), 2500); })]); }
  finally { clearTimeout(timer); }
}
async function check(name, run) {
  const previous = new Set(cleanups);
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.stack ?? error) }); }
  finally {
    // Failed assertions must not leave owned children/handles in later cases.
    // Keep the global shutdown fallback for any cleanup that itself fails.
    for (const cleanup of [...cleanups]) if (!previous.has(cleanup)) {
      try { await cleanup(); }
      catch (error) { results.push({ name: `${name}: cleanup`, ok: false, error: String(error.stack ?? error) }); }
    }
  }
}
const fdCount = async () => (await readdir("/proc/self/fd")).length;
async function fixture() {
  const pair = native.controlPair(), births = [], children = [], events = [];
  let ack = 0, output = "", stderr = "", outputBytes = 0, stderrBytes = 0, fault;
  function launch(command, args, stdio) {
    const child = spawn(command, args, { stdio, env: process.env });
    const exited = new Promise(resolveExit => { child.once("error", error => { fault = error; }); child.once("close", (code, signal) => resolveExit({ code, signal })); });
    children.push({ child, exited });
    const birth = native.retainChild(child.pid); births.push(birth);
    return { child, birth, exited };
  }
  const cleanup = async () => {
    native.close(pair.channel); native.close(pair.child);
    for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    for (const { exited } of children) await bounded(exited, "owned actual child cleanup");
    for (const birth of births) native.close(birth);
    cleanups.delete(cleanup);
  };
  cleanups.add(cleanup);
  let a, b;
  try {
    a = launch(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('data',()=>process.exit(0));setInterval(()=>{},1000);"], ["pipe", "ignore", "pipe"]);
    try { b = launch(receiverPath, [], ["pipe", "pipe", "pipe", native.controlChildFd(pair.child)]); }
    finally { native.close(pair.child); }
    b.child.stdout.on("data", chunk => {
      outputBytes += chunk.length; output += chunk;
      if (outputBytes > 262144 || Buffer.byteLength(output) > 32768) { fault = new Error("receiver output cap"); b.child.kill("SIGKILL"); return; }
      let end;
      while ((end = output.indexOf("\n")) >= 0) {
        try { assert.ok(events.length < 96, "receiver event cap"); events.push(JSON.parse(output.slice(0, end))); }
        catch (error) { fault = error; }
        output = output.slice(end + 1);
      }
    });
    b.child.stderr.on("data", chunk => {
      stderrBytes += chunk.length; if (stderrBytes > 8192) { fault = new Error("receiver stderr cap"); b.child.kill("SIGKILL"); }
      stderr += chunk.toString();
      let end;
      while ((end = stderr.indexOf("\n")) >= 0) { if (stderr.slice(0, end) === "ack") ack++; stderr = stderr.slice(end + 1); }
    });
    a.child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 8192) { fault = new Error("child stderr cap"); a.child.kill("SIGKILL"); } });
    await until(() => { if (fault) throw fault; return events.some(e => e.event === "start"); }, "receiver start");
  } catch (error) { await cleanup(); throw error; }
  const command = async text => {
    assert.ok(["receive", "inspect", "drop"].includes(text));
    const wanted = ack + 1, first = events.length; b.child.stdin.write(text + "\n");
    await until(() => {
      if (fault) throw fault;
      const emitted = events.slice(first), has = event => emitted.some(item => item.event === event);
      const complete = text === "receive" ? has("idle") || (has("received") && has("proof"))
        : text === "inspect" ? has("proof") : has("dropped");
      // Separate stdout/stderr pipes have no delivery ordering guarantee.
      return ack >= wanted && complete;
    }, "receiver command"); return events.slice(first);
  };
  return { pair, a, b, births, events, command, cleanup,
    async stopA() { a.child.stdin.write("exit\n"); assert.equal((await bounded(a.exited, "actual A exit")).code, 0); },
    async idle() { assert.deepEqual(await command("receive"), [{ event: "idle" }], "rejection emits no bytes or rights"); },
    async transfer(payload, birth = a.birth) {
      const written = native.controlSendChildBirth(pair.channel, payload, birth);
      assert.ok(Number.isInteger(written) && written > 0 && written <= payload.length, "truthful positive physical byte count");
      const received = await command("receive"), data = received.find(e => e.event === "received"), proof = received.find(e => e.event === "proof");
      assert.ok(data && proof); assert.equal(data.rights, 1); assert.equal(data.bytes, written);
      assert.equal(data.hex, payload.subarray(0, written).toString("hex"));
      assert.deepEqual(data.writer, { pid: process.pid, uid: process.getuid(), gid: process.getgid() }); assert.equal(data.parentAlive, true);
      assert.equal(proof.cloexec, true, "receiver owns MSG_CMSG_CLOEXEC pidfd copy"); return { written, data, proof };
    },
  };
}
try {
  assert.equal(process.platform, "linux"); assert.notEqual(process.getuid(), 0);
  native = createRequire(import.meta.url)(addonPath);
  await check("required controlSendChildBirth API present; absent API is not a runtime pass", async () => {
    for (const name of ["controlSendChildBirth", "controlPair", "controlChildFd", "retainChild", "childAlive", "receive", "send", "close"]) assert.equal(typeof native[name], "function", name);
  });
  if (results.every(result => result.ok)) {
    await check("real retained A pidfd reaches independent B with parent credentials; same proof dies at actual A exit", async () => {
      const f = await fixture(); assert.equal(f.events[0].parent, process.pid);
      const body = Buffer.from(`{"pid":${f.b.child.pid},"verified":true}`); // Deliberately wrong body identity, never parsed by receiver.
      const { proof } = await f.transfer(body);
      assert.equal(proof.kernelPid, f.a.child.pid); assert.notEqual(proof.kernelPid, f.b.child.pid); assert.equal(proof.alive, true);
      assert.equal(native.childAlive(f.a.birth), true); assert.equal(proof.fds, f.events[0].fds + 1);
      await f.stopA(); assert.equal(native.childAlive(f.a.birth), false);
      for (let n = 0; n < 3; n++) assert.equal((await f.command("inspect"))[0].alive, false, "same received pidfd cannot revive");
      await f.command("drop"); assert.equal(f.events.at(-1).fds, f.events[0].fds); await f.cleanup();
    });
    await check("closing and GC of original birth cannot kill A or invalidate B's independent pidfd copy", async () => {
      const f = await fixture(); await f.transfer(Buffer.from("original-close"));
      native.close(f.a.birth); assert.throws(() => native.childAlive(f.a.birth));
      const retainedCopy = (await f.command("inspect"))[0];
      assert.equal(retainedCopy.kernelPid, f.a.child.pid); assert.equal(retainedCopy.alive, true, "original close leaves delivered copy live");
      assert.equal(typeof global.gc, "function", "--expose-gc prerequisite");
      // Separate temporary original is genuinely unreachable after this call.
      await f.command("drop"); const beforeGc = await fdCount();
      native.controlSendChildBirth(f.pair.channel, Buffer.from("gc-copy"), native.retainChild(f.a.child.pid));
      global.gc(); await delay(20); global.gc(); await delay(20);
      assert.ok(await fdCount() <= beforeGc, "unreachable original pidfd is reclaimed on host");
      const received = await f.command("receive"); assert.equal(received.find(e => e.event === "proof").alive, true);
      assert.equal((await f.command("inspect"))[0].kernelPid, f.a.child.pid); assert.equal(f.a.child.exitCode, null);
      await f.stopA(); assert.equal((await f.command("inspect"))[0].alive, false); await f.cleanup();
    });
    await check("one-byte and8192-byte payloads preserve physical counts without implicit retries", async () => {
      const f = await fixture();
      for (const payload of [Buffer.from("x"), Buffer.alloc(8192, 0x65)]) {
        const { written } = await f.transfer(payload); assert.equal(written, payload.length, "empty socket accepts complete bounded payload");
        await f.command("drop"); await f.idle();
      }
      await f.cleanup();
    });
    await check("positive count remains physical fact when A exits before B consumes queued proof", async () => {
      const f = await fixture(), payload = Buffer.from("physical-before-exit");
      const written = native.controlSendChildBirth(f.pair.channel, payload, f.a.birth); assert.equal(written, payload.length);
      await f.stopA(); const events = await f.command("receive"), received = events.find(e => e.event === "received");
      assert.equal(received.bytes, written); assert.equal(received.hex, payload.toString("hex"));
      assert.equal(events.find(e => e.event === "proof").alive, false); await f.cleanup();
    });
    await check("invalid payload and wrong-kind/closed/dead birth reject before any bytes or rights", async () => {
      const f = await fixture();
      for (const payload of [Buffer.alloc(0), Buffer.alloc(8193), "text", 12, null]) assert.throws(() => native.controlSendChildBirth(f.pair.channel, payload, f.a.birth));
      const closed = native.retainChild(f.a.child.pid); native.close(closed);
      for (const birth of [closed, f.pair.channel, f.pair.child, {}, { pid: f.a.child.pid, verified: true }, f.a.child.pid, [f.a.birth]]) assert.throws(() => native.controlSendChildBirth(f.pair.channel, Buffer.from("x"), birth));
      await f.idle();
      const { proof } = await f.transfer(Buffer.from("still-valid")); assert.equal(proof.alive, true); await f.command("drop");
      await f.stopA(); assert.throws(() => native.controlSendChildBirth(f.pair.channel, Buffer.from("dead"), f.a.birth)); await f.idle();
      assert.equal(native.childAlive(f.b.birth), true); await f.cleanup();
    });
    await check("child-role and stdout handles cannot send birth or acquire another role", async () => {
      const f = await fixture(), control = native.controlPair(), stdout = native.stdoutPair();
      try {
        for (const role of [control.child, stdout.receiver, stdout.writer]) assert.throws(() => native.controlSendChildBirth(role, Buffer.from("forbidden"), f.a.birth));
        assert.equal(native.receive(control.channel), null); assert.equal(native.stdoutReceive(stdout.receiver), null);
        native.close(control.channel); assert.throws(() => native.controlSendChildBirth(control.channel, Buffer.from("closed"), f.a.birth));
        await f.idle();
      } finally { native.close(control.channel); native.close(control.child); native.close(stdout.receiver); native.close(stdout.writer); }
      await f.cleanup();
    });
    await check("ordinary accepted Terminal kind2 cannot transfer proof and retains ordinary I/O", async () => {
      const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "birth-terminal-")), path = join(directory, "socket");
      let listener, socket, connection, text = "";
      try {
        listener = native.listen(path); socket = createConnection(path); socket.on("error", () => {}); socket.on("data", chunk => { text += chunk; });
        await until(() => { connection ??= native.accept(listener); return !!connection; }, "ordinary accept");
        assert.throws(() => native.controlSendChildBirth(connection.handle, Buffer.from("forbidden-proof"), f.a.birth));
        await delay(30); assert.equal(text, "", "wrong role emits zero bytes");
        assert.equal(native.send(connection.handle, Buffer.from("ordinary-out")), 12); await until(() => text === "ordinary-out", "ordinary output");
        socket.write("ordinary-in"); let frame; await until(() => { frame ??= native.receive(connection.handle); return !!frame; }, "ordinary input");
        assert.equal(frame.data.toString(), "ordinary-in"); await f.idle();
      } finally { socket?.destroy(); if (connection) native.close(connection.handle); if (listener) native.close(listener); await rm(directory, { recursive: true, force: true }); }
      await f.cleanup();
    });
    await check("handoff works at shared128 handle exhaustion without allocating another host handle", async () => {
      const f = await fixture(), legacy = [], extra = native.retainChild(f.a.child.pid);
      try {
        // Parent channel + A birth + B birth + extra birth =4;62 legacy pairs =124.
        for (let n = 0; n < 62; n++) legacy.push(native.stdoutPair());
        assert.throws(() => native.controlPair()); assert.throws(() => native.stdoutPair());
        const before = await fdCount(), { proof } = await f.transfer(Buffer.from("at-cap"));
        assert.equal(proof.alive, true); assert.equal(await fdCount(), before, "SCM_RIGHTS receiver copy does not consume another sender handle");
        assert.throws(() => native.stdoutPair());
      } finally { native.close(extra); for (const pair of legacy) { native.close(pair.receiver); native.close(pair.writer); } }
      await f.cleanup();
    });
    await check("repeated receiver drop closes delivered pidfds; host descriptor ownership stays constant", async () => {
      const f = await fixture(), before = await fdCount();
      for (let n = 0; n < 12; n++) {
        const { proof } = await f.transfer(Buffer.from(`owned-${n}`)); assert.equal(proof.fds, f.events[0].fds + 1);
        const dropped = await f.command("drop"); assert.equal(dropped[0].fds, f.events[0].fds);
      }
      assert.equal(await fdCount(), before); assert.equal(native.childAlive(f.a.birth), true); await f.cleanup();
    });
    await check("full control buffer returns zero without retry, peer loss closes only control", async () => {
      const f = await fixture(), pair = native.controlPair();
      try {
        let written = 1;
        for (let n = 0; n < 1024 && written; n++) written = native.send(pair.channel, Buffer.alloc(8192));
        assert.equal(written, 0); assert.equal(native.controlSendChildBirth(pair.channel, Buffer.from("blocked"), f.a.birth), 0);
        assert.equal(native.receive(pair.channel), null, "EAGAIN leaves control open on unused reverse direction");
        assert.equal(native.childAlive(f.a.birth), true, "EAGAIN does not consume or close original birth");
      } finally { native.close(pair.channel); native.close(pair.child); }
      const closedPeer = native.controlPair(); native.close(closedPeer.child);
      try { assert.throws(() => native.controlSendChildBirth(closedPeer.channel, Buffer.from("peer-gone"), f.a.birth)); assert.throws(() => native.receive(closedPeer.channel)); }
      finally { native.close(closedPeer.channel); }
      assert.equal(native.childAlive(f.a.birth), true); await f.cleanup();
    });
  }
} catch (error) { results.push({ name: "setup", ok: false, error: String(error.stack ?? error) }); }
finally { for (const cleanup of [...cleanups]) { try { await cleanup(); } catch (error) { results.push({ name: "cleanup", ok: false, error: String(error) }); } } }
const files = [addonPath, receiverPath, fileURLToPath(import.meta.url), fileURLToPath(new URL("./native-birth-handoff-fixtures/receiver.c", import.meta.url))];
const artifacts = await Promise.all(files.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, sourceEnabled: false, accountQualified: false, qualification: "transport-only-pidfd-handoff", artifacts, results, cleanupPending: cleanups.size, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }, null, 2));
process.exitCode = results.some(r => !r.ok) || cleanups.size ? 1 : 0;
