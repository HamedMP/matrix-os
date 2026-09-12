import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CollaborationChatCommands } from "../../packages/gateway/src/chat/collaboration-commands.js";
import { ChatRunLifecycleRepository } from "../../packages/gateway/src/chat/run-lifecycle-repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-09T12:00:00.000Z";
const owner = { type: "personal" as const, ownerId: collaborationActors.owner };
const capabilitySnapshot = {
  revision: "shared-catalog-1", rootChat: true, attachments: [], resources: [], tools: [],
  approvals: true, userInput: false, resume: true, cancellation: true, steering: "none" as const,
  worktrees: "none" as const, interactionModes: ["default"], permissionModes: ["supervised"],
};

describe("shared Chat durable controls", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat(fixture);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("reauthorizes the original actor before claim and records not-executed state", async () => {
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(1, collaborationActors.editor));
    await fixture.db.transaction().execute(async (trx) => {
      await trx.updateTable("collaboration_scopes").set({ auth_epoch: 2 })
        .where("id", "=", collaborationIds.scope).execute();
      await trx.updateTable("collaboration_members").set({ role: "viewer", revision: 2, updated_at: now })
        .where("scope_id", "=", collaborationIds.scope)
        .where("actor_id", "=", collaborationActors.editor).execute();
    });

    await expect(repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      turnId: "cturn_revoked",
      runId: "run_revoked",
      messageId: "msg_revoked",
      claimedAt: now,
    })).resolves.toBeNull();
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat))
      .resolves.toMatchObject([{ state: "unauthorized", requestingActorId: collaborationActors.editor }]);
    expect(await fixture.db.selectFrom("chat_runs").select("id").execute()).toEqual([]);
  });

  it("rejects work accepted under an older scope authorization epoch", async () => {
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(70, collaborationActors.editor));
    await fixture.db.updateTable("collaboration_scopes").set({ auth_epoch: 2, updated_at: now })
      .where("id", "=", collaborationIds.scope).execute();

    await expect(repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      turnId: "cturn_stale_auth_epoch",
      runId: "run_stale_auth_epoch",
      messageId: "msg_stale_auth_epoch",
      claimedAt: now,
    })).resolves.toBeNull();
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat))
      .resolves.toMatchObject([{ state: "unauthorized", requestingActorId: collaborationActors.editor }]);
    expect(await fixture.db.selectFrom("chat_runs").select("id").execute()).toEqual([]);
  });

  it("lets editors cancel only their own request while owners control the scope", async () => {
    const ownerRequest = await repository.enqueueSharedQueuedTurn(owner, aiRequest(1, collaborationActors.owner));
    const editorRequest = await repository.enqueueSharedQueuedTurn(
      owner,
      aiRequest(2, collaborationActors.editor, 2),
    );
    const commands = createCommands();

    await expect(commands.cancel({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      requestId: ownerRequest.id,
      clientRequestId: uuid(101),
      payloadHash: "a".repeat(64),
      expectedRevision: 3,
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(commands.cancel({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      requestId: editorRequest.id,
      clientRequestId: uuid(102),
      payloadHash: "b".repeat(64),
      expectedRevision: 3,
    })).resolves.toMatchObject({ state: "completed", request: { state: "cancelled" } });
    await expect(commands.cancel({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      requestId: ownerRequest.id,
      clientRequestId: uuid(103),
      payloadHash: "c".repeat(64),
      expectedRevision: 4,
    })).resolves.toMatchObject({ state: "completed", request: { state: "cancelled" } });
  });

  it("retries an eligible request as a distinct ordered attempt linked to the original", async () => {
    const original = await repository.enqueueSharedQueuedTurn(owner, aiRequest(1, collaborationActors.editor));
    const commands = createCommands();
    await commands.cancel({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      requestId: original.id,
      clientRequestId: uuid(110),
      payloadHash: "d".repeat(64),
      expectedRevision: 2,
    });

    const retried = await commands.retry({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      requestId: original.id,
      newRequestId: "qturn_shared_retry_1",
      clientRequestId: uuid(111),
      payloadHash: "e".repeat(64),
      expectedRevision: 3,
    });
    expect(retried).toMatchObject({
      state: "completed",
      request: {
        id: "qturn_shared_retry_1",
        requestingActorId: collaborationActors.editor,
        acceptedSequence: 2,
        retryOfRequestId: original.id,
        state: "queued",
      },
    });
  });

  it("durably claims an active editor-owned cancellation before stopping execution", async () => {
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(40, collaborationActors.editor));
    const claimed = await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_active_cancel",
      runId: "run_active_cancel",
      messageId: "msg_active_cancel",
      claimedAt: now,
    });
    if (!claimed) throw new Error("Expected claimed request");
    const submitCancellation = vi.fn(async () => undefined);
    const commands = createCommands(undefined, undefined, submitCancellation);

    await expect(commands.cancel({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      requestId: claimed.queuedTurn.id,
      clientRequestId: uuid(140),
      payloadHash: "8".repeat(64),
      expectedRevision: 3,
    })).resolves.toMatchObject({ state: "completed" });
    expect(submitCancellation).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: collaborationIds.scope,
      chatId: collaborationIds.chat,
      runId: claimed.run.id,
      actorId: collaborationActors.editor,
    }));
  });

  it("claims one competing owner approval decision before calling the adapter", async () => {
    const run = await activeRunWithApproval("approval_shared_1");
    const submitApproval = vi.fn(async () => undefined);
    const commands = createCommands(submitApproval);
    const base = {
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      approvalId: "approval_shared_1",
      runId: run.id,
      expectedRevision: 3,
    };
    await expect(commands.decideApproval({
      ...base, decision: "approve", clientRequestId: uuid(120), payloadHash: "1".repeat(64),
    })).resolves.toMatchObject({ state: "completed", decision: "approve" });
    await expect(commands.decideApproval({
      ...base, decision: "decline", clientRequestId: uuid(121), payloadHash: "2".repeat(64),
    })).rejects.toMatchObject({ code: "conflict" });
    expect(submitApproval).toHaveBeenCalledTimes(1);
  });

  it("reconciles an unknown approval outcome after restart without replaying it", async () => {
    const run = await activeRunWithApproval("approval_shared_unknown");
    const firstDispatch = vi.fn(async () => { throw new Error("connection lost after send"); });
    const input = {
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      approvalId: "approval_shared_unknown",
      runId: run.id,
      decision: "approve" as const,
      clientRequestId: uuid(130),
      payloadHash: "3".repeat(64),
      expectedRevision: 3,
    };
    await expect(createCommands(firstDispatch).decideApproval(input))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(firstDispatch).toHaveBeenCalledOnce();

    const afterRestartDispatch = vi.fn(async () => undefined);
    const reconcileApproval = vi.fn(async () => {
      await settleRunAfterUnknownApproval(run.id);
      return "failed" as const;
    });
    const restarted = createCommands(afterRestartDispatch, reconcileApproval);
    await expect(restarted.decideApproval(input)).resolves.toMatchObject({ state: "failed" });
    expect(afterRestartDispatch).not.toHaveBeenCalled();
    expect(reconcileApproval).toHaveBeenCalledWith(expect.objectContaining({
      commandId: expect.any(String),
      scopeId: collaborationIds.scope,
      chatId: collaborationIds.chat,
      runId: run.id,
      approvalId: "approval_shared_unknown",
    }));
    await expect(fixture.db.selectFrom("chat_runs").select("status")
      .where("id", "=", run.id).executeTakeFirstOrThrow()).resolves.toMatchObject({ status: "failed" });
  });

  it("reconciles an accepted approval reservation left by a crash before dispatch", async () => {
    const run = await activeRunWithApproval("approval_shared_crashed");
    const first = createCommands(vi.fn(async () => { throw new Error("process terminated"); }));
    const input = {
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      approvalId: "approval_shared_crashed",
      runId: run.id,
      decision: "decline" as const,
      clientRequestId: uuid(131),
      payloadHash: "5".repeat(64),
      expectedRevision: 3,
    };
    await expect(first.decideApproval(input)).rejects.toMatchObject({ code: "unavailable" });
    await fixture.db.updateTable("chat_collaboration_commands").set({
      state: "accepted",
      updated_at: "2026-09-09T11:59:00.000Z",
    })
      .where("client_request_id", "=", input.clientRequestId).execute();

    const reconcileApproval = vi.fn(async () => {
      await settleRunAfterUnknownApproval(run.id);
      return "failed" as const;
    });
    const restarted = createCommands(vi.fn(async () => undefined), reconcileApproval);
    await expect(restarted.reconcilePendingApprovals()).resolves.toBe(1);
    await expect(restarted.decideApproval(input)).resolves.toMatchObject({ state: "failed" });
    expect(reconcileApproval).toHaveBeenCalledOnce();
  });

  it("does not reconcile a live accepted approval while dispatch is still in flight", async () => {
    const run = await activeRunWithApproval("approval_shared_live");
    const reconcileApproval = vi.fn(async () => "failed" as const);
    const commands = createCommands(vi.fn(async () => undefined), reconcileApproval);
    await fixture.db.insertInto("chat_collaboration_commands").values({
      id: uuid(232),
      scope_id: collaborationIds.scope,
      chat_id: collaborationIds.chat,
      target_request_id: null,
      run_id: run.id,
      approval_id: "approval_shared_live",
      actor_id: collaborationActors.owner,
      client_request_id: uuid(132),
      kind: "approval",
      payload_hash: "6".repeat(64),
      expected_state_revision: 3,
      decision: "approve",
      authorized_epoch: 1,
      state: "accepted",
      result_ref: JSON.stringify({
        id: uuid(232),
        kind: "approval",
        state: "accepted",
        approvalId: "approval_shared_live",
        decision: "approve",
      }),
      created_at: now,
      updated_at: now,
    }).execute();

    await expect(commands.reconcilePendingApprovals()).resolves.toBe(0);
    expect(reconcileApproval).not.toHaveBeenCalled();
  });

  it("preserves a successful approval after its resolution event leaves the recent window", async () => {
    const run = await activeRunWithApproval("approval_shared_evicted");
    const input = {
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      approvalId: "approval_shared_evicted",
      runId: run.id,
      decision: "approve" as const,
      clientRequestId: uuid(133),
      payloadHash: "7".repeat(64),
      expectedRevision: 3,
    };
    await expect(createCommands(vi.fn(async () => {
      throw new Error("connection lost after successful approval");
    })).decideApproval(input)).rejects.toMatchObject({ code: "unavailable" });
    const lifecycle = new ChatRunLifecycleRepository(
      fixture.db,
      (fn) => fixture.db.transaction().execute(fn),
      async () => undefined,
    );
    await lifecycle.appendRunActivities(owner, collaborationIds.chat, run.id, [{
      id: "activity_approval_shared_evicted_resolved",
      chatId: collaborationIds.chat,
      runId: run.id,
      occurredAt: now,
      type: "approval.resolved",
      approvalId: "approval_shared_evicted",
      decision: "approve",
    }]);
    await fixture.db.deleteFrom("chat_run_events")
      .where("id", "=", "activity_approval_shared_evicted_resolved")
      .execute();
    await fixture.db.updateTable("chat_runs").set({
      status: "completed",
      outcome: "completed",
      completed_at: now,
      updated_at: now,
    }).where("id", "=", run.id).execute();

    const reconcileApproval = vi.fn(async () => "failed" as const);
    const restarted = createCommands(vi.fn(async () => undefined), reconcileApproval);
    await expect(restarted.reconcilePendingApprovals()).resolves.toBe(1);
    await expect(restarted.decideApproval(input)).resolves.toMatchObject({ state: "completed" });
    expect(reconcileApproval).not.toHaveBeenCalled();
  });

  it("does not infer a specific approval succeeded from the terminal Run alone", async () => {
    const run = await activeRunWithApproval("approval_shared_without_evidence");
    const input = {
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      approvalId: "approval_shared_without_evidence",
      runId: run.id,
      decision: "approve" as const,
      clientRequestId: uuid(134),
      payloadHash: "9".repeat(64),
      expectedRevision: 3,
    };
    await expect(createCommands(vi.fn(async () => {
      throw new Error("connection lost after ambiguous approval");
    })).decideApproval(input)).rejects.toMatchObject({ code: "unavailable" });
    await fixture.db.updateTable("chat_runs").set({
      status: "completed",
      outcome: "completed",
      completed_at: now,
      updated_at: now,
    }).where("id", "=", run.id).execute();

    const reconcileApproval = vi.fn(async () => "failed" as const);
    const restarted = createCommands(vi.fn(async () => undefined), reconcileApproval);
    await expect(restarted.reconcilePendingApprovals()).resolves.toBe(1);
    await expect(restarted.decideApproval(input)).resolves.toMatchObject({ state: "failed" });
    expect(reconcileApproval).not.toHaveBeenCalled();
  });

  it("rejects a stale control revision without changing the queue", async () => {
    const queued = await repository.enqueueSharedQueuedTurn(owner, aiRequest(60, collaborationActors.editor));
    await expect(createCommands().cancel({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      requestId: queued.id,
      clientRequestId: uuid(160),
      payloadHash: "4".repeat(64),
      expectedRevision: 1,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat))
      .resolves.toMatchObject([{ id: queued.id, state: "queued" }]);
  });

  function createCommands(
    submitApproval = vi.fn(async () => undefined),
    reconcileApproval = vi.fn(async () => "failed" as const),
    submitCancellation = vi.fn(async () => undefined),
  ) {
    return new CollaborationChatCommands({
      db: fixture.db,
      now: () => new Date(now),
      submitApproval,
      reconcileApproval,
      submitCancellation,
    });
  }

  async function activeRunWithApproval(approvalId: string) {
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(50, collaborationActors.owner));
    const claimed = await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      turnId: `cturn_${approvalId}`,
      runId: `run_${approvalId}`,
      messageId: `msg_${approvalId}`,
      claimedAt: now,
    });
    if (!claimed) throw new Error("Expected claimed run");
    await fixture.db.updateTable("chat_runs").set({ status: "waiting_for_approval", started_at: now })
      .where("id", "=", claimed.run.id).execute();
    await fixture.db.insertInto("chat_run_events").values({
      id: `activity_${approvalId}`,
      chat_id: collaborationIds.chat,
      run_id: claimed.run.id,
      run_seq: 1,
      event: JSON.stringify({
        id: `activity_${approvalId}`,
        chatId: collaborationIds.chat,
        runId: claimed.run.id,
        sequence: 1,
        type: "approval.requested",
        approvalId,
        title: "Approve scoped action",
        risk: "high",
        allowedDecisions: ["approve", "decline"],
        occurredAt: now,
      }),
      occurred_at: now,
    }).execute();
    return claimed.run;
  }

  async function settleRunAfterUnknownApproval(runId: string): Promise<void> {
    await fixture.db.transaction().execute(async (trx) => {
      await trx.updateTable("chat_runs").set({
        status: "failed",
        outcome: "failed",
        completed_at: now,
        updated_at: now,
      }).where("id", "=", runId).execute();
      await trx.updateTable("chat_turns").set({ status: "failed", updated_at: now })
        .where("id", "=", `cturn_${runId.slice("run_".length)}`).execute();
      await trx.updateTable("chat_queued_turns").set({ status: "interrupted", updated_at: now })
        .where("claimed_run_id", "=", runId).execute();
    });
  }
});

