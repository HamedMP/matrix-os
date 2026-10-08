import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { ChatAgentContext, chatContextRequestHash } from "../../../packages/gateway/src/chat/agent-context.js";
import { createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { MissingRequestPrincipalError } from "../../../packages/gateway/src/request-principal.js";
import { OWNER, createBotStateDatabase } from "./bot-state-support.js";

const owner = { type: "personal" as const, ownerId: OWNER };
const input = { clientRequestId: "req_custom_one", name: "Signal Brief", description: "My saved bot", instructions: "Preserve these instructions.", selection: { instanceId: "codex_default", model: "gpt-5.6-sol", options: [{ id: "reasoningEffort", value: "high" }] } };
let home: string, agents: ChatAgentStore, repository: ChatRepository, destroy: () => Promise<void>;
beforeEach(async () => {
  const state = await createBotStateDatabase(); destroy = state.destroy;
  repository = new ChatRepository(state.db as unknown as Kysely<ChatDatabase>);
  home = await mkdtemp(join(tmpdir(), "matrix-custom-bot-"));
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely }); await agents.bootstrap();
});
afterEach(async () => { await agents.close(); await destroy(); await rm(home, { recursive: true, force: true }); });
const service = () => createCustomBotChats({ chats: repository, agents });
const files = async (directory: string): Promise<string[]> => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();

