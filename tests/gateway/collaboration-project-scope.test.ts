import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  CollaborationProjectScopeError,
  CollaborationProjectScopeService,
} from "../../packages/gateway/src/collaboration/project-scope.js";
import {
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const OWNER_ID = "user_project_owner";
const RUNTIME_ID = "runtime_project_owner";
const PROJECT_ID = "proj_alpha";
const SCOPE_ID = "10000000-0000-4000-8000-000000000601";
const REQUEST_ID = "20000000-0000-4000-8000-000000000601";

describe("project collaboration scope preparation", () => {
  let fixture: CollaborationTestDatabase;
  let revision: number;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    revision = 7;
  });

  afterEach(async () => fixture.destroy());

  it("creates one unpublished owner scope without a discoverable directory route", async () => {
    const service = projectScopeService(fixture, () => revision);
    const preflight = await service.preflight({ ownerId: OWNER_ID, projectId: PROJECT_ID });
    const scope = await service.prepare({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: REQUEST_ID,
      payloadHash: "a".repeat(64),
      expectedProjectRevision: preflight.projectRevision,
      confirmationToken: preflight.confirmationToken!,
    });

    expect(scope).toMatchObject({
      id: SCOPE_ID,
      ownerId: OWNER_ID,
      kind: "project",
      resourceId: PROJECT_ID,
      lifecycle: "private",
      revision: 0,
      authEpoch: 0,
    });
    await expect(fixture.db.selectFrom("collaboration_members").select(["actor_id", "role", "status"])
      .where("scope_id", "=", SCOPE_ID).execute()).resolves.toEqual([
      { actor_id: OWNER_ID, role: "owner", status: "accepted" },
    ]);
    await expect(fixture.db.selectFrom("collaboration_directory_outbox")
      .select("scope_id").where("scope_id", "=", SCOPE_ID).execute()).resolves.toEqual([]);
  });

  it("replays the same actor request but rejects a changed payload", async () => {
    const service = projectScopeService(fixture, () => revision);
    const preflight = await service.preflight({ ownerId: OWNER_ID, projectId: PROJECT_ID });
    const input = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: REQUEST_ID,
      payloadHash: "a".repeat(64),
      expectedProjectRevision: preflight.projectRevision,
      confirmationToken: preflight.confirmationToken!,
    };
    const first = await service.prepare(input);
    await expect(service.prepare(input)).resolves.toEqual(first);
    await expect(service.prepare({ ...input, payloadHash: "b".repeat(64) }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("returns the existing logical project scope for a new idempotent create request", async () => {
    const service = projectScopeService(fixture, () => revision);
    const preflight = await service.preflight({ ownerId: OWNER_ID, projectId: PROJECT_ID });
    const base = {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      payloadHash: "a".repeat(64),
      expectedProjectRevision: preflight.projectRevision,
      confirmationToken: preflight.confirmationToken!,
    };
    const first = await service.prepare({ ...base, clientRequestId: REQUEST_ID });
    const second = await service.prepare({
      ...base,
      clientRequestId: "20000000-0000-4000-8000-000000000602",
      payloadHash: "b".repeat(64),
    });
    expect(second).toEqual(first);
    await expect(fixture.db.selectFrom("collaboration_operations")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("scope_id", "=", SCOPE_ID)
      .where("operation_kind", "=", "scope.create")
      .executeTakeFirstOrThrow()).resolves.toMatchObject({ count: 2 });
  });

  it("returns an existing project scope in preflight so the owner can reopen sharing", async () => {
    const service = projectScopeService(fixture, () => revision);
    const preflight = await service.preflight({ ownerId: OWNER_ID, projectId: PROJECT_ID });
    await service.prepare({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: REQUEST_ID,
      payloadHash: "a".repeat(64),
      expectedProjectRevision: preflight.projectRevision,
      confirmationToken: preflight.confirmationToken,
    });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", revision: 1 })
      .where("id", "=", SCOPE_ID).execute();

    await expect(service.preflight({ ownerId: OWNER_ID, projectId: PROJECT_ID })).resolves.toMatchObject({
      eligible: true,
      existingScopeId: SCOPE_ID,
      existingLifecycle: "shared",
    });
  });

  it("rejects stale or cross-owner confirmation without creating a scope", async () => {
    const service = projectScopeService(fixture, () => revision);
    const preflight = await service.preflight({ ownerId: OWNER_ID, projectId: PROJECT_ID });
    revision = 8;
    await expect(service.prepare({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      clientRequestId: REQUEST_ID,
      payloadHash: "a".repeat(64),
      expectedProjectRevision: preflight.projectRevision,
      confirmationToken: preflight.confirmationToken!,
    })).rejects.toBeInstanceOf(CollaborationProjectScopeError);
    await expect(fixture.db.selectFrom("collaboration_scopes").select("id").execute())
      .resolves.toEqual([]);
  });
});

function projectScopeService(fixture: CollaborationTestDatabase, getRevision: () => number) {
  return new CollaborationProjectScopeService(fixture.db, {
    runtimeId: RUNTIME_ID,
    preflightSecret: "0123456789abcdef0123456789abcdef",
    now: () => NOW,
    createScopeId: () => SCOPE_ID,
    createEventId: () => "30000000-0000-4000-8000-000000000601",
    source: {
      getProject: async (ownerId, projectId) => ownerId === OWNER_ID && projectId === PROJECT_ID
        ? { id: PROJECT_ID, ownerId: OWNER_ID, revision: getRevision() }
        : null,
    },
  });
}
