import { setTimeout as delay } from "node:timers/promises";
import { sql, type Transaction } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotStateTransaction } from "../../../packages/gateway/src/bots/events.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createRoutineCliTargetService } from "../../../packages/gateway/src/bots/routine-cli-targets.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { NOW, OWNER, at, createRealBotStateDatabase } from "./bot-state-support.js";
import { context, invocation } from "./routine-cli-source-support.js";
import { requestFixture, propose, proposal, insertRoutine, TARGET_A, TARGET_B, scope } from "./routine-cli-request-support.js";

let fixture: Awaited<ReturnType<typeof requestFixture>> | undefined, destroy: (() => Promise<void>) | undefined;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const reached = async (barrier: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([barrier, new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("Native request barrier not reached")), 3_000); })]); }
  finally { if (timer) clearTimeout(timer); }
};
const pidOf = async (tx: BotStateTransaction) => (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx.db)).rows[0]!.pid;
const waiting = async (pid: () => number | undefined, advisory = true) => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const current = pid();
    if (current !== undefined) {
      const activity = await sql<{ wait_event_type: string | null; blockers: number[]; advisory: boolean }>`
        SELECT wait_event_type, pg_blocking_pids(pid) AS blockers,
          EXISTS (SELECT 1 FROM pg_locks WHERE pg_locks.pid = ${current} AND locktype='advisory' AND NOT granted) AS advisory
        FROM pg_stat_activity WHERE pid = ${current}`.execute(fixture!.db);
      const row = activity.rows[0];
      if (row?.wait_event_type === "Lock" && row.blockers.length > 0 && (!advisory || row.advisory)) return true;
    }
    await delay(10); // Only query-observed lock state is proof, never elapsed delay.
  }
  return false;
};
beforeEach(async () => {
  const connectionString = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!connectionString) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for native routine request races");
  const state = await createRealBotStateDatabase(connectionString); destroy = state.destroy; fixture = await requestFixture(state.db);
});
afterEach(async () => { try { await fixture?.close(); } finally { try { await destroy?.(); } finally { fixture = undefined; destroy = undefined; } } });