describe("dedicated custom Bot entry", () => {
  it("automatically creates one stable owned identity without changing definitions or historical Chats", async () => {
    const bot = await agents.create(owner, input);
    const paths = await files(home); const before = await Promise.all(paths.map(path => readFile(path, "utf8")));
    const historical = await repository.create(owner, { id: "chat_history", clientRequestId: "req_history", title: "Mixed history" });
    expect(await service().directChat(owner, bot.id)).toBeNull();
    const chatId = await service().ensureDirectChat(owner, bot.id);
    expect(await service().ensureDirectChat(owner, bot.id)).toBe(chatId);
    expect(await service().directChat(owner, bot.id)).toBe(chatId);
    expect(await service().directBot(owner, chatId)).toBe(bot.id);
    expect(await Promise.all(paths.map(path => readFile(path, "utf8")))).toEqual(before);
    expect(await agents.get(owner, bot.id)).toEqual(bot);
    expect(await repository.get(owner, historical.chat.id)).toEqual(historical);
    expect((await repository.get(owner, chatId))?.chat.currentSelection).toEqual(bot.selection);
    const bindings = await repository.kysely.selectFrom("bot_chat_bindings" as never).selectAll().execute(); expect(bindings).toHaveLength(1);
    const events = await repository.kysely.selectFrom("chat_outbox").selectAll().where("chat_id", "=", chatId).execute();
    expect(events.filter(event => event.event_type === "bot.created")).toHaveLength(1);
    const renamed = await agents.update(owner, bot.id, { baseRevision: bot.revision, name: "Changed name" });
    expect(await service().ensureDirectChat(owner, renamed.id)).toBe(chatId);
    const duplicate = await agents.create(owner, { ...input, clientRequestId: "req_custom_two" });
    expect(await service().ensureDirectChat(owner, duplicate.id)).not.toBe(chatId);
  });
  it("refuses foreign, archived, and removed conversations rather than replacing their identity", async () => {
    const bot = await agents.create(owner, input); const botChats = service();
    await expect(botChats.ensureDirectChat({ ...owner, ownerId: "other_owner" }, bot.id)).rejects.toMatchObject({ code: "not_found" });
    const chatId = await botChats.ensureDirectChat(owner, bot.id);
    await repository.kysely.updateTable("chats").set({ lifecycle: "archived" }).where("id", "=", chatId).execute();
    await expect(botChats.ensureDirectChat(owner, bot.id)).rejects.toMatchObject({ code: "conflict" });
    await agents.update(owner, bot.id, { baseRevision: 1, archived: true });
    await expect(botChats.ensureDirectChat(owner, bot.id)).rejects.toMatchObject({ code: "not_found" });
  });
  it.each(["request key", "deterministic ID"])("refuses a preexisting ordinary Chat occupying the custom %s", async (collision) => {
    const bot = await agents.create(owner, input);
    const digest = createHash("sha256").update(JSON.stringify(["custom-direct-v1", owner.ownerId, bot.id])).digest("hex");
    const historical = await repository.create(owner, {
      id: collision === "deterministic ID" ? `chat_${digest}` : "chat_ordinary_history",
      clientRequestId: collision === "request key" ? `req_${digest}` : "req_ordinary_history",
      title: "Keep ordinary history",
    });
    await expect(service().ensureDirectChat(owner, bot.id)).rejects.toMatchObject({ code: "conflict" });
    expect(await repository.get(owner, historical.chat.id)).toEqual(historical);
    expect(await service().directBot(owner, historical.chat.id)).toBeNull();
    expect(await repository.kysely.selectFrom("chats").selectAll().execute()).toHaveLength(1);
  });
  it.each(["deleted Chat", "removed binding"])("does not resurrect a %s when reopened", async (removal) => {
    const bot = await agents.create(owner, input);
    const chatId = await service().ensureDirectChat(owner, bot.id);
    if (removal === "deleted Chat") {
      await repository.hardDelete(owner, { chatId, clientRequestId: "req_delete_bot" });
    } else {
      await sql`UPDATE bot_chat_bindings SET removed_at = now() WHERE owner_id = ${owner.ownerId} AND bot_id = ${bot.id}`.execute(repository.kysely);
    }
    await expect(service().ensureDirectChat(owner, bot.id)).rejects.toMatchObject({ code: "conflict" });
    expect(await service().directChat(owner, bot.id)).toBeNull();
    expect(await agents.get(owner, bot.id)).toEqual(bot);
    expect(await repository.kysely.selectFrom("chats").selectAll().execute()).toHaveLength(removal === "deleted Chat" ? 0 : 1);
  });
  it("rolls back canonical Chat and outbox if binding fails", async () => {
    const bot = await agents.create(owner, input);
    const broken = createCustomBotChats({ chats: repository, agents, bindDirect: async () => { throw new Error("binding failed"); } });
    await expect(broken.ensureDirectChat(owner, bot.id)).rejects.toThrow("binding failed");
    expect(await repository.kysely.selectFrom("chats").selectAll().execute()).toHaveLength(0);
    expect(await repository.kysely.selectFrom("chat_outbox").selectAll().execute()).toHaveLength(0);
    expect(await service().ensureDirectChat(owner, bot.id)).toMatch(/^chat_/);
  });
  it("bounds and authenticates explicit open while GET remains pure", async () => {
    const bot = await agents.create(owner, input); const botChats = service();
    const app = (signed = true) => new Hono().route("/", createBotRoutes({ botChats, getPrincipal: () => { if (!signed) throw new MissingRequestPrincipalError(); return { userId: OWNER, source: "jwt" } as never; } }));
    const endpoint = `/api/chat-agents/${bot.id}/direct-chat`;
    expect(await (await app().request(endpoint)).json()).toEqual({ chatId: null });
    expect((await app(false).request(endpoint, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await app().request(endpoint, { method: "POST", body: '{"ownerId":"other_owner"}' })).status).toBe(400);
    expect((await app().request(endpoint, { method: "POST", body: "x".repeat(65537) })).status).toBe(413);
    const response = await app().request(endpoint, { method: "POST", body: "{}" });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ chatId: await botChats.directChat(owner, bot.id) });
  });
  it("server resolves custom executor, instructions and permission without trusting a client model", async () => {
    const bot = await agents.create(owner, input); const botChats = service(); const chatId = await botChats.ensureDirectChat(owner, bot.id);
    const context = new ChatAgentContext({ repository, agents, enabled: () => true, botChats });
    const request = { clientRequestId: "req_turn", baseRevision: 0, parts: [{ type: "text" as const, text: "Read only" }], selection: { instanceId: "matrix_bot", model: "auto" }, interactionMode: "default", permissionMode: "supervised" };
    const prepared = await context.prepare(owner, chatId, request);
    expect(prepared.selection).toEqual(bot.selection); expect(prepared.permissionMode).toBe("supervised");
    expect(prepared.context?.agent).toMatchObject({ id: bot.id, revision: 1, instructions: bot.instructions });
    expect(prepared.context?.requestHash).toBe(chatContextRequestHash(request));
    await expect(context.prepare(owner, chatId, { ...request, parts: [...request.parts, { type: "resource_reference", resource: { kind: "agent", id: "bot_alternate", label: "Forged" } }] })).rejects.toMatchObject({ code: "context_unavailable" });
    await expect(context.prepare(owner, chatId, { ...request, permissionMode: "full_access" })).rejects.toMatchObject({ code: "context_unavailable" });
    const consent = { type: "resource_reference" as const, resource: { kind: "agent" as const, id: bot.id, label: bot.name, revision: String(bot.revision) } };
    expect((await context.prepare(owner, chatId, { ...request, permissionMode: "full_access", parts: [...request.parts, consent] })).permissionMode).toBe("full_access");
    await agents.update(owner, bot.id, { baseRevision: 1, instructions: "Changed while queued" });
    await expect(context.prepare(owner, chatId, { ...request, permissionMode: "full_access", parts: [...request.parts, consent] })).rejects.toMatchObject({ code: "context_unavailable" });
    await expect(context.revalidate(owner, chatId, prepared.context)).rejects.toMatchObject({ code: "context_unavailable" });
  });
});
