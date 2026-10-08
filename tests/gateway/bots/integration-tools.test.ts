import { mkdtemp, readdir, readFile, rename, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createBotWorkspace, resolveBotWorkspaceRoot } from "../../../packages/gateway/src/chat/bot-workspace-root.js";
import { Hono } from "hono";
import { createIntegrationRoutes } from "../../../packages/gateway/src/integrations/routes.js";
import { createIntegrationReadCallRoutes } from "../../../packages/gateway/src/integrations/read-call.js";
import type { PlatformDb } from "../../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../../packages/gateway/src/integrations/pipedream.js";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { BotToolRequestSchema, BotToolResultSchema } from "@matrix-os/contracts";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import { createBotAccessHandlers } from "../../../packages/gateway/src/bots/access-handlers.js";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions, type BotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotIntegrationError, createBotIntegrationClient, type BotIntegrationConnection } from "../../../packages/gateway/src/bots/integration-client.js";
import { approvalDigest, createBotIntegrationTools, effectOf } from "../../../packages/gateway/src/bots/integration-tools.js";
import { createBotInteractionService } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotRecipeCatalog, type BotRecipe } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_integrations1";
const AT = "2026-09-28T09:00:00.000Z";
const RECIPE: BotRecipe = {
  recipeId: "mail-helper", version: "1", name: "Mail Helper", description: "Helps with mail.", instructions: "Help with mail.",
  capabilities: ["integration.inventory", "integration.call", "interaction.create"],
  integrations: [
    { service: "gmail", effects: ["read", "send"], required: true },
    { service: "google_calendar", effects: ["read"], required: false },
  ],
  output: "A reply.",
};
const WORK: BotIntegrationConnection = { connectionId: "conn_work", service: "gmail", label: "Work" };
const HOME: BotIntegrationConnection = { connectionId: "conn_home", service: "gmail", label: "Home" };

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let binding: BotRuntimeBinding;
let connected: BotIntegrationConnection[];
let toolClock: Date;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: AT });
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: AT });
  binding = {
    runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task.taskId,
    runId: "run_mail1", rootFingerprint: "f".repeat(64),
    route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 },
    accessSourceId: "matrix_included", capabilities: ["integration.inventory", "integration.call"], requestClass: "interactive",
  };
  connected = [WORK];
  toolClock = new Date("2026-09-28T10:00:00.000Z");
});
afterEach(async () => destroy());

function setup(call = vi.fn(async () => ({ data: { threads: [{ id: "t1", subject: "Hello" }] }, summary: "1 thread" })), beforeTransaction?: (number: number) => Promise<void>, assertSource?: (binding: BotRuntimeBinding, signal?: AbortSignal) => Promise<void>, homePath?: string) {
  const baseTransact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
  let transactions = 0;
  const transact: BotStateTransactions = async (ownerId, work) => {
    await beforeTransaction?.(++transactions);
    return baseTransact(ownerId, work);
  };
  const client = { inventory: vi.fn(async () => connected), call };
  const tools = createBotIntegrationTools({
    client, transact, ...(homePath ? { homePath } : {}), recipes: createBotRecipeCatalog([RECIPE]), assertSource,
    agents: { get: vi.fn(async () => ({ id: BOT, recipeRef: { recipeId: "mail-helper", version: "1" } }) as never) },
    now: () => toolClock,
  });
  const interactions = createBotInteractionService({ transact, handlers: createBotAccessHandlers({ tools, now: () => toolClock }), now: () => toolClock });
  return { tools, client, call, interactions };
}

async function grant(connection: BotIntegrationConnection, effects: Array<"read" | "write" | "send"> = ["read", "send"]) {
  return (await createBotGrantsRepository(db).grant({
    ownerId: OWNER, botId: BOT, service: connection.service, connectionId: connection.connectionId, accountLabel: connection.label,
    effects, audience: "direct", grantedByActorId: OWNER, now: AT,
  })).grant;
}

async function pending() {
  return db.selectFrom("bot_interactions").select(["interaction_id", "kind", "payload", "status", "revision"]).orderBy("created_at").execute();
}

