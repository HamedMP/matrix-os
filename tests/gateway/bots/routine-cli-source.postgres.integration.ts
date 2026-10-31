import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createRoutineCliSourceService } from "../../../packages/gateway/src/bots/routine-cli-source.js";
import { NOW, createRealBotStateDatabase } from "./bot-state-support.js";
import { SOURCE_SCOPE as scope, context, invocation, list } from "./routine-cli-source-support.js";

let db: Kysely<OwnerBotDatabase> | undefined, destroy: (() => Promise<void>) | undefined;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const service = () => createRoutineCliSourceService({ db: db!, scope, now: () => new Date(NOW),
  // Explicit substitutes for actual source lifecycle/action approval; all registry storage and locks are real.
  validateLifecycle: async () => true, authorizeOperation: async () => true });
const marker = async (database: Kysely<OwnerBotDatabase>) => database.selectFrom("routine_cli_preferences").selectAll().execute();
const inspectLock = async (pid: () => number | undefined) => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const currentPid = pid();
    if (currentPid !== undefined) {
      const result = await sql<{ wait_event_type: string | null; blockers: number[]; generation_gate_wait: boolean }>`
        SELECT wait_event_type, pg_blocking_pids(pid) AS blockers,
          EXISTS (SELECT 1 FROM pg_locks WHERE pg_locks.pid = ${currentPid} AND locktype = 'advisory' AND NOT granted) AS generation_gate_wait
        FROM pg_stat_activity WHERE pid = ${currentPid}
      `.execute(db!);
      if (result.rows[0]?.wait_event_type === "Lock" && result.rows[0].blockers.length > 0 && result.rows[0].generation_gate_wait) return true;
    }
    await delay(10); // Poll real lock evidence; elapsed time itself never proves serialization.
  }
  return false;
};
const reached = async (barrier: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([barrier, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Native source transaction barrier not reached")), 3_000); })]); }
  finally { if (timer) clearTimeout(timer); }
};
beforeEach(async () => {
  const connectionString = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!connectionString) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for native routine source races");
  ({ db, destroy } = await createRealBotStateDatabase(connectionString));
});
afterEach(async () => { try { await destroy?.(); } finally { db = undefined; destroy = undefined; } });

// Explicit native qualification. Missing PostgreSQL fails, never skip/pass fallback.
// Set MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL to a dedicated test database, then on Node 24:
// pnpm exec vitest run --config vitest.integration.config.ts tests/gateway/bots/routine-cli-source.postgres.integration.ts --maxWorkers=1 --no-file-parallelism
describe("native source generation revoke/consume serialization", () => {
  it("holds revocation behind atomic consumption until the dispatch transaction commits", async () => {
    const database = db!, svc = service(), ref = await svc.register(context());
    const first = (await svc.issue(ref, { invocationId: invocation(1), operation: list })).takeToken();
    const unused = (await svc.issue(ref, { invocationId: invocation(2), operation: list })).takeToken();
    const inside = deferred(), release = deferred(); let revokerPid: number | undefined;
    const consuming = database.transaction().execute(trx => svc.consumeWithin(trx, { token: first, operation: list }, async () => {
      await trx.insertInto("routine_cli_preferences").values({ owner_id: scope.ownerId, computer_id: scope.computerId, bot_id: null, chat_id: null, binding_created_at: null, revision: 1, updated_at: NOW }).execute();
      inside.resolve(); await release.promise; return "admitted";
    }));
    void consuming.catch(() => undefined);
    let revoking: Promise<unknown> | undefined;
    try {
      await reached(inside.promise);
      revoking = database.transaction().execute(async trx => {
        revokerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
        return svc.revokeWithin(trx, ref);
      });
      void revoking.catch(() => undefined);
      expect(await inspectLock(() => revokerPid), "revoker did not wait on the consuming source generation").toBe(true);
      expect(await marker(database)).toHaveLength(0); // Uncommitted DB admission is still invisible.
      release.resolve();
      await expect(consuming).resolves.toBe("admitted"); await revoking;
      expect(await marker(database)).toHaveLength(1);
      await expect(database.transaction().execute(trx => svc.consumeWithin(trx, { token: unused, operation: list }, async () => "forbidden")))
        .rejects.toMatchObject({ code: "permission_denied" });
    } finally { release.resolve(); await Promise.allSettled([consuming, ...(revoking ? [revoking] : [])]); }
  });
  it("rejects consumption after a winning revocation without performing DB admission", async () => {
    const database = db!, svc = service(), ref = await svc.register(context());
    const token = (await svc.issue(ref, { invocationId: invocation(1), operation: list })).takeToken();
    const inside = deferred(), release = deferred(); let consumerPid: number | undefined;
    const revoking = database.transaction().execute(async trx => { await svc.revokeWithin(trx, ref); inside.resolve(); await release.promise; });
    void revoking.catch(() => undefined);
    let consuming: Promise<unknown> | undefined;
    try {
      await reached(inside.promise);
      consuming = database.transaction().execute(async trx => {
        consumerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
        return svc.consumeWithin(trx, { token, operation: list }, async () => {
          await trx.insertInto("routine_cli_preferences").values({ owner_id: scope.ownerId, computer_id: scope.computerId, bot_id: null, chat_id: null, binding_created_at: null, revision: 1, updated_at: NOW }).execute();
          return "forbidden";
        });
      });
      void consuming.catch(() => undefined);
      expect(await inspectLock(() => consumerPid), "consumer did not wait on revocation's source gate").toBe(true);
      release.resolve(); await revoking;
      await expect(consuming).rejects.toMatchObject({ code: "permission_denied" });
      expect(await marker(database)).toHaveLength(0);
      expect((await database.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())?.consumed_at).toBeNull();
    } finally { release.resolve(); await Promise.allSettled([revoking, ...(consuming ? [consuming] : [])]); }
  });
  it("serializes generation recreation with consumption and prevents stale process resurrection", async () => {
    const database = db!, svc = service(), ref = await svc.register(context());
    const token = (await svc.issue(ref, { invocationId: invocation(1), operation: list })).takeToken();
    const stale = (await svc.issue(ref, { invocationId: invocation(2), operation: list })).takeToken();
    const inside = deferred(), release = deferred(); let registrarPid: number | undefined;
    const consuming = database.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: list }, async () => { inside.resolve(); await release.promise; return true; }));
    void consuming.catch(() => undefined);
    let replacing: Promise<Awaited<ReturnType<typeof svc.register>>> | undefined;
    try {
      await reached(inside.promise);
      replacing = database.transaction().execute(async trx => {
        registrarPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid;
        return service().registerWithin(trx, context("generation_two"));
      });
      void replacing.catch(() => undefined);
      expect(await inspectLock(() => registrarPid), "new generation bypassed the current generation consumer").toBe(true);
      release.resolve(); await consuming; const next = await replacing;
      await expect(service().register(context())).rejects.toMatchObject({ code: "permission_denied" });
      await expect(database.transaction().execute(trx => service().consumeWithin(trx, { token: stale, operation: list }, async () => true)))
        .rejects.toMatchObject({ code: "permission_denied" });
      const nextToken = (await service().issue(next, { invocationId: invocation(3), operation: list })).takeToken();
      expect(await database.transaction().execute(trx => service().consumeWithin(trx, { token: nextToken, operation: list }, async source => source.generation))).toBe("generation_two");
    } finally { release.resolve(); await Promise.allSettled([consuming, ...(replacing ? [replacing] : [])]); }
  });
  it("retains the generation gate acquired by Task1-compatible revalidation until transaction completion", async () => {
    const database = db!, svc = service(), ref = await svc.register(context()), inside = deferred(), release = deferred();
    let revokerPid: number | undefined;
    const validating = database.transaction().execute(async trx => { expect(await svc.revalidateSource(context(), "read", trx)).toBe(true); inside.resolve(); await release.promise; });
    void validating.catch(() => undefined);
    let revoking: Promise<unknown> | undefined;
    try {
      await reached(inside.promise);
      revoking = database.transaction().execute(async trx => { revokerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid; return svc.revokeWithin(trx, ref); });
      void revoking.catch(() => undefined);
      expect(await inspectLock(() => revokerPid)).toBe(true);
      release.resolve(); await validating; await revoking;
      await database.transaction().execute(async trx => { expect(await svc.revalidateSource(context(), "read", trx)).toBe(false); });
    } finally { release.resolve(); await Promise.allSettled([validating, ...(revoking ? [revoking] : [])]); }
  });
  it("allows exactly one DB admission for two concurrent uses of the same invocation token", async () => {
    const database = db!, svc = service(), ref = await svc.register(context()), inside = deferred(), release = deferred();
    const token = (await svc.issue(ref, { invocationId: invocation(1), operation: list })).takeToken(); let secondPid: number | undefined;
    const first = database.transaction().execute(trx => svc.consumeWithin(trx, { token, operation: list }, async () => { inside.resolve(); await release.promise; return "first"; }));
    void first.catch(() => undefined);
    let second: Promise<unknown> | undefined;
    try {
      await reached(inside.promise);
      second = database.transaction().execute(async trx => { secondPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid; return svc.consumeWithin(trx, { token, operation: list }, async () => "duplicate"); });
      void second.catch(() => undefined);
      expect(await inspectLock(() => secondPid)).toBe(true);
      release.resolve(); await expect(first).resolves.toBe("first");
      await expect(second).rejects.toMatchObject({ code: "permission_denied" });
    } finally { release.resolve(); await Promise.allSettled([first, ...(second ? [second] : [])]); }
  });
});
