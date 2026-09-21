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
import { createSharedClaudeAdapter } from "../../packages/gateway/src/collaboration/shared-claude-adapter.js";
import { ScopeRuntimeClientError } from "../../packages/gateway/src/collaboration/scope-runtime-client.js";
import type { AuthorizedCollaborationContext } from "../../packages/gateway/src/collaboration/authority.js";
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
    expect(COLLABORATION_VERSIONED_MIGRATIONS.map((step) => step.version)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  describe("run control actors", () => {
    it("lets the requesting member and the scope owner cancel, and records who decided", async () => {
      const mine = await repository.enqueueSharedQueuedTurn(owner, aiRequest(1, collaborationActors.editor));
      const theirs = await repository.enqueueSharedQueuedTurn(owner, aiRequest(2, collaborationActors.editor, 2));
      const commands = createCommands();
      const byRequester = await commands.cancel(control(collaborationActors.editor, mine.id, 3, 10));
      expect(byRequester.request?.state).toBe("cancelled");
      const byOwner = await commands.cancel(control(collaborationActors.owner, theirs.id, 4, 11));
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
      await expect(commands.cancel(control(otherEditor, queued.id, 5, 12))).rejects.toMatchObject({ code: "forbidden" });
      await expect(commands.cancel(control(collaborationActors.viewer, queued.id, 6, 13))).rejects.toMatchObject({ code: "forbidden" });
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
        ...control(collaborationActors.owner, queued.id, 7, 14), newRequestId: "qturn_retry_owner",
      })).rejects.toMatchObject({ code: "forbidden" });
      const retried = await commands.retry({
        ...control(collaborationActors.editor, queued.id, 8, 15), newRequestId: "qturn_retry_requester",
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
        ...control(otherEditor, run.id, 9, 16), runId: run.id, approvalId: "approval_actor_rule", decision: "approve",
      })).rejects.toMatchObject({ code: "forbidden" });
      await expect(commands.decideApproval({
        ...control(collaborationActors.viewer, run.id, 10, 17), runId: run.id, approvalId: "approval_actor_rule", decision: "approve",
      })).rejects.toMatchObject({ code: "forbidden" });
      const decided = await commands.decideApproval({
        ...control(collaborationActors.editor, run.id, 11, 18), runId: run.id, approvalId: "approval_actor_rule", decision: "approve",
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
        ...control(collaborationActors.owner, run.id, 12, 19), runId: run.id, approvalId: "approval_owner_rule", decision: "decline",
      });
      expect(await loss.listDecisions(run.id)).toMatchObject([
        { kind: "tool_approval", actorId: collaborationActors.owner, relation: "scope_owner", decision: "decline" },
      ]);
    });
  });

  describe("home loses a run", () => {
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
      const cancelSharedRun = vi.fn(async () => {
        await repository.finishRun(owner, { chatId: collaborationIds.chat, runId: claimed.run.id, outcome: "aborted", completedAt: now });
      });
      const interrupted = await interruptActiveSharedRuns({
        db: fixture.db, loss, reason: "control_partition", orchestrator: { cancelSharedRun },
      });
      expect(interrupted).toEqual([claimed.run.id]);
      expect(cancelSharedRun).toHaveBeenCalledWith(owner, collaborationIds.scope, collaborationIds.chat, claimed.run.id);
      const listed = await createExecutionAdapter().list(readContext(collaborationActors.owner));
      expect(listed).toMatchObject([{ runId: claimed.run.id, state: "interrupted", interruptedReason: "control_partition" }]);
    });

    it("re-admits preserved queued requests only for requesters whose membership is still fresh", async () => {
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(24, collaborationActors.editor));
      await repository.enqueueSharedQueuedTurn(owner, aiRequest(25, otherEditor, 2));
      await fixture.db.updateTable("collaboration_members").set({ status: "revoked", revision: 2, updated_at: now })
        .where("scope_id", "=", collaborationIds.scope).where("actor_id", "=", collaborationActors.editor).execute();
      const first = await claim("readmit_1");
      expect(first.sharedExecution?.requestingActorId).toBe(otherEditor);
      await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat)).resolves.toMatchObject([
        { requestingActorId: collaborationActors.editor, state: "unauthorized" },
        { requestingActorId: otherEditor, state: "claimed" },
      ]);
    });

    it("classifies isolated runtime failures into the frozen loss reasons", () => {
      expect(classifySharedRunLoss(new ScopeRuntimeClientError("runtime_unavailable"), "create")).toBe("scope_runtime_crash");
      expect(classifySharedRunLoss(new ScopeRuntimeClientError("runtime_unavailable"), "inference")).toBe("scope_runtime_crash");
      expect(classifySharedRunLoss(Object.assign(new Error("exited"), { code: "runtime_exited" }), "inference")).toBe("run_unit_exit");
      expect(classifySharedRunLoss(new Error("boom"), "inference")).toBe("run_unit_exit");
      expect(classifySharedRunLoss(new Error("boom"), "projection")).toBeNull();
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

    it("runs Codex on the project root inside the sandbox manifest and binds the runtime", async () => {
      const c = client();
      const bound: unknown[] = [];
      const adapter = createSharedCodexAdapter({
        client: c, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", sandbox,
        runtimes: { bind: (binding) => { bound.push(binding); }, release: () => {} },
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
      const adapter = createSharedClaudeAdapter({ client: c, scopeId, executionGeneration: "7", harnessVersion: "1.0.0" });
      expect(adapter.driverKind).toBe("claude_code");
      const resumed = [];
      for await (const event of adapter.start({ ...runInput(), resumeState: { runtimeHandle, executionGeneration: "7" } })) resumed.push(event);
      expect(resumed).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
      const parts = [];
      for await (const event of adapter.start({ ...runInput(), parts: [{ type: "text", text: "x" }, { type: "file", fileId: "f", name: "n", mimeType: "text/plain", sizeBytes: 1 } as never] })) parts.push(event);
      expect(parts).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
      expect((c as { createRuntime: ReturnType<typeof vi.fn> }).createRuntime).not.toHaveBeenCalled();
    });

    it("refuses an execution root without a sandbox manifest", async () => {
      const c = client();
      const adapter = createSharedCodexAdapter({ client: c, scopeId, executionGeneration: "7", harnessVersion: "1.0.0" });
      const events = [];
      for await (const event of adapter.start({ ...runInput("codex_default", "gpt-5.6-sol"), executionRoot: "/home/matrix/home/projects/demo" })) events.push(event);
      expect(events).toMatchObject([{ type: "run.completed", outcome: "failed" }]);
      expect((c as { createRuntime: ReturnType<typeof vi.fn> }).createRuntime).not.toHaveBeenCalled();
    });

    it("reports a runtime crash and a run unit exit as loss reasons before failing the run", async () => {
      const crashed = client({ createRuntime: vi.fn(async () => { throw new ScopeRuntimeClientError("runtime_unavailable"); }) });
      const losses: string[] = [];
      const adapter = createSharedCodexAdapter({
        client: crashed, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", onLoss: (reason) => { losses.push(reason); },
      });
      const events = [];
      for await (const event of adapter.start(runInput("codex_default", "gpt-5.6-sol"))) events.push(event);
      expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "failed" });
      const exited = client({ runChat: vi.fn(async () => { throw Object.assign(new Error("runtime exited"), { code: "runtime_exited" }); }) });
      const adapter2 = createSharedCodexAdapter({
        client: exited, scopeId, executionGeneration: "7", harnessVersion: "1.0.0", onLoss: (reason) => { losses.push(reason); },
      });
      for await (const event of adapter2.start(runInput("codex_default", "gpt-5.6-sol"))) events.push(event);
      expect(losses).toEqual(["scope_runtime_crash", "run_unit_exit"]);
    });
  });

  it.skipIf(!hasRealPostgres)("keeps one active run per Chat while different Chats run concurrently (real Postgres)", async () => {
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(30, collaborationActors.editor));
    await repository.enqueueSharedQueuedTurn(owner, aiRequest(31, otherEditor, 2));
    const [first, second] = await Promise.all([claim("race_a", true), claim("race_b", true)]);
    expect([first, second].filter((claimed) => claimed !== null)).toHaveLength(1);
  });

  function createCommands(submitApproval = vi.fn(async () => undefined)) {
    return new CollaborationChatCommands({
      db: fixture.db,
      now: () => new Date(now),
      submitApproval,
      reconcileApproval: vi.fn(async () => "failed" as const),
      submitCancellation: vi.fn(async () => undefined),
      runControls: loss,
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

function control(actorId: string, requestId: string, index: number, hashSeed: number) {
  return {
    scopeId: collaborationIds.scope, actorId, requestId,
    clientRequestId: uuid(index), payloadHash: hashSeed.toString(16).padStart(64, "0"),
    expectedRevision: 0 as number,
  };
}

function readContext(actorId: string): AuthorizedCollaborationContext {
  return {
    scopeId: collaborationIds.scope, actorId, ownerId: collaborationActors.owner,
    resourceKind: "chat", resourceId: collaborationIds.chat, capability: "read",
    role: actorId === collaborationActors.owner ? "owner" : "viewer", authEpoch: 1, authorityGeneration: 1,
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
