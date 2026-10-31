import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createRealBotStateDatabase, OWNER, at } from "./bot-state-support.js";
import { canonicalFixture, runningCanonicalFire } from "./routine-cli-canonical-support.js";
import { context } from "./routine-cli-source-support.js";
import { TARGET_A } from "./routine-cli-request-support.js";
import type { BotStateTransaction } from "../../../packages/gateway/src/bots/events.js";
let f: Awaited<ReturnType<typeof canonicalFixture>>, destroy: (() => Promise<void>) | undefined;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function reached(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("Canonical control barrier not reached")), 3000); })]); }
  finally { clearTimeout(timer); }
}
const pidOf = async (tx: BotStateTransaction) => (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx.db)).rows[0]!.pid;
async function waiting(pid: () => number | undefined) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const p = pid();
    if (p !== undefined) {
      const row = (await sql<{ waiting: boolean }>`SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AS waiting FROM pg_stat_activity WHERE pid=${p}`.execute(f.db)).rows[0];
      if (row?.waiting) return true;
    }
    await delay(10);
  }
  return false;
}
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for native canonical CLI controls");
  const data = await createRealBotStateDatabase(url); destroy = data.destroy; f = await canonicalFixture(data.db);
});
afterEach(async () => { try { await f?.close(); } finally { await destroy?.(); } });
// Real PostgreSQL + owning Chat transactions + real canonical control/approval/outbox. Only source/peer/cancel endpoints are fixtures.
it.each(["lifecycle", "operation"] as const)("actual execute-entry canonical writes roll back on final %s denial", async boundary => {
  const running = await runningCanonicalFire(f), cancel = vi.fn(async () => undefined);
  f.execution.connect({ repository: f.chats, orchestrator: { cancelRun: cancel } } as never);
  let witnessed = false; const post = vi.fn(f.adapter.afterMutationCommit);
  await expect(f.execute(f.operation("pause", running.revision), { ...f.adapter, afterMutationCommit: post,
    sources: { consumeWithin: (trx, input, work) => f.sources.consumeWithin(trx, input, async (source, executor, invocation) => {
      const result = await work(source, executor, invocation);
      expect(await f.repo.get(OWNER, f.id, trx)).toMatchObject({ status: "paused", revision: running.revision + 1 });
      expect(await trx.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
      expect(await trx.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute()).toHaveLength(1);
      expect((await trx.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).not.toBeNull();
      witnessed = true; if (boundary === "lifecycle") f.state.live = false; else f.state.operationAllowed = false;
      return result;
    }) } })).rejects.toMatchObject({ code: "permission_denied" });
  expect(witnessed).toBe(true); expect(post).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled();
  expect(await f.repo.get(OWNER, f.id)).toMatchObject({ status: "active", revision: running.revision });
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute()).toHaveLength(0);
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).toBeNull();
});
it("duplicate canonical control waits then applies and cancels once", async () => {
  const operation = f.operation("pause"), firstToken = await f.token(operation);
  const other = await f.sources.register({ ...context("canonical_other"), identity: { kind: "terminal_launch", sessionId: "s", incarnationId: "i", launchId: "l" } });
  const secondToken = await f.token(operation, other);
  const entered = deferred(), release = deferred(), post = vi.fn(f.adapter.afterMutationCommit); let secondPid: number | undefined;
  const first = f.service({ ...f.adapter, afterMutationCommit: post, admitMutation: async input => {
    const applied = await f.adapter.admitMutation(input); entered.resolve(); await release.promise; return applied;
  } }).execute({ token: firstToken, operation });
  void first.catch(() => undefined); let second: Promise<unknown> | undefined;
  try {
    await reached(entered.promise);
    second = f.service({ ...f.adapter, afterMutationCommit: post, transact: (owner, work) => f.transact(owner, async tx => { secondPid = await pidOf(tx); return work(tx); }) }).execute({ token: secondToken, operation });
    void second.catch(() => undefined);
    expect(await waiting(() => secondPid)).toBe(true);
    release.resolve(); const result = await first; expect(await second).toEqual(result);
    expect(post).toHaveBeenCalledTimes(1);
    expect(await f.repo.get(OWNER, f.id)).toMatchObject({ revision: 2 });
    expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
    expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute()).toHaveLength(1);
  } finally { release.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
});
it("source revoke acquires its gate while postcommit cancellation is blocked", async () => {
  const running = await runningCanonicalFire(f), operation = f.operation("pause", running.revision);
  const token = await f.token(operation), unused = await f.token(f.operation("archive", running.revision + 1, 101));
  const entered = deferred(), release = deferred(), revoked = deferred();
  f.execution.connect({ repository: f.chats, orchestrator: { cancelRun: async () => {
    expect(await f.repo.get(OWNER, f.id)).toMatchObject({ status: "paused", revision: running.revision + 1 });
    entered.resolve(); await release.promise; throw new Error("Fixture cancellation unavailable after commit");
  } } } as never);
  const request = f.service(f.adapter).execute({ token, operation });
  void request.catch(() => undefined); let revoke: Promise<unknown> | undefined;
  try {
    await reached(entered.promise);
    revoke = f.sources.revoke(f.source).then(value => { revoked.resolve(); return value; });
    void revoke.catch(() => undefined);
    await reached(revoked.promise); await revoke;
    await expect(f.service(f.adapter).execute({ token: unused, operation: f.operation("archive", running.revision + 1, 101) })).rejects.toMatchObject({ code: "permission_denied" });
    release.resolve(); expect(await request).toMatchObject({ receipt: { disposition: "applied" }, execution: { stop: "unconfirmed" } });
    expect(await f.repo.getFire(OWNER, running.fire.fireId)).toMatchObject({ status: "uncertain" });
  } finally { release.resolve(); await Promise.allSettled([request, ...(revoke ? [revoke] : [])]); }
});
it("does not cancel a newer resumed occurrence when an older pause postcommit phase is delayed", async () => {
  const entered = deferred(), release = deferred();
  const pause = f.execute(f.operation("pause"), { ...f.adapter, afterMutationCommit: async intent => {
    entered.resolve(); await release.promise; await f.adapter.afterMutationCommit(intent);
  } });
  void pause.catch(() => undefined);
  try {
    await reached(entered.promise);
    expect(await f.control("resume", 2, 101)).toMatchObject({ receipt: { routine: { status: "active", revision: 3 } } });
    const later = await f.repo.claim({ ownerId: OWNER, routineId: f.id, scheduledFor: at(60_000),
      nextFireAt: at(120_000), now: at(60_000) });
    expect(later).toBeDefined();
    release.resolve();
    expect(await pause).toMatchObject({ receipt: { routine: { status: "paused", revision: 2 } }, execution: { stop: "unconfirmed" } });
    expect(await f.repo.get(OWNER, f.id)).toMatchObject({ status: "active" });
    expect(await f.repo.getFire(OWNER, later!.fireId)).toMatchObject({ status: "claimed" });
  } finally { release.resolve(); await Promise.allSettled([pause]); }
});

