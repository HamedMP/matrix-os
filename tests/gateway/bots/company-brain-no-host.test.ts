import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { startBots, type BotServices } from "../../../packages/gateway/src/startup/bots.js";
import { BOT, OWNER, createBotStateDatabase } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let home: string;
let agents: ChatAgentStore;
let repository: ChatRepository;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  home = await mkdtemp(join(tmpdir(), "matrix-bot-no-host-"));
  repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely });
  await agents.bootstrap();
});
afterEach(async () => {
  await agents.close();
  await destroy();
  await rm(home, { recursive: true, force: true });
});

async function start(available: boolean): Promise<BotServices> {
  const host = {
    available, client: { runBot: vi.fn(), stopRuntime: vi.fn(), createRuntime: vi.fn() },
    registerAuthorizer: vi.fn(() => vi.fn()), close: vi.fn(),
  };
  const services = await startBots({
    homePath: home, repository, agents, executionRoots: { resolve: vi.fn() } as never,
    providers: { getSnapshot: vi.fn() } as never, host: host as never,
  });
  if (!services) throw new Error("bots did not start");
  return services;
}

function routes(services: BotServices) {
  return new Hono().route("/", createBotRoutes({
    recipes: services.recipes, botChats: services.botChats, ...(services.threads ? { threads: services.threads } : {}),
    getPrincipal: () => ({ userId: OWNER, source: "jwt" }),
  }));
}

describe("brain chat with no runtime host", () => {
  it("offers no thread recipe and answers unavailable from the thread routes, so no thread is ever made", async () => {
    const services = await start(false);
    try {
      expect(services.threads).toBeUndefined();
      const ids = services.recipes.list().map((recipe) => recipe.recipeId);
      expect(ids).not.toContain("company-brain");
      expect(ids.length).toBeGreaterThan(0);
      // An existing Bot keeps its recipe version.
      expect(services.recipes.resolve({ recipeId: "company-brain", version: "2026-10-08.1" }).recipeId).toBe("company-brain");
      const app = routes(services);
      const lookup = await app.request("/api/chat-agents/bot-recipes?recipeId=company-brain");
      expect(lookup.status).toBe(200);
      expect(await lookup.json()).toEqual({ recipes: [] });
      const created = await app.request(`/api/chat-agents/${BOT}/threads`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientRequestId: "req_nohost", projectId: "proj_brain01" }),
      });
      expect(created.status).toBe(503);
      expect((await app.request(`/api/chat-agents/${BOT}/threads?projectId=proj_brain01`)).status).toBe(503);
      expect(await db.selectFrom("chats").select("id").execute()).toEqual([]);
    } finally {
      await services.close();
    }
  });

  it("serves the recipe and the thread routes once a host can run them", async () => {
    const services = await start(true);
    try {
      expect(services.threads).toBeDefined();
      const lookup = await routes(services).request("/api/chat-agents/bot-recipes?recipeId=company-brain");
      expect(await lookup.json()).toEqual({ recipes: [expect.objectContaining({ recipeId: "company-brain" })] });
    } finally {
      await services.close();
    }
  });
});
