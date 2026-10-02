import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotInteractionError, createBotInteractionService, renderAnswer } from "../../../packages/gateway/src/bots/interactions.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import type { BotRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, OTHER_OWNER, OWNER, createBotStateDatabase, createRealBotStateDatabase, insertChat } from "./bot-state-support.js";

const CHAT = "chat_questions1";
const QUESTION = {
  kind: "question" as const,
  questions: [
    { questionId: "q1", header: "Tone", question: "Formal or casual?", options: [{ label: "Formal" }, { label: "Casual" }], allowOther: false, secret: false },
    { questionId: "q2", header: "Length", question: "How long?", allowOther: true, secret: false },
  ],
};

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let binding: BotRuntimeBinding;
let clock: number;

beforeEach(async () => {
  ({ db, destroy } = await (process.env.MATRIX_TEST_POSTGRES_URL ? createRealBotStateDatabase() : createBotStateDatabase()));
  await insertChat(db, CHAT);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: "2026-09-28T09:00:00.000Z" });
  const task = await createBotTasksRepository(db).create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: "2026-09-28T09:00:00.000Z" });
  binding = {
    runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task.taskId,
    runId: "run_ask1", rootFingerprint: "f".repeat(64),
    route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 },
    accessSourceId: "matrix_included", capabilities: ["interaction.create"], requestClass: "interactive",
  };
  clock = Date.parse("2026-09-28T10:00:00.000Z");
});
afterEach(async () => destroy());

function service() {
  return createBotInteractionService({
    transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)),
    now: () => new Date(clock),
  });
}

async function events() {
  return (await db.selectFrom("chat_outbox").select(["event_type", "payload"]).orderBy("cursor").execute())
    .map((row) => ({ type: row.event_type, payload: row.payload }));
}

async function ask(blocking = true) {
  const questions = service();
  await questions.createFromTool(binding, { blocking, payload: QUESTION });
  const [pending] = await questions.listPending(OWNER, CHAT);
  return pending!;
}

