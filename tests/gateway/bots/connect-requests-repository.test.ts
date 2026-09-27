import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { connectOutcome, createBotConnectRequestsRepository } from "../../../packages/gateway/src/bots/repositories/connect-requests.js";
import { createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OWNER, at, createBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let interactionId: string;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, "chat_connect1");
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: "chat_connect1", now: NOW });
  interactionId = (await createBotInteractionsRepository(db).create({
    ownerId: OWNER, botId: BOT, chatId: "chat_connect1", taskId: task.taskId, kind: "connect_request",
    payload: { kind: "connect_request", service: "gmail" }, responderActorId: OWNER, blocking: true, expiresAt: at(10 * 60_000), now: NOW,
  })).interaction.interactionId;
});
afterEach(async () => destroy());

const create = (repo: ReturnType<typeof createBotConnectRequestsRepository>) => repo.create({
  ownerId: OWNER, interactionId, service: "gmail", baselineConnectionIds: ["conn_old"], expiresAt: at(10 * 60_000), now: NOW,
});

describe("bot connect requests repository", () => {
  it("computes outcomes from new connection IDs against the baseline", () => {
    const request = { baselineConnectionIds: ["conn_old"], expiresAt: at(60_000) };
    expect(connectOutcome(request, ["conn_old"], at(1))).toEqual({ status: "pending" });
    expect(connectOutcome(request, ["conn_old", "conn_new"], at(1))).toEqual({ status: "completed", connectionId: "conn_new" });
    expect(connectOutcome(request, ["conn_b", "conn_a", "conn_old"], at(1))).toEqual({ status: "ambiguous", connectionIds: ["conn_a", "conn_b"] });
    expect(connectOutcome(request, ["conn_old"], at(60_000))).toEqual({ status: "expired" });
    // A connection that appears after the deadline does not complete the request.
    expect(connectOutcome(request, ["conn_old", "conn_late"], at(60_000))).toEqual({ status: "expired" });
    expect(() => connectOutcome(request, ["bad id!"], at(1))).toThrow(BotStateError);
  });

  it("records one outcome at the row's revision and leaves pending requests unchanged", async () => {
    const repo = createBotConnectRequestsRepository(db);
    const request = await create(repo);
    expect(request).toMatchObject({ status: "pending", revision: 1, baselineConnectionIds: ["conn_old"] });
    await expect(repo.reconcile({ ownerId: OWNER, requestId: request.requestId, baseRevision: 1, currentConnectionIds: ["conn_old"], now: at(1) }))
      .resolves.toMatchObject({ outcome: { status: "pending" }, request: { revision: 1 } });
    const completed = await repo.reconcile({ ownerId: OWNER, requestId: request.requestId, baseRevision: 1, currentConnectionIds: ["conn_old", "conn_new"], now: at(2) });
    expect(completed.request).toMatchObject({ status: "completed", completedConnectionId: "conn_new", revision: 2 });
    await expect(repo.reconcile({ ownerId: OWNER, requestId: request.requestId, baseRevision: 2, currentConnectionIds: ["conn_new"], now: at(3) }))
      .rejects.toEqual(new BotStateError("invalid_transition"));
  });

  it("allows one request per interaction and bounds its lifetime", async () => {
    const repo = createBotConnectRequestsRepository(db);
    await create(repo);
    await expect(create(repo)).rejects.toThrow();
    await expect(repo.create({ ownerId: OWNER, interactionId, service: "gmail", baselineConnectionIds: [], expiresAt: at(20 * 60_000), now: NOW }))
      .rejects.toEqual(new BotStateError("invalid_input"));
    const pending = await repo.listPending({ ownerId: OWNER });
    expect(pending).toHaveLength(1);
    await expect(repo.cancel({ ownerId: OWNER, requestId: pending[0]!.requestId, now: at(1) })).resolves.toBe(true);
    await expect(repo.cancel({ ownerId: OWNER, requestId: pending[0]!.requestId, now: at(2) })).resolves.toBe(false);
  });
});
