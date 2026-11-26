import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotIntegrationTools } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotResourceGrantService } from "../../../packages/gateway/src/bots/resource-grant-service.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { bootstrapChatSharing } from "../../../packages/gateway/src/chat/sharing.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, NOW, OTHER_OWNER, OWNER, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_reviewer";
const OTHER_BOT = "bot_abcdef0123456789";
const REPO = {
  connectionId: "conn_review",
  label: "example/review-sandbox",
  scope: { kind: "github_repository", repositoryId: "101", fullName: "example/review-sandbox" },
} as const;

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let agents: ChatAgentStore;
let home: string;
const createService = (list = vi.fn(async () => [REPO]), isActiveManagedAgent = vi.fn(async () => true)) => createBotResourceGrantService({
  transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
  providers: { list },
  isActiveManagedAgent,
  now: () => new Date(NOW),
});

beforeEach(async () => {
  ({ db, destroy } = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase()));
  const chatDb = db as unknown as Kysely<ChatDatabase>;
  home = await mkdtemp(join(tmpdir(), "matrix-resource-grant-test-"));
  agents = new ChatAgentStore({ homePath: home, db: chatDb });
  await agents.bootstrap();
  await bootstrapChatSharing(chatDb);
  await insertChat(db, CHAT);
  await insertChat(db, "chat_other_reviewer");
  const bindings = createBotBindingsRepository(db);
  await bindings.bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
  await bindings.bindDirect({ ownerId: OWNER, botId: OTHER_BOT, chatId: "chat_other_reviewer", now: NOW });
});

afterEach(async () => {
  await agents.close();
  await rm(home, { recursive: true, force: true });
  await destroy();
});