const read = { service: "gmail", action: "list_threads", connectionId: "conn_work", params: {} };
const send = { service: "gmail", action: "send_email", connectionId: "conn_work", params: { to: "a@example.com", subject: "Hi", body: "Hello" } };

describe("bot integration tools", () => {
  it("classifies effects from the registry", () => {
    expect(effectOf("gmail", "list_threads")).toBe("read");
    expect(effectOf("gmail", "send_email")).toBe("send");
    expect(effectOf("gmail", "no_such_action")).toBeUndefined();
  });

  it("lists what the bot may use without exposing emails", async () => {
    connected = [WORK, HOME];
    await grant(WORK);
    const result = await setup().tools.inventory(binding, {});
    expect(result).toEqual({ ok: true, content: [{ type: "text", text: [
      `Gmail (gmail): account "Work", connection conn_work, allowed: read, send`,
      "Google Calendar (google_calendar): not connected",
    ].join("\n") }] });
  });

  it.each([false, true])("keeps the granted immutable account through the real bot client/read route (label reused=%s)", async replaced => {
    await grant(WORK);
    const providerRead = vi.fn(async () => ({ threads: [{ id: "safe-thread" }] }));
    const selected = { id: replaced ? "conn_replacement" : WORK.connectionId, service: "gmail", account_label: WORK.label, pipedream_account_id: replaced ? "apn_replacement" : "apn_work" };
    const platformDb = { listConnectedServices: vi.fn(async () => [selected]), getUserById: vi.fn(async () => ({ pipedream_external_id: "pd_owner" })), touchServiceUsage: vi.fn() } as unknown as PlatformDb;
    const app = new Hono();
    app.get("/", c => c.json([{ id: WORK.connectionId, service: "gmail", account_label: WORK.label, status: "active" }]));
    app.route("/", createIntegrationReadCallRoutes({ db: platformDb, pipedream: { boundedGmailGet: providerRead } as unknown as PipedreamConnectClient, resolveUserId: async () => OWNER }));
    const transport = vi.fn(async (ownerId, request) => {
      expect(ownerId).toBe(OWNER);
      return app.request(request.path, { method: request.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body), signal: request.signal });
    });
    const realClient = createBotIntegrationClient(transport);
    // Inventory retains the original grant; the real read route sees the fresh
    // account list after dispatch, including a newly reused label.
    const tools = createBotIntegrationTools({
      client: realClient, transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
      recipes: createBotRecipeCatalog([RECIPE]),
      agents: { get: async () => ({ id: BOT, recipeRef: { recipeId: "mail-helper", version: "1" } }) as never }, now: () => toolClock,
    });
    if (replaced) {
      await expect(tools.call(binding, read)).rejects.toMatchObject({ code: "denied" });
      expect(providerRead).not.toHaveBeenCalled();
    } else {
      await expect(tools.call(binding, read)).resolves.toMatchObject({ ok: true });
      expect(providerRead).toHaveBeenCalledWith(expect.objectContaining({ accountId: "apn_work", externalUserId: "pd_owner" }));
    }
    expect(transport).toHaveBeenCalledWith(OWNER, expect.objectContaining({ path: "/read-call", readScope: true, body: expect.objectContaining({ connectionId: WORK.connectionId, label: "Work" }) }));
  });
  it.each([false, true])("pins an approved send through the real bot client/call route (label reused=%s)", async replaced => {
    await grant(WORK);
    const providerWrite = vi.fn(async () => ({ id: "safe-message" }));
    const selected = { id: replaced ? "conn_replacement" : WORK.connectionId, service: "gmail", account_label: WORK.label, pipedream_account_id: replaced ? "apn_replacement" : "apn_work" };
    const platformDb = { listConnectedServices: vi.fn(async () => [selected]), getUserById: vi.fn(async () => ({ pipedream_external_id: "pd_owner" })), touchServiceUsage: vi.fn() } as unknown as PlatformDb;
    const app = new Hono();
    app.get("/", c => c.json([{ id: WORK.connectionId, service: "gmail", account_label: WORK.label, status: "active" }]));
    app.route("/", createIntegrationRoutes({ db: platformDb, pipedream: { proxyPost: providerWrite, getAppInfo: async () => null } as unknown as PipedreamConnectClient,
      webhookSecret: "test-secret", resolveUserId: async () => OWNER }));
    const transport = vi.fn(async (ownerId, request) => {
      expect(ownerId).toBe(OWNER);
      return app.request(request.path, { method: request.method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body), signal: request.signal });
    });
    const transact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
    const tools = createBotIntegrationTools({ client: createBotIntegrationClient(transport), transact, recipes: createBotRecipeCatalog([RECIPE]),
      agents: { get: async () => ({ id: BOT, recipeRef: { recipeId: "mail-helper", version: "1" } }) as never }, now: () => toolClock });
    const interactions = createBotInteractionService({ transact, handlers: createBotAccessHandlers({ tools, now: () => toolClock }), now: () => toolClock });
    await expect(tools.call(binding, send)).resolves.toMatchObject({ ok: true });
    expect(providerWrite).not.toHaveBeenCalled();
    expect(transport.mock.calls.every(([, request]) => request.path !== "/call")).toBe(true);
    const [approval] = await pending();
    await interactions.resolve(OWNER, CHAT, approval!.interaction_id, { kind: "approval", baseRevision: 1, decision: "approve" });
    const later = { ...binding, runId: "run_mail2" };
    if (replaced) {
      await expect(tools.call(later, send)).rejects.toMatchObject({ code: "denied" });
      expect(providerWrite).not.toHaveBeenCalled();
    } else {
      await expect(tools.call(later, send)).resolves.toMatchObject({ ok: true });
      expect(providerWrite).toHaveBeenCalledOnce();
      expect(providerWrite).toHaveBeenCalledWith(expect.objectContaining({ accountId: "apn_work", externalUserId: "pd_owner" }));
      await expect(tools.call(later, send)).resolves.toMatchObject({ ok: true });
      expect(providerWrite).toHaveBeenCalledOnce();
    }
    expect(transport).toHaveBeenCalledWith(OWNER, expect.objectContaining({ path: "/call", readScope: false,
      body: expect.objectContaining({ connectionId: WORK.connectionId, label: "Work" }) }));
  });
  async function attachmentWorkspace() {
    const home = await mkdtemp(join(tmpdir(), "matrix-bot-attachment-"));
    onTestFinished(() => rm(home, { recursive: true, force: true }));
    const path = await createBotWorkspace({ homePath: home, botId: BOT });
    const resolved = await resolveBotWorkspaceRoot({ homePath: home, owner: { type: "personal", ownerId: OWNER }, ref: { kind: "bot_workspace", botId: BOT } });
    binding = { ...binding, rootFingerprint: resolved.fingerprint };
    return { home, path };
  }
  const attachment = { service: "gmail", action: "get_attachment", connectionId: WORK.connectionId, params: { messageId: "mail_1", attachmentId: "part_1" } };

  it.each([100 * 1024, 1024 * 1024])("keeps the complete %s-byte attachment in the bound bot workspace and a small usable result", async size => {
    const { home, path } = await attachmentWorkspace();
    await grant(WORK);
    const bytes = Buffer.alloc(size, 0x81);
    const transport = vi.fn(async () => Response.json({ data: { size, data: bytes.toString("base64url") } }));
    const sent = vi.fn(createBotIntegrationClient(transport).call);
    const { tools } = setup(sent as never, undefined, undefined, home);
    const result = await tools.call(binding, attachment);
    const shown = result.content.map(part => part.text).join("");
    expect(shown.length).toBeLessThan(2048);
    const reference = JSON.parse(shown);
    expect(reference).toMatchObject({ kind: "workspace_attachment", size, sha256: createHash("sha256").update(bytes).digest("hex"), untrusted: true });
    expect(reference.relPath).toMatch(/^gmail-attachment-[0-9]{2}\.bin$/);
    expect(await readFile(join(path, reference.relPath))).toEqual(bytes);
    // Follow the reference through the same bounded dispatcher the bot can use.
    const dispatcher = createBotToolDispatcher({ homePath: home });
    const chunks: Buffer[] = [];
    let offset = 0;
    while (offset < size) {
      const request = BotToolRequestSchema.parse({ toolCallId: "call_chunk", capability: "artifact.read",
        args: { relPath: reference.relPath, chunk: { offset, length: 32 * 1024, sha256: reference.sha256 } } });
      const response = BotToolResultSchema.parse((await dispatcher.dispatch(binding, request, new AbortController().signal)).result);
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("Read failed");
      const chunk = JSON.parse(response.content.map(part => part.text).join(""));
      expect(chunk).toMatchObject({ offset, size, sha256: reference.sha256, encoding: "base64", untrusted: true });
      const data = Buffer.from(chunk.data, "base64");
      expect(data.length).toBeLessThanOrEqual(32 * 1024);
      expect(chunk.nextOffset).toBe(offset + data.length);
      expect(chunk.eof).toBe(chunk.nextOffset === size);
      chunks.push(data); offset = chunk.nextOffset;
    }
    expect(Buffer.concat(chunks)).toEqual(bytes);
    expect(shown).not.toContain(bytes.toString("base64url").slice(0, 100));
    expect(sent).toHaveBeenCalledExactlyOnceWith(OWNER, expect.objectContaining({ connectionId: WORK.connectionId }), undefined);
    expect(await readdir(join(path, ".bot-save"))).toEqual([]);
    // A repeated read reuses the complete owner artifact instead of filling slots.
    const repeated = await tools.call(binding, attachment);
    expect(repeated).toEqual(result);
    expect((await readdir(path)).filter(name => name.startsWith("gmail-attachment-"))).toHaveLength(1);
  });

  it.each([
    { size: 8, data: "not+base64" }, { size: 2, data: "YQ" }, { size: 1, data: "YR" },
    { size: 1024 * 1024 + 1, data: Buffer.alloc(1024 * 1024 + 1).toString("base64url") },
  ])("rejects malformed or oversized attachment payload without partial JSON or files", async payload => {
    const { home, path } = await attachmentWorkspace();
    await grant(WORK);
    const { tools } = setup(vi.fn(async () => ({ data: payload })) as never, undefined, undefined, home);
    await expect(tools.call(binding, attachment)).rejects.toMatchObject({ code: "unavailable" });
    expect(await readdir(path)).toEqual([]);
  });

  it.each(["replaced", "wrong-owner"])("rejects attachment storage after %s workspace binding", async change => {
    const { home, path } = await attachmentWorkspace();
    await grant(WORK);
    const sent = vi.fn(async () => {
      if (change === "replaced") { await rename(path, `${path}-old`); await mkdir(path); }
      return { data: { size: 1, data: "YQ" } };
    });
    // Mutation changes the actual existing root while the call is outstanding;
    // wrong-owner fingerprints are supplied before dispatch instead.
    if (change === "wrong-owner") binding = { ...binding, rootFingerprint: (await resolveBotWorkspaceRoot({ homePath: home,
      owner: { type: "personal", ownerId: "different_owner" }, ref: { kind: "bot_workspace", botId: BOT } })).fingerprint };
    const { tools } = setup(sent as never, undefined, undefined, home);
    await expect(tools.call(binding, attachment)).rejects.toMatchObject({ code: "stale_generation" });
    expect(await readdir(path)).toEqual([]);
  });

  it("rejects a linked attachment staging directory without writing outside the workspace", async () => {
    const { home, path } = await attachmentWorkspace();
    const outside = join(home, "outside"); await mkdir(outside); await symlink(outside, join(path, ".bot-save"));
    await grant(WORK);
    const { tools } = setup(vi.fn(async () => ({ data: { size: 1, data: "YQ" } })) as never, undefined, undefined, home);
    await expect(tools.call(binding, attachment)).rejects.toMatchObject({ code: "unavailable" });
    expect(await readdir(outside)).toEqual([]);
  });

  it("caps concurrently stored attachments without overwriting complete owner files", async () => {
    const { home, path } = await attachmentWorkspace();
    await grant(WORK);
    let byte = 0;
    const sent = vi.fn(async () => ({ data: { size: 1, data: Buffer.from([byte++]).toString("base64url") } }));
    const { tools } = setup(sent as never, undefined, undefined, home);
    await Promise.all(Array.from({ length: 16 }, () => tools.call(binding, attachment)));
    const files = (await readdir(path)).filter(name => name.startsWith("gmail-attachment-"));
    expect(files).toHaveLength(16);
    const before = await Promise.all(files.map(name => readFile(join(path, name))));
    await expect(tools.call(binding, attachment)).rejects.toMatchObject({ code: "unavailable" });
    expect(await Promise.all(files.map(name => readFile(join(path, name))))).toEqual(before);
    expect(await readdir(join(path, ".bot-save"))).toEqual([]);
  });

  it("fails closed when the owner workspace storage dependency is unavailable", async () => {
    await grant(WORK);
    const { tools } = setup(vi.fn(async () => ({ data: { size: 100 * 1024, data: Buffer.alloc(100 * 1024).toString("base64url") } })) as never);
    await expect(tools.call(binding, attachment)).rejects.toMatchObject({ code: "unavailable" });
  });
  it("runs a granted read through the read-only route for the grant's account", async () => {
    await grant(WORK);
    const { tools, call } = setup();
    const result = await tools.call(binding, read);
    expect(result).toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("1 thread") }] });
    expect(call).toHaveBeenCalledWith(OWNER, { service: "gmail", action: "list_threads", label: "Work", connectionId: WORK.connectionId, params: {}, read: true }, undefined);
  });

  it("refuses effects the recipe does not declare and unknown actions", async () => {
    await grant(WORK);
    await expect(setup().tools.call(binding, { ...read, service: "google_calendar", action: "create_event", connectionId: "conn_cal" }))
      .rejects.toBeInstanceOf(BotBrokerActionError);
    await expect(setup().tools.call(binding, { ...read, action: "no_such_action" })).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
  });

  it("asks the owner which account to use, once, and grants the choice", async () => {
    connected = [WORK, HOME];
    const { tools, interactions, call } = setup();
    await expect(tools.call(binding, read)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("which Gmail account") }] });
    await expect(tools.call(binding, read)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("not answered") }] });
    const [choice] = await pending();
    expect(choice).toMatchObject({ kind: "account_choice", status: "pending" });
    expect(call).not.toHaveBeenCalled();
    const resolved = await interactions.resolve(OWNER, CHAT, choice!.interaction_id, { kind: "account_choice", baseRevision: 1, connectionId: "conn_home" });
    expect(resolved.continuation?.text).toBe('Use the gmail account "Home" (connection conn_home). Its access is now available to you.');
    const grants = await createBotGrantsRepository(db).listLive({ ownerId: OWNER, botId: BOT, audience: "direct", now: AT });
    // Only what the recipe declares for the service is granted.
    expect(grants).toEqual([expect.objectContaining({ connectionId: "conn_home", accountLabel: "Home", effects: ["read", "send"] })]);
    await expect(tools.call(binding, { ...read, connectionId: "conn_home" })).resolves.toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledWith(OWNER, { service: "gmail", action: "list_threads", label: "Home", connectionId: HOME.connectionId, params: {}, read: true }, undefined);
    await expect(interactions.resolve(OWNER, CHAT, choice!.interaction_id, { kind: "account_choice", baseRevision: 2, connectionId: "conn_work" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("offers a single connected account for a grant without starting a new connection", async () => {
    const { tools, interactions } = setup();
    await tools.call(binding, read);
    const [choice] = await pending();
    expect(choice).toMatchObject({ kind: "account_choice", payload: { kind: "account_choice", service: "gmail", options: [{ connectionId: "conn_work", label: "Work" }] } });
    await interactions.resolve(OWNER, CHAT, choice!.interaction_id, { kind: "account_choice", baseRevision: 1, connectionId: "conn_work" });
    expect(await createBotGrantsRepository(db).findUsable({ ownerId: OWNER, botId: BOT, service: "gmail", connectionId: "conn_work", audience: "direct", effect: "read", now: AT })).toBeDefined();
  });

  it("asks to connect when nothing usable is connected, and never nags after a decline", async () => {
    connected = [];
    const { tools, interactions } = setup();
    await expect(tools.call(binding, read)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("asked to connect Gmail") }] });
    const [request] = await pending();
    expect(request).toMatchObject({ kind: "connect_request", payload: expect.objectContaining({ service: "gmail", access: ["read", "send"] }) });
    const declined = await interactions.resolve(OWNER, CHAT, request!.interaction_id, { kind: "connect_request", baseRevision: 1, action: "decline" });
    expect(declined.continuation?.text).toContain("chose not to connect gmail");
    await expect(tools.call(binding, read)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("do not ask again") }] });
    expect(await pending()).toHaveLength(1);
    await expect(interactions.resolve(OWNER, CHAT, request!.interaction_id, { kind: "connect_request", baseRevision: 2, action: "start" }))
      .rejects.toMatchObject({ code: "invalid_request" });
  });

  it("asks again when a granted account was renamed or removed", async () => {
    await grant(WORK);
    connected = [{ ...WORK, label: "Renamed" }];
    await expect(setup().tools.call(binding, read)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("which Gmail account") }] });
  });

  it("needs the owner's approval of the exact call before a send, and claims it once in a later run", async () => {
    await grant(WORK);
    const sent = vi.fn(async () => ({ data: { id: "m1" } }));
    const { tools, interactions } = setup(sent);
    const asked = await tools.call(binding, send);
    expect(asked).toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("asked to approve") }] });
    await expect(tools.call(binding, send)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("not decided") }] });
    expect(sent).not.toHaveBeenCalled();
    const [approval] = await pending();
    expect(approval).toMatchObject({ kind: "approval", payload: expect.objectContaining({ argsDigest: approvalDigest(send), account: { service: "gmail", label: "Work" } }) });
    const decided = await interactions.resolve(OWNER, CHAT, approval!.interaction_id, { kind: "approval", baseRevision: 1, decision: "approve" });
    expect(decided.continuation?.text).toContain("Go ahead with exactly this action now.");
    // A continuation run of the same task claims it once.
    const later = { ...binding, runId: "run_mail2" };
    await expect(tools.call(later, send)).resolves.toMatchObject({ ok: true });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith(OWNER, { service: "gmail", action: "send_email", label: "Work", connectionId: WORK.connectionId, params: send.params, read: false }, undefined);
    // The same call again needs a new approval.
    await expect(tools.call(later, send)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("asked to approve") }] });
    // Different arguments are a different action.
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("refuses to request approval for arguments the owner cannot see in full", async () => {
    await grant(WORK);
    const { tools, call } = setup();
    await expect(tools.call(binding, { ...send, params: { ...send.params, body: "a".repeat(3_100) } }))
      .rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    expect(await pending()).toEqual([]);
    expect(call).not.toHaveBeenCalled();
  });

  it("does not re-ask for an action the owner denied in this task", async () => {
    await grant(WORK);
    const { tools, interactions, call } = setup();
    await tools.call(binding, send);
    const [approval] = await pending();
    await interactions.resolve(OWNER, CHAT, approval!.interaction_id, { kind: "approval", baseRevision: 1, decision: "deny" });
    await expect(tools.call(binding, send)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("do not ask again") }] });
    expect(await pending()).toHaveLength(1);
    expect(call).not.toHaveBeenCalled();
  });

  it("asks again after an unclaimed approval expires", async () => {
    await grant(WORK);
    const { tools } = setup();
    await tools.call(binding, send);
    const [approval] = await pending();
    await db.updateTable("bot_approvals").set({ expires_at: "2026-09-28T10:30:00.000Z" }).where("approval_id", "=", approval!.interaction_id).execute();
    await db.updateTable("bot_interactions").set({ expires_at: "2026-09-28T10:30:00.000Z" }).where("interaction_id", "=", approval!.interaction_id).execute();
    toolClock = new Date("2026-09-28T11:00:00.000Z");
    await expect(tools.call(binding, send)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("asked to approve") }] });
    expect(await pending()).toHaveLength(2);
  });

  it("refuses dispatch if the grant was revoked after the first grant lookup", async () => {
    const granted = await grant(WORK);
    const call = vi.fn(async () => ({ data: { threads: [] } }));
    const { tools } = setup(call, async (number) => {
      if (number === 2) await createBotGrantsRepository(db).revoke({ ownerId: OWNER, grantId: granted.grantId, now: AT });
    });
    await expect(tools.call(binding, read)).rejects.toEqual(new BotBrokerActionError("not_granted"));
    expect(call).not.toHaveBeenCalled();
  });

  it.each(["revoked", "revised", "expired"])("refuses a grant %s while source qualification waits", async mutation => {
    const granted = await grant(WORK);
    if (mutation === "expired") await db.updateTable("bot_grants").set({ expires_at: "2026-09-28T10:30:00.000Z" }).where("grant_id", "=", granted.grantId).execute();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let checks = 0;
    const assertSource = vi.fn(async () => { if (++checks === 1) { entered(); await held; } });
    const { tools, call } = setup(undefined, undefined, assertSource);
    const signal = new AbortController().signal;
    const result = tools.call(binding, read, signal);
    await started;
    try {
      if (mutation === "revoked") await createBotGrantsRepository(db).revoke({ ownerId: OWNER, grantId: granted.grantId, now: AT });
      else if (mutation === "revised") await createBotGrantsRepository(db).updateEffects({ ownerId: OWNER, grantId: granted.grantId, baseRevision: granted.revision, effects: ["read"], now: AT });
      else toolClock = new Date("2026-09-28T11:00:00.000Z");
    } finally { release(); }
    await expect(result).rejects.toEqual(new BotBrokerActionError("not_granted"));
    expect(signal.aborted).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });

  it("refuses expiration during source qualification under the final grant lock", async () => {
    const granted = await grant(WORK);
    await db.updateTable("bot_grants").set({ expires_at: "2026-09-28T10:30:00.000Z" }).where("grant_id", "=", granted.grantId).execute();
    let checks = 0;
    const { tools, call } = setup(undefined, undefined, async () => {
      if (++checks === 2) toolClock = new Date("2026-09-28T11:00:00.000Z");
    });
    await expect(tools.call(binding, read)).rejects.toEqual(new BotBrokerActionError("not_granted"));
    expect(call).not.toHaveBeenCalled();
  });

  it.each(["abort", "deadline"])("releases the grant lock on source-check %s even when the source ignores cancellation", async cancellation => {
    const granted = await grant(WORK);
    let entered!: () => void, checks = 0;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const { tools, call } = setup(undefined, undefined, async () => {
      if (++checks === 2) { entered(); await new Promise<void>(() => {}); }
    });
    const controller = new AbortController();
    const result = tools.call(binding, read, controller.signal);
    await started;
    if (cancellation === "abort") controller.abort();
    await expect(result).rejects.toEqual(new BotBrokerActionError("timeout"));
    await expect(createBotGrantsRepository(db).revoke({ ownerId: OWNER, grantId: granted.grantId, now: AT })).resolves.toBe(true);
    expect(call).not.toHaveBeenCalled();
  }, 12_000);

  it("invalidates an approval when the grant changed, and honors a denial", async () => {
    const granted = await grant(WORK);
    const sent = vi.fn(async () => ({ data: {} }));
    const { tools, interactions } = setup(sent);
    await tools.call(binding, send);
    const [approval] = await pending();
    await interactions.resolve(OWNER, CHAT, approval!.interaction_id, { kind: "approval", baseRevision: 1, decision: "approve" });
    await createBotGrantsRepository(db).updateEffects({ ownerId: OWNER, grantId: granted.grantId, baseRevision: granted.revision, effects: ["read", "send"], now: AT });
    await expect(tools.call(binding, send)).resolves.toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("asked to approve") }] });
    expect(sent).not.toHaveBeenCalled();
    const [, second] = await pending();
    const denied = await interactions.resolve(OWNER, CHAT, second!.interaction_id, { kind: "approval", baseRevision: 1, decision: "deny" });
    expect(denied.continuation?.text).toContain("Do not do it.");
  });

  it("maps integration failures to allowlisted codes", async () => {
    await grant(WORK);
    for (const [code, expected] of [["denied", "denied"], ["missing", "not_granted"], ["unavailable", "unavailable"], ["ambiguous", "unavailable"]] as const) {
      const { tools } = setup(vi.fn(async () => { throw new BotIntegrationError(code); }));
      await expect(tools.call(binding, read)).rejects.toEqual(new BotBrokerActionError(expected));
    }
    const aborted = new AbortController();
    aborted.abort();
    const { tools } = setup(vi.fn(async () => { throw new BotIntegrationError("unavailable"); }));
    await expect(tools.call(binding, read, aborted.signal)).rejects.toEqual(new BotBrokerActionError("timeout"));
  });
});