function aiRequest(index: number, actorId: string, expectedRevision = 1) {
  return {
    chatId: collaborationIds.chat,
    scopeId: collaborationIds.scope,
    queuedTurnId: `qturn_control_${index}_${actorId}`,
    clientRequestId: uuid(index),
    requestingActorId: actorId,
    acceptedAuthEpoch: 1,
    payloadHash: index.toString(16).padStart(64, "0"),
    expectedRevision,
    parts: [{ type: "text" as const, text: `Control request ${index}` }],
    driverKind: "claude_code" as const,
    selection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
    interactionMode: "default",
    permissionMode: "supervised",
    capabilitySnapshot,
    acceptedAt: now,
  };
}

async function seedSharedChat(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat, owner_type: "personal", owner_id: collaborationActors.owner,
    create_request_id: "req_shared_controls_chat", project_id: null, title: "Shared controls",
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
    authority_generation: 1, execution_generation: 1,
    execution_eligibility: JSON.stringify({ profileId: "scope-runtime-chat-v1" }),
    deleted_at: null, created_at: now, updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_members").values([
    member(collaborationActors.owner, "owner"),
    member(collaborationActors.editor, "editor"),
  ]).execute();
}

function member(actorId: string, role: "owner" | "editor") {
  return {
    scope_id: collaborationIds.scope, actor_id: actorId, role, status: "accepted" as const,
    invitation_id: null, invited_by: collaborationActors.owner, accepted_at: now, expires_at: null,
    revision: 1, joined_at: now, updated_at: now,
  };
}

function uuid(index: number): string {
  return `76000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