describe("bot questions", () => {
  it("records a question for the owner and announces it without its content", async () => {
    const result = await service().createFromTool(binding, { blocking: true, payload: QUESTION });
    expect(result).toEqual({ ok: true, content: [{ type: "text", text: expect.stringContaining("End your turn now") }] });
    const [pending] = await service().listPending(OWNER, CHAT);
    expect(pending).toMatchObject({ chatId: CHAT, agentId: BOT, kind: "question", blocking: true, status: "pending", revision: 1, payload: QUESTION });
    expect(pending!.expiresAt).toBe("2026-09-29T10:00:00.000Z");
    expect(await events()).toEqual([{ type: "interaction.requested", payload: expect.objectContaining({ interactionId: pending!.interactionId, kind: "question", blocking: true }) }]);
    expect(JSON.stringify(await events())).not.toContain("Formal or casual");
    // Someone else sees none of it.
    await expect(service().listPending(OTHER_OWNER, CHAT)).resolves.toEqual([]);
  });

  it("allows one blocking question per task, and never a secret or another kind yet", async () => {
    await ask();
    await expect(service().createFromTool(binding, { blocking: true, payload: QUESTION })).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    await expect(service().createFromTool(binding, { blocking: false, payload: QUESTION })).resolves.toMatchObject({ ok: true });
    const secret = { ...QUESTION, questions: [{ ...QUESTION.questions[1]!, secret: true }] };
    await expect(service().createFromTool(binding, { blocking: false, payload: secret })).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    await expect(service().createFromTool(binding, {
      blocking: true, payload: { kind: "approval", tool: "integration.call", argsDigest: "a".repeat(64), audience: "direct", preview: "Send", policyRevision: 1 },
    } as never)).rejects.toEqual(new BotBrokerActionError("not_granted"));
  });

  it("records the answer once and returns one continuation, even when the request is repeated", async () => {
    const pending = await ask();
    const body = { kind: "question", baseRevision: 1, structuredAnswers: { q1: ["Casual"] }, answer: "Keep it under a page." };
    const first = await service().resolve(OWNER, CHAT, pending.interactionId, body);
    expect(first).toEqual({
      response: { interaction: { interactionId: pending.interactionId, status: "resolved", revision: 2 } },
      continuation: { chatId: CHAT, clientRequestId: `req_answer_${pending.interactionId}`, text: "Formal or casual?\nCasual\n\nKeep it under a page." },
    });
    await expect(service().resolve(OWNER, CHAT, pending.interactionId, body)).resolves.toEqual(first);
    await service().ackContinuation(OTHER_OWNER, first.continuation!.clientRequestId);
    await expect(service().resolve(OWNER, CHAT, pending.interactionId, body)).resolves.toEqual(first);
    await service().ackContinuation(OWNER, first.continuation!.clientRequestId);
    await expect(service().resolve(OWNER, CHAT, pending.interactionId, body)).resolves.toEqual({ response: first.response });
    await expect(service().resolve(OWNER, CHAT, pending.interactionId, { ...body, answer: "Different" })).rejects.toEqual(new BotInteractionError("conflict"));
    expect((await events()).map((event) => event.type)).toEqual(["interaction.requested", "interaction.resolved"]);
  });

  it("reconstructs a blocking question continuation for older resolved rows", async () => {
    const pending = await ask();
    const body = { kind: "question", baseRevision: 1, answer: "Keep it short." };
    const first = await service().resolve(OWNER, CHAT, pending.interactionId, body);
    await db.updateTable("bot_interactions").set({ resolution: { answer: "Keep it short." } }).where("interaction_id", "=", pending.interactionId).execute();
    expect((await service().resolve(OWNER, CHAT, pending.interactionId, body)).continuation).toEqual(first.continuation);
  });

  it("refuses the wrong responder, chat, kind, or question, and answers after expiry as expired", async () => {
    const pending = await ask();
    const body = { kind: "question", baseRevision: 1, answer: "Yes" };
    await expect(service().resolve(OTHER_OWNER, CHAT, pending.interactionId, body)).rejects.toEqual(new BotInteractionError("not_found"));
    await expect(service().resolve(OWNER, "chat_elsewhere1", pending.interactionId, body)).rejects.toEqual(new BotInteractionError("not_found"));
    await expect(service().resolve(OWNER, CHAT, pending.interactionId, { kind: "approval", baseRevision: 1, decision: "approve" }))
      .rejects.toEqual(new BotInteractionError("invalid_request"));
    await expect(service().resolve(OWNER, CHAT, pending.interactionId, { kind: "question", baseRevision: 1, structuredAnswers: { q9: ["x"] } }))
      .rejects.toEqual(new BotInteractionError("invalid_request"));
    await expect(service().resolve(OWNER, CHAT, "in_bad", body)).rejects.toEqual(new BotInteractionError("invalid_request"));
    clock += 25 * 60 * 60_000;
    await expect(service().resolve(OWNER, CHAT, pending.interactionId, body)).rejects.toEqual(new BotInteractionError("expired"));
  });

  it("delivers a non-blocking answer once with a stable continuation request", async () => {
    const pending = await ask(false);
    const result = await service().resolve(OWNER, CHAT, pending.interactionId, { kind: "question", baseRevision: 1, answer: "Later" });
    expect(result.continuation).toEqual({ chatId: CHAT, clientRequestId: `req_answer_${pending.interactionId}`, text: "Later" });
    await expect(service().resolve(OWNER, CHAT, pending.interactionId, { kind: "question", baseRevision: 1, answer: "Later" })).resolves.toEqual(result);
    expect((await events()).filter((event) => event.type === "interaction.resolved")).toHaveLength(1);
  });

  it("lets a reply in Chat answer the task's open question", async () => {
    const pending = await ask();
    await service().answerWithMessage({ ownerId: OWNER, taskId: binding.taskId, chatId: CHAT, text: "Casual, short." });
    await expect(service().listPending(OWNER, CHAT)).resolves.toEqual([]);
    const row = await db.selectFrom("bot_interactions").select(["status", "resolution"]).where("interaction_id", "=", pending.interactionId).executeTakeFirstOrThrow();
    expect(row.status).toBe("resolved");
    expect(JSON.stringify(row.resolution)).toContain("Casual, short.");
  });

  it("expires overdue questions and announces each", async () => {
    await ask();
    clock += 25 * 60 * 60_000;
    await expect(service().expireAllDue()).resolves.toBe(1);
    expect((await events()).at(-1)).toEqual({ type: "interaction.resolved", payload: expect.objectContaining({ status: "expired" }) });
    await expect(service().expireAllDue()).resolves.toBe(0);
  });

  it("renders only the questions that were answered", () => {
    expect(renderAnswer(QUESTION, { structuredAnswers: { q2: ["One page"] } })).toBe("How long?\nOne page");
  });
});
