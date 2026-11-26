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
  it("withholds grant candidates when another Bot also has a live direct binding to this Chat", async () => {
    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: "bot_12345678abcd", chatId: CHAT, now: NOW });
    const discovery = vi.fn(async () => [REPO]);
    await expect(createService(discovery).list(OWNER, BOT)).rejects.toMatchObject({ code: "missing" });
    expect(discovery).not.toHaveBeenCalled();
  });

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

it("routes one verified Slack installation by channel, freezes the review repo grant and rejects stale authority", async () => {
  const { createSlackAgentRouteResolver, routedSlackPublicationCurrent } = await import("../../../packages/gateway/src/slack/agent-routes.js");
  const { routeCandidates } = await import("../../../packages/gateway/src/bots/resource-grant-candidates.js");
  const transact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
  const source = { ownerId: OWNER, runtimeId: "runtime_test", appId: "A123", teamId: "T123",
    installationGeneration: 1, senderId: "U123", sourceId: "e".repeat(64) };
  const channels = ["summary", "reviews"].map((name, i) => ({ ...source, name, channelId: "C00" + i }));
  const service = createBotResourceGrantService({ transact, providers: { list: async () => [REPO, ...routeCandidates(channels)] },
    isActiveManagedAgent: async () => true, now: () => new Date(NOW) });
  const resolver = createSlackAgentRouteResolver({ ownerId: OWNER, runtimeId: source.runtimeId, transact, isActiveManagedAgent: async () => true });
  const first = await service.list(OWNER, BOT);
  expect(first.candidates.map(c => c.label)).not.toContain("#reviews · Review pull requests");
  const grant = async (bot: string, label: string) => {
    const option = (await service.list(OWNER, bot)).candidates.find(c => c.label === label);
    expect(option).toBeDefined();
    return (await service.grant(OWNER, bot, option!.id)).grant;
  };
  await grant(BOT, "#summary · Summarize new messages");
  expect((await service.list(OWNER, OTHER_BOT)).candidates.map(c => c.label)).not.toContain("#summary · Summarize new messages");
  const repo = await grant(OTHER_BOT, REPO.label);
  await grant(OTHER_BOT, "#reviews · Review pull requests");
  const event = { ...source, channelId: "C001", eventId: "Ev100", userId: "U123", ts: "2100000000.000001", threadTs: "2100000000.000001", text: "Review this PR" };
  const lookup = (overrides = {}) => transact(OWNER, tx => resolver.resolve({ ...event, ...overrides }, tx.db));
  expect(await lookup({ channelId: "C000" })).toMatchObject({ kind: "summary", agentId: BOT, chatId: CHAT });
  expect(await lookup({ channelId: "C999" })).toBeNull();
  expect(await lookup({ userId: "U999" })).toBeNull();
  expect(await lookup({ ts: "1000000000.000001" })).toBeNull();
  const review = await lookup();
  expect(review).toMatchObject({ kind: "review", agentId: OTHER_BOT, github: { grantId: repo.id } });
  expect(await transact(OWNER, tx => routedSlackPublicationCurrent(tx.db, review!))).toBe(true);
  await service.revoke(OWNER, OTHER_BOT, repo.id, repo.revision);
  await grant(OTHER_BOT, REPO.label);
  expect(await lookup()).toBeNull();
  expect(await resolver.current(review!)).toBe(false);
  const summary = await lookup({ channelId: "C000" });
  await createBotBindingsRepository(db).remove({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
  expect(await lookup({ channelId: "C000" })).toBeNull();
  expect(await resolver.current(summary!)).toBe(false);
});

it("serializes channel assignments across Agents and fails closed on ambiguous stored grants", async () => {
  const { createSlackAgentRouteResolver } = await import("../../../packages/gateway/src/slack/agent-routes.js");
  const { routeCandidates } = await import("../../../packages/gateway/src/bots/resource-grant-candidates.js");
  const transact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
  const source = { ownerId: OWNER, runtimeId:"runtime_test", appId:"A123", teamId:"T123", senderId:"U123", sourceId:"f".repeat(64),
    name:"summary", channelId:"C001", installationGeneration:1 };
  const service = createBotResourceGrantService({ transact, providers:{list:async () => routeCandidates([source])},isActiveManagedAgent:async()=>true,now:()=>new Date(NOW) });
  const ids = [BOT,OTHER_BOT];
  const offers = await Promise.all(ids.map(id => service.list(OWNER,id)));
  const saved = await Promise.allSettled(ids.map((id,i) => service.grant(OWNER,id,offers[i]!.candidates[0]!.id)));
  expect(saved.filter(result=>result.status==="fulfilled")).toHaveLength(1);
  const records = await db.selectFrom("bot_resource_grants").selectAll().execute();
  expect(records).toHaveLength(1);
  const row = records[0]!;
  const other = row.bot_id === BOT ? OTHER_BOT : BOT;
  const chatId = other === BOT ? CHAT : "chat_other_reviewer";
  await db.insertInto("bot_resource_grants").values({...row,scope:JSON.stringify(row.scope),bot_id:other,chat_id:chatId,grant_id:"rgr_"+"a".repeat(32)}).execute();
  const active = vi.fn(async()=>true);
  const resolver = createSlackAgentRouteResolver({ownerId:OWNER,runtimeId:source.runtimeId,transact,isActiveManagedAgent:active});
  expect(await transact(OWNER,tx=>resolver.resolve({...source,userId:"U123",eventId:"Ev111",ts:"2100000000.000001",threadTs:"2100000000.000001",text:"hello"},tx.db))).toBeNull();
  expect(active).not.toHaveBeenCalled();
});

it("withdraws a routed job's publication authority when its saved Agent is archived", async () => {
  const { createSlackAgentRouteResolver, routedSlackPublicationCurrent } = await import("../../../packages/gateway/src/slack/agent-routes.js");
  const { routeCandidates } = await import("../../../packages/gateway/src/bots/resource-grant-candidates.js");
  const owner = { type:"personal" as const, ownerId:OWNER };
  const agent = await agents.create(owner, {clientRequestId:"req_archive_route",name:"Review",description:"Review changes",
    instructions:"Review proposed changes.",selection:{ instanceId:"hermes_default",model:"openai:gpt-5.6-sol" }});
  const chat = "chat_archivable";
  await insertChat(db,chat);
  await createBotBindingsRepository(db).bindDirect({ownerId:OWNER,botId:agent.id,chatId:chat,now:NOW});
  const source = {ownerId:OWNER,runtimeId:"runtime_test",appId:"A123",teamId:"T123",senderId:"U123",sourceId:"f".repeat(64),
    name:"reviews",channelId:"C001",installationGeneration:1};
  const transact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
  const active = async () => !(await agents.get(owner,agent.id))?.archived;
  const service = createBotResourceGrantService({transact,providers:{list:async()=>[REPO,...routeCandidates([source])]},isActiveManagedAgent:active,now:()=>new Date(NOW)});
  async function grant(label:string) {
    const view = await service.list(OWNER,agent.id);
    return service.grant(OWNER,agent.id,view.candidates.find(c=>c.label === label)!.id);
  }
  await grant(REPO.label); await grant("#reviews · Review pull requests");
  const resolver = createSlackAgentRouteResolver({ownerId:OWNER,runtimeId:source.runtimeId,transact,isActiveManagedAgent:active});
  const job = await transact(OWNER,tx=>resolver.resolve({...source,userId:"U123",eventId:"Ev012",ts:"2100000000.000001",threadTs:"2100000000.000001",text:"Review"},tx.db));
  expect(job).not.toBeNull();
  await agents.update(owner,agent.id,{baseRevision:agent.revision,archived:true});
  expect(await transact(OWNER,tx=>routedSlackPublicationCurrent(tx.db,job!))).toBe(false);
  const grants = await db.selectFrom("bot_resource_grants").select(["kind","revoked_at"]).where("bot_id","=",agent.id).execute();
  expect(grants).toContainEqual({kind:"github_repository",revoked_at:null});
});
