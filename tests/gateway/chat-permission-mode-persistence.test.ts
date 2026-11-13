import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalChatRun } from "@matrix-os/contracts";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

describe("Chat effective permission persistence", () => {
  let repository: ChatRepository;
  const owner = { type: "personal" as const, ownerId: "owner_permission" };
  const timestamp = "2026-11-13T19:00:00.000Z";

  beforeEach(async () => {
    const database = await createTestPGlite();
    repository = new ChatRepository(database.dialect);
    await repository.bootstrap();
  });
  afterEach(async () => { await repository.kysely.destroy(); });

  it("reloads the acknowledged effective mode while retaining admission capabilities", async () => {
    const { chat } = await repository.create(owner, {
      id: "chat_permission", clientRequestId: "req_create_permission", title: "Permission mode",
    });
    const snapshot: CanonicalChatRun["capabilitySnapshot"] = {
      revision: "catalog_permission", rootChat: true, attachments: [], resources: [], tools: [],
      approvals: true, userInput: true, resume: true, cancellation: true, steering: "same_run",
      worktrees: "none", interactionModes: ["default"], permissionModes: ["supervised", "full_access"],
    };
    await repository.admitTurn(owner, {
      chatId: chat.id, baseRevision: chat.revision,
      message: { id: "msg_permission", chatId: chat.id, seq: 1, role: "user", state: "committed",
        purpose: "ai_request", turnId: "cturn_permission", parts: [{ type: "text", text: "Inspect files" }], createdAt: timestamp },
      turn: { id: "cturn_permission", chatId: chat.id, clientRequestId: "req_turn_permission", baseMessageSeq: 0,
        inputMessageId: "msg_permission", status: "accepted", createdAt: timestamp, updatedAt: timestamp },
      run: { id: "run_permission", chatId: chat.id, turnId: "cturn_permission", attempt: 1,
        driverKind: "claude_code", instanceId: "claude_code_default",
        selection: { instanceId: "claude_code_default", model: "claude-sonnet-4-5" }, interactionMode: "default",
        permissionMode: "supervised", status: "accepted", historyBoundarySeq: 0, capabilitySnapshot: snapshot,
        createdAt: timestamp, updatedAt: timestamp },
    });
    await repository.markRunRunning(owner, { chatId: chat.id, runId: "run_permission", startedAt: timestamp });
    await repository.appendRunActivities(owner, chat.id, "run_permission", [{
      id: "activity_permission", chatId: chat.id, runId: "run_permission", occurredAt: timestamp,
      type: "run.permission_mode", permissionMode: "full_access", clientRequestId: "req_live_permission",
    } as never]);
    const reloaded = await repository.exportChat(owner, chat.id);
    expect(reloaded?.runs[0]?.permissionMode).toBe("full_access");
    expect(reloaded?.runs[0]?.capabilitySnapshot).toEqual(snapshot);
    expect(reloaded?.activities).toContainEqual(expect.objectContaining({
      type: "run.permission_mode", permissionMode: "full_access", clientRequestId: "req_live_permission",
    }));
  });
});
