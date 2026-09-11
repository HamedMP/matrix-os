import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  ProjectTransitionError,
  createProjectTransitionJournal,
} from "../../packages/gateway/src/collaboration/project-transition.js";
import {
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const SCOPE_ID = "10000000-0000-4000-8000-000000000051";
const TRANSITION_ID = "20000000-0000-4000-8000-000000000051";
const CLIENT_REQUEST_ID = "50000000-0000-4000-8000-000000000051";
const OWNER_ID = "user_project_owner";
const SOURCE_RUNTIME = "runtime_project_owner";
const DESTINATION_RUNTIME = "vps:runtime_project_shared";
const INVENTORY_HASH = "a".repeat(64);
const MEMBERSHIP_HASH = "b".repeat(64);
const PAYLOAD_HASH = "c".repeat(64);
const NOW = new Date("2026-08-11T12:00:00.000Z");

async function seedProjectScope(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("collaboration_scopes").values({
    id: SCOPE_ID,
    owner_type: "personal",
    owner_id: OWNER_ID,
    kind: "project",
    resource_id: "proj_alpha",
    parent_scope_id: null,
    membership_mode: "direct",
    lifecycle: "private",
    revision: 4,
    auth_epoch: 0,
    authority_runtime_id: SOURCE_RUNTIME,
    authority_generation: 3,
    execution_generation: null,
    execution_eligibility: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  }).execute();
}

describe("project collaboration transition journal", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedProjectScope(fixture);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  function journal() {
    return createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      createTransitionId: () => TRANSITION_ID,
    });
  }

  async function prepare() {
    return journal().prepare({
      scopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      requestedBy: OWNER_ID,
      clientRequestId: CLIENT_REQUEST_ID,
      payloadHash: PAYLOAD_HASH,
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
      destinationAuthorityGeneration: 1,
    });
  }

  it("atomically prepares one transition and fences duplicate preparation", async () => {
    await expect(journal().prepare({
      scopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      requestedBy: "user_not_owner",
      clientRequestId: CLIENT_REQUEST_ID,
      payloadHash: PAYLOAD_HASH,
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
      destinationAuthorityGeneration: 1,
    })).rejects.toMatchObject({ code: "conflict" });
    await expect(prepare()).resolves.toMatchObject({
      id: TRANSITION_ID,
      scopeId: SCOPE_ID,
      status: "prepared",
      sourceAuthorityRuntimeId: SOURCE_RUNTIME,
      sourceAuthorityGeneration: 3,
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
    });
    await expect(prepare()).resolves.toMatchObject({ id: TRANSITION_ID, status: "prepared" });
    await expect(journal().prepare({
      scopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      requestedBy: OWNER_ID,
      clientRequestId: CLIENT_REQUEST_ID,
      payloadHash: "d".repeat(64),
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
      destinationAuthorityGeneration: 1,
    })).rejects.toBeInstanceOf(ProjectTransitionError);
    await expect(fixture.db.selectFrom("collaboration_operations")
      .select(["operation_kind", "payload_hash", "status", "result_ref"])
      .where("scope_id", "=", SCOPE_ID)
      .where("actor_id", "=", OWNER_ID)
      .where("client_request_id", "=", CLIENT_REQUEST_ID)
      .executeTakeFirstOrThrow()).resolves.toMatchObject({
      operation_kind: "project.confirm",
      payload_hash: PAYLOAD_HASH,
      status: "completed",
      result_ref: { transitionId: TRANSITION_ID },
    });

    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "authority_runtime_id", "authority_generation"])
      .where("id", "=", SCOPE_ID).executeTakeFirstOrThrow()).resolves.toEqual({
      lifecycle: "preparing",
      authority_runtime_id: SOURCE_RUNTIME,
      authority_generation: 3,
    });
  });

  it("moves to a new authority generation on the same owner runtime", async () => {
    await expect(journal().prepare({
      scopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      requestedBy: OWNER_ID,
      clientRequestId: CLIENT_REQUEST_ID,
      payloadHash: PAYLOAD_HASH,
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: SOURCE_RUNTIME,
      destinationAuthorityGeneration: 4,
    })).resolves.toMatchObject({
      sourceAuthorityRuntimeId: SOURCE_RUNTIME,
      sourceAuthorityGeneration: 3,
      destinationAuthorityRuntimeId: SOURCE_RUNTIME,
      destinationAuthorityGeneration: 4,
    });
  });

  it("requires ordered durable stages and publishes the destination authority exactly once", async () => {
    const transitions = journal();
    await prepare();
    const childScopeId = "10000000-0000-4000-8000-000000000052";
    await fixture.db.insertInto("collaboration_scopes").values({
      id: childScopeId,
      owner_type: "personal",
      owner_id: OWNER_ID,
      kind: "chat",
      resource_id: "chat_project",
      parent_scope_id: SCOPE_ID,
      membership_mode: "inherited",
      lifecycle: "preparing",
      revision: 1,
      auth_epoch: 0,
      authority_runtime_id: DESTINATION_RUNTIME,
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_resource_bindings").values({
      id: "30000000-0000-4000-8000-000000000051",
      project_scope_id: SCOPE_ID,
      resource_scope_id: childScopeId,
      resource_kind: "chat",
      resource_id: "chat_project",
      authority_runtime_id: DESTINATION_RUNTIME,
      authority_generation: 1,
      revision: 1,
      readiness: "ready",
      blocker: null,
      incarnation: null,
      created_at: NOW,
      updated_at: NOW,
    }).execute();
    await transitions.beginStaging(TRANSITION_ID);
    await transitions.recordStagedManifest(TRANSITION_ID, "manifest_11111111111111111111111111111111");
    await expect(transitions.markFenced({
      transitionId: TRANSITION_ID,
      sourceFenceEpoch: 8,
      currentInventoryRevision: 7,
      currentInventoryHash: INVENTORY_HASH,
      currentMembershipHash: MEMBERSHIP_HASH,
    })).resolves.toBe(true);
    await transitions.beginCommit(TRANSITION_ID);
    await transitions.recordPublication(TRANSITION_ID, "publication_11111111111111111111111111111111");

    const first = await transitions.activate(TRANSITION_ID);
    const second = await transitions.activate(TRANSITION_ID);
    expect(first.status).toBe("active");
    expect(second.status).toBe("active");
    expect(await fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "revision", "authority_runtime_id", "authority_generation"])
      .where("id", "=", SCOPE_ID).executeTakeFirstOrThrow()).toEqual({
      lifecycle: "shared",
      revision: 5,
      authority_runtime_id: DESTINATION_RUNTIME,
      authority_generation: 1,
    });
    expect(await fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "membership_mode", "parent_scope_id", "authority_runtime_id"])
      .where("id", "=", childScopeId).executeTakeFirstOrThrow()).toEqual({
      lifecycle: "shared",
      membership_mode: "inherited",
      parent_scope_id: SCOPE_ID,
      authority_runtime_id: DESTINATION_RUNTIME,
    });
    expect(await fixture.db.selectFrom("collaboration_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("scope_id", "=", SCOPE_ID)
      .where("event_type", "=", "project.transition.active")
      .executeTakeFirstOrThrow()).toEqual({ count: 1 });
  });

  it("publishes accepted and pending members only after activation at the destination authority", async () => {
    const editorId = "user_project_editor";
    const inviteeId = "user_project_invitee";
    const invitationId = "40000000-0000-4000-8000-000000000051";
    for (const member of [
      {
        scope_id: SCOPE_ID,
        actor_id: OWNER_ID,
        role: "owner" as const,
        status: "accepted" as const,
        invitation_id: null,
        accepted_at: NOW,
      },
      {
        scope_id: SCOPE_ID,
        actor_id: editorId,
        role: "editor" as const,
        status: "accepted" as const,
        invitation_id: null,
        accepted_at: NOW,
      },
      {
        scope_id: SCOPE_ID,
        actor_id: inviteeId,
        role: "viewer" as const,
        status: "pending" as const,
        invitation_id: invitationId,
        accepted_at: null,
        expires_at: new Date("2026-09-18T12:00:00.000Z"),
      },
    ]) {
      await fixture.db.insertInto("collaboration_members").values({
        ...member,
        invited_by: OWNER_ID,
        expires_at: "expires_at" in member ? member.expires_at : null,
        revision: 1,
        joined_at: member.status === "accepted" ? member.accepted_at : null,
        updated_at: NOW,
      }).execute();
    }
    const transitions = journal();
    await prepare();
    await transitions.beginStaging(TRANSITION_ID);
    await transitions.recordStagedManifest(TRANSITION_ID, "manifest_11111111111111111111111111111111");
    await transitions.markFenced({
      transitionId: TRANSITION_ID,
      sourceFenceEpoch: 8,
      currentInventoryRevision: 7,
      currentInventoryHash: INVENTORY_HASH,
      currentMembershipHash: MEMBERSHIP_HASH,
    });
    await transitions.beginCommit(TRANSITION_ID);
    await transitions.recordPublication(TRANSITION_ID, "publication_11111111111111111111111111111111");

    expect(await fixture.db.selectFrom("collaboration_directory_outbox")
      .select("event_id").where("scope_id", "=", SCOPE_ID).execute()).toEqual([]);
    await transitions.activate(TRANSITION_ID);
    await expect(fixture.db.selectFrom("collaboration_directory_outbox")
      .select(["recipient_actor_ids", "authority_runtime_id", "authority_generation", "discovery_state"])
      .where("scope_id", "=", SCOPE_ID).orderBy("discovery_state", "asc").execute()).resolves.toEqual([
      {
        recipient_actor_ids: [{ actorId: OWNER_ID }, { actorId: editorId }],
        authority_runtime_id: DESTINATION_RUNTIME,
        authority_generation: 1,
        discovery_state: "accepted",
      },
      {
        recipient_actor_ids: [{ actorId: inviteeId, invitationId }],
        authority_runtime_id: DESTINATION_RUNTIME,
        authority_generation: 1,
        discovery_state: "invited",
      },
    ]);
  });

  it("invalidates stale confirmation under the fence and preserves the source authority", async () => {
    const transitions = journal();
    await prepare();
    await transitions.beginStaging(TRANSITION_ID);
    await transitions.recordStagedManifest(TRANSITION_ID, "manifest_11111111111111111111111111111111");

    await expect(transitions.markFenced({
      transitionId: TRANSITION_ID,
      sourceFenceEpoch: 8,
      currentInventoryRevision: 8,
      currentInventoryHash: "c".repeat(64),
      currentMembershipHash: MEMBERSHIP_HASH,
    })).resolves.toBe(false);

    expect(await transitions.get(TRANSITION_ID)).toMatchObject({
      status: "recovering",
      errorCode: "inventory_changed",
    });
    expect(await fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "authority_runtime_id", "authority_generation"])
      .where("id", "=", SCOPE_ID).executeTakeFirstOrThrow()).toEqual({
      lifecycle: "recovering",
      authority_runtime_id: SOURCE_RUNTIME,
      authority_generation: 3,
    });
    await transitions.recover({
      cleanupStaging: vi.fn(async () => undefined),
      completePublication: vi.fn(async () => undefined),
    });
    expect(await transitions.get(TRANSITION_ID)).toMatchObject({
      status: "failed",
      errorCode: "inventory_changed",
    });
    expect(await fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "authority_runtime_id", "authority_generation"])
      .where("id", "=", SCOPE_ID).executeTakeFirstOrThrow()).toEqual({
      lifecycle: "private",
      authority_runtime_id: SOURCE_RUNTIME,
      authority_generation: 3,
    });
  });

  it.each(["prepared", "staging", "fenced", "committing"] as const)(
    "recovers a %s crash by cleaning staging and retaining the original",
    async (crashAt) => {
    const transitions = journal();
    await prepare();
    if (crashAt !== "prepared") await transitions.beginStaging(TRANSITION_ID);
    if (crashAt === "fenced" || crashAt === "committing") {
      await transitions.recordStagedManifest(TRANSITION_ID, "manifest_11111111111111111111111111111111");
      await transitions.markFenced({
        transitionId: TRANSITION_ID,
        sourceFenceEpoch: 8,
        currentInventoryRevision: 7,
        currentInventoryHash: INVENTORY_HASH,
        currentMembershipHash: MEMBERSHIP_HASH,
      });
    }
    if (crashAt === "committing") await transitions.beginCommit(TRANSITION_ID);
    const cleanupStaging = vi.fn(async () => undefined);
    const completePublication = vi.fn(async () => undefined);

    await expect(transitions.recover({ cleanupStaging, completePublication })).resolves.toEqual({
      recovered: 1,
      activated: 0,
      failed: 1,
    });
    expect(cleanupStaging).toHaveBeenCalledWith(expect.objectContaining({
      transitionId: TRANSITION_ID,
      ...(crashAt === "fenced" || crashAt === "committing"
        ? {
            stagedManifestRef: "manifest_11111111111111111111111111111111",
            sourceFenceEpoch: 8,
          }
        : {}),
    }));
    expect(completePublication).not.toHaveBeenCalled();
    expect(await transitions.get(TRANSITION_ID)).toMatchObject({ status: "failed", errorCode: "recovered_before_publication" });
    },
  );

  it("finishes destination activation after a durable publication marker", async () => {
    const transitions = journal();
    await prepare();
    await transitions.beginStaging(TRANSITION_ID);
    await transitions.recordStagedManifest(TRANSITION_ID, "manifest_11111111111111111111111111111111");
    await transitions.markFenced({
      transitionId: TRANSITION_ID,
      sourceFenceEpoch: 8,
      currentInventoryRevision: 7,
      currentInventoryHash: INVENTORY_HASH,
      currentMembershipHash: MEMBERSHIP_HASH,
    });
    await transitions.beginCommit(TRANSITION_ID);
    await transitions.recordPublication(TRANSITION_ID, "publication_11111111111111111111111111111111");
    const completePublication = vi.fn(async () => undefined);

    await expect(transitions.recover({
      cleanupStaging: vi.fn(async () => undefined),
      completePublication,
    })).resolves.toEqual({ recovered: 1, activated: 1, failed: 0 });
    expect(completePublication).toHaveBeenCalledWith(expect.objectContaining({
      transitionId: TRANSITION_ID,
      publicationMarker: "publication_11111111111111111111111111111111",
      stagedManifestRef: "manifest_11111111111111111111111111111111",
    }));
    expect(await transitions.get(TRANSITION_ID)).toMatchObject({ status: "active" });
  });

  it("bounds failed recovery work and leaves a truthful retryable journal state", async () => {
    const transitions = journal();
    await prepare();
    await transitions.beginStaging(TRANSITION_ID);
    const bounded = createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      recoveryTimeoutMs: 5,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(bounded.recover({
        cleanupStaging: async () => new Promise<void>(() => undefined),
        completePublication: vi.fn(async () => undefined),
      })).resolves.toEqual({ recovered: 0, activated: 0, failed: 0 });
      await expect(bounded.get(TRANSITION_ID)).resolves.toMatchObject({
        status: "recovering",
        retryCount: 1,
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("processes a bounded recovery batch without wedging a larger backlog", async () => {
    const scopes = Array.from({ length: 3 }, (_, index) => ({
      id: `10000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      owner_type: "personal" as const,
      owner_id: OWNER_ID,
      kind: "project" as const,
      resource_id: `proj_backlog_${index}`,
      parent_scope_id: null,
      membership_mode: "direct" as const,
      lifecycle: "preparing" as const,
      revision: 1,
      auth_epoch: 0,
      authority_runtime_id: SOURCE_RUNTIME,
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    }));
    await fixture.db.insertInto("collaboration_scopes").values(scopes).execute();
    await fixture.db.insertInto("collaboration_transitions").values(scopes.map((scope, index) => ({
      id: `20000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
      scope_id: scope.id,
      source_authority_runtime_id: SOURCE_RUNTIME,
      source_authority_generation: 1,
      destination_authority_runtime_id: DESTINATION_RUNTIME,
      destination_authority_generation: 1,
      requested_by: OWNER_ID,
      inventory_revision: 1,
      inventory_hash: INVENTORY_HASH,
      intended_membership_hash: MEMBERSHIP_HASH,
      status: "prepared" as const,
      source_fence_epoch: null,
      staged_manifest_ref: null,
      publication_marker: null,
      retry_count: 0,
      error_code: null,
      created_at: new Date(NOW.getTime() + index),
      updated_at: NOW,
    }))).execute();

    const boundedBatch = createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      recoveryBatchSize: 2,
    });
    await expect(boundedBatch.recover({
      cleanupStaging: vi.fn(async () => undefined),
      completePublication: vi.fn(async () => undefined),
    })).resolves.toEqual({ recovered: 2, activated: 0, failed: 2 });
    await expect(fixture.db.selectFrom("collaboration_transitions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("status", "=", "prepared").executeTakeFirstOrThrow()).resolves.toEqual({ count: 1 });
  });

  it("does not overlap a timed-out recovery callback with a later recovery pass", async () => {
    const transitions = journal();
    await prepare();
    await transitions.beginStaging(TRANSITION_ID);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const cleanupStaging = vi.fn(async () => blocked);
    const bounded = createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      recoveryTimeoutMs: 5,
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await bounded.recover({
        cleanupStaging,
        completePublication: vi.fn(async () => undefined),
      });
      await bounded.recover({
        cleanupStaging,
        completePublication: vi.fn(async () => undefined),
      });

      expect(cleanupStaging).toHaveBeenCalledTimes(1);
      await expect(bounded.get(TRANSITION_ID)).resolves.toMatchObject({
        status: "recovering",
        retryCount: 1,
      });
    } finally {
      release?.();
      await expect.poll(async () => (await bounded.get(TRANSITION_ID))?.status).toBe("failed");
      warning.mockRestore();
    }
  });
});

