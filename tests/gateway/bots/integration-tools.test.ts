import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotAccessHandlers } from "../../../packages/gateway/src/bots/access-handlers.js";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions, type BotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotIntegrationError, type BotIntegrationConnection } from "../../../packages/gateway/src/bots/integration-client.js";
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

function setup(call = vi.fn(async () => ({ data: { threads: [{ id: "t1", subject: "Hello" }] }, summary: "1 thread" })), beforeTransaction?: (number: number) => Promise<void>) {
  const baseTransact = createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>));
  let transactions = 0;
  const transact: BotStateTransactions = async (ownerId, work) => {
    await beforeTransaction?.(++transactions);
    return baseTransact(ownerId, work);
  };
  const client = { inventory: vi.fn(async () => connected), call };
  const tools = createBotIntegrationTools({
    client, transact, recipes: createBotRecipeCatalog([RECIPE]),
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

  it("runs a granted read through the read-only route for the grant's account", async () => {
    await grant(WORK);
    const { tools, call } = setup();
    const result = await tools.call(binding, read);
    expect(result).toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("1 thread") }] });
    expect(call).toHaveBeenCalledWith(OWNER, { service: "gmail", action: "list_threads", label: "Work", params: {}, read: true }, undefined);
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
    expect(call).toHaveBeenCalledWith(OWNER, { service: "gmail", action: "list_threads", label: "Home", params: {}, read: true }, undefined);
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
    expect(sent).toHaveBeenCalledWith(OWNER, { service: "gmail", action: "send_email", label: "Work", params: send.params, read: false }, undefined);
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
