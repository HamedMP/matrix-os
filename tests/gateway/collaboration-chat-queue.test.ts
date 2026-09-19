import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  collaborationActors,
  collaborationExecutionEligibility,
  collaborationIds,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-09T10:00:00.000Z";
const owner = { type: "personal" as const, ownerId: collaborationActors.owner };
const productionClaudeSelection = { instanceId: "claude_code_default", model: "opus" };
const productionClaudeAuthority = {
  driverKind: "claude_code" as const,
  selection: productionClaudeSelection,
};
const capabilitySnapshot = {
  revision: "shared-catalog-1",
  rootChat: true,
  attachments: [],
  resources: [],
  tools: [],
  approvals: true,
  userInput: false,
  resume: true,
  cancellation: true,
  steering: "none" as const,
  worktrees: "none" as const,
  interactionModes: ["default"],
  permissionModes: ["supervised"],
};

describe("shared Chat canonical queue", () => {
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

  it("accepts work while idle or busy and keeps one active run", async () => {
    const first = await repository.enqueueSharedQueuedTurn(owner, request(1, collaborationActors.owner));
    expect(first).toMatchObject({ acceptedSequence: 1, pendingCount: 1, alreadyAccepted: false });

    const claimed = await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      turnId: "cturn_shared_1",
      runId: "run_shared_1",
      messageId: "msg_shared_1",
      claimedAt: now,
    });
    expect(claimed?.message).toMatchObject({
      actorId: collaborationActors.owner,
      purpose: "ai_request",
    });

    const second = await repository.enqueueSharedQueuedTurn(
      owner,
      request(2, collaborationActors.editor, 3),
    );
    expect(second).toMatchObject({ acceptedSequence: 2, pendingCount: 1 });

    const racingClaims = await Promise.all([
      repository.claimNextQueuedTurn(owner, {
        chatId: collaborationIds.chat,
        turnId: "cturn_shared_2a",
        runId: "run_shared_2a",
        messageId: "msg_shared_2a",
        claimedAt: now,
      }),
      repository.claimNextQueuedTurn(owner, {
        chatId: collaborationIds.chat,
        turnId: "cturn_shared_2b",
        runId: "run_shared_2b",
        messageId: "msg_shared_2b",
        claimedAt: now,
      }),
    ]);
    expect(racingClaims.filter(Boolean)).toHaveLength(0);
    expect(await fixture.db.selectFrom("chat_runs").select("id")
      .where("chat_id", "=", collaborationIds.chat)
      .where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"])
      .execute()).toHaveLength(1);
  });

  it("scopes request idempotency to the actor and rejects payload substitution", async () => {
    const first = await repository.enqueueSharedQueuedTurn(owner, request(10, collaborationActors.owner));
    const replay = await repository.enqueueSharedQueuedTurn(owner, request(10, collaborationActors.owner));
    const otherActor = await repository.enqueueSharedQueuedTurn(
      owner,
      request(10, collaborationActors.editor, 2),
    );

    expect(replay).toEqual({ ...first, alreadyAccepted: true });
    expect(otherActor).toMatchObject({ acceptedSequence: 2, alreadyAccepted: false });
    await expect(repository.enqueueSharedQueuedTurn(owner, {
      ...request(10, collaborationActors.owner),
      payloadHash: "f".repeat(64),
      parts: [{ type: "text", text: "A substituted payload" }],
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not conflate the scope revision with the canonical Chat revision", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({ revision: 2, updated_at: now })
      .where("id", "=", collaborationIds.scope).execute();

    await expect(repository.enqueueSharedQueuedTurn(
      owner,
      request(14, collaborationActors.editor, 1),
    )).resolves.toMatchObject({ acceptedSequence: 1, resourceRevision: 2 });
  });

  it("preserves the production-shaped Claude binding server-side for an editor request", async () => {
    const admitted = await repository.enqueueSharedQueuedTurn(
      owner,
      request(15, collaborationActors.editor),
    );

    expect(admitted.selection).toEqual(productionClaudeSelection);
    const stored = await fixture.db.selectFrom("chat_queued_turns")
      .select(["driver_kind", "instance_id", "selection"])
      .where("id", "=", admitted.id)
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      driver_kind: "claude_code",
      instance_id: "claude_code_default",
      selection: productionClaudeSelection,
    });
  });

  it("keeps an existing Codex binding immutable when an editor requests shared AI", async () => {
    await fixture.db.updateTable("chats").set({
      current_selection: JSON.stringify({ instanceId: "codex_default", model: "gpt-5.6-sol" }),
      bound_driver_kind: "codex",
      bound_instance_id: "codex_default",
      bound_at_turn_id: "cturn_original_codex",
    }).where("id", "=", collaborationIds.chat).execute();

    await expect(repository.enqueueSharedQueuedTurn(
      owner,
      request(16, collaborationActors.editor),
    )).rejects.toMatchObject({ code: "unavailable" });
    await expect(fixture.db.selectFrom("chats")
      .select(["current_selection", "bound_driver_kind", "bound_instance_id", "bound_at_turn_id"])
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow())
      .resolves.toMatchObject({
        current_selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        bound_driver_kind: "codex",
        bound_instance_id: "codex_default",
        bound_at_turn_id: "cturn_original_codex",
      });
  });

  it("requires the owner to establish an unbound shared Chat Provider", async () => {
    await fixture.db.updateTable("chats").set({
      bound_driver_kind: null,
      bound_instance_id: null,
      bound_at_turn_id: null,
    }).where("id", "=", collaborationIds.chat).execute();

    await expect(repository.enqueueSharedQueuedTurn(
      owner,
      request(18, collaborationActors.editor),
    )).rejects.toMatchObject({ code: "unavailable" });
    const admitted = await repository.enqueueSharedQueuedTurn(
      owner,
      { ...request(19, collaborationActors.owner), canonicalProviderAuthority: productionClaudeAuthority },
    );
    expect(admitted.selection).toEqual(productionClaudeSelection);
    await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_owner_initial_binding",
      runId: "run_owner_initial_binding",
      messageId: "msg_owner_initial_binding",
      claimedAt: now,
    });
    await expect(repository.get(owner, collaborationIds.chat)).resolves.toMatchObject({
      providerBinding: {
        driverKind: "claude_code",
        instanceId: "claude_code_default",
        lockedAtTurnId: "cturn_owner_initial_binding",
      },
    });
  });

  it("rejects partial or mismatched immutable bindings without changing provider authority", async () => {
    await fixture.db.updateTable("chats").set({
      bound_driver_kind: "claude_code",
      bound_instance_id: null,
      bound_at_turn_id: "cturn_partial_binding",
    }).where("id", "=", collaborationIds.chat).execute();
    await expect(repository.enqueueSharedQueuedTurn(
      owner,
      request(20, collaborationActors.editor),
    )).rejects.toMatchObject({ code: "unavailable" });

    await fixture.db.updateTable("chats").set({
      bound_driver_kind: "codex",
      bound_instance_id: "claude_code_default",
      bound_at_turn_id: "cturn_mismatched_driver",
    }).where("id", "=", collaborationIds.chat).execute();
    await expect(repository.enqueueSharedQueuedTurn(
      owner,
      request(21, collaborationActors.editor),
    )).rejects.toMatchObject({ code: "unavailable" });
    await expect(fixture.db.selectFrom("chats")
      .select(["current_selection", "bound_driver_kind", "bound_instance_id", "bound_at_turn_id"])
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow())
      .resolves.toMatchObject({
        current_selection: productionClaudeSelection,
        bound_driver_kind: "codex",
        bound_instance_id: "claude_code_default",
        bound_at_turn_id: "cturn_mismatched_driver",
      });
  });

  it("requires current signed isolated-adapter eligibility at admission and claim", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({
      execution_eligibility: JSON.stringify({
        ...collaborationExecutionEligibility(), adapterId: "codex",
      }),
    }).where("id", "=", collaborationIds.scope).execute();
    await expect(repository.enqueueSharedQueuedTurn(
      owner,
      request(22, collaborationActors.editor),
    )).rejects.toMatchObject({ code: "unavailable" });

    await fixture.db.updateTable("collaboration_scopes").set({
      execution_generation: 13,
      execution_eligibility: JSON.stringify(collaborationExecutionEligibility()),
    }).where("id", "=", collaborationIds.scope).execute();
    await repository.enqueueSharedQueuedTurn(owner, request(23, collaborationActors.editor));
    await fixture.db.updateTable("collaboration_scopes").set({
      execution_generation: 14,
      execution_eligibility: JSON.stringify({
        ...collaborationExecutionEligibility(), harnessVersion: "9.9.9",
      }),
    }).where("id", "=", collaborationIds.scope).execute();

    await expect(repository.enqueueSharedQueuedTurn(
      owner,
      request(23, collaborationActors.editor),
    )).rejects.toMatchObject({ code: "unavailable" });

    await expect(repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_changed_eligibility",
      runId: "run_changed_eligibility",
      messageId: "msg_changed_eligibility",
      claimedAt: now,
    })).resolves.toBeNull();
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat))
      .resolves.toEqual([expect.objectContaining({ state: "unavailable" })]);
    expect(await fixture.db.selectFrom("chat_runs").select("id").execute()).toEqual([]);
  });

  it("terminalizes a queued selection that no longer exactly matches canonical authority", async () => {
    const admitted = await repository.enqueueSharedQueuedTurn(
      owner,
      request(25, collaborationActors.editor),
    );
    await fixture.db.updateTable("chat_queued_turns").set({
      selection: JSON.stringify({ instanceId: "claude_code_default", model: "sonnet" }),
    }).where("id", "=", admitted.id).execute();

    await expect(repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_tampered_selection",
      runId: "run_tampered_selection",
      messageId: "msg_tampered_selection",
      claimedAt: now,
    })).resolves.toBeNull();
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat))
      .resolves.toEqual([expect.objectContaining({ state: "unavailable" })]);
    expect(await fixture.db.selectFrom("chats").select("current_selection")
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow())
      .toEqual({ current_selection: productionClaudeSelection });
  });

  it("revalidates accepted membership at claim", async () => {
    await repository.enqueueSharedQueuedTurn(owner, request(24, collaborationActors.editor));
    await fixture.db.updateTable("collaboration_members").set({ status: "revoked", revision: 2 })
      .where("scope_id", "=", collaborationIds.scope)
      .where("actor_id", "=", collaborationActors.editor).execute();
    await fixture.db.updateTable("collaboration_scopes").set({ auth_epoch: 2 })
      .where("id", "=", collaborationIds.scope).execute();

    await expect(repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_revoked_editor",
      runId: "run_revoked_editor",
      messageId: "msg_revoked_editor",
      claimedAt: now,
    })).resolves.toBeNull();
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat))
      .resolves.toEqual([expect.objectContaining({ state: "unauthorized" })]);
  });

  it("terminalizes an incompatible legacy shared request without corrupting owner reads", async () => {
    await fixture.db.updateTable("chats").set({
      current_selection: JSON.stringify({ instanceId: "codex_default", model: "gpt-5.6-sol" }),
      bound_driver_kind: "codex",
      bound_instance_id: "codex_default",
      bound_at_turn_id: "cturn_original_codex",
    }).where("id", "=", collaborationIds.chat).execute();
    await fixture.db.insertInto("chat_queued_turns").values({
      id: "qturn_corrupt_claude",
      chat_id: collaborationIds.chat,
      client_request_id: "req_corrupt_claude",
      actor_request_id: uuid(17),
      requesting_actor_id: collaborationActors.editor,
      collaboration_scope_id: collaborationIds.scope,
      accepted_seq: 1,
      payload_hash: "a".repeat(64),
      accepted_auth_epoch: 1,
      retry_of_queued_turn_id: null,
      position: 1,
      status: "queued",
      parts: JSON.stringify([{ type: "text", text: "Legacy corrupt request" }]),
      driver_kind: "claude_code",
      instance_id: "claude_shared",
      selection: JSON.stringify({ instanceId: "claude_shared", model: "claude-opus-4-6" }),
      interaction_mode: "default",
      permission_mode: "supervised",
      execution_root: null,
      execution_root_fingerprint: null,
      capability_snapshot: JSON.stringify(capabilitySnapshot),
      claimed_turn_id: null,
      claimed_run_id: null,
      cancelled_at: null,
      created_at: now,
      updated_at: now,
    }).execute();

    await expect(repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_should_not_exist",
      runId: "run_should_not_exist",
      messageId: "msg_should_not_exist",
      claimedAt: now,
    })).resolves.toBeNull();
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat))
      .resolves.toEqual([expect.objectContaining({ id: "qturn_corrupt_claude", state: "unavailable" })]);
    await expect(repository.get(owner, collaborationIds.chat)).resolves.toMatchObject({
      chat: { currentSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" } },
      providerBinding: { driverKind: "codex", instanceId: "codex_default" },
    });
  });

  it("allows 32 pending requests and rejects the thirty-third without consuming order", async () => {
    for (let index = 1; index <= 32; index += 1) {
      await expect(repository.enqueueSharedQueuedTurn(
        owner,
        request(index, index % 2 === 0 ? collaborationActors.editor : collaborationActors.owner, index),
      )).resolves.toMatchObject({ acceptedSequence: index, pendingCount: index });
    }

    await expect(repository.enqueueSharedQueuedTurn(owner, request(33, collaborationActors.editor, 33)))
      .rejects.toMatchObject({ code: "capacity" });
    const requests = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    expect(requests).toHaveLength(32);
    expect(requests.map((entry) => entry.acceptedSequence)).toEqual(
      Array.from({ length: 32 }, (_value, index) => index + 1),
    );
  });

  it("rejects admission against a stale canonical Chat revision", async () => {
    await fixture.db.updateTable("chats").set({ revision: 2, updated_at: now })
      .where("id", "=", collaborationIds.chat)
      .where("revision", "=", 1)
      .executeTakeFirstOrThrow();

    await expect(repository.enqueueSharedQueuedTurn(
      owner,
      request(40, collaborationActors.editor, 1),
    )).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat)).resolves.toEqual([]);
  });
});

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;

