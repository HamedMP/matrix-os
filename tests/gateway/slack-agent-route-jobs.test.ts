import { afterEach, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createBotIntegrationClient, type BotIntegrationTransport } from "../../packages/gateway/src/bots/integration-client.js";
import { createSlackMentionSummaries } from "../../packages/gateway/src/slack/mention-summary.js";
import { createSlackAgentRouteResolver, type RoutedSlackEvent } from "../../packages/gateway/src/slack/agent-routes.js";
import { createBotStateTransactions } from "../../packages/gateway/src/bots/events.js";
import { bootstrapChatSharing } from "../../packages/gateway/src/chat/sharing.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { summaryRuntime } from "./slack-summary-runtime-support.js";

const ownerId = "user_route_test", runtimeId = "dev_route_test", teamId = "T123", appId = "A123", senderId = "U123";
const date = new Date(Date.now() - 30_000);
const ts = String(Math.floor(Date.now() / 1000)) + ".000001";
const head = "a".repeat(40), base = "b".repeat(40);
const github = { id: 328, full_name: "test/sample", private: true };
const metadata = { number: 6, changed_files: 1, additions: 1, deletions: 1, base: { sha: base, repo: github }, head: { sha: head, repo: github } };
const repositories = [{ id: "gh_conn", service: "github", account_label: "dev", status: "active" }];
const patch = {
  filename: "guide.md", patch: "@@ -1 +1 @@\n-before\n+after", changes: 2, additions: 1, deletions: 1, status: "modified",
  contents_url: "https://api.github.com/repos/test/sample/contents/guide.md?ref=" + head
};
const close: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); });

async function fixture() {
  const { db, destroy } = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase());
  close.push(destroy);
  const chatDb = db as unknown as Kysely<ChatDatabase>;
  await bootstrapChatSharing(chatDb);
  const repo = new ChatRepository(chatDb);
  const local = createSlackAgentRouteResolver({ ownerId, runtimeId, transact: createBotStateTransactions(repo), isActiveManagedAgent: async () => true });
  let patchAvailable = true;
  const transport = vi.fn<BotIntegrationTransport>(async (_, req) => Response.json(req.path === "/" ? repositories :
    { data: req.body?.action === "get_pr" ? metadata : [{ ...patch, patch: patchAvailable ? patch.patch : undefined }] }));
  const verifySource = vi.fn(async () => true);
  const worker = await createSlackMentionSummaries({
    db, ownerId, runtimeId, authorize: async () => false, readThread: async () => null,
    routed: { ...local, verifySource, github: createBotIntegrationClient(transport) }
  });
  close.push(worker.close);
  const event = (kind: "summary" | "review", overrides: Partial<RoutedSlackEvent> = {}): RoutedSlackEvent => ({
    appId, teamId, ownerId, runtimeId,
    sourceId: "1".repeat(64), installationGeneration: 1, channelId: kind === "review" ? "C123" : "C456", eventId: kind === "review" ? "EvReview" : "EvSummary",
    ts, threadTs: ts, userId: senderId, text: kind === "review" ? 'Please review https://github.com/test/sample/pull/6 at ' + head : "The release notes are ready.", ...overrides
  });
  for (const kind of ["summary", "review"] as const) {
    const chatId = "chat_" + kind, agentId = "bot_" + kind + "12345678", channelId = event(kind).channelId;
    await insertChat(db, chatId, ownerId);
    await db.insertInto("bot_chat_bindings").values({ owner_id: ownerId, bot_id: agentId, chat_id: chatId, kind: "direct", created_at: date, removed_at: null }).execute();
    const row = { owner_id: ownerId, bot_id: agentId, chat_id: chatId, binding_created_at: date, label: "Test", created_at: date, revoked_at: null };
    const repoGrantId = "rgr_" + "b".repeat(32);
    if (kind === "review") await db.insertInto("bot_resource_grants").values({
      ...row, grant_id: repoGrantId, candidate_id: "source_" + "b".repeat(48),
      connection_id: "gh_conn", kind: "github_repository", scope: JSON.stringify({ kind: "github_repository", repositoryId: "328", fullName: "test/sample" })
    }).execute();
    const route = { ownerId, runtimeId, appId, senderId, sourceId: event(kind).sourceId, installationGeneration: 1, kind, ...(kind === "review" ? { repoGrantId } : {}) };
    await db.insertInto("bot_resource_grants").values({
      ...row, grant_id: "rgr_" + (kind === "review" ? "c" : "d").repeat(32), candidate_id: "source_" + (kind === "review" ? "c" : "d").repeat(48),
      connection_id: "slack_test", kind: "slack_channel", scope: JSON.stringify({ kind: "slack_channel", teamId, channelId, route })
    }).execute();
  }
  return { db, worker, event, transport, verifySource, repo, noPatch() { patchAvailable = false; } };
}

