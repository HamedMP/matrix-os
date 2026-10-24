import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import type { OwnerBotDatabase } from "../../packages/gateway/src/bots/database.js";
import { createBotInstantiation, ensureBotWorkspace } from "../../packages/gateway/src/bots/instantiation.js";
import { createBotRecipeCatalog, type BotRecipe } from "../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotOperationsRepository } from "../../packages/gateway/src/bots/repositories/operations.js";
import { InstantiateBotRequestSchema } from "@matrix-os/contracts";
import {
  MAX_GET_STARTED_BOT_ATTEMPTS,
  createGetStartedBotStatus,
  createGetStartedBots,
  getStartedBotFollowUpRequestId,
  getStartedBotRequestId,
} from "../../packages/gateway/src/get-started/bots.js";
import { OWNER, createBotStateDatabase } from "./bots/bot-state-support.js";

const scope = { type: "personal" as const, ownerId: OWNER };
const current = createBotRecipeCatalog().list().find((recipe) => recipe.recipeId === "writing-bot")!;
// The same recipe in a later release.
const next: BotRecipe = { ...current, version: "2026-12-01.1" };

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let home: string;
let chats: ChatRepository;
let agents: ChatAgentStore;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  home = await mkdtemp(join(tmpdir(), "matrix-get-started-bots-"));
  chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: db as unknown as Kysely<ChatDatabase> });
  await agents.bootstrap();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await agents.close();
  await destroy();
  await rm(home, { recursive: true, force: true });
});

/** One gateway release: its recipe catalog, sharing the owner's bot state with every other release. */
function release(recipes: BotRecipe[], fail: { definition?: boolean; workspaceOnce?: boolean } = {}) {
  let workspaceFailed = false;
  const catalog = createBotRecipeCatalog(recipes);
  const instantiation = createBotInstantiation({
    db,
    chats,
    agents: {
      createRecipeBot: (owner, input) => (fail.definition ? Promise.reject(new Error("disk full")) : agents.createRecipeBot(owner, input)),
      get: (owner, id) => agents.get(owner, id),
      count: (owner) => agents.count(owner),
    },
    recipes: catalog,
    ensureWorkspace: async (botId) => {
      if (fail.workspaceOnce && !workspaceFailed) {
        workspaceFailed = true;
        throw new Error("disk full");
      }
      await ensureBotWorkspace(home, botId);
    },
  });
  const services = { recipes: catalog, instantiation };
  return { ensure: createGetStartedBots(services), status: createGetStartedBotStatus(services) };
}

const firstAttempt = () => createBotOperationsRepository(db).get(OWNER, getStartedBotRequestId("writing-bot"));

describe("Get started bots", () => {
  it("creates a saved bot once, under its fixed request, and reports the bot it made", async () => {
    const { ensure, status } = release([current]);
    await expect(status(OWNER, "writing-bot")).resolves.toEqual({ status: "pending" });
    await ensure(OWNER, "writing-bot");
    await expect(status(OWNER, "writing-bot")).resolves.toEqual({ status: "created", agentId: (await firstAttempt())!.botId });
    await ensure(OWNER, "writing-bot");
    await expect(agents.count(scope)).resolves.toBe(1);
  });

  it("starts the bot again when its recipe changed before the first attempt wrote anything", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(release([current], { definition: true }).ensure(OWNER, "writing-bot")).rejects.toThrow();
    const after = release([next]);
    await expect(after.status(OWNER, "writing-bot")).resolves.toEqual({ status: "pending" });
    await after.ensure(OWNER, "writing-bot");
    const created = await after.status(OWNER, "writing-bot");
    if (created.status !== "created") throw new Error("not created");
    await expect(agents.get(scope, created.agentId)).resolves.toMatchObject({ recipeRef: { recipeId: "writing-bot", version: next.version } });
    await after.ensure(OWNER, "writing-bot");
    await expect(agents.count(scope)).resolves.toBe(1);
  });

  it("finishes an older attempt from its saved file instead of making a second bot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(release([current], { workspaceOnce: true }).ensure(OWNER, "writing-bot")).rejects.toThrow();
    const after = release([next]);
    await after.ensure(OWNER, "writing-bot");
    const first = (await firstAttempt())!;
    await expect(after.status(OWNER, "writing-bot")).resolves.toEqual({ status: "created", agentId: first.botId });
    await expect(agents.get(scope, first.botId)).resolves.toMatchObject({ recipeRef: { recipeId: "writing-bot", version: current.version } });
    await expect(agents.count(scope)).resolves.toBe(1);
  });

  it("keeps follow-up request IDs within the request ID limit, whatever the recipe", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const long: BotRecipe = { ...current, recipeId: "w".repeat(100) };
    await expect(release([long], { definition: true }).ensure(OWNER, long.recipeId)).rejects.toThrow();
    const after = release([{ ...long, version: next.version }]);
    await after.ensure(OWNER, long.recipeId);
    await expect(after.status(OWNER, long.recipeId)).resolves.toMatchObject({ status: "created" });
    expect(InstantiateBotRequestSchema.shape.clientRequestId.safeParse(getStartedBotFollowUpRequestId(`bot_${"a".repeat(64)}`)).success).toBe(true);
  });

  it("stops after a few attempts that could not be finished", async () => {
    let made = 0;
    const instantiation = {
      instantiate: vi.fn(async () => { throw new Error("not expected"); }),
      attempt: vi.fn(async () => ({ active: false, botId: `bot_${String(made += 1).padStart(8, "0")}`, payloadHash: "an older recipe" })),
      finishFromDefinition: vi.fn(async () => false),
    };
    const ensure = createGetStartedBots({ recipes: createBotRecipeCatalog([current]), instantiation });
    await expect(ensure(OWNER, "writing-bot")).rejects.toThrow("BotRetriesExhausted");
    expect(instantiation.attempt).toHaveBeenCalledTimes(MAX_GET_STARTED_BOT_ATTEMPTS);
    expect(instantiation.instantiate).not.toHaveBeenCalled();
  });
});