realDescribe("shared Chat queue real PostgreSQL ordering", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat(fixture);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("claims claude_code_default without rewriting the immutable binding or selection", async () => {
    const admitted = await repository.enqueueSharedQueuedTurn(
      owner,
      request(49, collaborationActors.editor),
    );
    const claimed = await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_real_claude_default",
      runId: "run_real_claude_default",
      messageId: "msg_real_claude_default",
      claimedAt: now,
    });

    expect(admitted.selection).toEqual(productionClaudeSelection);
    expect(claimed?.run).toMatchObject({
      driverKind: "claude_code",
      instanceId: "claude_code_default",
      selection: productionClaudeSelection,
    });
    await expect(fixture.db.selectFrom("chats")
      .select(["current_selection", "bound_driver_kind", "bound_instance_id", "bound_at_turn_id"])
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow())
      .resolves.toMatchObject({
        current_selection: productionClaudeSelection,
        bound_driver_kind: "claude_code",
        bound_instance_id: "claude_code_default",
        bound_at_turn_id: "cturn_original_claude",
      });
  });

  it("serializes simultaneous admissions into one immutable accepted order", async () => {
    const admitted = await Promise.all(Array.from({ length: 12 }, (_value, index) =>
      enqueueAfterConflict(
        repository,
        fixture,
        request(index + 1, index % 2 === 0 ? collaborationActors.owner : collaborationActors.editor),
      )));

    expect(new Set(admitted.map((entry) => entry.acceptedSequence)).size).toBe(12);
    const ordered = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    expect(ordered.map((entry) => entry.acceptedSequence)).toEqual(
      Array.from({ length: 12 }, (_value, index) => index + 1),
    );
  });

  it("enforces the 32-pending ceiling under simultaneous admission", async () => {
    const results = await Promise.allSettled(Array.from({ length: 33 }, (_value, index) =>
      enqueueAfterConflict(
        repository,
        fixture,
        request(index + 1, index % 2 === 0 ? collaborationActors.owner : collaborationActors.editor),
      )));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(32);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: { code: "capacity" } });
    const ordered = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    expect(ordered).toHaveLength(32);
    expect(ordered.map((entry) => entry.acceptedSequence)).toEqual(
      Array.from({ length: 32 }, (_value, index) => index + 1),
    );
  });

  it("serializes actor-scoped idempotency without conflating two actors", async () => {
    const [first, replay, otherActor] = await Promise.all([
      enqueueAfterConflict(repository, fixture, request(40, collaborationActors.owner)),
      enqueueAfterConflict(repository, fixture, request(40, collaborationActors.owner)),
      enqueueAfterConflict(repository, fixture, request(40, collaborationActors.editor)),
    ]);

    expect([first.alreadyAccepted, replay.alreadyAccepted].sort()).toEqual([false, true]);
    expect(first.id).toBe(replay.id);
    expect(otherActor).toMatchObject({ alreadyAccepted: false });
    const ordered = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered.map((entry) => entry.requestingActorId))).toEqual(
      new Set([collaborationActors.owner, collaborationActors.editor]),
    );
  });

  it("serializes initial binding attempts and never lets an editor establish ownership", async () => {
    await fixture.db.updateTable("chats").set({
      bound_driver_kind: null,
      bound_instance_id: null,
      bound_at_turn_id: null,
    }).where("id", "=", collaborationIds.chat).execute();

    const results = await Promise.allSettled([
      repository.enqueueSharedQueuedTurn(owner, {
        ...request(50, collaborationActors.owner),
        canonicalProviderAuthority: productionClaudeAuthority,
      }),
      repository.enqueueSharedQueuedTurn(owner, request(51, collaborationActors.editor)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected"))
      .toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "unavailable" }) })]);

    await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat,
      collaborationScopeId: collaborationIds.scope,
      turnId: "cturn_concurrent_initial_binding",
      runId: "run_concurrent_initial_binding",
      messageId: "msg_concurrent_initial_binding",
      claimedAt: now,
    });
    await expect(fixture.db.selectFrom("chats")
      .select(["bound_driver_kind", "bound_instance_id", "bound_at_turn_id"])
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow())
      .resolves.toEqual({
        bound_driver_kind: "claude_code",
        bound_instance_id: "claude_code_default",
        bound_at_turn_id: "cturn_concurrent_initial_binding",
      });
  });
});

