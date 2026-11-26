import { afterEach, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createRealBotStateDatabase, createBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { createPrivateSlackThreadContext } from "../../packages/gateway/src/slack/private-thread-context.js";
import { createSlackMentionSummaries } from "../../packages/gateway/src/slack/mention-summary.js";
import type { SlackThreadContextEnvelope } from "@matrix-os/contracts/slack-bridge";
const ownerId = "user_summary", chatId = "chat_summary123", botId = "bot_12345678", runtimeId = "preview_runtime";
const envelope: SlackThreadContextEnvelope = { ownerId, chatId, botId, runtimeId, grantId: "a".repeat(64), event: { appId: "A123", teamId: "T123", channelId: "C123", threadTs: "1795000000.000001", ts: "1795000001.000001", eventId: "EvSummary", userId: "U456", text: "<@U123> review this change" } };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse())
  await close(); });
it("atomically persists one mention job, leaves ordinary context Run-free, and reconciles a lost canonical acknowledgement", async () => {
  const fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  cleanup.push(fixture.destroy);
  await insertChat(fixture.db, chatId, ownerId);
  await fixture.db.insertInto("bot_chat_bindings").values({ owner_id: ownerId, bot_id: botId, chat_id: chatId, kind: "direct", created_at: new Date(), removed_at: null }).execute();
  let clock = new Date("2026-11-19T13:00:00Z");
  let allowed = true;
  const authorize = vi.fn(async () => ({ allowed }));
  const service = await createSlackMentionSummaries({ db: fixture.db, ownerId, runtimeId, now: () => clock, authorize,
    readThread: async () => ({ recipientUserId: "U123", messages: [{ ts: envelope.event.threadTs, user: "U456", text: "Root context" }], partial: false }) });
  cleanup.push(service.close);
  const context = await createPrivateSlackThreadContext({ db: fixture.db, ownerId, runtimeId, authorize, onReceive: service.receive });
  await context.receive(envelope);
  expect((await sql `SELECT * FROM slack_mention_summary_jobs`.execute(fixture.db)).rows).toHaveLength(0);
  expect(await fixture.db.selectFrom("chat_runs").select("id").execute()).toHaveLength(0);
  const mention = { ...envelope, summary: { ruleId: "owner-mentions", version: 1, proof: "b".repeat(64) } };
  await context.receive(mention); // Already recorded plain event must never acquire a job on replay.
  expect((await sql `SELECT * FROM slack_mention_summary_jobs`.execute(fixture.db)).rows).toHaveLength(0);
  const fresh = { ...mention, event: { ...mention.event, eventId: "EvFresh", ts: "1795000002.000001" } };
  await context.receive(fresh);
  await context.receive(fresh);
  await context.receive({ ...fresh, event: { ...fresh.event, eventId: "EvDuplicateTimestamp" } });
  expect((await sql `SELECT * FROM slack_mention_summary_jobs`.execute(fixture.db)).rows).toHaveLength(1);
  await sql `DELETE FROM slack_private_thread_context`.execute(fixture.db);
  await context.receive({ ...fresh, summary: { ...fresh.summary, proof: "c".repeat(64) }, event: { ...fresh.event, eventId: "EvAfterEviction" } });
  await context.receive({ ...fresh, event: { ...fresh.event, ts: "1795000003.000001" } });
  expect((await sql `SELECT * FROM slack_mention_summary_jobs`.execute(fixture.db)).rows).toHaveLength(1);
  let requests = 0;
  const submit = vi.fn(async () => { requests++; if (requests === 1)
    throw new Error("Lost canonical acknowledgement"); return { runId: "run_summary" }; });
  service.attach(submit);
  await service.drain();
  clock = new Date(clock.getTime() + 60000);
  await service.drain();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[0][0].clientRequestId).toEqual(submit.mock.calls[1][0].clientRequestId);
  expect(JSON.stringify(submit.mock.calls[0][0])).not.toContain("review this change");
  expect((await sql `SELECT state FROM slack_mention_summary_jobs`.execute(fixture.db)).rows).toEqual([{ state: "accepted" }]);
  allowed = false;
  await expect(service.assertAuthorized({ ownerId, chatId, botId, runId: "run_summary" })).resolves.toBe(false);
});
async function setup(options: {
  authorize?: () => Promise<boolean>;
} = {}) {
  const fixture = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  cleanup.push(fixture.destroy);
  await insertChat(fixture.db, chatId, ownerId);
  await fixture.db.insertInto("bot_chat_bindings").values({ owner_id: ownerId, bot_id: botId, chat_id: chatId, kind: "direct", created_at: new Date(), removed_at: null }).execute();
  let time = new Date("2026-11-19T13:00:00Z");
  const service = await createSlackMentionSummaries({ db: fixture.db, ownerId, runtimeId, now: () => time, authorize: options.authorize ?? (async () => true), readThread: async () => ({ recipientUserId: "U123", messages: [], partial: true }) });
  cleanup.push(service.close);
  const context = await createPrivateSlackThreadContext({ db: fixture.db, ownerId, runtimeId, authorize: async () => true, onReceive: service.receive });
  const push = (index: number) => context.receive({ ...envelope, summary: { ruleId: "owner-mentions", version: 1, proof: "b".repeat(64) }, event: { ...envelope.event, eventId: `EvLimit${index}`, ts: `1795000001.${String(index).padStart(6, "0")}` } });
  return { ...fixture, service, context, push, advance() { time = new Date(time.getTime() + 3600000); } };
}
it("caps the pilot at25 jobs per day and stops after5 recoverable admission attempts", async () => {
  const f = await setup();
  for (let index = 0; index < 26; index++)
    await f.push(index);
  expect((await sql `SELECT id FROM slack_mention_summary_jobs`.execute(f.db)).rows).toHaveLength(25);
  await sql `DELETE FROM slack_mention_summary_jobs WHERE id NOT IN (SELECT id FROM slack_mention_summary_jobs ORDER BY id LIMIT 1)`.execute(f.db);
  const submit = vi.fn(async () => { throw new Error("Synthetic transport unavailable"); });
  f.service.attach(submit);
  for (let index = 0; index < 5; index++) {
    await f.service.drain();
    f.advance();
  }
  expect(submit).toHaveBeenCalledTimes(5);
  expect((await sql `SELECT state,attempts FROM slack_mention_summary_jobs ORDER BY created_at,id LIMIT 1`.execute(f.db)).rows).toEqual([{ state: "failed", attempts: 5 }]);
});
it("rechecks local retirement after platform access returns and expires raw jobs without catchup", async () => {
  let db: Awaited<ReturnType<typeof setup>>["db"];
  const f = await setup({ authorize: async () => { await db.updateTable("bot_chat_bindings").set({ removed_at: new Date() }).where("chat_id", "=", chatId).execute(); return true; } });
  db = f.db;
  await f.push(1);
  const submit = vi.fn(async () => ({ runId: "run_unwanted" }));
  f.service.attach(submit);
  await f.service.drain();
  expect(submit).not.toHaveBeenCalled();
  expect((await sql `SELECT state FROM slack_mention_summary_jobs`.execute(db)).rows).toEqual([{ state: "failed" }]);
  for (let i = 0; i < 25; i++)
    f.advance();
  await f.service.drain();
  expect((await sql `SELECT id FROM slack_mention_summary_jobs`.execute(db)).rows).toHaveLength(0);
});
