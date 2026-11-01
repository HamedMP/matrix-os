import type { Kysely } from "kysely";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotAuthorityError, createBotAuthority } from "../../../packages/gateway/src/bots/authority.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotIntegrationError } from "../../../packages/gateway/src/bots/integration-client.js";
import { createBotRecipeCatalog, type BotRecipe } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotMemoryRepository } from "../../../packages/gateway/src/bots/repositories/memory.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const AT = "2026-09-28T09:00:00.000Z";
const RECIPE: BotRecipe = {
  recipeId: "brief", version: "1", name: "Brief", description: "Brief.", instructions: "Brief.",
  capabilities: ["integration.inventory"],
  integrations: [
    { service: "gmail", effects: ["read"], required: true },
    { service: "google_calendar", effects: ["read"], required: true },
    { service: "slack", effects: ["read"], required: false },
  ],
  output: "A brief.",
};
let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_authority1");
  await createBotGrantsRepository(db).grant({
    ownerId: OWNER, botId: BOT, service: "gmail", connectionId: "conn_work", accountLabel: "Work", effects: ["read"],
    audience: "direct", grantedByActorId: OWNER, now: AT,
  });
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_authority1", now: AT });
  await createBotInteractionsRepository(db).create({
    ownerId: OWNER, botId: BOT, chatId: "chat_authority1", taskId: task.taskId, kind: "question",
    payload: { kind: "question" }, responderActorId: OWNER, blocking: true, expiresAt: "2026-09-29T09:00:00.000Z", now: AT,
  });
  await createBotMemoryRepository(db).remember({
    ownerId: OWNER, botId: BOT, kind: "preference", scope: "bot", content: "Prefers short briefs.",
    source: { at: AT }, confirmed: true, now: AT,
  });
});
afterEach(async () => destroy());

function authority(inventory: () => Promise<Array<{ connectionId: string; service: string; label: string; email?: string | null }>>, recipe = RECIPE) {
  return createBotAuthority({
    transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
    agents: { get: vi.fn(async (_owner, id) => (id === BOT ? { id: BOT, revision: 7, recipeRef: { recipeId: "brief", version: "1" } } : null) as never) },
    recipes: createBotRecipeCatalog([recipe]),
    client: { inventory: vi.fn(inventory) } as never,
    now: () => new Date("2026-09-28T10:00:00.000Z"),
  });
}

