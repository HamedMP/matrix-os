import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { MAX_PENDING_INTERACTIONS_PER_OWNER, createBotInteractionsRepository } from "../../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { BotStateError } from "../../../packages/gateway/src/bots/repositories/shared.js";
import { BOT, NOW, OWNER, at, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let taskId: string;
const CHAT = "chat_interact1";
const question = { kind: "question", questions: [{ questionId: "q1", header: "Company", question: "Which one?" }] };

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  await insertChat(db, CHAT);
  taskId = (await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW })).taskId;
});
afterEach(async () => destroy());

const createFull = (repo: ReturnType<typeof createBotInteractionsRepository>, overrides: Record<string, unknown> = {}) => repo.create({
  ownerId: OWNER, botId: BOT, chatId: CHAT, taskId, kind: "question", payload: question,
  responderActorId: OWNER, blocking: true, expiresAt: at(60 * 60_000), now: NOW, ...overrides,
});
const create = async (repo: ReturnType<typeof createBotInteractionsRepository>, overrides: Record<string, unknown> = {}) =>
  (await createFull(repo, overrides)).interaction;

describe("bot interactions repository", () => {
  it("allows one pending blocking question per task and frees the slot on resolution", async () => {
    const repo = createBotInteractionsRepository(db);
    const first = await create(repo);
    expect(first).toMatchObject({ status: "pending", revision: 1, blocking: true, payload: question });
    await expect(create(repo)).rejects.toEqual(new BotStateError("conflict"));
    // A non-blocking note can sit beside it.
    await expect(create(repo, { blocking: false })).resolves.toMatchObject({ blocking: false });
    const resolved = await repo.resolve({ ownerId: OWNER, interactionId: first.interactionId, baseRevision: 1, responderActorId: OWNER, resolution: { answers: { q1: "Acme" } }, now: at(1) });
    expect(resolved).toMatchObject({ status: "resolved", revision: 2, resolution: { answers: { q1: "Acme" } } });
    await expect(create(repo)).resolves.toMatchObject({ status: "pending" });
  });

  it("claims only at the current revision, by the responder, before expiry", async () => {
    const repo = createBotInteractionsRepository(db);
    const item = await create(repo, { expiresAt: at(10_000) });
    const resolve = (overrides: Record<string, unknown>) => repo.resolve({
      ownerId: OWNER, interactionId: item.interactionId, baseRevision: 1, responderActorId: OWNER,
      resolution: { answers: { q1: "Acme" } }, now: at(1), ...overrides,
    } as never);
    await expect(resolve({ responderActorId: "user_stranger" })).rejects.toEqual(new BotStateError("not_found"));
    await expect(resolve({ baseRevision: 7 })).rejects.toEqual(new BotStateError("revision_conflict"));
    await expect(resolve({ now: at(20_000) })).rejects.toEqual(new BotStateError("invalid_transition"));
    await expect(resolve({})).resolves.toMatchObject({ status: "resolved" });
    await expect(resolve({ baseRevision: 2 })).rejects.toEqual(new BotStateError("invalid_transition"));
  });

  it("caps pending interactions per owner", async () => {
    const repo = createBotInteractionsRepository(db);
    for (let index = 0; index < MAX_PENDING_INTERACTIONS_PER_OWNER; index += 1) await create(repo, { blocking: false });
    await expect(create(repo, { blocking: false })).rejects.toEqual(new BotStateError("capacity_exceeded"));
  });

  it("bounds lifetimes and payloads, and expires overdue interactions in batches", async () => {
    const repo = createBotInteractionsRepository(db);
    await expect(create(repo, { expiresAt: at(25 * 60 * 60_000) })).rejects.toEqual(new BotStateError("invalid_input"));
    await expect(create(repo, { kind: "connect_request", expiresAt: at(20 * 60_000) })).rejects.toEqual(new BotStateError("invalid_input"));
    await expect(create(repo, { payload: { blob: "x".repeat(17 * 1024) } })).rejects.toEqual(new BotStateError("too_large"));
    const soon = await create(repo, { expiresAt: at(1_000) });
    await create(repo, { blocking: false, expiresAt: at(5_000) });
    await expect(repo.expireDue({ now: at(2_000) })).resolves.toEqual([expect.objectContaining({ interactionId: soon.interactionId, status: "expired" })]);
    await expect(repo.listPending({ ownerId: OWNER, chatId: CHAT, now: at(2_000) })).resolves.toHaveLength(1);
    // An overdue blocking question no longer holds the task's slot, and it is handed back for follow-up.
    const overdue = await create(repo, { expiresAt: at(9_000), now: at(3_000) });
    const replacement = await createFull(repo, { now: at(9_500), expiresAt: at(20_000) });
    expect(replacement.interaction).toMatchObject({ status: "pending" });
    // Every overdue pending interaction of the task comes back, including the earlier non-blocking one.
    expect(replacement.expired).toHaveLength(2);
    expect(replacement.expired).toEqual(expect.arrayContaining([expect.objectContaining({ interactionId: overdue.interactionId, status: "expired" })]));
  });

  it("refuses an interaction in a chat the owner does not own", async () => {
    await insertChat(db, "chat_foreign4", "user_owner_2");
    await expect(create(createBotInteractionsRepository(db), { chatId: "chat_foreign4" })).rejects.toEqual(new BotStateError("not_found"));
  });
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("bot interactions repository on pooled Postgres", () => {
  it("holds the per-owner cap under concurrent creates", async () => {
    const real = await createRealBotStateDatabase();
    try {
      await insertChat(real.db, CHAT);
      const task = await createBotTasksRepository(real.db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: NOW });
      const repo = createBotInteractionsRepository(real.db);
      const attempts = await Promise.allSettled(Array.from({ length: MAX_PENDING_INTERACTIONS_PER_OWNER + 8 }, () => repo.create({
        ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task.taskId, kind: "question", payload: question,
        responderActorId: OWNER, blocking: false, expiresAt: at(60 * 60_000), now: NOW,
      })));
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(MAX_PENDING_INTERACTIONS_PER_OWNER);
      const refused = attempts.filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
      expect(refused.every((attempt) => attempt.reason instanceof BotStateError && attempt.reason.code === "capacity_exceeded")).toBe(true);
    } finally {
      await real.destroy();
    }
  }, 60_000);
});
