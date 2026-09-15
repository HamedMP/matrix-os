import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "purpose_owner" };
const now = "2026-09-10T00:00:00.000Z";
const selection = { instanceId: "opencode_default", model: "claude-sonnet-5" };

describe("Chat message purpose compatibility", () => {
  let repository: ChatRepository;
  beforeEach(async () => {
    const database = await KyselyPGlite.create();
    repository = new ChatRepository(database.dialect);
    await repository.bootstrap();
  });
  afterEach(async () => { await repository.kysely.destroy(); });

  async function requirePurposeWithoutDefault() {
    // Reproduce the schema left by a newer collaboration-enabled bundle.
    await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS purpose TEXT`.execute(repository.kysely);
    await sql`ALTER TABLE chat_messages ALTER COLUMN purpose DROP DEFAULT`.execute(repository.kysely);
    await sql`ALTER TABLE chat_messages ALTER COLUMN purpose SET NOT NULL`.execute(repository.kysely);
  }

  async function admit() {
    const { chat } = await repository.create(owner, {
      id: "chat_purpose", clientRequestId: "req_create_purpose", title: "Purpose compatibility",
    });
    const message: CanonicalChatMessage = {
      id: "msg_purpose", chatId: chat.id, seq: 1, role: "user", state: "committed",
      turnId: "cturn_purpose", parts: [{ type: "text", text: "Hello" }], createdAt: now,
    };
    const turn: CanonicalChatTurn = {
      id: "cturn_purpose", chatId: chat.id, clientRequestId: "req_turn_purpose",
      inputMessageId: message.id, baseMessageSeq: 0, status: "accepted", createdAt: now, updatedAt: now,
    };
    const run: CanonicalChatRun = {
      id: "run_purpose", chatId: chat.id, turnId: turn.id, attempt: 1, driverKind: "opencode",
      instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "supervised",
      status: "accepted", historyBoundarySeq: 0,
      capabilitySnapshot: {
        revision: "purpose_test", rootChat: true, attachments: [], resources: [], tools: [],
        approvals: true, userInput: true, resume: true, cancellation: true, steering: "same_run",
        worktrees: "optional", interactionModes: ["default"], permissionModes: ["supervised"],
      },
      createdAt: now, updatedAt: now,
    };
    const admitted = await repository.admitTurn(owner, { chatId: chat.id, baseRevision: 0, message, turn, run });
    return { chatId: chat.id, message, turn, run, admitted };
  }

  async function purposes() {
    return (await sql<{ role: string; purpose: string }>`SELECT role, purpose FROM chat_messages ORDER BY seq`
      .execute(repository.kysely)).rows;
  }

  it.each(["fresh", "upgraded"])("admits and reads attributed messages on a %s schema", async (schema) => {
    if (schema === "upgraded") await requirePurposeWithoutDefault();
    const admitted = await admit();
    expect(await purposes()).toEqual([{ role: "user", purpose: "ai_request" }]);
    expect(await repository.getMessages(owner, admitted.chatId, { afterSeq: 0, limit: 10 }))
      .toEqual([{ ...admitted.message, purpose: "ai_request" }]);
  });

  it.each(["streamed", "final"])("stores %s assistant output with a required purpose", async (kind) => {
    await requirePurposeWithoutDefault();
    const { chatId, run, turn } = await admit();
    if (kind === "streamed") {
      await repository.appendAssistantDelta(owner, { chatId, runId: run.id, messageId: "msg_reply", delta: "Hi", createdAt: now });
    }
    await repository.finishRun(owner, {
      chatId, runId: run.id, outcome: "completed", completedAt: now,
      ...(kind === "final" ? { output: {
        id: "msg_reply", chatId, seq: 2, role: "assistant" as const, state: "committed" as const,
        turnId: turn.id, runId: run.id, parts: [{ type: "text" as const, text: "Hi" }], createdAt: now,
      } } : {}),
    });
    expect(await purposes()).toEqual([{ role: "user", purpose: "ai_request" }, { role: "assistant", purpose: "assistant" }]);
  });

  it("stores accepted steering messages with a required purpose", async () => {
    await requirePurposeWithoutDefault();
    const { chatId, run, turn } = await admit();
    await repository.beginSteer(owner, {
      chatId, runId: run.id, expectedTurnId: turn.id, steerId: "steer_purpose", messageId: "msg_steer",
      clientRequestId: "req_steer", parts: [{ type: "text", text: "Focus" }], createdAt: now,
    });
    await repository.acceptSteer(owner, { chatId, runId: run.id, clientRequestId: "req_steer", acceptedAt: now });
    expect(await purposes()).toEqual([{ role: "user", purpose: "ai_request" }, { role: "user", purpose: "ai_request" }]);
  });

  it("stores claimed queue messages with a required purpose", async () => {
    await requirePurposeWithoutDefault();
    const { chatId, run } = await admit();
    await repository.enqueueQueuedTurn(owner, {
      chatId, baseRevision: 1, queuedTurnId: "qturn_purpose", clientRequestId: "req_queue_purpose",
      parts: [{ type: "text", text: "Next" }], driverKind: "opencode", selection,
      interactionMode: "default", permissionMode: "supervised", capabilitySnapshot: run.capabilitySnapshot, createdAt: now,
    });
    await repository.finishRun(owner, { chatId, runId: run.id, outcome: "completed", completedAt: now });
    expect(await repository.claimNextQueuedTurn(owner, {
      chatId, turnId: "cturn_next", runId: "run_next", messageId: "msg_next", claimedAt: now,
    })).not.toBeNull();
    expect(await purposes()).toEqual([{ role: "user", purpose: "ai_request" }, { role: "user", purpose: "ai_request" }]);
  });

  it("backfills legacy rows and makes repeated bootstrap safe", async () => {
    await admit();
    await sql`ALTER TABLE chat_messages DROP COLUMN IF EXISTS purpose`.execute(repository.kysely);
    await repository.bootstrap();
    await repository.bootstrap();
    expect(await purposes()).toEqual([{ role: "user", purpose: "ai_request" }]);
  });

  it("preserves newer discussion attribution and existing constraints during bootstrap", async () => {
    await requirePurposeWithoutDefault();
    await admit();
    await sql`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS actor_id TEXT`.execute(repository.kysely);
    await sql`UPDATE chat_messages SET purpose = 'discussion', actor_id = 'existing_author'`.execute(repository.kysely);
    await sql`ALTER TABLE chat_messages ADD CONSTRAINT preserved_purpose_check CHECK (purpose IN ('discussion', 'ai_request', 'assistant', 'system'))`.execute(repository.kysely);
    await repository.bootstrap();
    expect((await sql`SELECT purpose, actor_id FROM chat_messages`.execute(repository.kysely)).rows)
      .toEqual([{ purpose: "discussion", actor_id: "existing_author" }]);
    await expect(sql`UPDATE chat_messages SET purpose = 'invalid'`.execute(repository.kysely)).rejects.toThrow();
  });
});
