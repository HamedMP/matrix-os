import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatConflictError, ChatProviderInstanceLockedError } from "../../packages/gateway/src/chat/errors.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;
const owner = { type: "personal" as const, ownerId: "owner_provider_binding_race" };
const now = "2026-09-17T20:00:00.000Z";

realDescribe("personal Chat Provider binding PostgreSQL races", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
  });

  afterEach(async () => {
    if (fixture) await fixture.destroy();
  });

  it("atomically lets exactly one concurrent first Provider bind the Chat", async () => {
    await repository.create(owner, {
      id: "chat_binding_race",
      clientRequestId: "req_binding_race",
      title: "Binding race",
    });

    const results = await Promise.allSettled([
      repository.admitTurn(owner, admission("codex")),
      repository.admitTurn(owner, admission("claude")),
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toSatisfy((error: unknown) => (
      error instanceof ChatConflictError || error instanceof ChatProviderInstanceLockedError
    ));
    const stored = await repository.get(owner, "chat_binding_race");
    expect(stored?.providerBinding?.instanceId).toBe(fulfilled[0]?.value.run.instanceId);
    expect(stored?.providerBinding?.instanceId).toBe(stored?.chat.currentSelection?.instanceId);
    expect(await repository.kysely.selectFrom("chat_runs").selectAll()
      .where("chat_id", "=", "chat_binding_race").execute()).toHaveLength(1);
    expect(await repository.kysely.selectFrom("chat_turns").selectAll()
      .where("chat_id", "=", "chat_binding_race").execute()).toHaveLength(1);
    expect(await repository.kysely.selectFrom("chat_messages").selectAll()
      .where("chat_id", "=", "chat_binding_race").execute()).toHaveLength(1);
  });
});

function admission(suffix: "codex" | "claude") {
  const isCodex = suffix === "codex";
  const instanceId = isCodex ? "codex_default" : "claude_default";
  const turnId = `cturn_binding_${suffix}`;
  const message: CanonicalChatMessage = {
    id: `msg_binding_${suffix}`,
    chatId: "chat_binding_race",
    seq: 1,
    role: "user",
    state: "committed",
    purpose: "ai_request",
    turnId,
    parts: [{ type: "text", text: `bind ${suffix}` }],
    createdAt: now,
  };
  const turn: CanonicalChatTurn = {
    id: turnId,
    chatId: "chat_binding_race",
    clientRequestId: `req_binding_${suffix}`,
    baseMessageSeq: 0,
    inputMessageId: message.id,
    status: "accepted",
    createdAt: now,
    updatedAt: now,
  };
  const run: CanonicalChatRun = {
    id: `run_binding_${suffix}`,
    chatId: "chat_binding_race",
    turnId,
    attempt: 1,
    driverKind: isCodex ? "codex" : "claude_code",
    instanceId,
    selection: { instanceId, model: isCodex ? "gpt-5.6-sol" : "claude-opus-5" },
    interactionMode: "default",
    permissionMode: "supervised",
    status: "accepted",
    historyBoundarySeq: 0,
    capabilitySnapshot: {
      revision: "catalog_binding_race",
      rootChat: true,
      attachments: [],
      resources: [],
      tools: [],
      approvals: false,
      userInput: false,
      resume: true,
      cancellation: true,
      worktrees: "optional",
      interactionModes: ["default"],
      permissionModes: ["supervised"],
    },
    createdAt: now,
    updatedAt: now,
  };
  return { chatId: "chat_binding_race", baseRevision: 0, message, turn, run };
}
