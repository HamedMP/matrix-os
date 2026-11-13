import { afterEach, beforeEach, expect, it } from "vitest";
import { canonicalFixture } from "./routine-cli-canonical-support.js";
import { barrier, bounded, LockOrderTrace } from "./routine-cli-lock-order-support.js";
import { createRealBotStateDatabase, OWNER, at } from "./bot-state-support.js";
import { proposal } from "./routine-cli-request-support.js";
import { routineApprovalDigest } from "../../../packages/gateway/src/bots/routine-authorization.js";

// Required real PostgreSQL lane: absence is an error, never a PGlite/mock/skip pass.
// The external source/account policy is synthetic; canonical approvals, SQL, locks,
// source/request ledger, transaction and outbox are the actual production path.
let real: Awaited<ReturnType<typeof createRealBotStateDatabase>> | undefined;
let fixture: Awaited<ReturnType<typeof canonicalFixture>> | undefined;
let trace: LockOrderTrace;
const beforeCutoff = at(59_000), afterCutoff = at(61_000);

beforeEach(async () => {
  const url = process.env.MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL;
  if (!url) throw new Error("MATRIX_ROUTINE_CLI_TEST_POSTGRES_URL is required for the real PostgreSQL clock regression");
  real = await createRealBotStateDatabase(url);
  trace = new LockOrderTrace();
  fixture = await canonicalFixture(real.db.withPlugin(trace));
  fixture.state.clock = beforeCutoff;
});
afterEach(async () => {
  trace?.close();
  try { await fixture?.close(); } finally { await real?.destroy(); }
  fixture = undefined; real = undefined;
});

/** B locks before sampling input.now, so delaying only its FIRST query masks a
 * missing repository clock callback. Hold the FOURTH actual SQL lock result:
 * source lock-order gate -> request-service lock -> shared-control lock ->
 * repository.control lock.
 * The plugin returns every real row unchanged; no repository/clock is mocked.
 */
async function resumeAcrossInnerQuery() {
  const f = fixture!, entered = barrier(), release = barrier();
  let locks = 0;
  trace.after = async event => {
    if (event.kind !== "routine") return;
    if (++locks === 4) {
      entered.release();
      await bounded(release.ready);
    }
  };
  trace.active = true;
  const pending = trace.run("canonical-cli-resume", () => f.control("resume"))
    .then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    await bounded(entered.ready);
    expect(locks).toBe(4);
    // A separate real pooled connection independently proves that the routine
    // remains locked at this precise result boundary, rather than after commit.
    await expect(real!.db.transaction().execute(tx => tx.selectFrom("bot_routines")
      .select("routine_id").where("owner_id", "=", OWNER).where("routine_id", "=", f.id)
      .forUpdate().noWait().executeTakeFirstOrThrow())).rejects.toMatchObject({ code: "55P03" });
    f.state.clock = afterCutoff;
  } finally {
    release.release();
    await pending;
    trace.active = false;
  }
  return pending;
}

it("rejects a once cutoff crossed after the inner lock, rolling back routine/outbox/receipt", async () => {
  const f = fixture!, once = { ...proposal, schedule: { kind: "once" as const, at: at(60_000) } };
  // Seed an exact synthetic standing approval for this schedule, rather than
  // making the production authorization check succeed through a stub.
  await f.db.transaction().execute(async tx => {
    const routine = (await f.repo.get(OWNER, f.id, tx))!;
    await tx.updateTable("bot_routines").set({ proposal: once, next_fire_at: at(60_000) })
      .where("routine_id", "=", f.id).execute();
    await tx.updateTable("bot_approvals").set({ args_hash: routineApprovalDigest(once, f.authority) })
      .where("approval_id", "=", routine.approvalId!).execute();
  });
  const initial = await f.repo.get(OWNER, f.id);
  const outbox = await f.db.selectFrom("chat_outbox").selectAll().execute();
  const result = await resumeAcrossInnerQuery();
  expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(await f.repo.get(OWNER, f.id)).toEqual(initial);
  expect(await f.db.selectFrom("chat_outbox").selectAll().execute()).toEqual(outbox);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("bot_routine_fires").selectAll().execute()).toHaveLength(0);
});

it("resumes recurring work from the later clock after the inner lock, without paused backlog", async () => {
  const f = fixture!;
  const result = await resumeAcrossInnerQuery();
  expect(result).toMatchObject({ ok: true, value: { receipt: { disposition: "applied", routine: { status: "active", revision: 2 } } } });
  expect(await f.repo.get(OWNER, f.id)).toMatchObject({ status: "active", revision: 2,
    updatedAt: afterCutoff, nextFireAt: at(121_000) });
  expect(await f.repo.due(afterCutoff)).toHaveLength(0);
  expect(await f.db.selectFrom("bot_routine_fires").selectAll().execute()).toHaveLength(0);
  expect(await f.db.selectFrom("routine_cli_requests").selectAll().execute()).toHaveLength(1);
  expect(await f.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.authority.changed").execute()).toHaveLength(1);
});
