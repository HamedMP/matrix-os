import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createRealBotStateDatabase, OWNER, at } from "./bot-state-support.js";
import { proposalFixture } from "./routine-cli-proposal-support.js";
let data: Awaited<ReturnType<typeof createRealBotStateDatabase>>, f: Awaited<ReturnType<typeof proposalFixture>>;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function reached(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([promise, new Promise<never>((_r, reject) => { timer = setTimeout(() => reject(new Error("Proposal barrier not reached")), 3000); })]); }
  finally { clearTimeout(timer); }
}
beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for proposal source/claim races");
  data = await createRealBotStateDatabase(url); f = await proposalFixture(data.db, vi.fn);
});
afterEach(async () => { await f?.close(); await data?.destroy(); });
it("claim holds original source gate through actual task/run/progress commit, then origin revoke does not erase accepted intent", async () => {
  const entered = deferred(), release = deferred(), real = f.sources.validateAcceptedWithin; let revokerPid = 0;
  f.sources.validateAcceptedWithin = (trx, receipt, work) => real(trx, receipt, async () => {
    const result = await work();
    expect(await trx.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "running" }]);
    expect((await trx.selectFrom("routine_cli_proposals").select("stage").executeTakeFirst())!.stage).toBe("target_task_claimed");
    entered.resolve(); await release.promise; return result;
  });
  const submitting = f.submit(); void submitting.catch(() => undefined); let revoking: Promise<unknown> | undefined;
  try {
    await reached(entered.promise);
    revoking = f.db.transaction().execute(async trx => { revokerPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx)).rows[0]!.pid; return f.sources.revokeWithin(trx, f.source); });
    void revoking.catch(() => undefined);
    let observedWait = false; const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (revokerPid) {
        const row = (await sql<{ waiting: boolean }>`SELECT wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0 AND EXISTS(
          SELECT 1 FROM pg_locks WHERE pg_locks.pid=${revokerPid} AND locktype='advisory' AND NOT granted) AS waiting FROM pg_stat_activity WHERE pid=${revokerPid}`.execute(f.db)).rows[0];
        if (row?.waiting) { observedWait = true; break; }
      }
      await delay(10);
    }
    expect(observedWait).toBe(true);
    expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(0);
    release.resolve(); await submitting; await revoking; await f.canonical.drain();
    expect(await f.db.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "waiting_person" }]);
    expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(1);
    expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
  } finally { release.resolve(); await Promise.allSettled([submitting, ...(revoking ? [revoking] : [])]); }
});
it.each(["revoke", "expiry"] as const)("%s winning before task claim blocks the handoff, despite durable queued receipt", async mode => {
  const entered = deferred(), release = deferred(), begin = f.proposals.beginWithin;
  f.proposals.beginWithin = async (tx, input) => { entered.resolve(); await release.promise; return begin(tx, input); };
  const submitting = f.submit(); void submitting.catch(() => undefined);
  try {
    await reached(entered.promise);
    if (mode === "revoke") await f.sources.revoke(f.source); else f.state.clock = at(300001);
    release.resolve(); await submitting; await f.canonical.drain();
    expect(await f.db.selectFrom("routine_cli_requests").select("admission").execute()).toEqual([{ admission: { disposition: "queued" } }]);
    expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(0);
    expect(await f.db.selectFrom("bot_approvals").selectAll().execute()).toHaveLength(0);
    expect(f.host.createRuntime).not.toHaveBeenCalled(); expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
  } finally { release.resolve(); await submitting; }
});
it("final source/action rejection rolls actual target claim back while keeping earlier canonical admission and consumed request receipt", async () => {
  const real = f.sources.validateAcceptedWithin; let observed = false;
  f.sources.validateAcceptedWithin = (trx, receipt, work) => real(trx, receipt, async () => {
    const result = await work();
    expect(await trx.selectFrom("bot_tasks").select("status").execute()).toEqual([{ status: "running" }]);
    expect((await trx.selectFrom("routine_cli_proposals").select("stage").executeTakeFirst())!.stage).toBe("target_task_claimed");
    observed = true; f.state.operationAllowed = false; return result;
  });
  await f.submit(); await f.canonical.drain(); expect(observed).toBe(true);
  expect(await f.db.selectFrom("bot_tasks").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.task.updated").execute()).toHaveLength(0);
  expect((await f.db.selectFrom("routine_cli_proposals").select("task_id").executeTakeFirst())!.task_id).toBeNull();
  expect(await f.db.selectFrom("chat_runs").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).not.toBeNull();
  expect(vi.mocked(f.runBot).mock.calls.filter(([input]) => input.command.kind === "bot.run")).toHaveLength(0);
});
it("initial final source denial rolls actual reservation/receipt/consumption back before any canonical submission", async () => {
  const { propose } = await import("./routine-cli-request-support.js"); let observed = false;
  await expect(f.execute(propose(), { ...f.proposals, sources: { consumeWithin: (trx, input, work) => f.sources.consumeWithin(trx, input, async (source, executor, invocation) => {
    const result = await work(source, executor, invocation);
    expect(await trx.selectFrom("routine_cli_proposals").selectAll().execute()).toHaveLength(1);
    expect(await trx.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
    observed = true; f.state.operationAllowed = false; return result;
  }) } })).rejects.toMatchObject({ code: "permission_denied" });
  expect(observed).toBe(true);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("routine_cli_proposals").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("chat_runs").selectAll().execute()).toHaveLength(0);
  expect((await f.db.selectFrom("routine_cli_capabilities").select("consumed_at").executeTakeFirst())!.consumed_at).toBeNull();
  expect(f.host.createRuntime).not.toHaveBeenCalled();
});