it("waits for routine before taking target Chat lock with actual canonical port", async () => {
  const operation = f.operation("resume"), token = await f.token(operation), entered = deferred(), release = deferred(); let requestPid: number | undefined;
  const holder = f.db.transaction().execute(async trx => { await f.repo.lock(OWNER, f.id, trx); entered.resolve(); await release.promise; });
  void holder.catch(() => undefined); let request: Promise<unknown> | undefined;
  try {
    await reached(entered.promise);
    request = f.service({ ...f.adapter, transact: (owner, work) => f.transact(owner, async tx => { requestPid = await pidOf(tx); return work(tx); }) }).execute({ token, operation });
    void request.catch(() => undefined); expect(await waiting(() => requestPid)).toBe(true);
    await f.db.transaction().execute(trx => sql`SELECT id FROM chats WHERE id=${TARGET_A.chatId} FOR UPDATE NOWAIT`.execute(trx));
    release.resolve(); await holder; expect(await request).toMatchObject({ receipt: { routine: { status: "active" } } });
  } finally { release.resolve(); await Promise.allSettled([holder, ...(request ? [request] : [])]); }
});

it("canonical approval reads use the owning transaction's uncommitted authority state", async () => {
  await expect(f.execute(f.operation("resume"), { ...f.adapter, authorizeTarget: async (_input, tx) => {
    await tx.db.updateTable("bot_approvals").set({ status: "denied" }).execute();
    return true;
  } })).rejects.toMatchObject({ code: "invalid_input" });
  expect(await f.repo.get(OWNER, f.id)).toMatchObject({ status: "paused", revision: 1 });
  expect((await f.db.selectFrom("bot_approvals").select("status").executeTakeFirst())!.status).toBe("approved");
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
});
