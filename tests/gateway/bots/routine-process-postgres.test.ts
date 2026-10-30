/** Real compiled child process + pooled PostgreSQL; external model/source/host admission are synthetic. */
import { fork, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRealBotStateDatabase } from "./bot-state-support.js";

type Snapshot = {
  providerCalls: number;
  tasks: { task_id: string; status: string; run_id: string | null }[];
  fires: { fireId: string; status: string }[];
  routines: { routineId: string; status: string; requiresReview: boolean; lastFire: null | { fireId: string; taskId: string; status: string } }[];
  chat: null | { runs: { id: string; status: string; outcome: string | null }[]; messages: { role: string; parts: { type: string; text?: string }[] }[] };
  session: null | { revision: number; messages: Record<string, unknown>[] };
};
type ProcessClient = { child: ChildProcess; ask<T>(request: Record<string, unknown>): Promise<T>; stop(kill?: boolean): Promise<void> };
const realPg = Boolean(process.env.MATRIX_TEST_POSTGRES_URL);
const enabled = realPg || process.env.MATRIX_ROUTINE_PGLITE_TEST === "1";
describe.skipIf(!enabled)(`built routine process on ${realPg ? "pooled PostgreSQL" : "disk PGlite (not pooled PG)"}`, () => {
  let fixture: Awaited<ReturnType<typeof createRealBotStateDatabase>> | undefined;
  let dataDir: string | undefined;
  const children: ProcessClient[] = [], homes: string[] = [];
  beforeEach(async () => {
    fixture = realPg ? await createRealBotStateDatabase() : undefined;
    dataDir = realPg ? undefined : await mkdtemp(join(tmpdir(), "rp-db-"));
    if (dataDir) homes.push(dataDir);
  });
  afterEach(async () => {
    const clients = children.splice(0), cleanup = await Promise.allSettled(clients.map(client => client.stop()));
    if (clients.some(({ child }) => child.exitCode === null && child.signalCode === null)) throw new Error("Child exit uncertain; retain temporary database for cleanup");
    cleanup.push(...await Promise.allSettled([fixture?.destroy(), ...homes.splice(0).map(home => rm(home, { recursive: true, force: true }))]));
    const failures = cleanup.filter((item): item is PromiseRejectedResult => item.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(item => item.reason), "Qualification cleanup failed");
    console.info("routine_process_cleanup", { children: clients.length, allExited: true, temporaryDataRemoved: true });
  });
  async function launch(slow = false, expireFire?: string) {
    const artifact = process.env.MATRIX_ROUTINE_PROCESS_BUILD;
    if (!artifact) throw new Error("MATRIX_ROUTINE_PROCESS_BUILD is required; this lane never falls back to source");
    const build = JSON.parse(await readFile(join(artifact, "build.json"), "utf8")) as {
      head: string; root: string; lockSha256: string;
      artifacts: { file: string; sha256: string; sources: { realPath: string; sha256: string }[] }[];
    };
    const root = await realpath(process.cwd());
    expect(await realpath(build.root)).toBe(root);
    expect(build.head).toBe(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
    expect(build.lockSha256).toBe(createHash("sha256").update(await readFile(join(root, "pnpm-lock.yaml"))).digest("hex"));
    const entry = resolve(artifact, "routine-process.mjs"), expected = build.artifacts.find(a => a.file === "routine-process.mjs");
    expect(expected).toBeDefined();
    expect(createHash("sha256").update(await readFile(entry)).digest("hex")).toBe(expected!.sha256);
    for (const source of expected!.sources.filter(source => source.realPath.startsWith(`${root}/`))) {
      expect(await realpath(source.realPath)).toBe(source.realPath);
      expect(createHash("sha256").update(await readFile(source.realPath)).digest("hex")).toBe(source.sha256);
    }
    const schema = fixture ? (await sql<{ schema: string }>`SELECT current_schema() AS schema`.execute(fixture.db)).rows[0]!.schema : undefined;
    const home = await mkdtemp(join(tmpdir(), "rp-")); homes.push(home);
    const child = fork(entry, [], { cwd: home, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR, NODE_OPTIONS: "--max-old-space-size=512",
      MATRIX_TEST_POSTGRES_URL: process.env.MATRIX_TEST_POSTGRES_URL, MATRIX_ROUTINE_SCHEMA: schema,
      MATRIX_ROUTINE_PGLITE_TEST: dataDir ? "1" : undefined, MATRIX_ROUTINE_PGLITE_DIR: dataDir,
      MATRIX_ROUTINE_EXPIRE_FIRE: expireFire,
      MATRIX_ROUTINE_PROCESS_HOME: home, MATRIX_ROUTINE_PROCESS_SLOW: slow ? "1" : "0",
      OTEL_SDK_DISABLED: "true", POSTHOG_DISABLED: "true", TZ: "UTC",
    } });
    let logs = "", next = 0;
    child.stdout!.on("data", chunk => { logs = (logs + String(chunk)).slice(-65536); });
    child.stderr!.on("data", chunk => { logs = (logs + String(chunk)).slice(-65536); });
    const pending = new Map<number, { finish(value: unknown, error?: string): void }>(); // Max16, timeout/exit/stop clear.
    let readyResolve!: () => void;
    const ready = new Promise<void>(done => { readyResolve = done; });
    child.on("message", (raw: { ready?: boolean; id?: number; result?: unknown; error?: string }) => {
      if (raw.ready) readyResolve();
      if (raw.id) { pending.get(raw.id)?.finish(raw.result, raw.error); pending.delete(raw.id); }
    });
    const ended = new Promise<void>(done => child.once("exit", () => {
      for (const request of pending.values()) request.finish(undefined, "Process exited"); pending.clear(); done();
    }));
    const client: ProcessClient = { child,
      ask<T>(request: Record<string, unknown>): Promise<T> {
        if (pending.size >= 16) throw new Error("Bounded IPC capacity exceeded");
        return new Promise((done, reject) => {
          const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error(`IPC timeout: ${logs}`)); }, 15000);
          pending.set(id, { finish(value, error) { clearTimeout(timer); if (error) reject(new Error(error)); else done(value as T); } });
          child.send({ id, request });
        });
      },
      async stop(kill = false) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill(kill ? "SIGKILL" : "SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stopped: boolean;
        try { stopped = await Promise.race([ended.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), 12000); })]); }
        finally { clearTimeout(timer); }
        if (stopped!) { console.info("routine_process_exit", { pid: child.pid, code: child.exitCode, signal: child.signalCode }); return; }
        child.kill("SIGKILL");
        try { await Promise.race([ended, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Child exit uncertain after SIGKILL")), 5000); })]); }
        finally { clearTimeout(timer); }
        throw new Error("Graceful child stop timed out; SIGKILL exit was confirmed");
      },
    };
    children.push(client);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([ready, ended.then(() => { throw new Error(`Child boot failed: ${logs}`); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Child ready timeout: ${logs}`)), 10000); })]); }
    finally { clearTimeout(timer); }
    expect(child.pid).not.toBe(process.pid);
    console.info("routine_process_ready", { pid: child.pid, backend: realPg ? "pooled-postgresql" : "disk-pglite", artifact: expected!.sha256 });
    return client;
  }
  async function seed(client: ProcessClient) {
    return client.ask<{ routineId: string }>({ op: "seed", at: new Date(Date.now() + 1200).toISOString() });
  }
  async function until(client: ProcessClient, status: string) {
    const deadline = Date.now() + 22000;
    while (Date.now() < deadline) {
      const snap = await client.ask<Snapshot>({ op: "snapshot" });
      // Fire/task completion is committed before the adapter finishes the canonical run.
      // Observe both durable terminal states; never qualify from an intermediate snapshot.
      const canonicalSettled = status !== "completed" || (snap.chat?.runs.length === 1 && snap.chat.runs[0]?.status === "completed");
      if (snap.routines[0]?.lastFire?.status === status && canonicalSettled) return snap;
      await delay(100);
    }
    throw new Error(`Real scheduler did not reach ${status}`);
  }
  it("runs an approved future time through the built scheduler, canonical Chat, broker and Pi and persists its result once", async () => {
    const client = await launch(), routine = await seed(client);
    expect((await client.ask<Snapshot>({ op: "snapshot" })).routines[0].lastFire).toBeNull();
    await client.ask({ op: "start" });
    const snap = await until(client, "completed");
    expect(snap.routines[0].routineId).toBe(routine.routineId);
    expect(snap.chat!.messages.filter(m => m.role === "assistant").flatMap(m => m.parts)).toEqual([{ type: "text", text: "Verified scheduled Pi result." }]);
    expect(snap.session!.revision).toBeGreaterThan(0);
    expect(snap.session!.messages.some(m => m.role === "assistant")).toBe(true);
    const rows = fixture ? await fixture.db.selectFrom("bot_tasks").selectAll().where("task_id", "=", snap.routines[0].lastFire!.taskId).execute()
      : snap.tasks.filter(t => t.task_id === snap.routines[0].lastFire!.taskId);
    expect(rows).toHaveLength(1); expect(rows[0].status).toBe("completed");
    expect(snap.chat!.runs).toHaveLength(1); expect(rows[0].run_id).toBe(snap.chat!.runs[0].id);
    expect(snap.chat!.runs[0].status).toBe("completed");
    const foreign = await client.ask<Snapshot>({ op: "snapshot", foreign: true });
    expect(foreign.routines).toEqual([]); expect(foreign.chat).toBeNull(); expect(foreign.tasks).toEqual([]);
    expect(foreign.session).toMatchObject({ revision: 0, messages: [] });
    await expect(client.ask({ op: "control", routineId: routine.routineId, status: "archived", foreign: true })).rejects.toThrow();
    await client.stop();
    const restarted = await launch(); await restarted.ask({ op: "start" });
    await delay(16000); // Cross a subsequent production15-second pass, not only startup recovery.
    const noReplay = await restarted.ask<Snapshot>({ op: "snapshot" });
    expect(noReplay.chat!.runs).toHaveLength(1); expect(noReplay.fires).toHaveLength(1); expect(noReplay.providerCalls).toBe(0);
    expect(noReplay.fires[0].fireId).toBe(snap.routines[0].lastFire!.fireId);
  }, 60000);
  it("keeps pause durable across process restart and executes one catch-up only after owner resume", async () => {
    const first = await launch(), routine = await seed(first);
    await first.ask({ op: "control", routineId: routine.routineId, status: "paused" }); await first.stop();
    const restarted = await launch(); await restarted.ask({ op: "start" });
    await delay(16000);
    const paused = await restarted.ask<Snapshot>({ op: "snapshot" });
    expect(paused.routines[0].status).toBe("paused"); expect(paused.routines[0].lastFire).toBeNull(); expect(paused.chat!.runs).toEqual([]);
    await restarted.ask({ op: "control", routineId: routine.routineId, status: "active" });
    const done = await until(restarted, "completed"); expect(done.chat!.runs).toHaveLength(1);
  }, 50000);
  it("cancels the active real Pi loop through canonical cancellation before publishing a completed result", async () => {
    const client = await launch(true), routine = await seed(client); await client.ask({ op: "start" });
    await until(client, "dispatched");
    await expect.poll(async () => (await client.ask<Snapshot>({ op: "snapshot" })).providerCalls).toBeGreaterThan(0);
    await expect.poll(async () => (await client.ask<Snapshot>({ op: "snapshot" })).tasks.filter(t => t.status === "running").length).toBe(1);
    await client.ask({ op: "control", routineId: routine.routineId, status: "archived" });
    const cancelled = await until(client, "cancelled");
    expect(cancelled.routines[0].status).toBe("archived"); expect(cancelled.chat!.runs[0].status).toBe("aborted");
    expect(cancelled.chat!.messages.some(m => m.parts.some(p => p.text === "Verified scheduled Pi result."))).toBe(false);
  }, 40000);
  it("marks an interrupted dispatch uncertain after a real process crash and synthetic lease expiry without replay", async () => {
    const first = await launch(true); await seed(first); await first.ask({ op: "start" });
    const started = await until(first, "dispatched");
    await expect.poll(async () => (await first.ask<Snapshot>({ op: "snapshot" })).providerCalls).toBeGreaterThan(0);
    await expect.poll(async () => (await first.ask<Snapshot>({ op: "snapshot" })).tasks.filter(t => t.status === "running").length).toBe(1);
    await first.stop(true);
    // Do not wait the production12-minute lease; expire only this synthetic test fire.
    if (fixture) await fixture.db.updateTable("bot_routine_fires").set({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
      .where("fire_id", "=", started.routines[0].lastFire!.fireId).execute();
    const restarted = await launch(false, fixture ? undefined : started.routines[0].lastFire!.fireId); await restarted.ask({ op: "start" });
    const recovered = await until(restarted, "uncertain");
    expect(recovered.routines[0].requiresReview).toBe(true);
    expect(recovered.chat!.runs).toHaveLength(1);
    expect(recovered.chat!.messages.some(m => m.parts.some(p => p.text === "Verified scheduled Pi result."))).toBe(false);
    await delay(16000);
    const noReplay = await restarted.ask<Snapshot>({ op: "snapshot" });
    expect(noReplay.providerCalls).toBe(0); expect(noReplay.fires).toHaveLength(1); expect(noReplay.chat!.runs).toHaveLength(1);
    expect(noReplay.fires[0]).toMatchObject({ fireId: started.routines[0].lastFire!.fireId, status: "uncertain" });
  }, 60000);
});
