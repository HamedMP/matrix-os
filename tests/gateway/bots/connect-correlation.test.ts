import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBotConnections } from "../../../packages/gateway/src/bots/connections.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import type { BotIntegrationConnection } from "../../../packages/gateway/src/bots/integration-client.js";
import { BotInteractionError } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotConnectRequestsRepository } from "../../../packages/gateway/src/bots/repositories/connect-requests.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, OTHER_OWNER, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_connect1";
const AT = "2026-09-28T10:00:00.000Z";
const WORK: BotIntegrationConnection = { connectionId: "conn_work", service: "gmail", label: "Work" };
const HOME: BotIntegrationConnection = { connectionId: "conn_home", service: "gmail", label: "Home" };

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let connected: BotIntegrationConnection[];
let clock: number;
let interactionId: string;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: AT });
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: AT });
  interactionId = (await createBotInteractionsRepository(db).create({
    ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task.taskId, kind: "connect_request",
    payload: { kind: "connect_request", service: "gmail", access: ["read"], benefit: "Read mail.", connectRequestId: "cr_0123456789abcdef01234567" },
    responderActorId: OWNER, blocking: true, expiresAt: "2026-09-28T10:15:00.000Z", now: AT,
  })).interaction.interactionId;
  connected = [];
  clock = Date.parse(AT);
});
afterEach(async () => destroy());

function setup() {
  const client = {
    inventory: vi.fn(async () => connected),
    call: vi.fn(),
    connect: vi.fn(async () => "https://connect.example/oauth?state=abc"),
    sync: vi.fn(async () => undefined),
  };
  const connections = createBotConnections({
    client: client as never,
    transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
    tools: { declaredEffects: async () => ["read"] },
    now: () => new Date(clock),
  });
  return { connections, client };
}

async function interaction(id = interactionId) {
  return db.selectFrom("bot_interactions").select(["kind", "status", "revision", "resolution"]).where("interaction_id", "=", id).executeTakeFirstOrThrow();
}

async function grants() {
  return createBotGrantsRepository(db).listLive({ ownerId: OWNER, botId: BOT, audience: "direct", now: AT });
}

