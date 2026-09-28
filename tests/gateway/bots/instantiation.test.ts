import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { CreateChatAgentRequestSchema, UpdateChatAgentRequestSchema } from "@matrix-os/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import {
  BotInstantiationError,
  createBotInstantiation,
  ensureBotWorkspace,
  instantiationPayloadHash,
} from "../../../packages/gateway/src/bots/instantiation.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotOperationReconciler } from "../../../packages/gateway/src/bots/reconciliation.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotOperationsRepository } from "../../../packages/gateway/src/bots/repositories/operations.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import { OWNER, createBotStateDatabase, createRealBotStateDatabase } from "./bot-state-support.js";

const WRITING = { recipeId: "writing-bot", version: "2026-09-27.1" };
const request = (overrides: Record<string, unknown> = {}) => ({ clientRequestId: "req_instantiate_1", recipe: WRITING, ...overrides });
const scope = { type: "personal" as const, ownerId: OWNER };

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let home: string;
let chats: ChatRepository;
let agents: ChatAgentStore;
let clock: number;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  home = await mkdtemp(join(tmpdir(), "matrix-bot-instantiation-"));
  chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: db as unknown as Kysely<ChatDatabase> });
  await agents.bootstrap();
  clock = Date.parse("2026-09-28T10:00:00.000Z");
});
afterEach(async () => {
  await agents.close();
  await destroy();
  await rm(home, { recursive: true, force: true });
});

function setup(overrides: {
  agents?: Partial<Pick<ChatAgentStore, "createRecipeBot" | "get" | "count">>;
  chats?: Pick<ChatRepository, "withTransaction">;
  ensureWorkspace?: (botId: string) => Promise<void>;
  recipes?: ReturnType<typeof createBotRecipeCatalog>;
} = {}) {
  return createBotInstantiation({
    db,
    chats: overrides.chats ?? chats,
    agents: {
      createRecipeBot: (owner, input) => agents.createRecipeBot(owner, input),
      get: (owner, id) => agents.get(owner, id),
      count: (owner) => agents.count(owner),
      ...overrides.agents,
    },
    recipes: overrides.recipes ?? createBotRecipeCatalog(),
    ensureWorkspace: overrides.ensureWorkspace ?? ((botId) => ensureBotWorkspace(home, botId)),
    now: () => new Date(clock),
  });
}

async function operation() {
  return createBotOperationsRepository(db).get(OWNER, "req_instantiate_1");
}

/** Fails the wrapped step once, then behaves normally. */
function failOnce<Args extends unknown[], Result>(step: (...args: Args) => Promise<Result>) {
  let failed = false;
  return vi.fn(async (...args: Args) => {
    if (!failed) {
      failed = true;
      throw new Error("process crashed at /home/matrix/secret");
    }
    return step(...args);
  });
}

