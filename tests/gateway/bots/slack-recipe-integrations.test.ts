import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotIntegrationTools } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { Kysely } from "kysely";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT, OWNER, NOW, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_slack_recipe";
const connection = { service: "gmail", connectionId: "conn_private", label: "Private mail" };
const read = { service: "gmail", action: "list_threads", connectionId: connection.connectionId, params: {} };
const group = { scopeId: "scope-company", actorId: "user_member", authEpoch: 1, authorityGeneration: 1, authorityRuntimeId: "owner-runtime" };
let state: Awaited<ReturnType<typeof createBotStateDatabase>>;
let binding: BotRuntimeBinding;

beforeEach(async () => {
  state = await createBotStateDatabase();
  await insertChat(state.db, CHAT);
  const task = await createBotTasksRepository(state.db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
  binding = { runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId: BOT,
    chatId: CHAT, taskId: task.taskId, runId: "run_recipe", rootFingerprint: "f".repeat(64),
    route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 },
    accessSourceId: "matrix_included", capabilities: ["integration.inventory", "integration.call"], requestClass: "interactive" };
});
afterEach(async () => state.destroy());

function setup(recipeId: "company-brain" | "personal-assistant") {
  const call = vi.fn(async () => ({ data: { threads: [] }, summary: "No threads" }));
  const tools = createBotIntegrationTools({ recipes: createBotRecipeCatalog(),
    client: { inventory: vi.fn(async () => [connection]), call },
    transact: createBotStateTransactions(new ChatRepository(state.db as unknown as Kysely<ChatDatabase>)),
    agents: { get: vi.fn(async () => ({ id: BOT, recipeRef: { recipeId, version: "2026-09-30.1" } }) as never) },
    now: () => new Date(NOW) });
  return { tools, call };
}
async function grant(audience: "direct" | `group:${string}`) {
  await createBotGrantsRepository(state.db).grant({ ownerId: OWNER, botId: BOT, ...connection,
    accountLabel: connection.label, effects: ["read"], audience, grantedByActorId: OWNER, now: NOW });
}

describe("Slack recipe integration authority", () => {
  it("uses an approved private connection through the actual personal recipe", async () => {
    await grant("direct");
    const { tools, call } = setup("personal-assistant");
    expect(JSON.stringify(await tools.inventory(binding, { service: "gmail" }))).toContain(connection.connectionId);
    await expect(tools.call(binding, read)).resolves.toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledOnce();
  });
  it("asks the private owner for missing access without invoking the service", async () => {
    const { tools, call } = setup("personal-assistant");
    await expect(tools.call(binding, read)).resolves.toMatchObject({ ok: true });
    const requests = await state.db.selectFrom("bot_interactions").select(["kind", "payload"]).execute();
    expect(requests).toEqual([expect.objectContaining({ kind: "account_choice", payload: expect.objectContaining({ service: "gmail", access: ["read"] }) })]);
    expect(call).not.toHaveBeenCalled();
  });
  it("requires a grant for the exact company Chat and never requests private access", async () => {
    await grant("direct");
    const { tools, call } = setup("company-brain");
    const shared = { ...binding, group };
    expect(JSON.stringify(await tools.inventory(shared, {}))).not.toContain(connection.label);
    await expect(tools.call(shared, read)).rejects.toMatchObject({ code: "not_granted" });
    expect(call).not.toHaveBeenCalled();
    await grant(`group:${CHAT}`);
    await expect(tools.call(shared, read)).resolves.toMatchObject({ ok: true });
    await expect(tools.call({ ...shared, chatId: "chat_other" }, read)).rejects.toMatchObject({ code: "not_granted" });
    expect(call).toHaveBeenCalledOnce();
    expect(await state.db.selectFrom("bot_interactions").selectAll().execute()).toEqual([]);
  });
  it.each(["personal-assistant", "company-brain"] as const)("keeps %s limited to reads and drafts", async recipeId => {
    const { tools, call } = setup(recipeId);
    await grant(recipeId === "company-brain" ? `group:${CHAT}` : "direct");
    await expect(tools.call({ ...binding, ...(recipeId === "company-brain" ? { group } : {}) }, {
      service: "gmail", action: "send_email", connectionId: connection.connectionId, params: { to: "a@example.com", subject: "Hi", body: "Hello" },
    })).rejects.toMatchObject({ code: "denied" });
    expect(call).not.toHaveBeenCalled();
  });
});
