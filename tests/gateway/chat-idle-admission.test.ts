import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { CanonicalChatRunSchema } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { withCanonicalIdleChat } from "../../packages/gateway/src/chat/idle-runtime-admission.js";

const owner = { type: "personal" as const, ownerId: "owner" };
const at = "2026-09-08T00:00:00.000Z";
const identity = { ownerId: "owner", threadId: "thread_idle", sessionId: "sess_idle", providerThreadId: "native_idle" };
describe("canonical idle runtime admission", () => {
  let database: Awaited<ReturnType<typeof KyselyPGlite.create>>;
  let repository: ChatRepository;
  beforeEach(async () => { database = await KyselyPGlite.create(); repository = new ChatRepository(database.dialect); await repository.bootstrap(); });
  afterEach(async () => { await repository.release(); await repository.kysely.destroy(); });
  async function admitted() {
    const created = await repository.create(owner, { id: "chat_idle", clientRequestId: "req_create", title: "Idle" });
    const message = { id: "msg_idle", chatId: "chat_idle", seq: 1, role: "user" as const, state: "committed" as const,
      turnId: "cturn_idle", parts: [{ type: "text" as const, text: "Task" }], createdAt: at };
    const turn = { id: "cturn_idle", chatId: "chat_idle", clientRequestId: "req_turn", baseMessageSeq: 0,
      inputMessageId: message.id, status: "accepted" as const, createdAt: at, updatedAt: at };
    const run = CanonicalChatRunSchema.parse({ id: "run_idle", chatId: "chat_idle", turnId: turn.id, attempt: 1,
      driverKind: "codex", instanceId: "codex_default", selection: { instanceId: "codex_default", model: "model" },
      interactionMode: "default", permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0,
      capabilitySnapshot: { revision: "catalog_1", rootChat: true, attachments: [], resources: [], tools: [],
        approvals: true, userInput: true, resume: true, cancellation: true, steering: "same_run", worktrees: "optional",
        interactionModes: ["default"], permissionModes: ["supervised"] }, createdAt: at, updatedAt: at });
    await repository.admitTurn(owner, { chatId: "chat_idle", baseRevision: created.chat.revision, message, turn, run,
      adapterState: { schemaVersion: 1, state: { conversationId: identity.threadId } } });
    return run;
  }
  it("requires matching durable ownership and excludes active runs", async () => {
    await admitted();
    const reclaim = vi.fn(async () => true);
    expect(await withCanonicalIdleChat(repository.kysely, identity, reclaim)).toBe(false);
    await repository.finishRun(owner, { chatId: "chat_idle", runId: "run_idle", outcome: "completed", completedAt: at });
    expect(await withCanonicalIdleChat(repository.kysely, { ...identity, ownerId: "other" }, reclaim)).toBe(false);
    expect(await withCanonicalIdleChat(repository.kysely, identity, reclaim)).toBe(true);
    expect(reclaim).toHaveBeenCalledTimes(1);
  });
  it("does not reclaim a completed chat with a durable queued prompt", async () => {
    const run = await admitted();
    const chat = await repository.get(owner, "chat_idle");
    await repository.enqueueQueuedTurn(owner, { chatId: "chat_idle", baseRevision: chat!.chat.revision,
      queuedTurnId: "qturn_idle", clientRequestId: "req_queue", parts: [{ type: "text", text: "Next" }],
      driverKind: "codex", selection: run.selection, interactionMode: "default", permissionMode: "supervised",
      capabilitySnapshot: run.capabilitySnapshot, createdAt: at });
    await repository.finishRun(owner, { chatId: "chat_idle", runId: "run_idle", outcome: "completed", completedAt: at });
    const reclaim = vi.fn(async () => true);
    expect(await withCanonicalIdleChat(repository.kysely, identity, reclaim)).toBe(false);
    expect(reclaim).not.toHaveBeenCalled();
  });
});