const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;

realDescribe("project transition real PostgreSQL publication race", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedProjectScope(fixture);
  });

  afterEach(async () => {
    if (fixture) await fixture.destroy();
  });

  it("admits one preparation and publishes one authority under concurrent activation", async () => {
    const createJournal = (id: string) => createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      createTransitionId: () => id,
    });
    const prepareInput = {
      scopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      requestedBy: OWNER_ID,
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
      destinationAuthorityGeneration: 1,
    };
    const firstJournal = createJournal("20000000-0000-4000-8000-000000000061");
    const secondJournal = createJournal("20000000-0000-4000-8000-000000000062");
    const preparations = await Promise.allSettled([
      firstJournal.prepare(prepareInput),
      secondJournal.prepare(prepareInput),
    ]);
    expect(preparations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const accepted = preparations.find((result) => result.status === "fulfilled");
    if (!accepted || accepted.status !== "fulfilled") throw new Error("Transition preparation unavailable");
    const transitionId = accepted.value.id;
    await firstJournal.beginStaging(transitionId);
    await firstJournal.recordStagedManifest(transitionId, "manifest_11111111111111111111111111111111");
    await firstJournal.markFenced({
      transitionId,
      sourceFenceEpoch: 8,
      currentInventoryRevision: 7,
      currentInventoryHash: INVENTORY_HASH,
      currentMembershipHash: MEMBERSHIP_HASH,
    });
    await firstJournal.beginCommit(transitionId);
    await firstJournal.recordPublication(transitionId, "publication_11111111111111111111111111111111");

    const activations = await Promise.all([
      firstJournal.activate(transitionId),
      secondJournal.activate(transitionId),
    ]);
    expect(activations.map((transition) => transition.status)).toEqual(["active", "active"]);
    expect(await fixture.db.selectFrom("collaboration_events")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("scope_id", "=", SCOPE_ID)
      .where("event_type", "=", "project.transition.active")
      .executeTakeFirstOrThrow()).toEqual({ count: "1" });
  });
});
