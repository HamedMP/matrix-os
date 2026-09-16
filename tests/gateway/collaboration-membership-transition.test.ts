import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createProjectTransitionJournal } from "../../packages/gateway/src/collaboration/project-transition.js";
import {
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const PROJECT_SCOPE_ID = "10000000-0000-4000-8000-000000000201";
const CHAT_SCOPE_ID = "10000000-0000-4000-8000-000000000202";
const TERMINAL_SCOPE_ID = "10000000-0000-4000-8000-000000000203";
const TRANSITION_ID = "20000000-0000-4000-8000-000000000201";
const OWNER_ID = "user_project_owner";
const PROJECT_EDITOR_ID = "user_project_editor";
const ITEM_ONLY_ID = "user_item_only";
const SOURCE_RUNTIME = "runtime_project_owner";
const DESTINATION_RUNTIME = "runtime_project_shared";
const INVENTORY_HASH = "a".repeat(64);
const MEMBERSHIP_HASH = "b".repeat(64);
const NOW = new Date("2026-08-19T12:00:00.000Z");

describe("project membership publication transition", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedProjectAndDirectChildren(fixture);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("ends direct item grants without promoting item-only actors when project inheritance publishes", async () => {
    const transitions = createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      createTransitionId: () => TRANSITION_ID,
    });

    await transitions.prepare({
      scopeId: PROJECT_SCOPE_ID,
      ownerId: OWNER_ID,
      requestedBy: OWNER_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000053",
      payloadHash: "c".repeat(64),
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
      destinationAuthorityGeneration: 2,
    });
    await transitions.beginStaging(TRANSITION_ID);
    await transitions.recordStagedManifest(TRANSITION_ID, "manifest_membership_transition");
    await transitions.markFenced({
      transitionId: TRANSITION_ID,
      sourceFenceEpoch: 8,
      currentInventoryRevision: 7,
      currentInventoryHash: INVENTORY_HASH,
      currentMembershipHash: MEMBERSHIP_HASH,
    });
    await transitions.beginCommit(TRANSITION_ID);
    await transitions.recordPublication(TRANSITION_ID, "publication_membership_transition");

    await expect(transitions.activate(TRANSITION_ID)).resolves.toMatchObject({ status: "active" });

    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select([
        "id", "parent_scope_id", "membership_mode", "lifecycle", "auth_epoch",
        "authority_runtime_id", "authority_generation",
      ])
      .where("id", "in", [CHAT_SCOPE_ID, TERMINAL_SCOPE_ID])
      .orderBy("id", "asc")
      .execute()).resolves.toEqual([
      {
        id: CHAT_SCOPE_ID,
        parent_scope_id: PROJECT_SCOPE_ID,
        membership_mode: "inherited",
        lifecycle: "shared",
        auth_epoch: 4,
        authority_runtime_id: DESTINATION_RUNTIME,
        authority_generation: 2,
      },
      {
        id: TERMINAL_SCOPE_ID,
        parent_scope_id: PROJECT_SCOPE_ID,
        membership_mode: "inherited",
        lifecycle: "shared",
        auth_epoch: 4,
        authority_runtime_id: DESTINATION_RUNTIME,
        authority_generation: 2,
      },
    ]);
    await expect(fixture.db.selectFrom("collaboration_members")
      .select(["scope_id", "actor_id", "role", "status"])
      .orderBy("scope_id", "asc")
      .orderBy("actor_id", "asc")
      .execute()).resolves.toEqual([
      { scope_id: PROJECT_SCOPE_ID, actor_id: PROJECT_EDITOR_ID, role: "editor", status: "accepted" },
      { scope_id: PROJECT_SCOPE_ID, actor_id: OWNER_ID, role: "owner", status: "accepted" },
    ]);
    await expect(fixture.db.selectFrom("collaboration_members")
      .select("actor_id")
      .where("scope_id", "=", PROJECT_SCOPE_ID)
      .where("actor_id", "=", ITEM_ONLY_ID)
      .executeTakeFirst()).resolves.toBeUndefined();

    const revokedDiscoveries = await fixture.db.selectFrom("collaboration_directory_outbox")
      .select(["scope_id", "recipient_actor_ids", "discovery_state"])
      .where("scope_id", "in", [CHAT_SCOPE_ID, TERMINAL_SCOPE_ID])
      .orderBy("scope_id", "asc")
      .execute();
    expect(revokedDiscoveries).toEqual([
      {
        scope_id: CHAT_SCOPE_ID,
        recipient_actor_ids: [ITEM_ONLY_ID, PROJECT_EDITOR_ID],
        discovery_state: "revoked",
      },
      {
        scope_id: TERMINAL_SCOPE_ID,
        recipient_actor_ids: [ITEM_ONLY_ID],
        discovery_state: "revoked",
      },
    ]);
  });

  it("rolls back the publication when a bound direct scope no longer identifies the owned resource", async () => {
    await fixture.db.updateTable("collaboration_scopes")
      .set({ resource_id: "chat_replaced" })
      .where("id", "=", CHAT_SCOPE_ID)
      .execute();
    const transitions = createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      createTransitionId: () => TRANSITION_ID,
    });
    await transitions.prepare({
      scopeId: PROJECT_SCOPE_ID,
      ownerId: OWNER_ID,
      requestedBy: OWNER_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000054",
      payloadHash: "d".repeat(64),
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
      destinationAuthorityGeneration: 2,
    });
    await transitions.beginStaging(TRANSITION_ID);
    await transitions.recordStagedManifest(TRANSITION_ID, "manifest_membership_transition");
    await transitions.markFenced({
      transitionId: TRANSITION_ID,
      sourceFenceEpoch: 8,
      currentInventoryRevision: 7,
      currentInventoryHash: INVENTORY_HASH,
      currentMembershipHash: MEMBERSHIP_HASH,
    });
    await transitions.beginCommit(TRANSITION_ID);
    await transitions.recordPublication(TRANSITION_ID, "publication_membership_transition");

    await expect(transitions.activate(TRANSITION_ID)).rejects.toMatchObject({ code: "conflict" });
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "membership_mode", "parent_scope_id"])
      .where("id", "=", CHAT_SCOPE_ID)
      .executeTakeFirstOrThrow()).resolves.toEqual({
      lifecycle: "shared",
      membership_mode: "direct",
      parent_scope_id: null,
    });
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "authority_runtime_id"])
      .where("id", "=", PROJECT_SCOPE_ID)
      .executeTakeFirstOrThrow()).resolves.toEqual({
      lifecycle: "preparing",
      authority_runtime_id: SOURCE_RUNTIME,
    });
  });
});

