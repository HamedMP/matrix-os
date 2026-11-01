/* Standalone Linux acceptance: real compiled N-API + direct C child; no accounts.
 * node --expose-gc native-stdout-runtime.mjs --addon /tmp/writer.node --actor /tmp/actor
 * All cases mandatory. Parent owns compilation/container execution. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const option = name => process.argv[process.argv.indexOf(name) + 1];
const addonPath = resolve(option("--addon"));
const actorPath = resolve(option("--actor"));
const faultAddonPath = resolve(option("--fault-addon"));
const results = [];
const cleanups = new Set();
const digest = async path => createHash("sha256").update(await readFile(path)).digest("hex");
let native, createCodexNativeStdout;
async function until(predicate, label = "condition", ms = 2500) {
  const deadline = Date.now() + ms;
  while (!predicate()) { assert.ok(Date.now() < deadline, `${label} deadline`); await delay(2); }
}
async function check(name, run) {
  try { await run(); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: String(error.stack ?? error) }); }
}
async function fixture(options = {}) {
  const session = createCodexNativeStdout({ native, command: actorPath, args: [], env: process.env, ...options });
  let ack = 0, stderr = "";
  session.child.stderr.on("data", chunk => { stderr += chunk; ack += chunk.toString().split("ack\n").length - 1; });
  const messages = [], guards = [], bytes = [];
  let output;
  function consume(onMessage, onBytes = chunk => bytes.push(chunk.toString())) {
    output = session.consume({ onBytes, onMessage: async (message, current) => { messages.push(message); guards.push(current); await onMessage?.(message, current); } });
    output.catch(() => {}); return output;
  }
  async function command(text) {
    const next = ack + 1; session.child.stdin.write(`${text}\n`);
    if (text !== "exit") await until(() => ack >= next || session.child.exitCode !== null, `ack ${text.slice(0, 40)}`);
  }
  async function cleanup() {
    session.closeReader();
    if (session.child.pid && session.child.exitCode === null && session.child.signalCode === null) session.child.kill("SIGKILL");
    await Promise.race([session.exited, delay(2000).then(() => { throw new Error("child cleanup deadline"); })]);
    if (output) await output.catch(() => {});
    cleanups.delete(cleanup);
  }
  cleanups.add(cleanup);
  return { session, messages, guards, bytes, consume, command, cleanup, stderr: () => stderr };
}
try {
  native = createRequire(import.meta.url)(addonPath);
  await check("native API present (APIabsence is separate from runtime Red)", async () => {
    for (const name of ["stdoutPair", "stdoutWriterFd", "stdoutReceive", "retainChild", "childAlive", "receive", "close"]) assert.equal(typeof native[name], "function", name);
  });
  await check("adapter API present", async () => {
    ({ createCodexNativeStdout } = await import("../../packages/gateway/src/coding-agents/codex-native-stdout.mjs"));
    assert.equal(typeof createCodexNativeStdout, "function");
  });
  if (results.every(item => item.ok)) {
    await check("pair is credentialled before spawn; parent writer closes on synchronous success", async () => {
      let pair, writerFd, child;
      const wrapped = { ...Object.fromEntries(["stdoutPair", "stdoutWriterFd", "stdoutReceive", "retainChild", "childAlive", "receive", "close"].map(key => [key, native[key]])),
        stdoutPair() { pair = native.stdoutPair(); return pair; } };
      const f = await fixture({ native: wrapped, spawn(command, args, options) {
        writerFd = native.stdoutWriterFd(pair.writer);
        assert.equal(options.stdio[1], writerFd);
        child = spawn(command, args, options); return child;
      } });
      assert.equal(f.session.child, child); assert.equal(child.stdout, null);
      assert.throws(() => native.stdoutWriterFd(pair.writer));
      f.consume(); await f.command("flags"); await until(() => f.messages.length === 1);
      assert.deepEqual(f.messages[0], { blocking: true, cloexec: false }); // dup2 intentionally clears FD_CLOEXEC on child's fd1.
      assert.equal(f.guards[0](), true);
      await f.cleanup();
    });
    await check("preserves native argv cwd env stdin stderr and direct exit ownership", async () => {
      const f = await fixture({ args: ["selected-flag"], cwd: tmpdir(), env: { ...process.env, NATIVE_STDOUT_MARKER: "selected-native-value" } });
      f.consume(); await f.command("context"); await f.command("stderr"); await until(() => f.messages.length === 1);
      assert.deepEqual(f.messages[0], { cwd: tmpdir(), marker: "selected-native-value", arg: "selected-flag" });
      assert.match(f.stderr(), /native stderr fixture/); await f.command("exit");
      const exit = await f.session.exited; assert.equal(exit.code, 0); assert.equal(f.guards[0](), false); await f.cleanup();
    });
    await check("fragmented partial and coalesced original Codex JSON framing", async () => {
      const f = await fixture(); f.consume();
      await f.command('partial {"value":'); await f.command('emit 1}');
      f.session.child.stdin.write('emit {"value":2}\nemit {"value":3}\n');
      await until(() => f.messages.length === 3); assert.deepEqual(f.messages, [{ value: 1 }, { value: 2 }, { value: 3 }]); await f.cleanup();
    });
    await check("same-UID foreign writer with forged native PID permanently fences partial frame", async () => {
      const f = await fixture(); f.consume(); await f.command('partial {"value":');
      await f.command(`foreign {"pid":${f.session.child.pid},"value":"forged"}`);
      await f.command('emit 1}'); await f.command('emit {"value":"cannot revive"}');
      await until(() => f.session.isFenced()); assert.equal(f.messages.length, 0);
      await until(() => f.bytes.join("").includes("cannot revive"));
      assert.ok(f.bytes.join("").includes("cannot revive"), "ordinary bytes remain available, without source admission");
      assert.equal(f.session.child.exitCode, null, "proof failure does not kill child"); await f.cleanup();
    });
    await check("genuine bytes queued alive are rejected when first consumed after actual native exit", async () => {
      const f = await fixture(); await f.command('emit {"stale":true}'); await f.command("exit"); await f.session.exited;
      await f.consume(); assert.deepEqual(f.messages, []); assert.equal(f.session.isFenced(), true); await f.cleanup();
    });
    await check("pidfd-ready native exit before Node exit callback independently fences queued bytes", async () => {
      const f = await fixture(); await f.command('emit {"queuedBeforeExit":true}');
      const birth = native.retainChild(f.session.child.pid);
      assert.equal(native.childAlive(birth), true); f.session.child.stdin.write("exit\n");
      // Test-only bounded blocking isolates kernel death from Node event delivery.
      // Production never blocks or uses Atomics.wait.
      const cell = new Int32Array(new SharedArrayBuffer(4)); const deadline = Date.now() + 1000;
      while (native.childAlive(birth) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 5);
      assert.equal(native.childAlive(birth), false, "actual kernel pidfd death");
      assert.equal(f.session.child.exitCode, null, "Node has not delivered exit");
      const output = f.consume();
      assert.equal(f.session.isFenced(), true, "must fence synchronously from pidfd, before event callback");
      await output; assert.deepEqual(f.messages, []); native.close(birth); await f.cleanup();
    });
    await check("helper exit leaves actual native child live and transport generation current", async () => {
      const f = await fixture(); f.consume(); await f.command('emit {"beforeHelper":true}');
      await until(() => f.messages.length === 1); const guard = f.guards[0];
      await f.command("helper"); assert.equal(guard(), true); assert.equal(f.session.child.exitCode, null);
      await f.command('emit {"afterHelper":true}'); await until(() => f.messages.length === 2);
      assert.equal(f.guards[1](), true); await f.cleanup();
    });
    await check("paired alive control consumes genuine queued native bytes", async () => {
      const f = await fixture(); await f.command('emit {"alive":true}'); f.consume(); await until(() => f.messages.length === 1);
      assert.deepEqual(f.messages, [{ alive: true }]); await f.cleanup();
    });
    await check("cancellation invalidates delivery guard and suppresses queued coalesced callbacks", async () => {
      const f = await fixture(); let release;
      const gate = new Promise(resolve => { release = resolve; });
      f.consume(async () => { await gate; });
      f.session.child.stdin.write('emit {"n":1}\nemit {"n":2}\n'); await until(() => f.messages.length === 1);
      f.session.fence(); assert.equal(f.guards[0](), false); release(); await delay(30);
      assert.equal(f.messages.length, 1); assert.equal(f.session.child.exitCode, null); await f.cleanup();
    });
    await check("actual child exit while callback is queued invalidates delivery guard", async () => {
      const f = await fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
      f.consume(async () => { await gate; }); await f.command('emit {"queued":true}'); await until(() => f.messages.length === 1);
      await f.command("exit"); await f.session.exited; assert.equal(f.guards[0](), false); release(); await f.cleanup();
    });
    await check("SCM_RIGHTS reject before JSON and delivered descriptors close", async () => {
      const f = await fixture(); f.consume(); const before = (await readdir("/proc/self/fd")).length;
      await f.command("rights 1"); await until(() => f.session.isFenced()); await delay(20);
      assert.equal(f.messages.length, 0); assert.ok((await readdir("/proc/self/fd")).length <= before);
      await f.command('emit {"ordinary":"after-rights"}');
      await until(() => f.bytes.join("").includes("after-rights")); assert.equal(f.messages.length, 0); await f.cleanup();
    });
    await check("oversized ancillary rights are rejected with no descriptor leak", async () => {
      const f = await fixture(); f.consume(); const before = (await readdir("/proc/self/fd")).length;
      await f.command("rights 253"); await until(() => f.session.isFenced()); await delay(20);
      assert.equal(f.messages.length, 0); assert.ok((await readdir("/proc/self/fd")).length <= before);
      await f.command('emit {"ordinary":"after-rights"}');
      await until(() => f.bytes.join("").includes("after-rights")); assert.equal(f.messages.length, 0); await f.cleanup();
    });
    for (const fault of ["missing", "truncated", "unexpected", "duplicate", "baduid", "badgid", "badpid", "readerror"]) {
      await check(`syscall-return fault ${fault}: no JSON admission, permanent fence and cleanup`, async () => {
        const faultNative = createRequire(import.meta.url)(faultAddonPath);
        const f = await fixture({ native: faultNative }); f.consume();
        try {
          process.env.MATRIX_STDOUT_TEST_FAULT = fault;
          await f.command('emit {"fault":true}'); await until(() => f.session.isFenced());
        } finally { delete process.env.MATRIX_STDOUT_TEST_FAULT; }
        assert.equal(f.messages.length, 0); assert.equal(f.session.child.exitCode, null);
        if (fault !== "readerror") {
          await f.command('emit {"ordinary":"after-metadata-fault"}');
          await until(() => f.bytes.join("").includes("after-metadata-fault")); assert.equal(f.messages.length, 0);
        }
        await f.cleanup();
      });
    }
    await check("16MiB original parser cap fences without killing or retrying native child", async () => {
      const f = await fixture(); const output = f.consume(); f.session.child.stdin.write("oversize\n");
      await until(() => f.session.isFenced(), "oversized frame", 6000); await output.catch(() => {});
      assert.deepEqual(f.messages, []); assert.equal(f.session.child.exitCode, null); await f.cleanup();
    });
    await check("malformed JSON and UTF8 fence permanently using original parser", async () => {
      const f = await fixture(); f.consume(); await f.command("emit {malformed}"); await until(() => f.session.isFenced());
      assert.deepEqual(f.messages, []); await f.cleanup();
    });
    await check("invalid UTF8 uses original fatal decoder and permanently fences", async () => {
      const f = await fixture(); f.consume(); await f.command("utf8"); await until(() => f.session.isFenced());
      await f.command('emit {"ordinary":"after-invalid-utf8"}');
      await until(() => f.bytes.join("").includes("after-invalid-utf8")); assert.deepEqual(f.messages, []); await f.cleanup();
    });
    await check("ordinary byte sink failure is reader loss, never native stop or retry", async () => {
      const f = await fixture(); const output = f.consume(undefined, () => { throw new Error("fixture sink failed"); });
      await f.command('emit {"sink":true}'); await assert.rejects(output, /fixture sink failed/);
      assert.equal(f.session.isFenced(), true); assert.deepEqual(f.messages, []); assert.equal(f.session.child.exitCode, null); await f.cleanup();
    });
    await check("destroyed actual receiver fences safely without killing native", async () => {
      let pair; const wrapped = { ...Object.fromEntries(["stdoutPair", "stdoutWriterFd", "stdoutReceive", "retainChild", "childAlive", "receive", "close"].map(key => [key, native[key]])), stdoutPair() { pair = native.stdoutPair(); return pair; } };
      const f = await fixture({ native: wrapped }); native.close(pair.receiver);
      await assert.rejects(f.consume()); assert.equal(f.session.isFenced(), true); assert.equal(f.session.child.exitCode, null); await f.cleanup();
    });
    await check("closed reader yields real native EPIPE; only actual child exit settles lifetime", async () => {
      const f = await fixture(); f.session.closeReader(); assert.equal(f.session.child.exitCode, null);
      f.session.child.stdin.write("epipe\n"); const exit = await f.session.exited;
      await until(() => f.stderr().includes("epipe")); assert.equal(exit.code, 0);
      assert.doesNotMatch(f.stderr(), /unexpected-write-result/); await f.cleanup();
    });
    await check("reader EOF is not native stop; closeReader never signals child", async () => {
      const f = await fixture(); f.consume(); await f.command("eof"); await until(() => f.session.isFenced());
      assert.equal(f.session.child.exitCode, null); f.session.closeReader(); f.session.closeReader();
      assert.equal(f.session.child.exitCode, null); await f.cleanup();
    });
    await check("spawn throw closes both pair handles; no retry", async () => {
      let pair, calls = 0; const wrapped = { ...Object.fromEntries(["stdoutPair", "stdoutWriterFd", "stdoutReceive", "retainChild", "childAlive", "receive", "close"].map(key => [key, native[key]])), stdoutPair() { pair = native.stdoutPair(); return pair; } };
      assert.throws(() => createCodexNativeStdout({ native: wrapped, command: actorPath, args: [], spawn() { calls++; throw new Error("fixture spawn throw"); } }));
      assert.equal(calls, 1); assert.throws(() => native.stdoutWriterFd(pair.writer)); assert.throws(() => native.stdoutReceive(pair.receiver));
    });
    await check("actual missing executable spawn error and early native exit are bounded", async () => {
      const f = await fixture({ command: "/definitely-missing-native-stdout-actor" });
      await f.session.exited; assert.equal(f.session.isFenced(), true); await f.cleanup();
      const early = await fixture({ args: ["early"] }); await early.session.exited;
      assert.equal(early.session.isFenced(), true); await early.cleanup();
    });
    await check("single receiver consumer and explicit reader shutdown", async () => {
      const f = await fixture(); const output = f.consume(); assert.throws(() => f.session.consume({ onMessage: async () => {} }));
      f.session.closeReader(); await output.catch(() => {}); assert.equal(f.session.isFenced(), true);
      assert.equal(f.session.child.exitCode, null); await f.cleanup();
    });
    await check("native handle cap close GC and pidfd death primitive", async () => {
      const pairs = []; try { assert.throws(() => { for (let n = 0; n < 130; n++) pairs.push(native.stdoutPair()); }); }
      finally { for (const pair of pairs) { native.close(pair.receiver); native.close(pair.writer); } }
      const f = await fixture(); const birth = native.retainChild(f.session.child.pid); assert.equal(native.childAlive(birth), true);
      await f.command("exit"); await f.session.exited; assert.equal(native.childAlive(birth), false); native.close(birth); await f.cleanup();
      assert.equal(typeof global.gc, "function", "run Node with --expose-gc");
      const before = (await readdir("/proc/self/fd")).length;
      for (let n = 0; n < 20; n++) native.stdoutPair();
      global.gc(); await delay(20); global.gc(); await delay(20);
      assert.ok((await readdir("/proc/self/fd")).length <= before);
    });
    await check("ordinary Terminal listen accept receive send close regression", async () => {
      const directory = await mkdtemp(join(tmpdir(), "stdout-regression-")); const path = join(directory, "socket");
      const listener = native.listen(path); const { createConnection } = await import("node:net");
      const socket = createConnection(path); socket.on("error", () => {}); let connection;
      try {
        await until(() => { connection ??= native.accept(listener); return !!connection; });
        socket.write("ordinary"); let received; await until(() => { received ??= native.receive(connection.handle); return !!received; });
        assert.equal(received.data.toString(), "ordinary"); assert.equal(received.writer.pid, process.pid);
        let reply = ""; socket.on("data", chunk => { reply += chunk; }); assert.equal(native.send(connection.handle, Buffer.from("reply")), 5);
        await until(() => reply === "reply");
      } finally { socket.destroy(); if (connection) native.close(connection.handle); native.close(listener); await rm(directory, { recursive: true, force: true }); }
    });
  }
} catch (error) { results.push({ name: "harness setup", ok: false, error: String(error.stack ?? error) }); }
finally { for (const cleanup of [...cleanups]) { try { await cleanup(); } catch (error) { results.push({ name: "cleanup", ok: false, error: String(error) }); } } }
const files = [addonPath, faultAddonPath, actorPath, fileURLToPath(import.meta.url), fileURLToPath(new URL("./native-stdout-fixtures/actor.c", import.meta.url)), fileURLToPath(new URL("./native-stdout-fixtures/recv-fault.c", import.meta.url))];
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, artifacts: await Promise.all(files.map(async path => ({ path, sha256: await digest(path) }))), cases: results, ok: results.length > 2 && results.every(item => item.ok), sourceEnabled: false }, null, 2));
process.exitCode = results.length > 2 && results.every(item => item.ok) ? 0 : 1;