describe("bot connection requests", () => {
  it("reconciles owners with the oldest pending request first", async () => {
    const { connections } = setup();
    await connections.startConnect(OWNER, CHAT, interactionId, 1);
    const older = "2026-09-28T09:59:00.000Z";
    const otherChat = "chat_connect2";
    await insertChat(db, otherChat, OTHER_OWNER);
    const task = await createBotTasksRepository(db).create({ ownerId: OTHER_OWNER, botId: BOT, chatId: otherChat, now: older });
    const { interaction } = await createBotInteractionsRepository(db).create({
      ownerId: OTHER_OWNER, botId: BOT, chatId: otherChat, taskId: task.taskId, kind: "connect_request",
      payload: { kind: "connect_request", service: "gmail", access: ["read"], benefit: "Read mail.", connectRequestId: "cr_0123456789abcdef01234568" },
      responderActorId: OTHER_OWNER, blocking: true, expiresAt: "2026-09-28T10:14:00.000Z", now: older,
    });
    await createBotConnectRequestsRepository(db).create({
      ownerId: OTHER_OWNER, interactionId: interaction.interactionId, requestId: "cr_0123456789abcdef01234568",
      service: "gmail", baselineConnectionIds: [], expiresAt: "2026-09-28T10:14:00.000Z", now: older,
    });
    await expect(connections.ownersWithPending()).resolves.toEqual([OTHER_OWNER, OWNER]);
  });
  it("grants an account that is already connected when the owner starts", async () => {
    connected = [WORK];
    const result = await setup().connections.startConnect(OWNER, CHAT, interactionId, 1);
    expect(result.continuation).toEqual({
      chatId: CHAT, clientRequestId: `req_answer_${interactionId}`,
      text: 'Connected gmail account "Work" (connection conn_work). Continue the task.',
    });
    expect(result.response.interaction).toMatchObject({ status: "resolved", revision: 2 });
    expect(await grants()).toEqual([expect.objectContaining({ connectionId: "conn_work", accountLabel: "Work", effects: ["read"] })]);
  });

  it("asks which account when several are already connected", async () => {
    connected = [WORK, HOME];
    const result = await setup().connections.startConnect(OWNER, CHAT, interactionId, 1);
    expect(result.continuation).toBeUndefined();
    const [choice] = await db.selectFrom("bot_interactions").select(["kind", "status", "payload"]).where("kind", "=", "account_choice").execute();
    expect(choice).toMatchObject({ status: "pending", payload: expect.objectContaining({ options: [{ connectionId: "conn_work", label: "Work" }, { connectionId: "conn_home", label: "Home" }] }) });
    expect(await grants()).toEqual([]);
  });

  it("hands out the consent URL, records the baseline, and completes only from the inventory", async () => {
    const { connections, client } = setup();
    const started = await connections.startConnect(OWNER, CHAT, interactionId, 1);
    expect(started).toEqual({ response: { interaction: { interactionId, status: "pending", revision: 1 }, connectUrl: "https://connect.example/oauth?state=abc" } });
    // Starting again reuses the same request.
    await connections.startConnect(OWNER, CHAT, interactionId, 1);
    const requests = await db.selectFrom("bot_connect_requests").select(["request_id", "status", "baseline_connection_ids"]).execute();
    expect(requests).toEqual([{ request_id: "cr_0123456789abcdef01234567", status: "pending", baseline_connection_ids: [] }]);

    // Nothing new yet: a browser return alone proves nothing.
    await expect(connections.reconcile(OWNER)).resolves.toEqual([]);
    expect((await interaction()).status).toBe("pending");
    connected = [WORK];
    await expect(connections.reconcile(OWNER)).resolves.toEqual([{ chatId: CHAT, clientRequestId: `req_answer_${interactionId}`, text: expect.stringContaining('"Work"') }]);
    expect(client.sync).toHaveBeenCalled();
    expect((await interaction()).status).toBe("resolved");
    expect(await grants()).toHaveLength(1);
    // A repeated pass does nothing more.
    await expect(connections.reconcile(OWNER)).resolves.toEqual([]);
    await expect(connections.ownersWithPending()).resolves.toEqual([]);
  });

  it("asks which new account when several appeared, and expires a request nobody finished", async () => {
    const { connections } = setup();
    await connections.startConnect(OWNER, CHAT, interactionId, 1);
    connected = [WORK, HOME];
    await expect(connections.reconcile(OWNER)).resolves.toEqual([]);
    expect(await db.selectFrom("bot_interactions").select("kind").where("status", "=", "pending").execute()).toEqual([{ kind: "account_choice" }]);
    expect((await db.selectFrom("bot_connect_requests").select("status").executeTakeFirstOrThrow()).status).toBe("ambiguous");
  });

  it("expires a started request after its deadline without granting", async () => {
    const { connections } = setup();
    await connections.startConnect(OWNER, CHAT, interactionId, 1);
    clock = Date.parse("2026-09-28T10:16:00.000Z");
    connected = [WORK];
    await expect(connections.reconcile(OWNER)).resolves.toEqual([]);
    expect((await db.selectFrom("bot_connect_requests").select("status").executeTakeFirstOrThrow()).status).toBe("expired");
    expect(await grants()).toEqual([]);
  });

  it("refuses another responder, a stale revision, and an expired request", async () => {
    const { connections } = setup();
    await expect(connections.startConnect(OTHER_OWNER, CHAT, interactionId, 1)).rejects.toEqual(new BotInteractionError("not_found"));
    await expect(connections.startConnect(OWNER, CHAT, interactionId, 5)).rejects.toEqual(new BotInteractionError("conflict"));
    clock = Date.parse("2026-09-28T10:16:00.000Z");
    await expect(connections.startConnect(OWNER, CHAT, interactionId, 1)).rejects.toEqual(new BotInteractionError("expired"));
  });
});