async function seedProjectAndDirectChildren(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("collaboration_scopes").values([
    scope(PROJECT_SCOPE_ID, "project", "proj_alpha", {
      lifecycle: "private",
      revision: 4,
      authEpoch: 0,
      authorityRuntimeId: SOURCE_RUNTIME,
      authorityGeneration: 3,
    }),
    scope(CHAT_SCOPE_ID, "chat", "chat_owned"),
    scope(TERMINAL_SCOPE_ID, "terminal", "terminal_owned"),
  ]).execute();
  await fixture.db.insertInto("collaboration_members").values([
    member(PROJECT_SCOPE_ID, OWNER_ID, "owner"),
    member(PROJECT_SCOPE_ID, PROJECT_EDITOR_ID, "editor"),
    member(CHAT_SCOPE_ID, OWNER_ID, "owner"),
    member(CHAT_SCOPE_ID, ITEM_ONLY_ID, "viewer"),
    member(CHAT_SCOPE_ID, PROJECT_EDITOR_ID, "viewer"),
    member(TERMINAL_SCOPE_ID, OWNER_ID, "owner"),
    member(TERMINAL_SCOPE_ID, ITEM_ONLY_ID, "editor"),
  ]).execute();
  await fixture.db.insertInto("collaboration_resource_bindings").values([
    binding("30000000-0000-4000-8000-000000000201", CHAT_SCOPE_ID, "chat", "chat_owned"),
    binding("30000000-0000-4000-8000-000000000202", TERMINAL_SCOPE_ID, "terminal", "terminal_owned"),
  ]).execute();
}

function scope(
  id: string,
  kind: "chat" | "terminal" | "project",
  resourceId: string,
  overrides: Partial<{
    lifecycle: "private" | "shared";
    revision: number;
    authEpoch: number;
    authorityRuntimeId: string;
    authorityGeneration: number;
  }> = {},
) {
  return {
    id,
    owner_type: "personal" as const,
    owner_id: OWNER_ID,
    kind,
    resource_id: resourceId,
    parent_scope_id: null,
    membership_mode: "direct" as const,
    lifecycle: overrides.lifecycle ?? "shared",
    revision: overrides.revision ?? 2,
    auth_epoch: overrides.authEpoch ?? 3,
    authority_runtime_id: overrides.authorityRuntimeId ?? SOURCE_RUNTIME,
    authority_generation: overrides.authorityGeneration ?? 3,
    execution_generation: null,
    execution_eligibility: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
}

function member(scopeId: string, actorId: string, role: "owner" | "editor" | "viewer") {
  return {
    scope_id: scopeId,
    actor_id: actorId,
    role,
    status: "accepted" as const,
    invitation_id: null,
    invited_by: OWNER_ID,
    accepted_at: NOW,
    expires_at: null,
    revision: 1,
    joined_at: NOW,
    updated_at: NOW,
  };
}

function binding(
  id: string,
  resourceScopeId: string,
  kind: "chat" | "terminal",
  resourceId: string,
) {
  return {
    id,
    project_scope_id: PROJECT_SCOPE_ID,
    resource_scope_id: resourceScopeId,
    resource_kind: kind,
    resource_id: resourceId,
    authority_runtime_id: DESTINATION_RUNTIME,
    authority_generation: 2,
    revision: 2,
    readiness: "ready" as const,
    blocker: null,
    incarnation: kind === "terminal" ? "incarnation_owned" : null,
    created_at: NOW,
    updated_at: NOW,
  };
}
