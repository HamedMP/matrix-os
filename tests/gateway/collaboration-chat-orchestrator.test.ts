import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { SharedChatRunPreparationError } from "../../packages/gateway/src/chat/shared-execution-coordinator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createScopeRuntimeChatProviderAdapter } from "../../packages/gateway/src/collaboration/scope-runtime-chat-adapter.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";
const now = "2026-09-10T00:00:00.000Z";
const owner = { type: "personal" as const, ownerId: collaborationActors.owner };
const runtimeHandle = "runtime_22222222222222222222222222222222";
describe("canonical shared Chat orchestration", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;
  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat();
  });
  afterEach(async () => fixture.destroy());
  it("claims only the selected scope and dispatches through its isolated adapter without personal resume", async () => {
    await repository.enqueueSharedQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      scopeId: collaborationIds.scope,
      queuedTurnId: "qturn_shared_orchestrated",
      clientRequestId: "50000000-0000-4000-8000-000000000001",
      requestingActorId: collaborationActors.editor,
      acceptedAuthEpoch: 1,
      payloadHash: "a".repeat(64),
      expectedRevision: 1,
      parts: [{ type: "text", text: "Shared prompt" }],
      driverKind: "claude_code",
      selection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: {
        revision: "scope-runtime-chat-v1-1", rootChat: true, attachments: [], resources: [], tools: [],
        approvals: false, userInput: false, resume: false, cancellation: true, steering: "none",
        worktrees: "none", interactionModes: ["default"], permissionModes: ["supervised"],
      },
      acceptedAt: now,
    });
    const client = {
      capability: () => ({
        available: true as const,
        profileId: "scope-runtime-chat-v1",
        executionGeneration: "7",
        supportedAdapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240", workloads: ["chat_ai" as const] }],
      }),
      createRuntime: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", state: "running" as const })),
      runChat: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", text: "Shared answer" })),
      stopRuntime: vi.fn(async () => ({ state: "stopped" })),
    };
    const personalGuard = vi.fn(async () => { throw new Error("personal path must stay fenced"); });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => { throw new Error("personal catalog must not be used"); } },
      adapters: new CanonicalChatProviderRegistry([]),
      collaborationGuard: { assertPersonalExecutionAllowed: personalGuard },
      now: () => new Date(now),
    });
    await orchestrator.dispatchNextSharedQueued(
      owner,
      collaborationIds.chat,
      collaborationIds.scope,
      (execution) => {
        expect(execution).toMatchObject({
          scopeId: collaborationIds.scope,
          requestingActorId: collaborationActors.editor,
          executionGeneration: 7,
        });
        return createScopeRuntimeChatProviderAdapter({
          client,
          scopeId: execution.scopeId,
          executionGeneration: String(execution.executionGeneration),
          adapterId: "claude-code",
          harnessVersion: "2.1.240",
        });
      },
    );
    await orchestrator.drain();
    expect(personalGuard).not.toHaveBeenCalled();
    const messages = await fixture.db.selectFrom("chat_messages")
      .select(["role", "actor_id", "purpose", "parts"])
      .where("chat_id", "=", collaborationIds.chat)
      .orderBy("seq")
      .execute();
    const runs = await fixture.db.selectFrom("chat_runs")
      .select(["status", "outcome"])
      .where("chat_id", "=", collaborationIds.chat)
      .execute();
    const requests = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    const events = await fixture.db.selectFrom("collaboration_events")
      .select("event_type")
      .where("scope_id", "=", collaborationIds.scope)
      .orderBy("scope_seq")
      .execute();
    expect(client.createRuntime).toHaveBeenCalled();
    expect(client.runChat).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Shared prompt" }));
    expect(messages).toMatchObject([
      { role: "user", actor_id: collaborationActors.editor, purpose: "ai_request" },
      { role: "assistant", parts: [{ type: "text", text: "Shared answer" }] },
    ]);
    expect(runs).toMatchObject([{ status: "completed", outcome: "completed" }]);
    expect(requests).toMatchObject([{ state: "completed", runId: expect.any(String) }]);
    expect(events.map((event) => event.event_type)).toEqual([
      "chat.ai_request.accepted",
      "chat.ai_request.claimed",
      "run.activity",
      "run.message",
      "run.activity",
      "run.completed",
    ]);
    await expect(fixture.db.selectFrom("chat_outbox").selectAll()
      .where("chat_id", "=", collaborationIds.chat).execute()).resolves.toEqual([]);
  });
  it("preserves an explicit unavailable request when the rollout fence changes after claim", async () => {
    await enqueueSharedRequest("qturn_policy_changed");
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => { throw new Error("personal catalog must not be used"); } },
      adapters: new CanonicalChatProviderRegistry([]),
      now: () => new Date(now),
    });
    await orchestrator.dispatchNextSharedQueued(
      owner,
      collaborationIds.chat,
      collaborationIds.scope,
      () => { throw new SharedChatRunPreparationError("unavailable"); },
    );
    const requests = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    expect(requests).toMatchObject([{ id: "qturn_policy_changed", state: "unavailable" }]);
    await expect(fixture.db.selectFrom("chat_runs").select("outcome")
      .where("chat_id", "=", collaborationIds.chat).executeTakeFirstOrThrow())
      .resolves.toEqual({ outcome: "failed" });
  });
  it("marks an accepted shared request interrupted after gateway restart without replaying it", async () => {
    await enqueueSharedRequest("qturn_interrupted_restart");
    const claimed = await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_interrupted_restart",
      runId: "run_interrupted_restart",
      messageId: "msg_interrupted_restart",
      claimedAt: now,
    });
    expect(claimed?.run.id).toBe("run_interrupted_restart");
    const sharedFence = Object.assign(new Error("Shared execution is fenced"), {
      code: "shared_execution_disabled",
    });
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => { throw new Error("personal catalog must not be used"); } },
      adapters: new CanonicalChatProviderRegistry([]),
      collaborationGuard: { assertPersonalExecutionAllowed: async () => { throw sharedFence; } },
      now: () => new Date(now),
    });
    await expect(orchestrator.reconcileActiveRuns(owner)).resolves.toBe(1);
    const requests = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    expect(requests).toMatchObject([{ id: "qturn_interrupted_restart", state: "interrupted" }]);
  });
  it("preserves an interrupted request when isolated dispatch ends without a known completion", async () => {
    await enqueueSharedRequest("qturn_interrupted_dispatch");
    const client = {
      capability: () => ({
        available: true as const,
        profileId: "scope-runtime-chat-v1",
        executionGeneration: "7",
        supportedAdapters: [{ adapterId: "claude-code", harnessVersion: "2.1.240", workloads: ["chat_ai" as const] }],
      }),
      createRuntime: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", state: "running" as const })),
      runChat: vi.fn(async () => { throw new Error("transport interrupted"); }),
      stopRuntime: vi.fn(async () => ({ state: "stopped" })),
    };
    const orchestrator = new CanonicalChatOrchestrator({
      repository,
      catalog: { getCatalog: async () => { throw new Error("personal catalog must not be used"); } },
      adapters: new CanonicalChatProviderRegistry([]),
      now: () => new Date(now),
    });
    await orchestrator.dispatchNextSharedQueued(
      owner,
      collaborationIds.chat,
      collaborationIds.scope,
      (execution) => createScopeRuntimeChatProviderAdapter({
        client,
        scopeId: execution.scopeId,
        executionGeneration: String(execution.executionGeneration),
        adapterId: "claude-code",
        harnessVersion: "2.1.240",
      }),
    );
    await orchestrator.drain();
    const requests = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    expect(requests).toMatchObject([{ id: "qturn_interrupted_dispatch", state: "interrupted" }]);
    expect(client.runChat).toHaveBeenCalledTimes(1);
  });
  async function enqueueSharedRequest(queuedTurnId: string): Promise<void> {
    await repository.enqueueSharedQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      scopeId: collaborationIds.scope,
      queuedTurnId,
      clientRequestId: crypto.randomUUID(),
      requestingActorId: collaborationActors.editor,
      acceptedAuthEpoch: 1,
      payloadHash: "b".repeat(64),
      expectedRevision: 1,
      parts: [{ type: "text", text: "Shared prompt" }],
      driverKind: "claude_code",
      selection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: {
        revision: "scope-runtime-chat-v1-1", rootChat: true, attachments: [], resources: [], tools: [],
        approvals: false, userInput: false, resume: false, cancellation: true, steering: "none",
        worktrees: "none", interactionModes: ["default"], permissionModes: ["supervised"],
      },
      acceptedAt: now,
    });
  }
  async function seedSharedChat(): Promise<void> {
    await fixture.db.insertInto("chats").values({
      id: collaborationIds.chat, owner_type: "personal", owner_id: collaborationActors.owner,
      create_request_id: "req_shared_orchestrator", project_id: null, title: "Shared orchestrator",
      lifecycle: "active", attention: "none", revision: 1, message_count: 0,
      collaboration: JSON.stringify({ scopeId: collaborationIds.scope, mode: "shared_ai", executionFenced: true }),
      user_state: null, shell_state: null, fork_provenance: null, last_message_preview: null,
      current_selection: null, bound_driver_kind: null, bound_instance_id: null, bound_at_turn_id: null,
      created_at: now, updated_at: now,
    }).execute();
    await fixture.db.insertInto("collaboration_scopes").values({
      id: collaborationIds.scope, owner_type: "personal", owner_id: collaborationActors.owner,
      kind: "chat", resource_id: collaborationIds.chat, parent_scope_id: null, membership_mode: "direct",
      lifecycle: "shared", revision: 1, auth_epoch: 1, authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1, execution_generation: 7,
      execution_eligibility: JSON.stringify({
        profileId: "scope-runtime-chat-v1", profileVersion: 1, profileDigest: "a".repeat(64),
        adapterId: "claude-code", harnessVersion: "2.1.240",
      }),
      deleted_at: null, created_at: now, updated_at: now,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values([
      member(collaborationActors.owner, "owner"), member(collaborationActors.editor, "editor"),
    ]).execute();
  }
});
function member(actorId: string, role: "owner" | "editor") {
  return {
    scope_id: collaborationIds.scope, actor_id: actorId, role, status: "accepted" as const,
    invitation_id: null, invited_by: collaborationActors.owner, accepted_at: now, expires_at: null,
    revision: 1, joined_at: now, updated_at: now,
  };
}
