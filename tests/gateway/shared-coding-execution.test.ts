/**
 * S09 / T045: shared Codex and Claude execution against the canonical Chat queue.
 *
 * Runs on the PGlite fixture by default and on a dedicated PostgreSQL server
 * when MATRIX_TEST_POSTGRES_URL is set (row-lock races are gated on the real
 * server). Covers the locked run-control rules (cancel and tool approval by
 * the requesting member or the scope owner, retry by the requester only),
 * every home-loss mode marking the canonical run interrupted with the
 * requester attributed, preserved-queue re-admission on fresh membership, and
 * the focused Codex/Claude adapters with execution-root sandboxing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CollaborationChatCommands } from "../../packages/gateway/src/chat/collaboration-commands.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { COLLABORATION_VERSIONED_MIGRATIONS } from "../../packages/gateway/src/collaboration/database-migrations.js";
import { CollaborationChatExecutionAdapter } from "../../packages/gateway/src/collaboration/chat-execution-adapter.js";
import {
  COLLABORATION_SHARED_RUN_LOSS_MIGRATION_VERSION,
  CollaborationRunLossRepository,
  classifySharedRunLoss,
  interruptActiveSharedRuns,
  markLostSharedRunsOnStartup,
} from "../../packages/gateway/src/collaboration/shared-run-loss.js";
import { createSharedCodexAdapter } from "../../packages/gateway/src/collaboration/shared-codex-adapter.js";
import {
  SharedChatExecutionCoordinator,
  SharedChatRunPreparationError,
} from "../../packages/gateway/src/chat/shared-execution-coordinator.js";
import { createSharedClaudeAdapter } from "../../packages/gateway/src/collaboration/shared-claude-adapter.js";
import { ScopeRuntimeClientError } from "../../packages/gateway/src/collaboration/scope-runtime-client.js";
import { CollaborationAuthorizationError, type AuthorizedCollaborationContext } from "../../packages/gateway/src/collaboration/authority.js";
import {
  collaborationActors,
  collaborationExecutionEligibility,
  collaborationIds,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-21T09:00:00.000Z";
const owner = { type: "personal" as const, ownerId: collaborationActors.owner };
const otherEditor = "user_collaboration_second_editor";
const hasRealPostgres = Boolean(process.env.MATRIX_TEST_POSTGRES_URL);
const capabilitySnapshot = {
  revision: "shared-catalog-1", rootChat: true, attachments: [], resources: [], tools: [],
  approvals: true, userInput: false, resume: true, cancellation: true, steering: "none" as const,
  worktrees: "none" as const, interactionModes: ["default"], permissionModes: ["supervised"],
};

describe("shared coding execution (S09)", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;
  let loss: CollaborationRunLossRepository;

  beforeEach(async () => {
    fixture = hasRealPostgres ? await createRealCollaborationTestDatabase() : await createCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat(fixture);
    loss = new CollaborationRunLossRepository(fixture.db, { now: () => new Date(now) });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("registers the shared run loss migration after the execution policies", () => {
    expect(COLLABORATION_SHARED_RUN_LOSS_MIGRATION_VERSION).toBe(11);
    const versions = COLLABORATION_VERSIONED_MIGRATIONS.map((step) => step.version);
    expect(versions.slice(0, 9)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(new Set(versions).size).toBe(versions.length);
  });

  describe("run control actors", () => {
    it("rejects member submission before queueing when the effective policy is owner-only", async () => {
      const adapter = new CollaborationChatExecutionAdapter({
        repository, commands: createCommands(),
        resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
        resolveEligibility: async () => collaborationExecutionEligibility(),
        resolveResourceRevision: async () => 1,
        resolveEffectiveSubmitMode: async () => "owner_only",
        requestDispatch: async () => undefined,
      });
      await expect(adapter.submit({ ...readContext(collaborationActors.editor), capability: "request_ai", role: "editor" }, {
        clientRequestId: uuid(69), expectedRevision: "1", text: "Do work",
      })).rejects.toMatchObject({ code: "forbidden" });
      expect(await repository.listSharedQueuedTurns(owner, collaborationIds.chat)).toEqual([]);
    });

    it("uses the parent project authority for an inherited Chat's queue and controls", async () => {
      const parentId = "79000000-0000-4000-8000-000000000999";
      await fixture.db.insertInto("collaboration_scopes").values({
        id: parentId, owner_type: "personal", owner_id: collaborationActors.owner,
        kind: "project", resource_id: "project_s09", parent_scope_id: null, membership_mode: "direct",
        lifecycle: "shared", revision: 1, auth_epoch: 1, authority_runtime_id: collaborationIds.runtime,
        authority_generation: 1, execution_generation: null, organization_id: "org_collaboration_primary",
        execution_eligibility: null, deleted_at: null, created_at: now, updated_at: now,
      }).execute();
      await fixture.db.updateTable("collaboration_members").set({ scope_id: parentId })
        .where("scope_id", "=", collaborationIds.scope).execute();
      await fixture.db.updateTable("collaboration_scopes")
        .set({ parent_scope_id: parentId, membership_mode: "inherited" })
        .where("id", "=", collaborationIds.scope).execute();
      const authorize = async (scopeId: string, actorId: string, action: "request_ai" | "control_execution") => ({
        ...readContext(actorId), scopeId, actorId, membershipScopeId: parentId, capability: action,
        resourceAuthEpoch: 1, membershipAuthEpoch: 1,
        role: actorId === collaborationActors.owner ? "owner" as const : "editor" as const,
      });
      repository.setSharedAuthorizer(authorize);
      const queued = await repository.enqueueSharedQueuedTurn(owner, aiRequest(70, collaborationActors.editor));
      const commands = createCommands(undefined, authorize);
      const cancelled = await commands.cancel(control(collaborationActors.editor, queued.id, 71, 71, await revision()));
      expect(cancelled.request?.state).toBe("cancelled");
      expect(await loss.listDecisions(queued.id)).toMatchObject([
        { kind: "cancel", actorId: collaborationActors.editor, relation: "requester" },
      ]);
    });

    it("admits a standalone Chat Contributor with an S04 grant and no legacy member row", async () => {
      await fixture.db.deleteFrom("collaboration_members")
        .where("scope_id", "=", collaborationIds.scope).where("actor_id", "=", collaborationActors.editor).execute();
      await fixture.db.insertInto("collaboration_grants").values({
        id: "79000000-0000-4000-8000-000000000998", scope_id: collaborationIds.scope,
        organization_id: "org_collaboration_primary", audience_kind: "member",
        audience_actor_id: collaborationActors.editor, preset: "contributor", state: "active",
        policy_version: "v1", source_id: null, legacy_ceiling: null, expires_at: null,
        created_by: collaborationActors.owner, created_at: now, updated_at: now, revoked_at: null,
      }).execute();
      const authorize = async (scopeId: string, actorId: string, action: "request_ai" | "control_execution") => ({
        ...readContext(actorId), scopeId, actorId, membershipScopeId: scopeId, capability: action,
        resourceAuthEpoch: 1, membershipAuthEpoch: 1,
        role: "editor" as const,
      });
      repository.setSharedAuthorizer(authorize);
      const queued = await repository.enqueueSharedQueuedTurn(owner, aiRequest(72, collaborationActors.editor));
      const commands = createCommands(undefined, authorize);
      const cancelled = await commands.cancel(control(collaborationActors.editor, queued.id, 73, 73, await revision()));
      expect(cancelled.request?.state).toBe("cancelled");
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(75, collaborationActors.editor, await revision()));
      expect((await claim("grant_only"))?.sharedExecution?.requestingActorId).toBe(collaborationActors.editor);
      // The S04 departure path currently changes the grant under the scope lock
      // without advancing auth_epoch. The transaction must still reject it.
      await fixture.db.updateTable("collaboration_grants").set({ state: "revoked", revoked_at: now })
        .where("audience_actor_id", "=", collaborationActors.editor).execute();
      await expect(repository.enqueueSharedQueuedTurn(owner, aiRequest(76, collaborationActors.editor, await revision())))
        .rejects.toMatchObject({ code: "forbidden" });
    });

    it("lets the requesting member and the scope owner cancel, and records who decided", async () => {
      const mine = await repository.enqueueSharedQueuedTurn(owner, aiRequest(1, collaborationActors.editor));
      const theirs = await repository.enqueueSharedQueuedTurn(owner, aiRequest(2, collaborationActors.editor, 2));
      const commands = createCommands();
      const byRequester = await commands.cancel(control(collaborationActors.editor, mine.id, 3, 10, await revision()));
      expect(byRequester.request?.state).toBe("cancelled");
      const byOwner = await commands.cancel(control(collaborationActors.owner, theirs.id, 4, 11, await revision()));
      expect(byOwner.request?.state).toBe("cancelled");
      expect(await loss.listDecisions(mine.id)).toMatchObject([
        { kind: "cancel", actorId: collaborationActors.editor, relation: "requester" },
      ]);
      expect(await loss.listDecisions(theirs.id)).toMatchObject([
        { kind: "cancel", actorId: collaborationActors.owner, relation: "scope_owner" },
      ]);
    });

    it("denies cancellation to other Contributors and to Viewers", async () => {
      const queued = await repository.enqueueSharedQueuedTurn(owner, aiRequest(3, collaborationActors.editor));
      const commands = createCommands();
      await expect(commands.cancel(control(otherEditor, queued.id, 5, 12, await revision()))).rejects.toMatchObject({ code: "forbidden" });
      await expect(commands.cancel(control(collaborationActors.viewer, queued.id, 6, 13, await revision()))).rejects.toMatchObject({ code: "forbidden" });
      expect(await loss.listDecisions(queued.id)).toEqual([]);
      await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat))
        .resolves.toMatchObject([{ id: queued.id, state: "queued" }]);
    });

    it("lets only the requesting member retry an interrupted request, never the owner", async () => {
      const queued = await repository.enqueueSharedQueuedTurn(owner, aiRequest(4, collaborationActors.editor));
      const claimed = await claim("retry");
      await repository.finishRun(owner, {
        chatId: collaborationIds.chat, runId: claimed.run.id, outcome: "failed",
        sharedRequestState: "interrupted", completedAt: now,
      });
      const commands = createCommands();
      await expect(commands.retry({
        ...control(collaborationActors.owner, queued.id, 7, 14, await revision()), newRequestId: "qturn_retry_owner",
      })).rejects.toMatchObject({ code: "forbidden" });
      const retried = await commands.retry({
        ...control(collaborationActors.editor, queued.id, 8, 15, await revision()), newRequestId: "qturn_retry_requester",
      });
      expect(retried.request).toMatchObject({ id: "qturn_retry_requester", retryOfRequestId: queued.id, state: "queued" });
      expect(await loss.listDecisions(queued.id)).toMatchObject([
        { kind: "retry", actorId: collaborationActors.editor, relation: "requester" },
      ]);
    });

    it("lets the requesting member or the scope owner answer a tool approval, and nobody else", async () => {
      const run = await activeRunWithApproval("approval_actor_rule", collaborationActors.editor);
      const submitApproval = vi.fn(async () => undefined);
      const commands = createCommands(submitApproval);
      await expect(commands.decideApproval({
        ...control(otherEditor, run.id, 9, 16, await revision()), runId: run.id, approvalId: "approval_actor_rule", decision: "approve",
      })).rejects.toMatchObject({ code: "forbidden" });
      await expect(commands.decideApproval({
        ...control(collaborationActors.viewer, run.id, 10, 17, await revision()), runId: run.id, approvalId: "approval_actor_rule", decision: "approve",
      })).rejects.toMatchObject({ code: "forbidden" });
      const decided = await commands.decideApproval({
        ...control(collaborationActors.editor, run.id, 11, 18, await revision()), runId: run.id, approvalId: "approval_actor_rule", decision: "approve",
      });
      expect(decided).toMatchObject({ kind: "approval", state: "completed" });
      expect(submitApproval).toHaveBeenCalledTimes(1);
      expect(await loss.listDecisions(run.id)).toMatchObject([
        { kind: "tool_approval", actorId: collaborationActors.editor, relation: "requester", approvalId: "approval_actor_rule", decision: "approve" },
      ]);
    });

    it("lets the scope owner answer a member's tool approval and records the owner relation", async () => {
      const run = await activeRunWithApproval("approval_owner_rule", collaborationActors.editor);
      const commands = createCommands();
      await commands.decideApproval({
        ...control(collaborationActors.owner, run.id, 12, 19, await revision()), runId: run.id, approvalId: "approval_owner_rule", decision: "decline",
      });
      expect(await loss.listDecisions(run.id)).toMatchObject([
        { kind: "tool_approval", actorId: collaborationActors.owner, relation: "scope_owner", decision: "decline" },
      ]);
    });
  });

  describe("home loses a run", () => {
    it("preserves the queue while membership evidence is unavailable and rejects a revoked requester", async () => {
      let state: "fresh" | "unavailable" | "revoked" = "fresh";
      repository.setSharedAuthorizer(async (scopeId, actorId, action) => {
        if (state === "unavailable") throw new CollaborationAuthorizationError("unavailable", "Membership projection unavailable");
        if (state === "revoked") throw new CollaborationAuthorizationError("not_found", "Membership ended");
        return {
          ...readContext(actorId), scopeId, actorId, capability: action,
          role: "editor", resourceAuthEpoch: 1, membershipAuthEpoch: 1,
        };
      });
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(74, collaborationActors.editor));
      state = "unavailable";
      await expect(claim("unavailable_evidence", true)).resolves.toBeNull();
      expect(await repository.listSharedQueuedTurns(owner, collaborationIds.chat)).toMatchObject([{ state: "queued" }]);
      state = "revoked";
      await expect(claim("revoked_evidence", true)).resolves.toBeNull();
      expect(await repository.listSharedQueuedTurns(owner, collaborationIds.chat)).toMatchObject([{ state: "unauthorized" }]);
    });

    it.each(["gateway_restart", "scope_runtime_crash", "run_unit_exit", "control_partition"] as const)(
      "marks the run interrupted with the requester attributed for %s",
      async (reason) => {
        await repository.enqueueSharedQueuedTurn(owner, aiRequest(20, collaborationActors.editor));
        const claimed = await claim(`loss_${reason}`);
        await loss.recordInterruption({
          runId: claimed.run.id, scopeId: collaborationIds.scope, chatId: collaborationIds.chat,
          requestId: claimed.sharedExecution ? requestIdOf(claimed.run.id) : "", requestingActorId: collaborationActors.editor, reason,
        });
        await repository.finishRun(owner, {
          chatId: collaborationIds.chat, runId: claimed.run.id, outcome: "failed",
          sharedRequestState: "interrupted", completedAt: now,
        });
        const adapter = createExecutionAdapter();
        const listed = await adapter.list(readContext(collaborationActors.viewer));
        expect(listed).toMatchObject([{
          runId: claimed.run.id, state: "interrupted", interruptedReason: reason,
          actor: { actorId: collaborationActors.editor },
        }]);
        expect(await loss.getInterruption(claimed.run.id)).toMatchObject({ reason, requestingActorId: collaborationActors.editor });
      },
    );

    it("keeps the first recorded loss reason", async () => {
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(21, collaborationActors.editor));
      const claimed = await claim("loss_first");
      const base = { runId: claimed.run.id, scopeId: collaborationIds.scope, chatId: collaborationIds.chat, requestId: requestIdOf(claimed.run.id), requestingActorId: collaborationActors.editor };
      await loss.recordInterruption({ ...base, reason: "scope_runtime_crash" });
      await loss.recordInterruption({ ...base, reason: "gateway_restart" });
      expect((await loss.getInterruption(claimed.run.id))?.reason).toBe("scope_runtime_crash");
    });

    it("attributes a run the gateway lost across a restart as gateway_restart before recovery finishes it", async () => {
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(22, collaborationActors.editor));
      const claimed = await claim("loss_restart");
      const marked = await markLostSharedRunsOnStartup({ db: fixture.db, loss });
      expect(marked).toEqual([claimed.run.id]);
      expect((await loss.getInterruption(claimed.run.id))).toMatchObject({ reason: "gateway_restart", requestingActorId: collaborationActors.editor });
      expect(await markLostSharedRunsOnStartup({ db: fixture.db, loss })).toEqual([]);
    });

    it("interrupts active shared runs as control_partition and stops them through the orchestrator", async () => {
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(23, collaborationActors.editor));
      const claimed = await claim("loss_partition");
      const cancelSharedRun = vi.fn(async (
        _owner: typeof owner, _scopeId: string, _chatId: string, _runId: string,
        options?: { sharedRequestState?: "cancelled" | "interrupted" },
      ) => {
        await repository.finishRun(owner, {
          chatId: collaborationIds.chat, runId: claimed.run.id, outcome: "aborted", completedAt: now,
          ...(options?.sharedRequestState ? { sharedRequestState: options.sharedRequestState } : {}),
        });
      });
      const interrupted = await interruptActiveSharedRuns({
        db: fixture.db, loss, reason: "control_partition", orchestrator: { cancelSharedRun },
      });
      expect(interrupted).toEqual([claimed.run.id]);
      // The home lost the run: the queued request settles as interrupted, never as a member cancel.
      expect(cancelSharedRun).toHaveBeenCalledWith(
        owner, collaborationIds.scope, collaborationIds.chat, claimed.run.id, { sharedRequestState: "interrupted" },
      );
      expect(await fixture.db.selectFrom("chat_queued_turns").select("status")
        .where("claimed_run_id", "=", claimed.run.id).executeTakeFirstOrThrow()).toEqual({ status: "interrupted" });
      const listed = await createExecutionAdapter().list(readContext(collaborationActors.owner));
      expect(listed).toMatchObject([{ runId: claimed.run.id, state: "interrupted", interruptedReason: "control_partition" }]);
    });

    it("re-admits preserved queued requests only for requesters whose membership is still fresh", async () => {
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(24, collaborationActors.editor));
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(25, otherEditor, 2));
      await fixture.db.updateTable("collaboration_members").set({ status: "revoked", revision: 2, updated_at: now })
        .where("scope_id", "=", collaborationIds.scope).where("actor_id", "=", collaborationActors.editor).execute();
      expect(await claim("readmit_1", true)).toBeNull();
      const first = await claim("readmit_2");
      expect(first.sharedExecution?.requestingActorId).toBe(otherEditor);
      await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat)).resolves.toMatchObject([
        { requestingActorId: collaborationActors.editor, state: "unauthorized" },
        { requestingActorId: otherEditor, state: "claimed" },
      ]);
    });

    it("marks every lost run across startup batches, not only the first batch", async () => {
      const secondChat = "chat_collaboration_secondary";
      const secondScope = "10000000-0000-4000-8000-000000000077";
      await fixture.db.insertInto("chats").values({
        id: secondChat, owner_type: "personal", owner_id: collaborationActors.owner,
        create_request_id: "req_s09_chat_2", project_id: null, title: "Shared coding 2",
        lifecycle: "active", attention: "none", revision: 1, message_count: 0,
        collaboration: JSON.stringify({ scopeId: secondScope, mode: "shared_ai", executionFenced: true }),
        user_state: null, shell_state: null, fork_provenance: null, last_message_preview: null,
        current_selection: JSON.stringify({ instanceId: "claude_shared", model: "claude-opus-4-6" }),
        bound_driver_kind: "claude_code", bound_instance_id: "claude_shared", bound_at_turn_id: "cturn_s09_origin_2",
        created_at: now, updated_at: now,
      }).execute();
      await fixture.db.insertInto("collaboration_scopes").values({
        id: secondScope, owner_type: "personal", owner_id: collaborationActors.owner,
        kind: "chat", resource_id: secondChat, parent_scope_id: null, membership_mode: "direct",
        lifecycle: "shared", revision: 1, auth_epoch: 1, authority_runtime_id: collaborationIds.runtime,
        authority_generation: 1, execution_generation: 1, organization_id: "org_collaboration_primary",
        execution_eligibility: JSON.stringify(collaborationExecutionEligibility()),
        deleted_at: null, created_at: now, updated_at: now,
      }).execute();
      await fixture.db.insertInto("collaboration_members").values([
        { ...member(collaborationActors.owner, "owner"), scope_id: secondScope },
        { ...member(collaborationActors.editor, "editor"), scope_id: secondScope },
      ]).execute();
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(26, collaborationActors.editor));
      await repository.enqueueSharedQueuedTurn(owner, { ...aiRequest(27, collaborationActors.editor), chatId: secondChat, scopeId: secondScope });
      const first = await claim("batch_1");
      const second = await repository.claimNextQueuedTurn(owner, {
        chatId: secondChat, turnId: "cturn_batch_2", runId: "run_batch_2", messageId: "msg_batch_2", claimedAt: now,
      });
      expect(second).not.toBeNull();
      const marked = await markLostSharedRunsOnStartup({ db: fixture.db, loss, batchSize: 1 });
      expect(new Set(marked)).toEqual(new Set([first.run.id, second!.run.id]));
      expect(await markLostSharedRunsOnStartup({ db: fixture.db, loss, batchSize: 1 })).toEqual([]);
    });

    it("classifies isolated runtime failures into the frozen loss reasons", () => {
      expect(classifySharedRunLoss(new ScopeRuntimeClientError("runtime_unavailable"), "create")).toBe("scope_runtime_crash");
      expect(classifySharedRunLoss(new ScopeRuntimeClientError("runtime_unavailable"), "inference")).toBe("scope_runtime_crash");
      expect(classifySharedRunLoss(Object.assign(new Error("exited"), { code: "runtime_exited" }), "inference")).toBe("run_unit_exit");
      expect(classifySharedRunLoss(new Error("boom"), "inference")).toBe("run_unit_exit");
      expect(classifySharedRunLoss(new Error("boom"), "projection")).toBeNull();
    });
  });

  describe("run hardening (S09 review)", () => {
    it("lets the requester retry a request cancelled while running, never the owner", async () => {
      const queued = await repository.enqueueSharedQueuedTurn(owner, aiRequest(80, collaborationActors.editor));
      const claimed = await claim("cancel_running");
      const active = {
        controller: new AbortController(),
        adapter: { driverKind: "claude_code", parseState: (state: unknown) => state, cancel: vi.fn(async () => undefined) },
        owner, chatId: collaborationIds.chat, runId: claimed.run.id, instanceId: "claude_shared", sharedScopeId: collaborationIds.scope,
      };
      const coordinator = new SharedChatExecutionCoordinator({
        repository, isClosing: () => false, atCapacity: () => false, hasActiveRun: () => true,
        getActiveRun: (runId) => (runId === claimed.run.id ? active as never : undefined),
        startDispatch: () => { throw new Error("unexpected dispatch"); }, now: () => new Date(now),
      });
      await coordinator.cancel(owner, collaborationIds.scope, collaborationIds.chat, claimed.run.id);
      expect(active.controller.signal.aborted).toBe(true);
      expect(await fixture.db.selectFrom("chat_queued_turns").select("status").where("id", "=", queued.id).executeTakeFirstOrThrow())
        .toEqual({ status: "cancelled" });
      const commands = createCommands();
      await expect(commands.retry({
        ...control(collaborationActors.owner, queued.id, 81, 81, await revision()), newRequestId: "qturn_retry_cancel_owner",
      })).rejects.toMatchObject({ code: "forbidden" });
      const retried = await commands.retry({
        ...control(collaborationActors.editor, queued.id, 82, 82, await revision()), newRequestId: "qturn_retry_cancel_requester",
      });
      expect(retried.request).toMatchObject({ id: "qturn_retry_cancel_requester", retryOfRequestId: queued.id, state: "queued" });
    });

    it("lets the requester retry after a control partition interrupts the run, never the owner", async () => {
      const queued = await repository.enqueueSharedQueuedTurn(owner, aiRequest(83, collaborationActors.editor));
      const claimed = await claim("partition_retry");
      const cancelSharedRun = vi.fn(async (
        runOwner: typeof owner, _scopeId: string, chatId: string, runId: string,
        options?: { sharedRequestState?: "cancelled" | "interrupted" },
      ) => {
        await repository.finishRun(runOwner, {
          chatId, runId, outcome: "aborted", completedAt: now,
          ...(options?.sharedRequestState ? { sharedRequestState: options.sharedRequestState } : {}),
        });
      });
      await interruptActiveSharedRuns({ db: fixture.db, loss, reason: "control_partition", orchestrator: { cancelSharedRun } });
      expect(cancelSharedRun).toHaveBeenCalledWith(
        owner, collaborationIds.scope, collaborationIds.chat, claimed.run.id, { sharedRequestState: "interrupted" },
      );
      expect(await fixture.db.selectFrom("chat_queued_turns").select("status").where("id", "=", queued.id).executeTakeFirstOrThrow())
        .toEqual({ status: "interrupted" });
      const commands = createCommands();
      await expect(commands.retry({
        ...control(collaborationActors.owner, queued.id, 84, 84, await revision()), newRequestId: "qturn_retry_partition_owner",
      })).rejects.toMatchObject({ code: "forbidden" });
      const retried = await commands.retry({
        ...control(collaborationActors.editor, queued.id, 85, 85, await revision()), newRequestId: "qturn_retry_partition_requester",
      });
      expect(retried.request).toMatchObject({ state: "queued", retryOfRequestId: queued.id });
      const listed = await createExecutionAdapter().list(readContext(collaborationActors.owner));
      expect(listed.find((request) => request.id === queued.id))
        .toMatchObject({ state: "interrupted", interruptedReason: "control_partition" });
    });

    it("stops claiming after an unavailable owner source so later requests stay queued", async () => {
      const first = await repository.enqueueSharedQueuedTurn(owner, aiRequest(86, collaborationActors.editor));
      const second = await repository.enqueueSharedQueuedTurn(owner, aiRequest(87, otherEditor, 2));
      const coordinator = new SharedChatExecutionCoordinator({
        repository, isClosing: () => false, atCapacity: () => false, hasActiveRun: () => false,
        getActiveRun: () => undefined, startDispatch: () => { throw new Error("unexpected dispatch"); }, now: () => new Date(now),
      });
      const createAdapter = vi.fn(async () => { throw new SharedChatRunPreparationError("unavailable"); });
      await coordinator.dispatchNextQueued(owner, collaborationIds.chat, collaborationIds.scope, createAdapter);
      expect(createAdapter).toHaveBeenCalledTimes(1);
      await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat)).resolves.toMatchObject([
        { id: first.id, state: "unavailable" },
        { id: second.id, state: "queued" },
      ]);
    });

    it("reports Shared AI unavailable to a member on an owner-only scope before submission", async () => {
      const adapter = new CollaborationChatExecutionAdapter({
        repository, commands: createCommands(),
        resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
        resolveEligibility: async () => collaborationExecutionEligibility(),
        resolveResourceRevision: async () => 1,
        resolveEffectiveSubmitMode: async () => "owner_only",
        requestDispatch: async () => undefined,
      });
      expect((await adapter.capability(readContext(collaborationActors.editor), [])).capability.status).toBe("unavailable");
      expect((await adapter.capability(readContext(collaborationActors.owner), [])).capability.status).toBe("available");
    });

    it("reports Shared AI unavailable to everyone while the owner has selected no source", async () => {
      const adapter = new CollaborationChatExecutionAdapter({
        repository, commands: createCommands(),
        resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
        resolveEligibility: async () => collaborationExecutionEligibility(),
        resolveResourceRevision: async () => 1,
        resolveEffectiveSubmitMode: async () => "members",
        resolveOwnerSourceAdmission: async () => "missing",
        requestDispatch: async () => undefined,
      });
      expect((await adapter.capability(readContext(collaborationActors.owner), [])).capability.status).toBe("unavailable");
      expect((await adapter.capability(readContext(collaborationActors.editor), [])).capability.status).toBe("unavailable");
      await expect(adapter.submit({ ...readContext(collaborationActors.owner), capability: "request_ai", role: "owner" }, {
        clientRequestId: uuid(88), expectedRevision: "1", text: "Do work",
      })).rejects.toMatchObject({ code: "unavailable" });
      expect(await repository.listSharedQueuedTurns(owner, collaborationIds.chat)).toEqual([]);
    });
  });

  describe("focused shared adapters", () => {
    const scopeId = collaborationIds.scope;
    const runtimeHandle = "runtime_33333333333333333333333333333333";
    const sandbox = {
      version: 1 as const,
      scopeHandle: "scope_10000000000040008000000000000001",
      actorId: collaborationActors.editor,
      worktree: { hostPath: "/home/matrix/home/projects/demo", mode: "rw" as const, fingerprint: "a".repeat(64) },
      network: "broker_only" as const,
    };

    function client(overrides: Partial<Record<"createRuntime" | "runChat" | "stopRuntime", unknown>> = {}, adapterId = "codex") {
      return {
        capability: () => ({
          available: true as const, profileId: "scope-runtime-chat-v1", executionGeneration: "7",
          supportedAdapters: [{ adapterId, harnessVersion: "1.0.0", workloads: ["chat_ai" as const] }],
          sandbox: { policyVersion: 1, policyDigest: "b".repeat(64), workloads: ["chat_ai" as const] },
        }),
        createRuntime: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", state: "running" as const })),
        runChat: vi.fn(async () => ({ runtimeHandle, executionGeneration: "7", text: "Rooted answer" })),
        stopRuntime: vi.fn(async () => ({ state: "stopped" })),
        ...overrides,
      } as never;
    }

    /** The adapters require both collaborators; cases that assert other behaviour pass no-ops. */
    const noRuntimes = { bind: () => undefined, release: () => undefined };
    const noLoss = (): void => undefined;

    it("runs Codex on the project root inside the sandbox manifest and binds the runtime", async () => {
      const c = client();
      const bound: unknown[] = [];
      const adapter = createSharedCodexAdapter({
        client: c, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", sandbox,
        runtimes: { bind: (binding) => { bound.push(binding); }, release: () => {} },
        onLoss: noLoss,
      });
      const events = [];
      for await (const event of adapter.start({ ...runInput("codex_default", "gpt-5.6-sol"), executionRoot: "/home/matrix/home/projects/demo" })) events.push(event);
      expect(adapter.driverKind).toBe("codex");
      expect((c as { createRuntime: ReturnType<typeof vi.fn> }).createRuntime).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "codex", workload: "chat_ai", sandbox }));
      expect(bound).toEqual([{ scopeId, actorId: collaborationActors.editor, runtimeHandle }]);
      expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed", provider: "openai" });
    });

    it("runs Claude with the same contract and refuses resume state and non-text parts", async () => {
      const c = client({}, "claude-code");
      const adapter = createSharedClaudeAdapter({ client: c, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", runtimes: noRuntimes, onLoss: noLoss });
      expect(adapter.driverKind).toBe("claude_code");
      const resumed = [];
      for await (const event of adapter.start({ ...runInput(), resumeState: { runtimeHandle, executionGeneration: "7" } })) resumed.push(event);
      expect(resumed).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
      const parts = [];
      for await (const event of adapter.start({ ...runInput(), parts: [{ type: "text", text: "x" }, { type: "tool_request", toolCallId: "call_1", name: "shell", label: "Run shell" }] })) parts.push(event);
      expect(parts).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
      expect((c as { createRuntime: ReturnType<typeof vi.fn> }).createRuntime).not.toHaveBeenCalled();
    });

    it("refuses an execution root without a sandbox manifest", async () => {
      const c = client();
      const adapter = createSharedCodexAdapter({ client: c, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", runtimes: noRuntimes, onLoss: noLoss });
      const events = [];
      for await (const event of adapter.start({ ...runInput("codex_default", "gpt-5.6-sol"), executionRoot: "/home/matrix/home/projects/demo" })) events.push(event);
      expect(events).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
      expect((c as { createRuntime: ReturnType<typeof vi.fn> }).createRuntime).not.toHaveBeenCalled();
    });

    it("refuses an unrooted shared Chat and a root that differs from the signed sandbox mount", async () => {
      const c = client();
      const unrooted = createSharedCodexAdapter({ client: c, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", runtimes: noRuntimes, onLoss: noLoss });
      const unrootedEvents = [];
      for await (const event of unrooted.start(runInput("codex_default", "gpt-5.6-sol"))) unrootedEvents.push(event);
      expect(unrootedEvents).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
      const mismatched = createSharedCodexAdapter({ client: c, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", sandbox, runtimes: noRuntimes, onLoss: noLoss });
      const mismatchedEvents = [];
      for await (const event of mismatched.start({ ...runInput("codex_default", "gpt-5.6-sol"), executionRoot: "/home/matrix/home/projects/other" })) mismatchedEvents.push(event);
      expect(mismatchedEvents).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
      expect((c as { createRuntime: ReturnType<typeof vi.fn> }).createRuntime).not.toHaveBeenCalled();
    });

    it("reports a runtime crash and a run unit exit as loss reasons before failing the run", async () => {
      const crashed = client({ createRuntime: vi.fn(async () => { throw new ScopeRuntimeClientError("runtime_unavailable"); }) });
      const losses: string[] = [];
      const adapter = createSharedCodexAdapter({
        client: crashed, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", sandbox,
        runtimes: noRuntimes, onLoss: (reason) => { losses.push(reason); },
      });
      const events = [];
      for await (const event of adapter.start({ ...runInput("codex_default", "gpt-5.6-sol"), executionRoot: sandbox.worktree.hostPath })) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
      const exited = client({ runChat: vi.fn(async () => { throw Object.assign(new Error("runtime exited"), { code: "runtime_exited" }); }) });
      const adapter2 = createSharedCodexAdapter({
        client: exited, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", sandbox,
        runtimes: noRuntimes, onLoss: (reason) => { losses.push(reason); },
      });
      for await (const event of adapter2.start({ ...runInput("codex_default", "gpt-5.6-sol"), executionRoot: sandbox.worktree.hostPath })) events.push(event);
      expect(losses).toEqual(["scope_runtime_crash", "run_unit_exit"]);
    });

    it("records the loss before the failed terminal event is yielded", async () => {
      const crashed = client({ createRuntime: vi.fn(async () => { throw new ScopeRuntimeClientError("runtime_unavailable"); }) });
      let recorded = false;
      const adapter = createSharedCodexAdapter({
        client: crashed, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", sandbox,
        runtimes: noRuntimes,
        onLoss: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); recorded = true; },
      });
      const events = [];
      for await (const event of adapter.start({ ...runInput("codex_default", "gpt-5.6-sol"), executionRoot: sandbox.worktree.hostPath })) {
        if (event.type === "run.completed") expect(recorded).toBe(true);
        events.push(event);
      }
      expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
    });
  });

  it.skipIf(!hasRealPostgres)("keeps one active run per Chat while different Chats run concurrently (real Postgres)", async () => {
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(30, collaborationActors.editor));
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(31, otherEditor, 2));
    const [first, second] = await Promise.all([claim("race_a", true), claim("race_b", true)]);
    expect([first, second].filter((claimed) => claimed !== null)).toHaveLength(1);
  });

  function createCommands(
    submitApproval = vi.fn(async () => undefined),
    authorize?: (scopeId: string, actorId: string, action: "request_ai" | "control_execution") => Promise<AuthorizedCollaborationContext>,
  ) {
    return new CollaborationChatCommands({
      db: fixture.db,
      now: () => new Date(now),
      submitApproval,
      reconcileApproval: vi.fn(async () => "failed" as const),
      submitCancellation: vi.fn(async () => undefined),
      runControls: loss,
      ...(authorize ? { authorize } : {}),
    });
  }

  function createExecutionAdapter() {
    return new CollaborationChatExecutionAdapter({
      repository,
      commands: createCommands(),
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
      resolveEligibility: async () => collaborationExecutionEligibility(),
      resolveResourceRevision: async () => 1,
      requestDispatch: async () => undefined,
      runLoss: loss,
    });
  }

  async function claim(tag: string, allowNull = false) {
    const claimed = await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat, turnId: `cturn_${tag}`, runId: `run_${tag}`, messageId: `msg_${tag}`, claimedAt: now,
    });
    if (!claimed && !allowNull) throw new Error("Expected claimed run");
    return claimed as NonNullable<typeof claimed>;
  }

  async function revision(): Promise<number> {
    const row = await fixture.db.selectFrom("chats").select("revision").where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow();
    return Number(row.revision);
  }

  function requestIdOf(runId: string): string {
    return `req_for_${runId}`;
  }

  async function activeRunWithApproval(approvalId: string, requester: string) {
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(40 + approvalId.length, requester));
    const claimed = await claim(approvalId);
    await fixture.db.updateTable("chat_runs").set({ status: "waiting_for_approval", started_at: now })
      .where("id", "=", claimed.run.id).execute();
    await fixture.db.insertInto("chat_run_events").values({
      id: `activity_${approvalId}`, chat_id: collaborationIds.chat, run_id: claimed.run.id, run_seq: 1,
      event: JSON.stringify({
        id: `activity_${approvalId}`, chatId: collaborationIds.chat, runId: claimed.run.id, sequence: 1,
        type: "approval.requested", approvalId, title: "Approve scoped action", risk: "high",
        allowedDecisions: ["approve", "decline"], occurredAt: now,
      }),
      occurred_at: now,
    }).execute();
    return claimed.run;
  }
});