describe("bot authority view", () => {
  it("keeps X app access available when its registry logo is a local asset", async () => {
    const recipe = { ...RECIPE, integrations: [{ service: "twitter", effects: ["read"] as const, required: true }] };
    const view = await authority(async () => [], recipe).view(OWNER, BOT);
    expect(view.connections).toEqual([{ service: "twitter", serviceName: "X", state: "not_connected", accounts: [] }]);
  });

  it("reports and displays a usable grant beyond the ten-account display limit", async () => {
    const connected = Array.from({ length: 10 }, (_, index) => ({ connectionId: `conn_extra_${index}`, service: "gmail", label: `Extra ${index}` }));
    connected.push({ connectionId: "conn_work", service: "gmail", label: "Work" });
    const view = await authority(async () => connected).view(OWNER, BOT);
    expect(view.connections[0]).toMatchObject({ state: "granted" });
    expect(view.connections[0]?.accounts).toHaveLength(10);
    expect(view.connections[0]?.accounts).toContainEqual(expect.objectContaining({ label: "Work", state: "granted" }));
  });

  it("gives duplicate account labels stable distinct display keys without exposing connection IDs", async () => {
    const view = await authority(async () => [
      { connectionId: "conn_first", service: "gmail", label: "Gmail" },
      { connectionId: "conn_second", service: "gmail", label: "Gmail" },
    ]).view(OWNER, BOT);
    const accounts = view.connections[0]?.accounts ?? [];
    expect(accounts.map(account => account.displayKey)).toEqual([expect.stringMatching(/^acct_[a-f0-9]{24}$/), expect.stringMatching(/^acct_[a-f0-9]{24}$/)]);
    expect(accounts[0]?.displayKey).not.toBe(accounts[1]?.displayKey);
    expect(JSON.stringify(view)).not.toContain("conn_");
  });

  it("matches server state: grants, service states, open requests, and memory, with no account IDs", async () => {
    const view = await authority(async () => [
      { connectionId: "conn_work", service: "gmail", label: "Work" },
      { connectionId: "conn_cal", service: "google_calendar", label: "Calendar", email: "owner@example.test" },
    ]).view(OWNER, BOT);
    expect(view).toMatchObject({
      agentId: BOT, revision: 7, routines: [],
      grants: [{ service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
      connections: [
        { service: "gmail", serviceName: "Gmail", logoUrl: expect.stringMatching(/^https:\/\//), state: "granted",
          accounts: [{ label: "Work", email: null, state: "granted" }] },
        { service: "google_calendar", serviceName: "Google Calendar", logoUrl: expect.stringMatching(/^https:\/\//), state: "connected_not_granted",
          accounts: [{ label: "Calendar", email: "owner@example.test", state: "connected_not_granted" }] },
        { service: "slack", serviceName: "Slack", logoUrl: expect.stringMatching(/^https:\/\//), state: "not_connected", accounts: [] },
      ],
      pendingInteractions: [{ kind: "question", chatId: "chat_authority1", expiresAt: "2026-09-29T09:00:00.000Z" }],
      memory: { items: [expect.objectContaining({ kind: "preference", content: "Prefers short briefs.", confirmed: true })] },
    });
    expect(JSON.stringify(view)).not.toContain("conn_");
  });

  it("does not present a disconnected grant as usable bot access", async () => {
    const view = await authority(async () => [
      { connectionId: "conn_personal", service: "gmail", label: "Personal", email: "personal@example.test" },
    ]).view(OWNER, BOT);
    expect(view.connections[0]).toMatchObject({
      service: "gmail", state: "connected_not_granted",
      accounts: [{ label: "Personal", email: "personal@example.test", state: "connected_not_granted" }],
    });
  });

  it("claims nothing it cannot see when the inventory is unavailable", async () => {
    const view = await authority(async () => { throw new BotIntegrationError("unavailable"); }).view(OWNER, BOT);
    expect(view.connections).toEqual([expect.objectContaining({
      service: "gmail", serviceName: "Gmail", state: "granted", accounts: [],
    })]);
  });

  it("shows all 65 live grants within the repository's 100 grant bound", async () => {
    for (let index = 0; index < 64; index += 1) {
      await createBotGrantsRepository(db).grant({
        ownerId: OWNER, botId: BOT, service: "gmail", connectionId: `conn_extra_${index}`, accountLabel: `Extra ${index}`,
        effects: ["read"], audience: "direct", grantedByActorId: OWNER, now: AT,
      });
    }
    const view = await authority(async () => []).view(OWNER, BOT);
    expect(view.grants).toHaveLength(65);
  });

  it("refuses unknown bots and malformed IDs, and serves the route privately", async () => {
    const service = authority(async () => []);
    await expect(service.view(OWNER, "bot_ffffffffffffffffffffffff")).rejects.toEqual(new BotAuthorityError("not_found"));
    await expect(service.view(OWNER, "nope")).rejects.toEqual(new BotAuthorityError("invalid_request"));
    const app = new Hono();
    app.route("/", createBotRoutes({ authority: service, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) as never }));
    const ok = await app.request(`/api/chat-agents/${BOT}/authority`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect((await app.request("/api/chat-agents/bot_ffffffffffffffffffffffff/authority")).status).toBe(404);
    const bare = new Hono();
    bare.route("/", createBotRoutes({ getPrincipal: () => ({ userId: OWNER, source: "jwt" }) as never }));
    expect((await bare.request(`/api/chat-agents/${BOT}/authority`)).status).toBe(503);
  });

  it("rejects a malformed authority path before calling the service", async () => {
    const view = vi.fn();
    const app = new Hono();
    app.route("/", createBotRoutes({ authority: { view }, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) as never }));
    expect((await app.request("/api/chat-agents/wrong/authority")).status).toBe(400);
    expect(view).not.toHaveBeenCalled();
  });
});

it("projects durable active and paused routines and hides archived workflows",async()=>{
 const {createBotBindingsRepository}=await import("../../../packages/gateway/src/bots/repositories/bindings.js");
 const {createBotRoutinesRepository}=await import("../../../packages/gateway/src/bots/repositories/routines.js");
 await createBotBindingsRepository(db).bindDirect({ownerId:OWNER,botId:BOT,chatId:"chat_authority1",now:AT});
 const repo=createBotRoutinesRepository(db),r=await repo.create({ownerId:OWNER,botId:BOT,chatId:"chat_authority1",proposal:{name:"Fixture status",prompt:"Read fixture",schedule:{kind:"interval",everyMs:60000},selection:{instanceId:"matrix_chatgpt_plan",model:"fixture"},authorizedEffects:["read"]},nextFireAt:"2026-09-28T10:01:00.000Z",now:AT});
 expect((await authority(async()=>[]).view(OWNER,BOT)).routines).toEqual([{routineId:r.routineId,summary:"Fixture status",status:"active",nextFireAt:r.nextFireAt}]);
 const paused=await repo.control({ownerId:OWNER,routineId:r.routineId,baseRevision:r.revision,status:"paused",now:AT});expect((await authority(async()=>[]).view(OWNER,BOT)).routines[0].status).toBe("paused");
 await repo.control({ownerId:OWNER,routineId:r.routineId,baseRevision:paused.revision,status:"archived",now:AT});expect((await authority(async()=>[]).view(OWNER,BOT)).routines).toEqual([]);
});