describe("owner Agent resource approval", () => {
  it("persists only the selected exact resource in one private Agent and reopens from saved state", async () => {
    const discovery = vi.fn(async () => [REPO]);
    const service = createService(discovery);
    const pending = await service.list(OWNER, BOT);
    expect(pending.grants).toEqual([]);
    expect(pending.candidates).toEqual([{ id: expect.any(String), kind: "github_repository", label: REPO.label }]);
    expect(discovery).toHaveBeenCalledWith({ ownerId: OWNER, agentId: BOT, chatId: CHAT });
    const { grant } = await service.grant(OWNER, BOT, pending.candidates[0]!.id);
    expect(grant).toEqual({ id: expect.any(String), kind: "github_repository", label: REPO.label, revision: 1 });
    await expect(service.grant(OWNER, BOT, pending.candidates[0]!.id)).resolves.toEqual({ grant });
    await expect(createService().list(OWNER, BOT)).resolves.toEqual({ candidates: [], grants: [grant] });
    await expect(service.list(OWNER, OTHER_BOT)).resolves.toMatchObject({ grants: [] });
    await expect(service.list(OTHER_OWNER, BOT)).rejects.toMatchObject({ code: "missing" });
    expect(await db.selectFrom("chat_outbox").select(["event_type", "payload"]).execute()).toEqual([
      { event_type: "bot.authority.changed", payload: { agentId: BOT, revision: 1 } },
    ]);
  });

  it("commits one grant and event when two owner approvals race", async () => {
    const service = createService();
    const { candidates } = await service.list(OWNER, BOT);
    const [first, replay] = await Promise.all([
      service.grant(OWNER, BOT, candidates[0]!.id),
      service.grant(OWNER, BOT, candidates[0]!.id),
    ]);
    expect(replay).toEqual(first);
    const events = await db.selectFrom("chat_outbox").select("event_type").execute();
    expect(events).toEqual([{ event_type: "bot.authority.changed" }]);
  });

  it("rejects candidate replay across Agents and a changed provider connection", async () => {
    const service = createService();
    const { candidates } = await service.list(OWNER, BOT);
    await expect(service.grant(OWNER, OTHER_BOT, candidates[0]!.id)).rejects.toMatchObject({ code: "denied" });
    const replacement = createBotResourceGrantService({
      transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
      isActiveManagedAgent: async () => true,
      providers: { list: async () => [{ ...REPO, connectionId: "conn_replaced" }] },
    });
    await expect(replacement.grant(OWNER, BOT, candidates[0]!.id)).rejects.toMatchObject({ code: "denied" });
    const unrelated = createBotResourceGrantService({
      transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
      isActiveManagedAgent: async () => true,
      providers: { list: async () => [{ ...REPO, scope: { ...REPO.scope, repositoryId: "102" } }] },
    });
    await expect(unrelated.grant(OWNER, BOT, candidates[0]!.id)).rejects.toMatchObject({ code: "denied" });
  });

  it("requires the exact Agent and revision to revoke, and never revives the old grant ID", async () => {
    const service = createService();
    const { candidates } = await service.list(OWNER, BOT);
    const { grant } = await service.grant(OWNER, BOT, candidates[0]!.id);
    await expect(service.revoke(OWNER, OTHER_BOT, grant.id, grant.revision)).rejects.toMatchObject({ code: "missing" });
    await expect(service.revoke(OWNER, BOT, grant.id, grant.revision + 1)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.revoke(OWNER, BOT, grant.id, grant.revision)).resolves.toEqual({ grantId: grant.id, revokedAt: NOW });
    await expect(createService().list(OWNER, BOT)).resolves.toMatchObject({ grants: [] });
    await expect(service.grant(OWNER, BOT, candidates[0]!.id)).rejects.toMatchObject({ code: "denied" });
    const fresh = await service.list(OWNER, BOT);
    const { grant: replacement } = await service.grant(OWNER, BOT, fresh.candidates[0]!.id);
    expect(replacement.id).not.toEqual(grant.id);
    await expect(service.revoke(OWNER, BOT, grant.id, grant.revision)).rejects.toMatchObject({ code: "missing" });
  });

  it("withholds unmanaged Agent candidates and blocks approval if the Agent is archived during discovery", async () => {
    const discovery = vi.fn(async () => [REPO]);
    const isActiveManagedAgent = vi.fn(async () => false);
    const service = createService(discovery, isActiveManagedAgent);
    await expect(service.list(OWNER, BOT)).rejects.toMatchObject({ code: "missing" });
    expect(discovery).not.toHaveBeenCalled();

    isActiveManagedAgent.mockResolvedValue(true);
    const { candidates } = await service.list(OWNER, BOT);
    const { grant } = await service.grant(OWNER, BOT, candidates[0]!.id);
    discovery.mockImplementationOnce(async () => {
      isActiveManagedAgent.mockResolvedValue(false);
      return [REPO];
    });
    await expect(service.grant(OWNER, BOT, candidates[0]!.id)).rejects.toMatchObject({ code: "missing" });
    await expect(service.revoke(OWNER, BOT, grant.id, grant.revision)).resolves.toEqual({ grantId: grant.id, revokedAt: NOW });
  });

  it("refuses assignment when the otherwise personal Chat has an unexpired share", async () => {
    const discovery = vi.fn(async () => [REPO]);
    const service = createService(discovery);
    const { candidates } = await service.list(OWNER, BOT);
    await db.insertInto("chat_shares").values({
      id: "share_review", chat_id: CHAT, token_hash: "fixture", snapshot: { title: "Fixture", messages: [] },
      created_at: NOW, expires_at: new Date(Date.now() + 60_000),
    }).execute();
    discovery.mockClear();
    await expect(service.list(OWNER, BOT)).rejects.toMatchObject({ code: "missing" });
    await expect(service.grant(OWNER, BOT, candidates[0]!.id)).rejects.toMatchObject({ code: "missing" });
    expect(discovery).not.toHaveBeenCalled();
  });

  it("cannot spend repository approval on generic GitHub reads or writes", async () => {
    const service = createService();
    const { candidates } = await service.list(OWNER, BOT);
    await service.grant(OWNER, BOT, candidates[0]!.id);

    const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
    const binding: BotRuntimeBinding = {
      ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task.taskId, runId: "run_review",
      runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "1", rootFingerprint: "f".repeat(64),
      route: { api: "anthropic-messages", modelId: "claude-fixture", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8192 },
      accessSourceId: "matrix_included", capabilities: ["integration.call"], requestClass: "interactive",
    };
    const call = vi.fn(async () => ({ data: "Fixture that must never be returned" }));
    const tools = createBotIntegrationTools({
      client: { inventory: async () => [{ service: "github", connectionId: REPO.connectionId, label: "GitHub" }], call },
      transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
      recipes: createBotRecipeCatalog([{
        recipeId: "pr-reviewer", version: "1", name: "PR Reviewer", description: "Fixture", instructions: "Fixture",
        capabilities: ["integration.call"], integrations: [{ service: "github", effects: ["read", "write"], required: true }],
        output: "Fixture",
      }]),
      agents: { get: async () => ({ recipeRef: { recipeId: "pr-reviewer", version: "1" } }) as never },
      now: () => new Date(NOW),
    });

    for (const [action, params] of [
      ["get_pr", { repo: "example/unrelated", pullNumber: 1 }],
      ["get_pr", { repo: REPO.scope.fullName, pullNumber: 1 }],
      ["create_issue", { repo: REPO.scope.fullName, title: "Should never send" }],
    ] as const) {
      const decision = await tools.call(binding, { service: "github", connectionId: REPO.connectionId, action, params });
      expect(decision).toMatchObject({ ok: true, content: [{ text: expect.stringMatching(/asked|not answered/) }] });
    }
    expect(call).not.toHaveBeenCalled();
    expect(await db.selectFrom("bot_grants").select("grant_id").execute()).toEqual([]);
  });

  it("invalidates the old candidate and grant when a direct chat is unbound and restored", async () => {
    const service = createService();
    const { candidates } = await service.list(OWNER, BOT);
    await service.grant(OWNER, BOT, candidates[0]!.id);
    const bindings = createBotBindingsRepository(db);
    const later = "2026-11-26T12:00:00.000Z";
    await bindings.remove({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: later });
    await expect(service.list(OWNER, BOT)).rejects.toMatchObject({ code: "missing" });
    await bindings.bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: later });
    await expect(service.list(OWNER, BOT)).resolves.toMatchObject({ grants: [] });
    await expect(service.grant(OWNER, BOT, candidates[0]!.id)).rejects.toMatchObject({ code: "denied" });
  });
});
