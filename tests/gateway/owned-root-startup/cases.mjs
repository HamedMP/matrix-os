/* Actual producer/native/Root cases, not installed keeper or account acceptance. */
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bounded, cleanup, command, execEnvironment, fixture, now, recordRealPairs, track, until, waited } from "./support.mjs";
import { COPIED_REPLY } from "./actors.mjs";
import { boundedExitObservers } from "./exit-observers.mjs";
import { auditHandoffLoss, loseInitializerAtRealHandoff } from "./handoff-loss.mjs";

function startup(create, native, binary, f, rows, extra = {}, duration = 4_500_000_000n, expectedDaemonEnvironment = f.expected, pairRecords = null) {
  const initial = { ...f.environment }, callbacks = [], executions = [];
  const options = { native, executable: binary, cwd: f.cwd, layoutPath: f.layoutPath, socketPath: f.socketPath,
    sessionName: f.sessionName, environment: f.environment, generation: f.generation, deadlineNs: now() + duration,
    async validateInitialExec(input) {
      assert.deepEqual(Object.keys(input).sort(), ["cwd", "environment", "executable"]);
      assert.equal(input.executable, binary); assert.equal(input.cwd, f.cwd); assert.deepEqual({ ...input.environment }, initial);
      assert.equal(rows.length, 0, "initial exec eligibility before any owned child"); callbacks.push("initializer");
    },
    async validateDaemonExec(input) {
      assert.equal(input.executable, binary); assert.equal(input.cwd, f.cwd); assert.deepEqual({ ...input.environment }, { ...f.expected });
      assert.deepEqual(rows.map(row => row.role), ["initializer"], "no D before complete prepared reply and validator");
      assert.equal(rows[0].birthLife.alive(), true);
      assert.deepEqual(await execEnvironment(rows[0]), Object.assign(Object.create(null), initial),
        "actual held I exec map retains original nonoverridden input snapshot");
      callbacks.push("daemon");
    },
    onOwnedChild(role, child, birthLife) {
      const row = track(child, birthLife, role, rows); // Store actual child BEFORE proof queries or assertions.
      if (pairRecords) {
        const pair = pairRecords[rows.length - 1]; row.parentChildEndClosedAtCallback = false;
        if (pair) {
          try { native.controlChildFd(pair.child); }
          catch { row.parentChildEndClosedAtCallback = true; } // Observe only; never abort startup here.
        }
      }
      assert.ok(rows.length <= 2, "one operation has at most two actual returned children");
      assert.ok(child instanceof ChildProcess); assert.ok(["initializer", "daemon"].includes(role));
      assert.ok(child.stdout && child.stderr, "actual child has bounded observable private output streams");
      assert.equal(Object.isFrozen(birthLife), true); assert.deepEqual(Object.keys(birthLife), ["alive"]);
      assert.equal(typeof birthLife.alive, "function"); assert.equal(birthLife.alive(), true);
      if (role === "daemon") executions.push(execEnvironment(row).then(async environment => {
        assert.deepEqual(environment, expectedDaemonEnvironment, "actual same D /proc exec map is exact prepared environment");
        assert.equal(await readlink(`/proc/${child.pid}/cwd`), f.cwd);
        const status = await readFile(`/proc/${child.pid}/status`, "utf8");
        assert.match(status, new RegExp(`^Umask:\\s+${process.umask().toString(8).padStart(4, "0")}$`, "m"));
      }).catch(error => { row.observationError = error; }));
    }, ...extra };
  const operation = create(options);
  return { operation, options, callbacks, executions };
}

async function withFixture(evidence, name, run) {
  const caseEvidence = join(evidence, name); await mkdir(caseEvidence);
  const f = await fixture(caseEvidence), rows = []; let operation, value, failure, cleaned;
  try { value = await run(f, rows, owned => { operation = owned; }); }
  catch (error) { failure = error; }
  finally {
    // Fencing is not cleanup success or permission to discard a known child.
    try { operation?.fence(); } catch (error) { failure ??= error; }
    try { cleaned = await cleanup(rows, caseEvidence); } catch (error) { failure ??= error; }
    try { operation?.disposeExited(); operation?.disposeExited(); } catch (error) { failure ??= error; }
    if (rows.every(row => row.closed)) await f.remove();
    await writeFile(join(caseEvidence, "cleanup.json"), JSON.stringify(cleaned ?? { pending: rows.filter(row => !row.closed).length, errors: ["cleanup did not settle"] }, null, 2));
  }
  if (failure || cleaned.errors.length || cleaned.pending) {
    const error = failure ?? new Error("actual child cleanup incomplete"); error.fixtureCleanup = cleaned; throw error;
  }
  assert.equal(cleaned.facts.length, rows.length);
  return { observed: value, cleanup: cleaned.facts, cleanupPending: cleaned.pending };
}