describe("bot instantiation", () => {
  it("creates the bot, its workspace, and its direct chat once per request", async () => {
    const instantiation = setup();
    const created = await instantiation.instantiate(OWNER, request({ name: "Essay Partner" }));
    expect(created).toMatchObject({ operation: "created", agent: { name: "Essay Partner", revision: 1, status: "active" } });
    const replayed = await instantiation.instantiate(OWNER, request({ name: "Essay Partner" }));
    expect(replayed).toEqual({ ...created, operation: "replayed" });

    const agent = await agents.get(scope, created.agent.id);
    expect(agent).toMatchObject({ recipeRef: WRITING, selection: MATRIX_BOT_SELECTION, description: expect.any(String) });
    expect(agent!.instructions).toContain("draft and revise writing");
    const chat = await chats.get(scope, created.chatId);
    expect(chat?.chat).toMatchObject({ id: created.chatId, title: "Essay Partner" });
    await expect(createBotBindingsRepository(db).directChatId({ ownerId: OWNER, botId: created.agent.id })).resolves.toBe(created.chatId);
    expect((await stat(join(home, "bots", created.agent.id))).isDirectory()).toBe(true);
    await expect(operation()).resolves.toMatchObject({ status: "active", botId: created.agent.id, chatId: created.chatId });
  });

  it("refuses another payload for the same request, unknown recipes, and malformed input", async () => {
    const instantiation = setup();
    await instantiation.instantiate(OWNER, request());
    await expect(instantiation.instantiate(OWNER, request({ name: "Other" }))).rejects.toEqual(new BotInstantiationError("conflict"));
    await expect(instantiation.instantiate(OWNER, request({ clientRequestId: "req_2", recipe: { recipeId: "writing-bot", version: "1999-01-01.1" } })))
      .rejects.toEqual(new BotInstantiationError("invalid_request"));
    await expect(instantiation.instantiate(OWNER, { ...request({ clientRequestId: "req_3" }), botId: "bot_chosenbyclient" }))
      .rejects.toEqual(new BotInstantiationError("invalid_request"));
  });

  it("refuses an owner at the bot limit without reserving anything", async () => {
    const instantiation = setup({ agents: { count: async () => 100 } });
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("rate_limited"));
    await expect(operation()).resolves.toBeUndefined();
  });

  it("finishes a creation interrupted at each step with the same IDs, and never deletes an edited bot", async () => {
    const createRecipeBot = failOnce((owner: typeof scope, input: Parameters<ChatAgentStore["createRecipeBot"]>[1]) => agents.createRecipeBot(owner, input));
    const ensureWorkspace = failOnce((botId: string) => ensureBotWorkspace(home, botId));
    const withTransaction = failOnce(<T>(work: (repository: ChatRepository) => Promise<T>) => chats.withTransaction(work));
    const instantiation = setup({ agents: { createRecipeBot }, ensureWorkspace, chats: { withTransaction } as never });

    // 1. Definition file.
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("unavailable"));
    const reserved = await operation();
    expect(reserved).toMatchObject({ status: "failed_recoverable", failureCode: "definition_failed", attempts: 1 });
    // 2. Workspace, after the file exists.
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("unavailable"));
    expect(await operation()).toMatchObject({ status: "failed_recoverable", failureCode: "workspace_failed", botId: reserved!.botId });
    // The owner edits the saved bot while its creation is unfinished.
    await agents.update(scope, reserved!.botId, { baseRevision: 1, name: "Renamed" });
    // 3. Activation: the chat, binding, and activation roll back together.
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("unavailable"));
    expect(await operation()).toMatchObject({ status: "failed_recoverable", failureCode: "activation_failed" });
    await expect(chats.get(scope, reserved!.chatId)).resolves.toBeNull();

    const finished = await instantiation.instantiate(OWNER, request());
    expect(finished).toMatchObject({ operation: "replayed", chatId: reserved!.chatId, agent: { id: reserved!.botId, name: "Renamed", revision: 2 } });
    // One bot, kept with the owner's edit; retries never wrote a second definition.
    expect(await agents.count(scope)).toBe(1);
    expect(createRecipeBot).toHaveBeenCalledTimes(4);
  });

  it("recreates a workspace that disappeared before activation", async () => {
    const operations = createBotOperationsRepository(db);
    const { operation } = await operations.reserve({
      ownerId: OWNER, clientRequestId: "req_instantiate_1", payloadHash: instantiationPayloadHash(request()), now: new Date(clock).toISOString(),
    });
    // A process that stopped right after recording `file_created`, whose workspace was then removed.
    await agents.createRecipeBot(scope, {
      id: operation.botId, createHash: instantiationPayloadHash(request()),
      fields: { name: "Writing Bot", description: "", instructions: "Revise.", selection: MATRIX_BOT_SELECTION }, recipeRef: WRITING,
    });
    await ensureBotWorkspace(home, operation.botId);
    await operations.markFileCreated({ ownerId: OWNER, clientRequestId: "req_instantiate_1", baseRevision: operation.revision, now: new Date(clock).toISOString() });
    await rm(join(home, "bots", operation.botId), { recursive: true });

    const finished = await setup().instantiate(OWNER, request());
    expect(finished).toMatchObject({ operation: "replayed", agent: { id: operation.botId } });
    expect((await stat(join(home, "bots", operation.botId))).isDirectory()).toBe(true);
  });

  it("answers a duplicate that loses the race with the bot the other request finished", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const instantiation = setup({
      ensureWorkspace: async (botId) => {
        // The first request stops before recording `file_created`; the duplicate finishes meanwhile.
        if (calls++ === 0) await gate;
        await ensureBotWorkspace(home, botId);
      },
    });
    const first = instantiation.instantiate(OWNER, request());
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await instantiation.instantiate(OWNER, request());
    expect(second.operation).toBe("replayed");
    release();
    const finished = await first;
    expect(finished).toEqual({ ...second, operation: "created" });
    expect(await agents.count(scope)).toBe(1);
    await expect(operation()).resolves.toMatchObject({ status: "active", attempts: 0 });
  });

  it.runIf(process.env.MATRIX_TEST_POSTGRES_URL)("answers truly concurrent duplicates with one bot (real Postgres)", async () => {
    const real = await createRealBotStateDatabase();
    const realChats = new ChatRepository(real.db as unknown as Kysely<ChatDatabase>);
    const realAgents = new ChatAgentStore({ homePath: home, db: real.db as unknown as Kysely<ChatDatabase> });
    await realAgents.bootstrap();
    try {
      const instantiation = createBotInstantiation({
        db: real.db, chats: realChats, agents: realAgents, recipes: createBotRecipeCatalog(),
        ensureWorkspace: (botId) => ensureBotWorkspace(home, botId),
      });
      const results = await Promise.all([1, 2, 3].map(() => instantiation.instantiate(OWNER, request())));
      expect(new Set(results.map((result) => result.agent.id)).size).toBe(1);
      expect(new Set(results.map((result) => result.chatId)).size).toBe(1);
      expect(results.filter((result) => result.operation === "created")).toHaveLength(1);
      expect(await realAgents.count(scope)).toBe(1);
    } finally {
      await realAgents.close();
      await real.destroy();
    }
  });

  it("replays a created bot after its recipe version is retired", async () => {
    const created = await setup().instantiate(OWNER, request());
    const retired = createBotRecipeCatalog([]);
    await expect(setup({ recipes: retired }).instantiate(OWNER, request())).resolves.toEqual({ ...created, operation: "replayed" });
    await expect(setup({ recipes: retired }).instantiate(OWNER, request({ clientRequestId: "req_new" })))
      .rejects.toEqual(new BotInstantiationError("invalid_request"));
  });

  it("reuses only an empty workspace directory for a retried creation", async () => {
    await ensureBotWorkspace(home, "bot_aaaaaaaaaaaaaaaaaaaaaaaa");
    await expect(ensureBotWorkspace(home, "bot_aaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBeUndefined();
    await writeFile(join(home, "bots", "bot_aaaaaaaaaaaaaaaaaaaaaaaa", "notes.md"), "used");
    await expect(ensureBotWorkspace(home, "bot_aaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toEqual(new BotInstantiationError("unavailable"));
    await mkdir(join(home, "elsewhere"));
    await symlink(join(home, "elsewhere"), join(home, "bots", "bot_bbbbbbbbbbbbbbbbbbbbbbbb"));
    await expect(ensureBotWorkspace(home, "bot_bbbbbbbbbbbbbbbbbbbbbbbb")).rejects.toThrow();
  });

  it("keeps recipeRef server-owned: clients cannot write it on create or update", () => {
    const fields = { name: "Mine", instructions: "Help", selection: MATRIX_BOT_SELECTION };
    expect(CreateChatAgentRequestSchema.safeParse({ ...fields, clientRequestId: "req_client_1", recipeRef: WRITING }).success).toBe(false);
    expect(UpdateChatAgentRequestSchema.safeParse({ baseRevision: 1, recipeRef: WRITING }).success).toBe(false);
  });

  it("hashes the normalized payload, not the request ID", () => {
    expect(instantiationPayloadHash({ recipe: WRITING })).toBe(instantiationPayloadHash({ recipe: { version: WRITING.version, recipeId: WRITING.recipeId } }));
    expect(instantiationPayloadHash({ recipe: WRITING })).not.toBe(instantiationPayloadHash({ recipe: WRITING, name: "A" }));
  });
});

describe("bot creation reconciliation", () => {
  it("finishes stale creations that have a definition and parks those that do not", async () => {
    const ensureWorkspace = failOnce((botId: string) => ensureBotWorkspace(home, botId));
    const instantiation = setup({ ensureWorkspace });
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("unavailable"));
    // A creation that crashed before writing its file: nothing to finish it from.
    await createBotOperationsRepository(db).reserve({
      ownerId: OWNER, clientRequestId: "req_orphan", payloadHash: "a".repeat(64), now: new Date(clock).toISOString(),
    });
    clock += 5 * 60_000;
    const reconciler = createBotOperationReconciler({
      operations: createBotOperationsRepository(db), instantiation, now: () => new Date(clock), intervalMs: 60_000,
    });
    await reconciler.start();
    await reconciler.stop();

    const finished = await operation();
    expect(finished).toMatchObject({ status: "active" });
    await expect(chats.get(scope, finished!.chatId)).resolves.not.toBeNull();
    await expect(createBotOperationsRepository(db).get(OWNER, "req_orphan"))
      .resolves.toMatchObject({ status: "failed_recoverable", failureCode: "definition_missing", attempts: 1 });
  });

  it("stops retrying a creation after five failed attempts", async () => {
    const resume = vi.fn(async () => { throw new Error("still failing"); });
    const operations = createBotOperationsRepository(db);
    const { operation: reserved } = await operations.reserve({ ownerId: OWNER, clientRequestId: "req_x", payloadHash: "b".repeat(64), now: new Date(clock).toISOString() });
    let current = reserved;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      current = await operations.markFailed({ ownerId: OWNER, clientRequestId: "req_x", baseRevision: current.revision, failureCode: "activation_failed", now: new Date(clock).toISOString() });
    }
    clock += 5 * 60_000;
    const reconciler = createBotOperationReconciler({ operations, instantiation: { resume }, now: () => new Date(clock) });
    await reconciler.runOnce();
    expect(resume).not.toHaveBeenCalled();
  });
});
