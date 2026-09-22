import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { createProjectFence } from "../../packages/gateway/src/collaboration/project-fence.js";
import { createProjectInheritanceResolver } from "../../packages/gateway/src/collaboration/project-inheritance.js";
import { createProjectTransitionCoordinator } from "../../packages/gateway/src/collaboration/project-transition-coordinator.js";
import { createProjectTransitionJournal } from "../../packages/gateway/src/collaboration/project-transition.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const PROJECT_SCOPE = "10000000-0000-4000-8000-000000000191";
const TRANSITION = "20000000-0000-4000-8000-000000000191";
const SECOND_PROJECT_SCOPE = "10000000-0000-4000-8000-000000000192";
const SECOND_TRANSITION = "20000000-0000-4000-8000-000000000192";
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
      organization_id: "org_matrix_team",
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
      {
        ...member("user_invited", "editor"),
        status: "pending" as const,
        invitation_id: "40000000-0000-4000-8000-000000000191",
        accepted_at: null,
        joined_at: null,
        expires_at: new Date("2026-09-18T12:00:00.000Z"),
      },
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
    await expect(fixture.db.selectFrom("collaboration_directory_outbox")
      .select(["recipient_actor_ids", "authority_generation", "discovery_state"])
      .where("scope_id", "=", PROJECT_SCOPE)
      .where("discovery_state", "=", "invited")
      .executeTakeFirstOrThrow()).resolves.toEqual({
      recipient_actor_ids: [{
        actorId: "user_invited",
        invitationId: "40000000-0000-4000-8000-000000000191",
      }],
      authority_generation: 2,
      discovery_state: "invited",
    });
  });

  it("drains every durable prepared transition when the active scheduler is full", async () => {
    await seedSecondProject();
    const transitionIds = [TRANSITION, SECOND_TRANSITION];
    const transitions = createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      createTransitionId: () => transitionIds.shift()!,
      createEventId: uuid,
    });
    await prepareTransition(transitions, PROJECT_SCOPE, "50000000-0000-4000-8000-000000000191");
    await prepareTransition(transitions, SECOND_PROJECT_SCOPE, "50000000-0000-4000-8000-000000000192");
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    let secondStarted = false;
    const coordinator = createProjectTransitionCoordinator({
      db: fixture.db,
      transitions,
      fence: createProjectFence({ db: fixture.db, transitions }),
      inheritance: createProjectInheritanceResolver({ db: fixture.db, now: () => NOW }),
      maxActiveTransitions: 1,
      inventory: {
        preview: async ({ projectId }) => {
          if (projectId === "proj_alpha") {
            signalFirstStarted();
            await firstBlocked;
          } else {
            secondStarted = true;
          }
          return emptyInventory();
        },
      },
    });

    expect(coordinator.schedule(TRANSITION)).toBe(true);
    await firstStarted;
    expect(coordinator.schedule(SECOND_TRANSITION)).toBe(true);
    await expect(transitions.get(SECOND_TRANSITION)).resolves.toMatchObject({ status: "prepared" });
    expect(secondStarted).toBe(false);
    releaseFirst();
    await vi.waitFor(async () => {
      await expect(transitions.get(TRANSITION)).resolves.toMatchObject({ status: "active" });
      await expect(transitions.get(SECOND_TRANSITION)).resolves.toMatchObject({ status: "active" });
    }, { timeout: 5_000 });
    await coordinator.shutdown();
  });

  it("immediately recovers failed asynchronous staging and removes partial bindings", async () => {
    const transitions = createProjectTransitionJournal({
      db: fixture.db,
      now: () => NOW,
      createTransitionId: () => TRANSITION,
      createEventId: uuid,
    });
    await prepareTransition(transitions, PROJECT_SCOPE, "50000000-0000-4000-8000-000000000193");
    const inheritance = createProjectInheritanceResolver({
      db: fixture.db,
      now: () => NOW,
      createBindingId: uuid,
      createScopeId: uuid,
    });
    const coordinator = createProjectTransitionCoordinator({
      db: fixture.db,
      transitions,
      fence: createProjectFence({ db: fixture.db, transitions }),
      inheritance: {
        ...inheritance,
        bindOwnedResource: async (input) => {
          if (input.resourceId === "fail.txt") throw new Error("staging failed");
          return inheritance.bindOwnedResource(input);
        },
      },
      inventory: {
        preview: async () => ({
          ...emptyInventory(),
          ownedItems: [
            { kind: "file" as const, id: "ready.txt", revision: "1", compatibility: "ready" as const },
            { kind: "file" as const, id: "fail.txt", revision: "1", compatibility: "ready" as const },
          ],
        }),
      },
    });

    expect(coordinator.schedule(TRANSITION)).toBe(true);
    await vi.waitFor(async () => {
      await expect(transitions.get(TRANSITION)).resolves.toMatchObject({ status: "failed" });
    }, { timeout: 5_000 });
    await expect(fixture.db.selectFrom("collaboration_resource_bindings")
      .select("id").where("project_scope_id", "=", PROJECT_SCOPE).execute()).resolves.toEqual([]);
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select("lifecycle").where("id", "=", PROJECT_SCOPE).executeTakeFirstOrThrow())
      .resolves.toEqual({ lifecycle: "private" });
    await coordinator.shutdown();
  });

  function emptyInventory() {
    return {
      projectRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      ownedItems: [],
      blockers: [],
    };
  }

  async function seedSecondProject() {
    await fixture.db.insertInto("collaboration_scopes").values({
      id: SECOND_PROJECT_SCOPE,
      owner_type: "personal",
      owner_id: OWNER,
      kind: "project",
      organization_id: "org_matrix_team",
      resource_id: "proj_beta",
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
    await fixture.db.insertInto("collaboration_members").values({
      ...member(OWNER, "owner"),
      scope_id: SECOND_PROJECT_SCOPE,
    }).execute();
  }

  async function prepareTransition(
    transitions: ReturnType<typeof createProjectTransitionJournal>,
    scopeId: string,
    clientRequestId: string,
  ) {
    return transitions.prepare({
      scopeId,
      ownerId: OWNER,
      requestedBy: OWNER,
      clientRequestId,
      payloadHash: "c".repeat(64),
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: RUNTIME,
      destinationAuthorityGeneration: 2,
    });
  }

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