export async function happy(create, native, binary, evidence) {
  return withFixture(evidence, "happy", async (f, rows, own) => {
    const recorder = recordRealPairs(native);
    const s = startup(create, recorder.api, binary, f, rows, {}, undefined, undefined, recorder.pairs); own(s.operation);
    const first = s.operation.start(), duplicate = s.operation.start();
    assert.equal(first, duplicate, "same startup promise; no second startup effect");
    // Mutations after admission must not change the frozen proposed exec map.
    f.environment.MATRIX_INPUT_SNAPSHOT_SENTINEL = "mutated-after-start";
    const outcome = await bounded(first, s.options.deadlineNs + 400_000_000n, "one original startup budget");
    assert.deepEqual(outcome, { disposition: "first_frame_complete" });
    assert.equal(Object.isFrozen(outcome), true);
    assert.deepEqual(Object.keys(outcome), ["disposition"], "completion cannot expose environment/PID/proof/ready");
    assert.deepEqual(s.callbacks, ["initializer", "daemon"]); assert.deepEqual(rows.map(row => row.role), ["initializer", "daemon"]);
    await Promise.all(s.executions);
    for (const row of rows) if (row.observationError) throw row.observationError;
    const end = now() + 8_000_000_000n;
    assert.deepEqual(await s.operation.waitForExit("initializer", end), { code: 0, signal: null });
    assert.deepEqual(await waited(rows[0], end), { code: 0, signal: null });
    assert.deepEqual(s.operation.observe(), { initializer: "exited", daemon: "running", fenced: false });
    assert.equal(Object.isFrozen(s.operation.observe()), true);
    assert.equal(rows[1].birthLife.alive(), true);
    assert.equal(rows[0].stderr.length, 0); assert.equal(rows[0].stdout.length, 0);
    let panes;
    await until(async () => {
      try {
        const witness = await readFile(f.witness); assert.ok(witness.length <= 65536);
        const result = await command(binary, ["--session", f.sessionName, "action", "list-panes", "--all", "--json"], f.expected, f.cwd, end);
        assert.equal(result.code, 0); const all = JSON.parse(result.stdout);
        const plugins = all.filter(row => row.is_plugin), terminals = all.filter(row => !row.is_plugin);
        assert.ok(plugins.length <= 1 && plugins.every(row => row.is_suppressed && row.plugin_url === "zellij:link"));
        if (terminals.length === 1 && !terminals[0].is_suppressed && terminals[0].exited && terminals[0].exit_status === 0) { panes = terminals; return true; }
        return false;
      } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    }, end, "actual initialized Screen and native pane successful wait");
    const pane = panes[0], raw = await readFile(f.witness), witness = JSON.parse(raw);
    assert.equal(pane.tab_name, "owned-producer"); assert.match(pane.terminal_command ?? pane.pane_command ?? "", /workload\.py/);
    assert.deepEqual(witness.environment, { ...f.expected, ZELLIJ: "0", ZELLIJ_PANE_ID: String(pane.id) });
    assert.equal(witness.cwd, join(f.work, "pane-cwd")); assert.deepEqual(witness.isatty, [true, true, true]);
    assert.equal(witness.foregroundPgrp, true); assert.deepEqual(witness.fds, [0, 1, 2]);
    assert.equal(witness.umask, process.umask().toString(8).padStart(4, "0"));
    assert.equal(witness.rows, pane.pane_content_rows); assert.equal(witness.cols, pane.pane_content_columns);
    const screen = await command(binary, ["--session", f.sessionName, "action", "dump-screen", "--pane-id", "terminal_" + pane.id], f.expected, f.cwd, end);
    assert.equal(screen.code, 0); assert.ok(screen.stdout.includes(Buffer.from(f.marker)), "actual Screen contains PTY output");
    await writeFile(join(f.evidence, "workload-observed.json"), raw);
    const stop = await command(binary, ["kill-session", f.sessionName], f.expected, f.cwd, end);
    assert.equal(stop.code, 0, "canonical stop ACK is separate from actual D wait");
    assert.deepEqual(await s.operation.waitForExit("daemon", end), { code: 0, signal: null });
    assert.deepEqual(await waited(rows[1], end), { code: 0, signal: null });
    for (const row of rows) assert.equal(row.parentChildEndClosedAtCallback, true,
      "actual parent child-end must close BEFORE onOwnedChild callback");
    s.operation.fence(); s.operation.fence();
    assert.equal(s.operation.start(), first); assert.deepEqual(await first, outcome, "settled outcome never reopens/replays");
    assert.equal(rows.length, 2);
    return { samePromise: true, actualDirectChildren: 2, actualExecMap: true, actualScreenPty: true,
      actualNativePaneWait0: true, descriptors012: true, canonicalStopAck: true, actualDaemonWait0: true };
  });
}