it("rejects wrong repo, unlinked Agent, wrong channel and sender without provider reads or a job", async () => {
  const f = await fixture();
  await f.worker.receiveRoutedSlack(f.event("review", { text: "Review https://github.com/other/repo/pull/6" }));
  await f.worker.receiveRoutedSlack(f.event("review", { channelId: "C404" }));
  await f.worker.receiveRoutedSlack(f.event("summary", { text: f.event("review").text }));
  await f.worker.receiveRoutedSlack(f.event("review", { userId: "U404" }));
  await f.db.updateTable("bot_chat_bindings").set({ removed_at: new Date() }).where("chat_id", "=", "chat_review").execute();
  await f.worker.receiveRoutedSlack(f.event("review"));
  expect((await sql`select * from slack_mention_summary_jobs`.execute(f.db)).rows).toHaveLength(0);
  expect(f.transport).not.toHaveBeenCalled();
  expect(f.verifySource).not.toHaveBeenCalled();
});

it("rejects a review when another live Bot also owns the destination Chat before any external read", async () => {
  const f = await fixture();
  await f.db.insertInto("bot_chat_bindings").values({
    owner_id: ownerId, bot_id: "bot_other12345678", chat_id: "chat_review", kind: "direct", created_at: date, removed_at: null,
  }).execute();
  expect(await f.worker.receiveRoutedSlack(f.event("review"))).toBe(false);
  expect((await sql`SELECT id FROM slack_mention_summary_jobs`.execute(f.db)).rows).toHaveLength(0);
  expect(f.verifySource).not.toHaveBeenCalled();
  expect(f.transport).not.toHaveBeenCalled();
});

it("rejects a grant withdrawn while verifying membership, before creating a job", async () => {
  const f = await fixture();
  f.verifySource.mockImplementationOnce(async () => {
    await f.db.updateTable("bot_resource_grants").set({ revoked_at: new Date() }).where("kind", "=", "github_repository").execute();
    return true;
  });
  expect(await f.worker.receiveRoutedSlack(f.event("review"))).toBe(false);
  expect(f.verifySource).toHaveBeenCalledOnce();
  expect((await sql`SELECT id FROM slack_mention_summary_jobs`.execute(f.db)).rows).toHaveLength(0);
  expect(f.transport).not.toHaveBeenCalled();
});

it("delivers two signed-source jobs to their individual direct Chats, with one patch read for duplicate events", async () => {
  const f = await fixture();
  const summary = await summaryRuntime(f.db, f.worker, ownerId, "bot_summary12345678", "Release notes are ready.");
  close.push(summary.close);
  expect(await f.worker.receiveRoutedSlack(f.event("summary"))).toBe(true);
  await f.worker.drain();
  await vi.waitFor(async () => expect((await f.db.selectFrom("chat_runs").select("status").where("chat_id", "=", "chat_summary").execute())[0]?.status).toBe("completed"), { timeout: 30_000 });
  await f.worker.drain();
  expect(summary.modelRequests).toHaveLength(1);
  expect(f.transport).not.toHaveBeenCalled();
  const review = await summaryRuntime(f.db, f.worker, ownerId, "bot_review12345678", "guide.md changes the label from before to after. No blocking issue.");
  close.push(review.close);
  await f.worker.receiveRoutedSlack(f.event("review"));
  await f.worker.receiveRoutedSlack(f.event("review"));
  await f.worker.receiveRoutedSlack(f.event("review", { eventId: "EvReplay" }));
  await f.worker.drain();
  await vi.waitFor(async () => expect((await f.db.selectFrom("chat_runs").select("status").where("chat_id", "=", "chat_review").execute())[0]?.status).toBe("completed"), { timeout: 30_000 });
  await f.worker.drain();
  const runs = await f.db.selectFrom("chat_runs").select("chat_id").execute();
  expect(runs.map(r => r.chat_id).sort()).toEqual(["chat_review", "chat_summary"]);
  expect(f.transport.mock.calls.map(([, r]) => r.body?.action)).toEqual([undefined, "get_pr", "list_pr_files", "get_pr"]);
  expect(review.modelRequests).toHaveLength(1);
  const body = JSON.stringify(review.modelRequests[0]);
  expect(body).toContain("+after");
  expect(body).not.toContain("release notes");
  expect(review.modelRequests[0]!.tools ?? []).toEqual([]);
  const output = async (chatId: string) => JSON.stringify(await f.db.selectFrom("chat_messages").select("parts").where("role", "=", "assistant").where("chat_id", "=", chatId).execute());
  expect(await output("chat_review")).toContain("guide.md changes");
  expect(await output("chat_review")).toContain(head);
  expect(await output("chat_summary")).not.toContain("guide.md");
  expect((await sql`select state from slack_mention_summary_jobs`.execute(f.db)).rows).toEqual([{ state: "completed" }, { state: "completed" }]);
}, 40000);

