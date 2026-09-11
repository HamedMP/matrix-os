import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createProjectFence } from "../../packages/gateway/src/collaboration/project-fence.js";
import { createProjectInheritanceResolver } from "../../packages/gateway/src/collaboration/project-inheritance.js";
import { createProjectTransitionCoordinator } from "../../packages/gateway/src/collaboration/project-transition-coordinator.js";
import { createProjectTransitionJournal } from "../../packages/gateway/src/collaboration/project-transition.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const PROJECT_SCOPE = "10000000-0000-4000-8000-000000000191";
const TRANSITION = "20000000-0000-4000-8000-000000000191";
const OWNER = "user_owner";
const EDITOR = "user_editor";
const RUNTIME = "vps:11111111-1111-4111-8111-111111111111";
const INVENTORY_HASH = "a".repeat(64);
const MEMBERSHIP_HASH = "b".repeat(64);
const NOW = new Date("2026-09-11T12:00:00.000Z");

describe("whole-project transition integration", () => {
  let fixture: CollaborationTestDatabase;
  let sequence: number;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: PROJECT_SCOPE,
      owner_type: "personal",
      owner_id: OWNER,
      kind: "project",
      resource_id: "proj_alpha",
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "private",
      revision: 4,
      auth_epoch: 0,
      authority_runtime_id: RUNTIME,
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      created_at: NOW,
      updated_at: NOW,
      deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values([
      member(OWNER, "owner"),
      member(EDITOR, "editor"),
    ]).execute();
    sequence = 200;
  });

  afterEach(async () => fixture.destroy());

  it("stages every owned kind and publishes one routable authority", async () => {
    const transitions = createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      createTransitionId: () => TRANSITION,
      createEventId: uuid,
    });
    await transitions.prepare({
      scopeId: PROJECT_SCOPE,
      ownerId: OWNER,
      requestedBy: OWNER,
      clientRequestId: "50000000-0000-4000-8000-000000000191",
      payloadHash: "c".repeat(64),
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: RUNTIME,
      destinationAuthorityGeneration: 2,
    });
    const inventory = {
      projectRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      ownedItems: [
        { kind: "file" as const, id: "README.md", revision: "10:20", compatibility: "ready" as const },
        { kind: "chat" as const, id: "chat_alpha", revision: "4", compatibility: "ready" as const },
        { kind: "app" as const, id: "app_board", revision: "2", compatibility: "ready" as const },
        { kind: "layout" as const, id: "cnv_alpha", revision: "6", compatibility: "ready" as const },
        {
          kind: "terminal" as const,
          id: "terminal-alpha",
          revision: "8",
          compatibility: "ready" as const,
          incarnation: "terminal-11111111111111111111111111111111",
        },
      ],
      blockers: [],
    };
    const coordinator = createProjectTransitionCoordinator({
      db: fixture.db,
      transitions,
      fence: createProjectFence({ db: fixture.db, transitions }),
      inheritance: createProjectInheritanceResolver({
        db: fixture.db,
        now: () => NOW,
        createBindingId: uuid,
        createScopeId: uuid,
      }),
      inventory: { preview: async () => inventory },
    });

    await expect(coordinator.run(TRANSITION)).resolves.toMatchObject({ status: "active" });
    await expect(fixture.db.selectFrom("collaboration_resource_bindings")
      .select(["resource_kind", "resource_id", "authority_runtime_id", "authority_generation"])
      .where("project_scope_id", "=", PROJECT_SCOPE)
      .orderBy("resource_kind", "asc").execute()).resolves.toEqual([
      binding("app", "app_board"),
      binding("chat", "chat_alpha"),
      binding("file", "README.md"),
      binding("layout", "cnv_alpha"),
      binding("terminal", "terminal-alpha"),
    ]);
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["lifecycle", "authority_runtime_id", "authority_generation"])
      .where("id", "=", PROJECT_SCOPE).executeTakeFirstOrThrow()).resolves.toEqual({
      lifecycle: "shared",
      authority_runtime_id: RUNTIME,
      authority_generation: 2,
    });
    const publication = await fixture.db.selectFrom("collaboration_directory_outbox")
      .select(["recipient_actor_ids", "authority_runtime_id", "authority_generation", "discovery_state"])
      .where("scope_id", "=", PROJECT_SCOPE)
      .where("discovery_state", "=", "accepted")
      .orderBy("created_at", "desc").executeTakeFirstOrThrow();
    expect(publication).toMatchObject({
      recipient_actor_ids: [{ actorId: OWNER }, { actorId: EDITOR }],
      authority_runtime_id: RUNTIME,
      authority_generation: 2,
      discovery_state: "accepted",
    });
  });

  function uuid(): string {
    return `30000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
  }

  function member(actorId: string, role: "owner" | "editor") {
    return {
      scope_id: PROJECT_SCOPE,
      actor_id: actorId,
      role,
      status: "accepted" as const,
      invitation_id: null,
      invited_by: OWNER,
      accepted_at: NOW,
      expires_at: null,
      revision: 1,
      joined_at: NOW,
      updated_at: NOW,
    };
  }

  function binding(resourceKind: "app" | "chat" | "file" | "layout" | "terminal", resourceId: string) {
    return {
      resource_kind: resourceKind,
      resource_id: resourceId,
      authority_runtime_id: RUNTIME,
      authority_generation: 2,
    };
  }
});
