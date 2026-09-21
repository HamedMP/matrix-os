import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  AmbiguousProjectGitEffect,
  ProjectGitBrokerError,
  createProjectGitBroker,
  hashGitAction,
} from "../../packages/gateway/src/collaboration/project-git-broker.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const NOW = "2026-09-21T10:00:00.000Z";
const ORG = "org_git_broker_test";
const PROJECT = "proj_git_broker";
let requestNumber = 0;

function action<T extends "commit" | "push" | "pr">(type: T, fields: Record<string, unknown>) {
  requestNumber += 1;
  const input = {
    type,
    clientRequestId: `70000000-0000-4000-8000-${String(requestNumber).padStart(12, "0")}`,
    expectedRevision: "1",
    ...fields,
  };
  return { ...input, payloadHash: hashGitAction(input) };
}

describe("project Git broker PostgreSQL boundary", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    requestNumber = 0;
    fixture = process.env.MATRIX_TEST_POSTGRES_URL
      ? await createRealCollaborationTestDatabase()
      : await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: collaborationIds.scope,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      organization_id: ORG,
      kind: "project",
      resource_id: PROJECT,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      revision: 1,
      auth_epoch: 1,
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      deleted_at: null,
      created_at: NOW,
      updated_at: NOW,
    }).execute();
  });

  afterEach(async () => fixture?.destroy());

  it("registers migration 13 for durable operations and audit detail", async () => {
    const versions = await fixture.db.selectFrom("collaboration_schema_migrations").select("version").execute();
    expect(versions.map((row) => Number(row.version))).toContain(13);
    await expect(fixture.db.selectFrom("collaboration_git_operations").select("id").execute()).resolves.toEqual([]);
  });

  it("executes one concurrent member commit with owner identity and durable requester/run attribution", async () => {
    const run = vi.fn(async () => ({ commitSha: "a".repeat(40) }));
    const authorize = vi.fn(async () => ({ ownerId: collaborationActors.owner, projectId: PROJECT }));
    const broker = createProjectGitBroker({
      db: fixture.db,
      authorize,
      resolveOwnerIdentity: async () => ({ name: "Owner", email: "owner@example.test", label: "Owner <owner@example.test>" }),
      driver: { run, reconcile: async () => null },
      now: () => new Date(NOW),
    });
    const request = action("commit", { message: "feat: shared change", expectedHeadSha: "b".repeat(40) });
    const results = await Promise.all(Array.from({ length: 4 }, () => broker.submit({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      runId: "run_member_change",
      request,
    })));
    expect(results.every((result) => result.state === "completed" && result.commitSha === "a".repeat(40))).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      requestingActorId: collaborationActors.editor,
      runId: "run_member_change",
      ownerIdentity: { name: "Owner", email: "owner@example.test", label: "Owner <owner@example.test>" },
    }));
    expect(authorize).toHaveBeenCalledWith({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, action: "git.commit" });
    const audit = await fixture.db.selectFrom("collaboration_audit").select(["actor_id", "action", "detail"]).execute();
    expect(audit).toContainEqual(expect.objectContaining({
      actor_id: collaborationActors.editor,
      action: "git.commit",
      detail: expect.objectContaining({ runId: "run_member_change", commitSha: "a".repeat(40), ownerId: collaborationActors.owner }),
    }));
  });

  it("denies a Viewer before creating an operation or running a side effect", async () => {
    const run = vi.fn();
    const broker = createProjectGitBroker({
      db: fixture.db,
      authorize: async () => { throw new ProjectGitBrokerError("forbidden"); },
      resolveOwnerIdentity: async () => ({ name: "Owner", email: "owner@example.test", label: "Owner <owner@example.test>" }),
      driver: { run, reconcile: async () => null },
    });
    const request = action("push", { branch: "feature/member", expectedHeadSha: "a".repeat(40) });
    await expect(broker.submit({ scopeId: collaborationIds.scope, actorId: collaborationActors.viewer, request }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(run).not.toHaveBeenCalled();
    expect(await fixture.db.selectFrom("collaboration_git_operations").select("id").execute()).toEqual([]);
  });

  it("reconciles an ambiguous push by operation ID before retrying the side effect", async () => {
    const run = vi.fn(async () => { throw new AmbiguousProjectGitEffect(); });
    const reconcile = vi.fn(async () => ({ remoteBranch: "feature/member" }));
    const broker = createProjectGitBroker({
      db: fixture.db,
      authorize: async () => ({ ownerId: collaborationActors.owner, projectId: PROJECT }),
      resolveOwnerIdentity: async () => ({ name: "Owner", email: "owner@example.test", label: "Owner <owner@example.test>" }),
      driver: { run, reconcile },
    });
    const request = action("push", { branch: "feature/member", expectedHeadSha: "a".repeat(40) });
    const first = await broker.submit({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, request });
    expect(first.state).toBe("unknown");
    const second = await broker.submit({ scopeId: collaborationIds.scope, actorId: collaborationActors.editor, request });
    expect(second).toMatchObject({ id: first.id, state: "completed", remoteBranch: "feature/member" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ operationId: first.id }));
  });
});