function control(actorId: string, requestId: string, index: number, hashSeed: number, expectedRevision: number) {
  return {
    scopeId: collaborationIds.scope, actorId, requestId,
    clientRequestId: uuid(index), payloadHash: hashSeed.toString(16).padStart(64, "0"),
    expectedRevision,
  };
}

function readContext(actorId: string): AuthorizedCollaborationContext {
  return {
    scopeId: collaborationIds.scope, actorId, ownerId: collaborationActors.owner,
    organizationId: "org_collaboration_primary", membershipScopeId: collaborationIds.scope,
    resourceKind: "chat", resourceId: collaborationIds.chat, capability: "read",
    role: actorId === collaborationActors.owner ? "owner" : "viewer", authEpoch: 1,
    authorityRuntimeId: collaborationIds.runtime, authorityGeneration: 1,
  } as AuthorizedCollaborationContext;
}

function runInput(instanceId = "claude_shared", model = "claude-opus-4-6") {
  return {
    owner: { type: "personal" as const, ownerId: collaborationActors.owner },
    chatId: collaborationIds.chat, turnId: "turn_shared", runId: "run_shared",
    prompt: "Shared prompt", parts: [{ type: "text" as const, text: "Shared prompt" }],
    selection: { instanceId, model }, interactionMode: "default", permissionMode: "supervised",
    signal: new AbortController().signal,
  };
}