const BAD_REPLY = `#!/usr/bin/python3
import os,socket,struct
s=socket.socket(fileno=3); s.settimeout(2)
def exact(size):
 output=bytearray()
 while len(output)<size:
  data,anc,flags,_=s.recvmsg(size-len(output),128)
  assert data
  cred=[struct.unpack('3i',value) for level,kind,value in anc if level==socket.SOL_SOCKET and kind==socket.SCM_CREDENTIALS]
  assert cred==[(os.getppid(),os.getuid(),os.getgid())]
  output.extend(data)
 return bytes(output)
magic,version,kind,reserved,size=struct.unpack('<8sBBHI',exact(16))
assert (magic,version,kind,reserved)==(b'MXZPREP\\0',1,1,0) and size<=8176
exact(size)
s.sendall(struct.pack('<8sBBHI',b'MXZPREP\\0',1,2,0,1)+b'x')
assert s.recv(1)==b''
`;
export async function badReply(create, native, _binary, evidence) {
  return withFixture(evidence, "bad-reply", async (f, rows, own) => {
    const actor = join(f.work, "bad-reply.py"); await writeFile(actor, BAD_REPLY, { mode: 0o700 });
    const s = startup(create, native, actor, f, rows); own(s.operation);
    const outcome = await bounded(s.operation.start(), s.options.deadlineNs + 400_000_000n, "malformed reply refusal");
    assert.deepEqual(outcome, { disposition: "unsent" }); assert.deepEqual(rows.map(row => row.role), ["initializer"]);
    assert.deepEqual(s.callbacks, ["initializer"]); assert.equal(s.executions.length, 0);
    assert.deepEqual(await s.operation.waitForExit("initializer", now() + 3_000_000_000n), { code: 0, signal: null });
    assert.deepEqual(await waited(rows[0], now() + 3_000_000_000n), { code: 0, signal: null });
    assert.equal(rows[0].stderr.length, 0);
    return { actualCredentialledBadReply: true, actualInitializerWait0: true, daemonSpawned: false, syntheticActorNotRoot: true };
  });
}