it.each(["revoke", "missing patch"])("ends before inference on %s and never retries a read", async (reason) => {
  const f = await fixture();
  expect(await f.worker.receiveRoutedSlack(f.event("review"))).toBe(true);
  if (reason === "revoke") await f.db.updateTable("bot_resource_grants").set({ revoked_at: new Date() }).where("kind", "=", "github_repository").execute();
  else f.noPatch();
  const submit = vi.fn(async () => ({ runId: "run_unexpected" }));
  f.worker.attach(submit);
  await f.worker.drain();
  const calls = f.transport.mock.calls.length;
  await f.worker.drain();
  expect(submit).not.toHaveBeenCalled();
  expect(f.transport).toHaveBeenCalledTimes(reason === "revoke" ? 0 : calls);
  expect((await sql`select state from slack_mention_summary_jobs`.execute(f.db)).rows).toEqual([{ state: "failed" }]);
});

it("withholds an answer that just restates the PR title and fails the same Bot task and canonical Run", async () => {
  const f = await fixture();
  const runtime = await summaryRuntime(f.db, f.worker, ownerId, "bot_review12345678", "The guide.md update looks fine.");
  close.push(runtime.close);
  expect(await f.worker.receiveRoutedSlack(f.event("review"))).toBe(true);
  await f.worker.drain();
  await vi.waitFor(async () => expect((await f.db.selectFrom("chat_runs").select("status").where("chat_id", "=", "chat_review").execute())[0]?.status).toBe("failed"), { timeout: 30_000 });
  expect(await f.db.selectFrom("bot_tasks").select("status").where("chat_id", "=", "chat_review").execute()).toEqual([{ status: "failed" }]);
  expect(await f.db.selectFrom("chat_messages").select("id").where("role", "=", "assistant").execute()).toEqual([]);
}, 60_000);

it("suppresses an in-flight reviewer result when the repository grant is revoked after model dispatch", async () => {
  const f = await fixture();
  const runtime = await summaryRuntime(f.db, f.worker, ownerId, "bot_review12345678", "guide.md replaces before with after.");
  close.push(runtime.close);
  const revoked = vi.fn(async () => {
    await f.db.updateTable("bot_resource_grants").set({ revoked_at: new Date() })
      .where("kind", "=", "github_repository").execute();
  });
  f.verifySource.mockImplementation(async () => {
    if (runtime.modelRequests.length && !revoked.mock.calls.length) await revoked();
    return true;
  });
  expect(await f.worker.receiveRoutedSlack(f.event("review"))).toBe(true);
  await f.worker.drain();
  await vi.waitFor(async () => {
    expect((await f.db.selectFrom("chat_runs").select("status").where("chat_id", "=", "chat_review").execute())[0]?.status).toBe("failed");
  }, { timeout: 30_000 });
  expect(revoked).toHaveBeenCalledOnce();
  expect(runtime.modelRequests).toHaveLength(1);
  expect(f.transport).toHaveBeenCalledTimes(4);
  expect(await f.db.selectFrom("chat_messages").select("id").where("role", "=", "assistant").execute()).toEqual([]);
}, 60_000);
