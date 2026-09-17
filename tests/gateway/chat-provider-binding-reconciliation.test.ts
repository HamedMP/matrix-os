import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatRecordSchema, type CanonicalChatMessage, type CanonicalChatRun, type CanonicalChatTurn } from "@matrix-os/contracts";
import {
  ChatProviderInstanceLockedError,
  ChatRepository,
} from "../../packages/gateway/src/chat/repository.js";
import {
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const owner = { type: "personal" as const, ownerId: "user_provider_repair_owner" };
const now = "2026-09-17T12:00:00.000Z";
const codexSelection = { instanceId: "codex_default", model: "gpt-5.6-sol" };
const corruptSelection = { instanceId: "claude_shared", model: "claude-opus-4-6" };

describe("Chat Provider binding reconciliation", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
  });

  afterEach(async () => fixture.destroy());

  it("repairs only a proven mismatch, is idempotent, and never rewrites the binding", async () => {
    await seedBoundCodexChat(repository, "chat_repair_proven");
    await fixture.db.updateTable("chats").set({ current_selection: JSON.stringify(corruptSelection) })
      .where("id", "=", "chat_repair_proven").execute();

    await expect(repository.reconcileProviderBindings()).resolves.toEqual({ repaired: 1, unresolved: 0 });
    await expect(repository.reconcileProviderBindings()).resolves.toEqual({ repaired: 0, unresolved: 0 });
    const repaired = await fixture.db.selectFrom("chats")
      .select(["current_selection", "bound_driver_kind", "bound_instance_id", "bound_at_turn_id"])
      .where("id", "=", "chat_repair_proven").executeTakeFirstOrThrow();
    expect(repaired).toEqual({
      current_selection: codexSelection,
      bound_driver_kind: "codex",
      bound_instance_id: "codex_default",
      bound_at_turn_id: "cturn_chat_repair_proven",
    });
    const ownerRecord = await repository.get(owner, "chat_repair_proven");
    expect(() => CanonicalChatRecordSchema.parse(ownerRecord)).not.toThrow();
  });

  it("does not let the owner switch Provider instances after the first binding", async () => {
    await seedBoundCodexChat(repository, "chat_owner_switch_forbidden");

    await expect(repository.update(owner, "chat_owner_switch_forbidden", {
      baseRevision: 1,
      currentSelection: corruptSelection,
    })).rejects.toBeInstanceOf(ChatProviderInstanceLockedError);
    await expect(repository.get(owner, "chat_owner_switch_forbidden")).resolves.toMatchObject({
      chat: { currentSelection: codexSelection },
      providerBinding: { instanceId: "codex_default" },
    });
  });

  it("does nothing to valid rows and fails closed with a bounded diagnostic when provenance is unavailable", async () => {
    await seedBoundCodexChat(repository, "chat_repair_valid");
    await seedBoundCodexChat(repository, "chat_repair_unproven");
    await fixture.db.updateTable("chats").set({
      current_selection: JSON.stringify(corruptSelection),
      bound_at_turn_id: "cturn_missing_provenance",
    }).where("id", "=", "chat_repair_unproven").execute();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(repository.reconcileProviderBindings()).resolves.toEqual({ repaired: 0, unresolved: 1 });
    expect(warn).toHaveBeenCalledWith(
      "[chat/provider-binding] reconciliation unavailable",
      expect.objectContaining({ chatId: "chat_repair_unproven", reason: "provenance_unavailable" }),
    );
    await expect(fixture.db.selectFrom("chats").select("current_selection")
      .where("id", "=", "chat_repair_valid").executeTakeFirstOrThrow())
      .resolves.toEqual({ current_selection: codexSelection });
    await expect(fixture.db.selectFrom("chats").select(["current_selection", "bound_instance_id"])
      .where("id", "=", "chat_repair_unproven").executeTakeFirstOrThrow())
      .resolves.toEqual({ current_selection: corruptSelection, bound_instance_id: "codex_default" });
    warn.mockRestore();
  });
});

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;

realDescribe("Chat Provider binding reconciliation on PostgreSQL", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
  });

  afterEach(async () => fixture.destroy());

  it("reproduces and repairs the codex_default to claude_shared production corruption", async () => {
    const chatId = "chat_e5aca64e722f41d8b128403096c8dbd2";
    await seedBoundCodexChat(repository, chatId, "New caht");
    await fixture.db.updateTable("chats").set({ current_selection: JSON.stringify(corruptSelection) })
      .where("id", "=", chatId).execute();
    const corrupt = await repository.get(owner, chatId);
    expect(() => CanonicalChatRecordSchema.parse(corrupt)).toThrow(
      "Bound Chat selection must use its immutable Provider Instance",
    );

    await expect(repository.reconcileProviderBindings()).resolves.toEqual({ repaired: 1, unresolved: 0 });
    expect(CanonicalChatRecordSchema.parse(await repository.get(owner, chatId)))
      .toMatchObject({
        chat: { title: "New caht", currentSelection: codexSelection },
        providerBinding: { driverKind: "codex", instanceId: "codex_default" },
      });
  });
});

async function seedBoundCodexChat(
  repository: ChatRepository,
  chatId: string,
  title = "Provider repair",
): Promise<void> {
  await repository.create(owner, {
    id: chatId,
    clientRequestId: `req_${chatId}`,
    title,
    currentSelection: codexSelection,
  });
  const message: CanonicalChatMessage = {
    id: `msg_${chatId}`,
    chatId,
    seq: 1,
    role: "user",
    state: "committed",
    purpose: "ai_request",
    turnId: `cturn_${chatId}`,
    parts: [{ type: "text", text: "Bind this Chat to Codex" }],
    createdAt: now,
  };
  const turn: CanonicalChatTurn = {
    id: `cturn_${chatId}`,
    chatId,
    clientRequestId: `req_turn_${chatId}`,
    baseMessageSeq: 0,
    inputMessageId: message.id,
    status: "accepted",
    createdAt: now,
    updatedAt: now,
  };
  const run: CanonicalChatRun = {
    id: `run_${chatId}`,
    chatId,
    turnId: turn.id,
    attempt: 1,
    driverKind: "codex",
    instanceId: "codex_default",
    selection: codexSelection,
    interactionMode: "default",
    permissionMode: "supervised",
    status: "accepted",
    historyBoundarySeq: 0,
    capabilitySnapshot: {
      revision: "repair-test",
      rootChat: true,
      attachments: [],
      resources: [],
      tools: [],
      approvals: true,
      userInput: true,
      resume: true,
      cancellation: true,
      steering: "same_run",
      worktrees: "optional",
      interactionModes: ["default"],
      permissionModes: ["supervised"],
    },
    createdAt: now,
    updatedAt: now,
  };
  await repository.admitTurn(owner, {
    chatId,
    baseRevision: 0,
    message,
    turn,
    run,
  });
}
