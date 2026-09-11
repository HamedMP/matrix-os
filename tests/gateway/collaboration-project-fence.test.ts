import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  ProjectFenceError,
  createProjectFence,
} from "../../packages/gateway/src/collaboration/project-fence.js";
import { createProjectTransitionJournal } from "../../packages/gateway/src/collaboration/project-transition.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const SCOPE_ID = "10000000-0000-4000-8000-000000000081";
const TRANSITION_ID = "20000000-0000-4000-8000-000000000081";
const OWNER_ID = "user_project_owner";
const PROJECT_ID = "proj_alpha";
const SOURCE_RUNTIME = "runtime_project_owner";
const DESTINATION_RUNTIME = "runtime_project_shared";
const INVENTORY_HASH = "a".repeat(64);
const MEMBERSHIP_HASH = "b".repeat(64);
const NOW = new Date("2026-08-13T12:00:00.000Z");

describe("project collaboration writer fence", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: SCOPE_ID,
      owner_type: "personal",
      owner_id: OWNER_ID,
      kind: "project",
      resource_id: PROJECT_ID,
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

  function fence(capacity = 256) {
    return createProjectFence({
      db: fixture.db,
      transitions: journal(),
      capacity,
    });
  }

  async function stage(): Promise<void> {
    const transitions = journal();
    await transitions.prepare({
      scopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      requestedBy: OWNER_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000052",
      payloadHash: "c".repeat(64),
      expectedScopeRevision: 4,
      inventoryRevision: 7,
      inventoryHash: INVENTORY_HASH,
      membershipHash: MEMBERSHIP_HASH,
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME,
      destinationAuthorityGeneration: 1,
    });
    await transitions.beginStaging(TRANSITION_ID);
    await transitions.recordStagedManifest(TRANSITION_ID, "manifest_11111111111111111111111111111111");
  }

  it("admits source legacy writes while staging and returns a fenced admission epoch", async () => {
    await stage();
    const operation = vi.fn(async (admission: { fenceEpoch: number }) => admission.fenceEpoch);

    await expect(fence().withAdmission({
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      authorityRuntimeId: SOURCE_RUNTIME,
      authorityGeneration: 3,
      kind: "write",
      path: "legacy",
    }, operation)).resolves.toBe(0);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("waits for an admitted write before final inventory validation", async () => {
    await stage();
    const projectFence = fence();
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let enteredWrite!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredWrite = resolve;
    });
    const write = projectFence.withAdmission({
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      authorityRuntimeId: SOURCE_RUNTIME,
      authorityGeneration: 3,
      kind: "write",
      path: "legacy",
    }, async () => {
      enteredWrite();
      await writeStarted;
    });
    await entered;
    const inspectCurrent = vi.fn(async () => ({
      inventoryRevision: 8,
      inventoryHash: "c".repeat(64),
      membershipHash: MEMBERSHIP_HASH,
    }));
    const cutover = projectFence.fenceTransition({
      transitionId: TRANSITION_ID,
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      inspectCurrent,
    });

    await Promise.resolve();
    expect(inspectCurrent).not.toHaveBeenCalled();
    releaseWrite();
    await write;
    await expect(cutover).resolves.toBe(false);
    expect(inspectCurrent).toHaveBeenCalledTimes(1);
    await expect(journal().get(TRANSITION_ID)).resolves.toMatchObject({
      status: "recovering",
      errorCode: "inventory_changed",
      sourceFenceEpoch: 1,
    });
  });

  it("rejects delayed legacy writes and runs after a successful fence", async () => {
    await stage();
    const projectFence = fence();
    await expect(projectFence.fenceTransition({
      transitionId: TRANSITION_ID,
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      inspectCurrent: async () => ({
        inventoryRevision: 7,
        inventoryHash: INVENTORY_HASH,
        membershipHash: MEMBERSHIP_HASH,
      }),
    })).resolves.toBe(true);

    for (const kind of ["write", "run"] as const) {
      const operation = vi.fn(async () => undefined);
      await expect(projectFence.withAdmission({
        projectScopeId: SCOPE_ID,
        ownerId: OWNER_ID,
        projectId: PROJECT_ID,
        authorityRuntimeId: SOURCE_RUNTIME,
        authorityGeneration: 3,
        kind,
        path: "legacy",
      }, operation)).rejects.toMatchObject({ code: "fenced" });
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("requires scoped destination admission after publication", async () => {
    await stage();
    const projectFence = fence();
    await projectFence.fenceTransition({
      transitionId: TRANSITION_ID,
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      inspectCurrent: async () => ({
        inventoryRevision: 7,
        inventoryHash: INVENTORY_HASH,
        membershipHash: MEMBERSHIP_HASH,
      }),
    });
    const transitions = journal();
    await transitions.beginCommit(TRANSITION_ID);
    await transitions.recordPublication(TRANSITION_ID, "publication_11111111111111111111111111111111");
    await transitions.activate(TRANSITION_ID);

    await expect(projectFence.withAdmission({
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      authorityRuntimeId: SOURCE_RUNTIME,
      authorityGeneration: 3,
      kind: "write",
      path: "legacy",
    }, async () => undefined)).rejects.toMatchObject({ code: "scope_required" });
    await expect(projectFence.withAdmission({
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      authorityRuntimeId: DESTINATION_RUNTIME,
      authorityGeneration: 1,
      kind: "write",
      path: "scoped",
    }, async (admission) => admission.fenceEpoch)).resolves.toBe(1);
  });

  it("fails closed on identity mismatch and bounds active project coordinators", async () => {
    const projectFence = fence(1);
    await expect(projectFence.withAdmission({
      projectScopeId: SCOPE_ID,
      ownerId: "user_other",
      projectId: PROJECT_ID,
      authorityRuntimeId: SOURCE_RUNTIME,
      authorityGeneration: 3,
      kind: "write",
      path: "legacy",
    }, async () => undefined)).rejects.toBeInstanceOf(ProjectFenceError);

    let release!: () => void;
    const held = projectFence.withAdmission({
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      authorityRuntimeId: SOURCE_RUNTIME,
      authorityGeneration: 3,
      kind: "write",
      path: "legacy",
    }, async () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(projectFence.withAdmission({
      projectScopeId: "10000000-0000-4000-8000-000000000082",
      ownerId: OWNER_ID,
      projectId: "proj_beta",
      authorityRuntimeId: SOURCE_RUNTIME,
      authorityGeneration: 3,
      kind: "write",
      path: "legacy",
    }, async () => undefined)).rejects.toMatchObject({ code: "capacity" });
    release();
    await held;
  });

  it("allows ordinary projects but blocks legacy owner bypass after sharing", async () => {
    const projectFence = fence();
    const ordinary = vi.fn(async () => "ordinary");
    await expect(projectFence.withLegacyAdmission({
      ownerType: "personal",
      ownerId: OWNER_ID,
      projectId: "proj_without_scope",
      authorityRuntimeId: SOURCE_RUNTIME,
      kind: "write",
    }, ordinary)).resolves.toBe("ordinary");

    await stage();
    await projectFence.fenceTransition({
      transitionId: TRANSITION_ID,
      projectScopeId: SCOPE_ID,
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      inspectCurrent: async () => ({
        inventoryRevision: 7,
        inventoryHash: INVENTORY_HASH,
        membershipHash: MEMBERSHIP_HASH,
      }),
    });
    const operation = vi.fn(async () => undefined);
    await expect(projectFence.withLegacyAdmission({
      ownerType: "personal",
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      authorityRuntimeId: SOURCE_RUNTIME,
      kind: "run",
    }, operation)).rejects.toMatchObject({ code: "fenced" });
    expect(operation).not.toHaveBeenCalled();
  });
});