export async function copiedWriter(create, native, _binary, evidence) {
  return withFixture(evidence, "copied-writer", async (f, rows, own) => {
    const actor = join(f.work, "copied-reply.py"); await writeFile(actor, COPIED_REPLY, { mode: 0o700 });
    // Deliberately admit the actor's exact valid bounded map. Requiring the
    // happy Root collision map here would mask a missing actual-writer guard.
    const s = startup(create, native, actor, f, rows, { async validateDaemonExec(input) {
      assert.equal(input.executable, actor); assert.equal(input.cwd, f.cwd);
      assert.deepEqual({ ...input.environment }, { ...f.environment });
    } }, undefined, f.environment); own(s.operation);
    let outcome;
    try { outcome = await bounded(s.operation.start(), s.options.deadlineNs + 400_000_000n, "actual copied-writer rejection"); }
    finally {
      s.operation.fence();
      // Also on a named missing-writer-guard failure, allow actual I to reap
      // its own fork B before generic direct-child failure cleanup may signal I.
      const initializer = rows.find(row => row.role === "initializer");
      if (initializer) await bounded(initializer.wait, now() + 3_000_000_000n, "actual copied-writer fork owner reap");
    }
    assert.deepEqual(outcome, { disposition: "unsent" });
    assert.deepEqual(rows.map(row => row.role), ["initializer"], "valid copied reply must not reach any D spawn effect");
    const end = now() + 3_000_000_000n;
    assert.deepEqual(await s.operation.waitForExit("initializer", end), { code: 0, signal: null });
    assert.deepEqual(await waited(rows[0], end), { code: 0, signal: null });
    const witness = await readFile(join(f.cwd, "copied-writer-reaped.json")); assert.ok(witness.length <= 1024);
    assert.deepEqual(JSON.parse(witness), { actualWait: true, exit: 0 });
    assert.equal(rows[0].stderr.length, 0); assert.equal(rows[0].stdout.length, 0);
    return { actualCopiedKernelWriterRefused: true, validFrameDigestCorrelation: true, daemonSpawned: false,
      actualForkOwnerReapedWriter: true, syntheticActorNotRoot: true };
  });
}

export async function initialExpiry(create, native, binary, evidence) {
  return withFixture(evidence, "initial-expiry", async (f, rows, own) => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const s = startup(create, native, binary, f, rows, { validateInitialExec: () => gate }, 150_000_000n); own(s.operation);
    const first = s.operation.start();
    try {
      const result = await bounded(first, s.options.deadlineNs + 300_000_000n, "unresolved initial validator cannot hold startup past original budget");
      assert.deepEqual(result, { disposition: "unsent" }); assert.equal(rows.length, 0);
      release(); await delay(50); assert.equal(rows.length, 0); assert.equal(s.operation.start(), first);
      assert.deepEqual(await first, result); assert.equal(s.operation.observe().daemon, "not-spawned");
      return { unresolvedValidatorSettles: true, lateValidatorCannotSpawn: true, actualChildren: 0 };
    } finally { release(); }
  });
}

export async function daemonExpiry(create, native, binary, evidence) {
  return withFixture(evidence, "daemon-expiry", async (f, rows, own) => {
    let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
    const s = startup(create, native, binary, f, rows, { async validateDaemonExec(input) {
      assert.deepEqual({ ...input.environment }, { ...f.expected }); assert.deepEqual(rows.map(row => row.role), ["initializer"]);
      entered = true; await gate;
    } }, 2_500_000_000n); own(s.operation);
    const first = s.operation.start();
    try {
      await until(() => entered, s.options.deadlineNs, "actual prepared Root reply before delayed D validator");
      const result = await bounded(first, s.options.deadlineNs + 300_000_000n, "unresolved D validator keeps original budget");
      assert.deepEqual(result, { disposition: "unsent" }); assert.deepEqual(rows.map(row => row.role), ["initializer"]);
      release(); await delay(50); assert.equal(s.operation.start(), first); assert.deepEqual(await first, result); assert.equal(rows.length, 1);
      const end = now() + 3_000_000_000n;
      assert.deepEqual(await s.operation.waitForExit("initializer", end), { code: 69, signal: null });
      assert.deepEqual(await waited(rows[0], end), { code: 69, signal: null });
      assert.equal(rows[0].stderr.toString(), "private initializer unavailable\n");
      return { actualRootPreparedBeforeValidator: true, lateValidatorCannotSpawnDaemon: true, actualInitializerWait69: true };
    } finally { release(); }
  });
}

export async function exitObservers(create, native, binary, evidence) {
  return withFixture(evidence, "exit-observers", async (f, rows, own) => {
    const s = startup(create, native, binary, f, rows); own(s.operation);
    return boundedExitObservers(s, binary, f, rows);
  });
}

export async function handoffLoss(create, native, binary, evidence) {
  return withFixture(evidence, "handoff-loss", async (f, rows, own) => {
    const trace = loseInitializerAtRealHandoff(native, rows);
    const s = startup(create, trace.api, binary, f, rows); own(s.operation);
    return auditHandoffLoss(s, f, rows, trace.state);
  });
}