function request(index: number, actorId: string, expectedRevision = 1) {
  return {
    chatId: collaborationIds.chat,
    scopeId: collaborationIds.scope,
    queuedTurnId: `qturn_shared_${index}_${actorId}`,
    clientRequestId: uuid(index),
    requestingActorId: actorId,
    acceptedAuthEpoch: 1,
    payloadHash: index.toString(16).padStart(64, "0"),
    expectedRevision,
    parts: [{ type: "text" as const, text: `Shared request ${index}` }],
    interactionMode: "default",
    permissionMode: "supervised",
    capabilitySnapshot,
    acceptedAt: now,
  };
}

async function enqueueAfterConflict(
  repository: ChatRepository,
  fixture: CollaborationTestDatabase,
  input: ReturnType<typeof request>,
) {
  for (;;) {
    const chat = await fixture.db.selectFrom("chats").select("revision")
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow();
    try {
      return await repository.enqueueSharedQueuedTurn(owner, {
        ...input,
        expectedRevision: Number(chat.revision),
      });
    } catch (error: unknown) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "conflict") throw error;
    }
  }
}

async function seedSharedChat(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    create_request_id: "req_shared_queue_chat",
    project_id: null,
    title: "Shared queue",
    lifecycle: "active",
    attention: "none",
    revision: 1,
    message_count: 0,
    collaboration: JSON.stringify({
      scopeId: collaborationIds.scope,
      mode: "shared_ai",
      executionFenced: true,
    }),
    user_state: null,
    shell_state: null,
    fork_provenance: null,
    last_message_preview: null,
    current_selection: JSON.stringify(productionClaudeSelection),
    bound_driver_kind: "claude_code",
    bound_instance_id: "claude_code_default",
    bound_at_turn_id: "cturn_original_claude",
    created_at: now,
    updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    kind: "chat",
    resource_id: collaborationIds.chat,
    parent_scope_id: null,
    membership_mode: "direct",
    lifecycle: "shared",
    revision: 1,
    auth_epoch: 1,
    authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1,
    execution_generation: 13,
    execution_eligibility: JSON.stringify(collaborationExecutionEligibility()),
    deleted_at: null,
    created_at: now,
    updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_members").values([
    member(collaborationActors.owner, "owner"),
    member(collaborationActors.editor, "editor"),
  ]).execute();
}

function member(actorId: string, role: "owner" | "editor") {
  return {
    scope_id: collaborationIds.scope,
    actor_id: actorId,
    role,
    status: "accepted" as const,
    invitation_id: null,
    invited_by: collaborationActors.owner,
    accepted_at: now,
    expires_at: null,
    revision: 1,
    joined_at: now,
    updated_at: now,
  };
}

function uuid(index: number): string {
  return `75000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
