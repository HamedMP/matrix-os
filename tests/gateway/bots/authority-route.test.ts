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

function authority(inventory: () => Promise<Array<{ connectionId: string; service: string; label: string }>>) {
  return createBotAuthority({
    transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
    agents: { get: vi.fn(async (_owner, id) => (id === BOT ? { id: BOT, revision: 7, recipeRef: { recipeId: "brief", version: "1" } } : null) as never) },
    recipes: createBotRecipeCatalog([RECIPE]),
    client: { inventory: vi.fn(inventory) } as never,
    now: () => new Date("2026-09-28T10:00:00.000Z"),
  });
}

describe("bot authority view", () => {
  it("matches server state: grants, service states, open requests, and memory, with no account IDs", async () => {
    const view = await authority(async () => [
      { connectionId: "conn_work", service: "gmail", label: "Work" },
      { connectionId: "conn_cal", service: "google_calendar", label: "Calendar" },
    ]).view(OWNER, BOT);
    expect(view).toMatchObject({
      agentId: BOT, revision: 7, routines: [],
      grants: [{ service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
      connections: [
        { service: "gmail", state: "granted" },
        { service: "google_calendar", state: "connected_not_granted" },
        { service: "slack", state: "not_connected" },
      ],
      pendingInteractions: [{ kind: "question", chatId: "chat_authority1", expiresAt: "2026-09-29T09:00:00.000Z" }],
      memory: { items: [expect.objectContaining({ kind: "preference", content: "Prefers short briefs.", confirmed: true })] },
    });
    expect(JSON.stringify(view)).not.toContain("conn_");
  });

  it("claims nothing it cannot see when the inventory is unavailable", async () => {
    const view = await authority(async () => { throw new BotIntegrationError("unavailable"); }).view(OWNER, BOT);
    expect(view.connections).toEqual([{ service: "gmail", state: "granted" }]);
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
