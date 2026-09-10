import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-09T10:00:00.000Z";
const owner = { type: "personal" as const, ownerId: collaborationActors.owner };
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

  it("rejects a stale scope revision before accepting shared work", async () => {
    await expect(repository.enqueueSharedQueuedTurn(owner, {
      ...request(14, collaborationActors.editor),
      expectedRevision: 2,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(repository.listSharedQueuedTurns(owner, collaborationIds.chat)).resolves.toEqual([]);
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
      repository.enqueueSharedQueuedTurn(
        owner,
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
      repository.enqueueSharedQueuedTurn(owner, request(40, collaborationActors.owner)),
      repository.enqueueSharedQueuedTurn(owner, request(40, collaborationActors.owner)),
      repository.enqueueSharedQueuedTurn(owner, request(40, collaborationActors.editor)),
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
    driverKind: "claude_code" as const,
    selection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
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
    current_selection: null,
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
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
    execution_generation: 1,
    execution_eligibility: JSON.stringify({
      profileId: "scope-runtime-chat-v1",
      profileVersion: 1,
      profileDigest: "a".repeat(64),
      adapterId: "claude-code",
      harnessVersion: "2.1.240",
    }),
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