// Real owner PostgreSQL/source/target/outbox/ledger, with explicit fixture lifecycle/policy and atomic admission port.
// This is NOT canonical proposal/control or native harness integration qualification.
describe("native routine request receipt serialization", () => {
  it.each(["same input", "changed input", "case-equivalent UUID"] as const)("serializes concurrent %s from distinct legitimate sources without another durable admission", async mode => {
    const f = fixture!, operation = propose(), firstToken = await f.token(operation);
    const other = await f.sources.register({ ...context("generation_other"), identity: { kind: "terminal_launch", sessionId: "s", incarnationId: "i", launchId: "l" } });
    const secondOperation = mode === "same input" ? operation : mode === "case-equivalent UUID"
      ? { operation: "propose" as const, requestId: invocation(100).toUpperCase(), proposal }
      : { operation: "propose" as const, requestId: invocation(100), proposal: { ...proposal, name: "Changed" } };
    const secondToken = await f.token(secondOperation, other), inside = deferred(), release = deferred(); let secondPid: number | undefined;
    const first = f.service({ admitMutation: async input => { const result = await f.admitMutation(input); inside.resolve(); await release.promise; return result; } }).execute({ token: firstToken, operation });
    void first.catch(() => undefined); let second: Promise<unknown> | undefined;
    try {
      await reached(inside.promise);
      second = f.service({ transact: (owner, work) => f.transact(owner, async tx => { secondPid = await pidOf(tx); return work(tx); }),
        ...(mode === "case-equivalent UUID" ? { admitMutation: async () => { throw new Error("Conflicting UUID reached atomic admission"); } } : {}) }).execute({ token: secondToken, operation: secondOperation });
      void second.catch(() => undefined);
      expect(await waiting(() => secondPid), "duplicate did not wait for the durable request transaction").toBe(true);
      expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
      release.resolve(); const original = await first;
      if (mode === "same input") await expect(second).resolves.toEqual(original);
      else await expect(second).rejects.toMatchObject({ code: "request_conflict" });
      expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
      expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.task.updated").execute()).toHaveLength(1);
      expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
    } finally { release.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
  it("pins an accepted target while a concurrent default switch waits, then reconciles the original destination", async () => {
    const f = fixture!, operation = propose(), token = await f.token(operation), inside = deferred(), release = deferred();
    const request = f.service({ admitMutation: async input => { const result = await f.admitMutation(input); inside.resolve(); await release.promise; return result; } }).execute({ token, operation });
    let changerPid: number | undefined;
    void request.catch(() => undefined); let changing: Promise<unknown> | undefined;
    try {
      await reached(inside.promise);
      changing = f.db.connection().execute(async connection => {
        changerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(connection)).rows[0]!.pid;
        const targetService = createRoutineCliTargetService({ db: connection, scope, agents: f.agents, now: () => new Date(NOW),
          revalidateSource: f.sources.revalidateSource, canAccessTarget: async () => true });
        const stored = await targetService.getStoredPreference(f.principal);
        return targetService.remember(f.principal, { ...TARGET_B, baseRevision: stored.revision });
      });
      void changing.catch(() => undefined);
      expect(await waiting(() => changerPid), "default switch changed routing inside atomic admission").toBe(true);
      release.resolve(); const receipt = await request; await changing;
      const stored = await f.db.selectFrom("routine_cli_requests").select("target_snapshot").executeTakeFirstOrThrow();
      expect(stored.target_snapshot).toMatchObject(TARGET_A);
      expect((await f.db.selectFrom("bot_tasks").select("chat_id").executeTakeFirst())?.chat_id).toBe(TARGET_A.chatId);
      expect(await f.execute({ operation: "request", requestId: invocation(100) })).toEqual(receipt);
      expect(await f.execute(operation)).toEqual(receipt);
      expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
    } finally { release.resolve(); await Promise.allSettled([request, ...(changing ? [changing] : [])]); }
  });
  it("keeps source revocation behind atomic ledger/outbox admission and rejects a later unused credential", async () => {
    const f = fixture!, operation = propose(), token = await f.token(operation), laterOperation = propose(101), unused = await f.token(laterOperation);
    const inside = deferred(), release = deferred(); let revokerPid: number | undefined;
    const request = f.service({ admitMutation: async input => { const result = await f.admitMutation(input); inside.resolve(); await release.promise; return result; } }).execute({ token, operation });
    void request.catch(() => undefined); let revoking: Promise<unknown> | undefined;
    try {
      await reached(inside.promise);
      revoking = f.db.transaction().execute(async trx => { revokerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid; return f.sources.revokeWithin(trx, f.source); });
      void revoking.catch(() => undefined);
      expect(await waiting(() => revokerPid)).toBe(true);
      release.resolve(); await expect(request).resolves.toMatchObject({ receipt: { disposition: "queued" } }); await revoking;
      await expect(f.service().execute({ token: unused, operation: laterOperation })).rejects.toMatchObject({ code: "permission_denied" });
      expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
      expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(1);
    } finally { release.resolve(); await Promise.allSettled([request, ...(revoking ? [revoking] : [])]); }
  });
  it("preserves a receipt binding's PostgreSQL microseconds across default switch and rejects same-millisecond replacement", async () => {
    const f = fixture!, bindings = createBotBindingsRepository(f.db), first = "2026-09-27T12:00:00.123456Z", second = "2026-09-27T12:00:00.123457Z";
    await bindings.remove({ ownerId: OWNER, ...TARGET_A, now: at(1) }); await bindings.bindDirect({ ownerId: OWNER, ...TARGET_A, now: first });
    await f.targets.remember(f.principal, { ...TARGET_A, baseRevision: 1 });
    await f.execute(propose()); await f.switchDefault();
    const stored = await f.db.selectFrom("routine_cli_requests").select("target_snapshot").executeTakeFirstOrThrow();
    expect(stored.target_snapshot.bindingCreatedAt).toBe(first);
    expect(await f.execute({ operation: "request", requestId: invocation(100) })).toMatchObject({ receipt: { disposition: "queued" } });
    await bindings.remove({ ownerId: OWNER, ...TARGET_A, now: at(2) }); await bindings.bindDirect({ ownerId: OWNER, ...TARGET_A, now: second });
    await expect(f.execute({ operation: "request", requestId: invocation(100) })).rejects.toMatchObject({ code: "target_unavailable" });
  });
  it("waits on a canonical routine lock before taking target Chat locks for controls", async () => {
    const f = fixture!, id = await insertRoutine(f.db, 1), operation = { operation: "pause" as const, routineId: id, baseRevision: 1, requestId: invocation(100) };
    const token = await f.token(operation), inside = deferred(), release = deferred(); let requestPid: number | undefined;
    const holding = f.db.transaction().execute(async trx => { await trx.selectFrom("bot_routines").select("routine_id").where("routine_id", "=", id).forUpdate().execute(); inside.resolve(); await release.promise; });
    void holding.catch(() => undefined); let request: Promise<unknown> | undefined;
    try {
      await reached(inside.promise);
      request = f.service({ transact: (owner, work) => f.transact(owner, async tx => { requestPid = await pidOf(tx); return work(tx); }) }).execute({ token, operation });
      void request.catch(() => undefined);
      expect(await waiting(() => requestPid, false)).toBe(true);
      await f.db.transaction().execute(async trx => { await sql`SELECT id FROM chats WHERE id = ${TARGET_A.chatId} FOR UPDATE NOWAIT`.execute(trx); });
      release.resolve(); await holding;
      await expect(request).resolves.toMatchObject({ receipt: { disposition: "queued" } });
    } finally { release.resolve(); await Promise.allSettled([holding, ...(request ? [request] : [])]); }
  });
});
