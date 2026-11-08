import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createRoutineDirectChatContexts } from "../../../packages/gateway/src/bots/routine-direct-chat-contexts.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { BOT, NOW, OTHER_OWNER, OWNER, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

const origin = { ownerId: OWNER, computerId: "computer_dev", sourceChatId: "chat_plain" };
const owner = { type: "personal" as const, ownerId: OWNER };
const signal = () => new AbortController().signal;
const postgres = process.env.MATRIX_TEST_POSTGRES_URL;
let fixture: Awaited<ReturnType<typeof createBotStateDatabase>>;
let home: string;
let agents: ChatAgentStore;
let repository: ChatRepository;
let ensureWorkspace: ReturnType<typeof vi.fn<(botId: string) => Promise<void>>>;

beforeEach(async () => {
  fixture = postgres ? await createRealBotStateDatabase(postgres) : await createBotStateDatabase();
  home = await mkdtemp(join(tmpdir(), "matrix-routine-direct-chat-"));
  const chatDb = fixture.db as unknown as Kysely<ChatDatabase>;
  agents = new ChatAgentStore({ homePath: home, db: chatDb });
  await agents.bootstrap();
  repository = new ChatRepository(chatDb);
  ensureWorkspace = vi.fn(async () => {});
  await insertChat(fixture.db, origin.sourceChatId);
});

afterEach(async () => {
  await agents?.close();
  await fixture?.destroy();
  if (home) await rm(home, { recursive: true, force: true });
});

const contexts = () => createRoutineDirectChatContexts({ db: fixture.db, agents, repository, ensureWorkspace, now: () => new Date(NOW) });
const read = (service = contexts(), scope = origin) => fixture.db.transaction().execute(trx => service.getWithin(trx, scope));

describe("private schedule execution context", () => {
  it("provisions a real private binding without a user Bot or preference and reuses it across retries", async () => {
    const service = contexts();
    expect(await agents.list(owner)).toEqual([]);
    expect(await read(service)).toBeNull();
    await service.ensure(origin, signal());
    const context = await read(service);
    expect(context).toEqual({ botId: expect.stringMatching(/^bot_routine/), chatId: expect.stringMatching(/^chat_routine_/) });
    expect(context?.chatId).not.toBe(origin.sourceChatId);
    expect(await agents.get(owner, context!.botId)).toMatchObject({ recipeRef: { recipeId: "matrix-routine-executor" }, archived: false });
    expect(await createBotBindingsRepository(fixture.db).directChatId({ ...origin, botId: context!.botId })).toBe(context!.chatId);
    await contexts().ensure(origin, signal());
    expect(await read()).toEqual(context);
    expect(ensureWorkspace).toHaveBeenCalledTimes(1);
  });

  // PGlite shares one session. Only native Postgres exercises two independent transactions.
  it.runIf(Boolean(postgres))("concurrent first invocations converge on the same reservation and do not publish it early", async () => {
    const service = contexts();
    let workspaceCalls = 0;
    let ready!: () => void, finish!: () => void;
    const bothReady = new Promise<void>(resolve => { ready = resolve; });
    const workspaceGate = new Promise<void>(resolve => { finish = resolve; });
    ensureWorkspace.mockImplementation(async () => {
      if (++workspaceCalls === 2) ready();
      await workspaceGate;
    });
    const attempts = Promise.all([service.ensure(origin, signal()), contexts().ensure(origin, signal())]);
    try {
      await Promise.race([bothReady, attempts]);
      expect(workspaceCalls).toBe(2);
      expect(await read()).toBeNull();
    } finally {
      finish();
      await attempts;
    }
    const context = (await read())!;
    expect(ensureWorkspace.mock.calls.map(([botId]) => botId)).toEqual([context.botId, context.botId]);
    expect(await agents.list(owner)).toEqual([]);
    expect(createBotRecipeCatalog().list()).not.toContainEqual(expect.objectContaining({ recipeId: "matrix-routine-executor" }));
  });

  it("keeps a failed provision inert, then finishes it with the reserved identity", async () => {
    const service = contexts();
    ensureWorkspace.mockRejectedValueOnce(new Error("disk temporarily unavailable"));
    await expect(service.ensure(origin, signal())).rejects.toMatchObject({ code: "unavailable" });
    expect(await read(service)).toBeNull();
    await contexts().ensure(origin, signal());
    expect(await read()).toMatchObject({ botId: ensureWorkspace.mock.calls[0]![0] });
    expect(ensureWorkspace.mock.calls[1]![0]).toBe(ensureWorkspace.mock.calls[0]![0]);
  });

  it("rejects foreign, aborted, and Bot-bound origins before provisioning", async () => {
    const service = contexts();
    await expect(service.ensure({ ...origin, ownerId: OTHER_OWNER }, signal())).rejects.toMatchObject({ code: "permission_denied" });
    await expect(service.ensure(origin, AbortSignal.abort())).rejects.toMatchObject({ code: "permission_denied" });
    await createBotBindingsRepository(fixture.db).bindDirect({ ...origin, botId: BOT, chatId: origin.sourceChatId, now: NOW });
    await expect(service.ensure(origin, signal())).rejects.toMatchObject({ code: "permission_denied" });
    expect(await read(service)).toBeNull();
    expect(ensureWorkspace).not.toHaveBeenCalled();
  });

  it("does not recreate a removed backing binding or authorize an archived origin", async () => {
    const service = contexts();
    await service.ensure(origin, signal());
    const context = (await read(service))!;
    expect(await read(service, { ...origin, computerId: "computer_other" })).toBeNull();
    await createBotBindingsRepository(fixture.db).remove({ ...origin, ...context, now: NOW });
    await expect(service.ensure(origin, signal())).rejects.toMatchObject({ code: "target_unavailable" });
    expect(await read(service)).toBeNull();
    await fixture.db.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", origin.sourceChatId).execute();
    await expect(service.ensure(origin, signal())).rejects.toMatchObject({ code: "permission_denied" });
    expect(ensureWorkspace).toHaveBeenCalledTimes(1);
  });
});