function aiRequest(index: number, actorId: string, expectedRevision = 1) {
  return {
    chatId: collaborationIds.chat, scopeId: collaborationIds.scope,
    queuedTurnId: `qturn_s09_${index}_${actorId}`, clientRequestId: uuid(index),
    requestingActorId: actorId, acceptedAuthEpoch: 1,
    payloadHash: index.toString(16).padStart(64, "0"), expectedRevision,
    parts: [{ type: "text" as const, text: `Request ${index}` }],
    interactionMode: "default", permissionMode: "supervised", capabilitySnapshot, acceptedAt: now,
  };
}

async function seedSharedChat(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat, owner_type: "personal", owner_id: collaborationActors.owner,
    create_request_id: "req_s09_chat", project_id: null, title: "Shared coding",
    lifecycle: "active", attention: "none", revision: 1, message_count: 0,
    collaboration: JSON.stringify({ scopeId: collaborationIds.scope, mode: "shared_ai", executionFenced: true }),
    user_state: null, shell_state: null, fork_provenance: null, last_message_preview: null,
    current_selection: JSON.stringify({ instanceId: "claude_shared", model: "claude-opus-4-6" }),
    bound_driver_kind: "claude_code", bound_instance_id: "claude_shared", bound_at_turn_id: "cturn_s09_origin",
    created_at: now, updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope, owner_type: "personal", owner_id: collaborationActors.owner,
    kind: "chat", resource_id: collaborationIds.chat, parent_scope_id: null, membership_mode: "direct",
    lifecycle: "shared", revision: 1, auth_epoch: 1, authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1, execution_generation: 1, organization_id: "org_collaboration_primary",
    execution_eligibility: JSON.stringify(collaborationExecutionEligibility()),
    deleted_at: null, created_at: now, updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_members").values([
    member(collaborationActors.owner, "owner"),
    member(collaborationActors.editor, "editor"),
    member(otherEditor, "editor"),
    member(collaborationActors.viewer, "viewer"),
  ]).execute();
}

function member(actorId: string, role: "owner" | "editor" | "viewer") {
  return {
    scope_id: collaborationIds.scope, actor_id: actorId, role, status: "accepted" as const,
    invitation_id: null, invited_by: collaborationActors.owner, accepted_at: now, expires_at: null,
    revision: 1, joined_at: now, updated_at: now,
  };
}

function uuid(index: number): string {
  return `79000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
