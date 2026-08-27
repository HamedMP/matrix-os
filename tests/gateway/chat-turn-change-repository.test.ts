import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CanonicalChatMessage, CanonicalChatRun, CanonicalChatTurn } from "@matrix-os/contracts";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";

const owner = { type: "personal" as const, ownerId: "owner_changes" };
const other = { type: "personal" as const, ownerId: "owner_other" };
const at = "2026-08-27T04:00:00.000Z";

function records(chatId: string) {
  const message: CanonicalChatMessage = {
    id: "msg_changes",
    chatId,
    seq: 1,
    role: "user",
    state: "committed",
    turnId: "cturn_changes",
    parts: [{ type: "text", text: "change it" }],
    createdAt: at,
  };
  const turn: CanonicalChatTurn = {
    id: "cturn_changes",
    chatId,
    clientRequestId: "req_changes",
    baseMessageSeq: 0,
    inputMessageId: message.id,
    status: "accepted",
    createdAt: at,
    updatedAt: at,
  };
  const run: CanonicalChatRun = {
    id: "run_changes",
    chatId,
    turnId: turn.id,
    attempt: 1,
    driverKind: "codex",
    instanceId: "codex_default",
    selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
    interactionMode: "default",
    permissionMode: "supervised",
    executionRoot: { kind: "project", projectId: "project_matrix" },
    executionRootFingerprint: "f".repeat(64),
    status: "accepted",
    historyBoundarySeq: 0,
    capabilitySnapshot: {
      revision: "catalog_changes",
      rootChat: true,
      attachments: [],
      resources: ["file", "folder", "project"],
      tools: [],
      approvals: true,
      userInput: true,
      resume: true,
      cancellation: true,
      worktrees: "optional",
      interactionModes: ["default"],
      permissionModes: ["supervised"],
    },
    createdAt: at,
    updatedAt: at,
  };
  return { message, turn, run };
}

describe("ChatRepository turn changes", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let repository: ChatRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    repository = new ChatRepository(pglite.dialect);
    await repository.bootstrap();
    await repository.create(owner, {
      id: "chat_changes",
      clientRequestId: "req_create_changes",
      title: "Changes",
      projectId: "project_matrix",
    });
    const { message, turn, run } = records("chat_changes");
    await repository.admitTurn(owner, { chatId: "chat_changes", baseRevision: 0, message, turn, run });
  });

  afterEach(async () => repository.kysely.destroy());

  it("persists an owner-scoped start checkpoint and settles the change set atomically with the Run", async () => {
    await repository.recordTurnChangeStart(owner, {
      chatId: "chat_changes",
      turnId: "cturn_changes",
      runId: "run_changes",
      projectId: "project_matrix",
      executionRoot: { kind: "project", projectId: "project_matrix" },
      executionRootFingerprint: "f".repeat(64),
      beforeTree: "a".repeat(40),
      beforeHead: "b".repeat(40),
      capturedAt: at,
    });
    const changes = {
      chatId: "chat_changes",
      turnId: "cturn_changes",
      runId: "run_changes",
      projectId: "project_matrix",
      executionRoot: { kind: "project" as const, projectId: "project_matrix" },
      revision: `turnrev_${"c".repeat(64)}`,
      beforeRevision: `tree_${"a".repeat(40)}`,
      afterRevision: `tree_${"d".repeat(40)}`,
      source: "workspace_checkpoints" as const,
      label: "Workspace changes observed during this turn" as const,
      concurrent: false,
      partial: false,
      files: [{ path: "README.md", status: "modified" as const, additions: 1, deletions: 1, partial: false }],
      totals: { changedFileCount: 1, additions: 1, deletions: 1 },
      capturedAt: at,
    };
    await repository.finishRun(owner, {
      chatId: "chat_changes",
      runId: "run_changes",
      outcome: "completed",
      completedAt: at,
      turnChanges: { changes, afterTree: "d".repeat(40), afterHead: "b".repeat(40) },
    });

    await expect(repository.getTurnChanges(owner, "chat_changes", "cturn_changes"))
      .resolves.toMatchObject({ changes, beforeTree: "a".repeat(40), afterTree: "d".repeat(40) });
    await expect(repository.getTurnChanges(other, "chat_changes", "cturn_changes")).resolves.toBeNull();
  });

  it("rejects mismatched root provenance without settling the Run", async () => {
    await expect(repository.recordTurnChangeStart(owner, {
      chatId: "chat_changes",
      turnId: "cturn_changes",
      runId: "run_changes",
      projectId: "project_other",
      executionRoot: { kind: "project", projectId: "project_other" },
      executionRootFingerprint: "e".repeat(64),
      beforeTree: "a".repeat(40),
      beforeHead: "b".repeat(40),
      capturedAt: at,
    })).rejects.toBeDefined();

    expect((await repository.getTurnRunContext(owner, "chat_changes", "cturn_changes"))?.latestRun.status)
      .toBe("accepted");
  });
});
