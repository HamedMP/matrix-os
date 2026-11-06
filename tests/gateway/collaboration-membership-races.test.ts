import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { ProjectAccessRevocationEnforcer } from "../../packages/gateway/src/collaboration/revocation-enforcer.js";
import { createProjectTransitionJournal } from "../../packages/gateway/src/collaboration/project-transition.js";
import { createProjectInheritanceResolver } from "../../packages/gateway/src/collaboration/project-inheritance.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  createRealCollaborationTestDatabase,
  allowAllOrganizationPrecondition,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const future = "2026-09-14T12:00:00.000Z";
const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;

realDescribe("collaboration membership real PostgreSQL races", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    repository = new CollaborationRepository(fixture.db, { now: () => now });
    await repository.createDirectScope({
      scopeId: collaborationIds.scope,
      organizationId: "org_matrix_team",
      ownerId: collaborationActors.owner,
      kind: "chat",
      resourceId: collaborationIds.chat,
      authorityRuntimeId: collaborationIds.runtime,
    });
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared" })
      .where("id", "=", collaborationIds.scope).execute();
  });

  afterEach(async () => {
    if (fixture) await fixture.destroy();
  });

  it("serializes simultaneous invitations for one actor", async () => {
    const results = await Promise.allSettled([1, 2].map((index) => repository.createInvitation({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: index === 1 ? "editor" : "viewer",
      clientRequestId: uuid(index),
      expectedRevision: 0,
      payloadHash: index.toString().repeat(64),
      expiresAt: future,
    })));

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await repository.listMembers(collaborationIds.scope, { includePending: true })).toHaveLength(2);
  });

  it("replays simultaneous acceptance of one actor operation exactly", async () => {
    const invitation = await inviteEditor();
    const input = {
      invitationId: invitation.invitationId,
      actorId: collaborationActors.editor,
      clientRequestId: uuid(11),
      expectedRevision: 1,
      payloadHash: "b".repeat(64),
    };

    const [first, replay] = await Promise.all([
      repository.acceptInvitation(input),
      repository.acceptInvitation(input),
    ]);
    expect(replay).toEqual(first);
    await expect(repository.getMember(collaborationIds.scope, collaborationActors.editor))
      .resolves.toMatchObject({ status: "accepted", revision: 2 });
  });

  it("allows exactly one simultaneous downgrade or revoke", async () => {
    const invitation = await inviteEditor();
    await repository.acceptInvitation({
      invitationId: invitation.invitationId,
      actorId: collaborationActors.editor,
      clientRequestId: uuid(21),
      expectedRevision: 1,
      payloadHash: "c".repeat(64),
    });
    const base = {
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      expectedRevision: 2,
      expectedMemberRevision: 2,
    };
    const results = await Promise.allSettled([
      repository.changeMemberRole({
        ...base,
        role: "viewer",
        clientRequestId: uuid(22),
        payloadHash: "d".repeat(64),
      }),
      repository.revokeMember({
        ...base,
        clientRequestId: uuid(23),
        payloadHash: "e".repeat(64),
      }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const member = await repository.getMember(collaborationIds.scope, collaborationActors.editor);
    expect(member?.revision).toBe(3);
    expect(["accepted", "revoked"]).toContain(member?.status);
  });

  it("rejects every attempt to downgrade or revoke the final owner", async () => {
    const base = {
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.owner,
      expectedRevision: 0,
      expectedMemberRevision: 1,
    };
    const results = await Promise.allSettled([
      repository.changeMemberRole({
        ...base,
        role: "viewer",
        clientRequestId: uuid(31),
        payloadHash: "f".repeat(64),
      }),
      repository.revokeMember({
        ...base,
        clientRequestId: uuid(32),
        payloadHash: "0".repeat(64),
      }),
    ]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({ status: "rejected", reason: { code: "forbidden" } });
    }
    await expect(repository.getMember(collaborationIds.scope, collaborationActors.owner))
      .resolves.toMatchObject({ role: "owner", status: "accepted", revision: 1 });
  });

  it("does not acknowledge a reconnected owner departure before concurrent cleanup finishes", async () => {
    const projectScopeId = "73000000-0000-4000-8000-000000000101";
    const childScopeId = "73000000-0000-4000-8000-000000000102";
    await fixture.db.insertInto("collaboration_scopes").values([
      realRevocationScope({
        id: projectScopeId,
        ownerId: collaborationActors.owner,
        organizationId: "org_matrix_team",
        kind: "project",
        resourceId: "project_reconnected_owner",
      }),
      realRevocationScope({
        id: childScopeId,
        ownerId: collaborationActors.owner,
        organizationId: "org_matrix_team",
        kind: "chat",
        resourceId: "chat_reconnected_owner",
        parentScopeId: projectScopeId,
      }),
    ]).execute();

    let signalLockAcquired!: (backendPid: number) => void;
    let releaseProjectLock!: () => void;
    const lockAcquired = new Promise<number>((resolve) => { signalLockAcquired = resolve; });
    const projectLockReleased = new Promise<void>((resolve) => { releaseProjectLock = resolve; });
    const lockHolder = fixture.db.transaction().execute(async (trx) => {
      await trx.selectFrom("collaboration_scopes")
        .select("id")
        .where("id", "=", projectScopeId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const backend = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
      signalLockAcquired(backend.rows[0]!.pid);
      await projectLockReleased;
    });
    const lockHolderPid = await lockAcquired;

    let projectDrainAttempts = 0;
    const drainScope = vi.fn(async (scopeId: string) => {
      if (scopeId === projectScopeId && projectDrainAttempts++ === 0) {
        throw new Error("first drain interrupted");
      }
    });
    const enforcer = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke: vi.fn(() => [] as string[]) },
      drainScope,
    });
    const input = { organizationId: "org_matrix_team", actorId: collaborationActors.owner };
    const first = enforcer.membershipEnded(input);
    const reconnected = enforcer.membershipEnded(input);
    let barrierError: unknown;
    try {
      await waitForBlockedProjectTransactions(fixture.db, lockHolderPid, 2);
    } catch (error) {
      barrierError = error;
    } finally {
      releaseProjectLock();
      await lockHolder;
    }

    const results = await Promise.allSettled([first, reconnected]);
    if (barrierError) throw barrierError;
    const rejected = results.filter(({ status }) => status === "rejected");
    const fulfilled = results.filter(({ status }) => status === "fulfilled");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    const operationBeforeRetry = await fixture.db.selectFrom("collaboration_operations")
      .select("status")
      .where("scope_id", "=", projectScopeId)
      .where("operation_kind", "=", "membership.departure_cleanup")
      .executeTakeFirstOrThrow();
    if (fulfilled.length > 0) {
      expect(operationBeforeRetry).toEqual({ status: "completed" });
    } else {
      expect(operationBeforeRetry).toEqual({ status: "accepted" });
      await enforcer.membershipEnded(input);
    }
    expect(drainScope.mock.calls.filter(([scopeId]) => scopeId === projectScopeId)).toHaveLength(2);
    await expect(fixture.db.selectFrom("collaboration_operations")
      .select("status")
      .where("scope_id", "=", projectScopeId)
      .where("operation_kind", "=", "membership.departure_cleanup")
      .executeTakeFirstOrThrow()).resolves.toEqual({ status: "completed" });
  });

  async function inviteEditor() {
    return repository.createInvitation({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "editor",
      clientRequestId: uuid(10),
      expectedRevision: 0,
      payloadHash: "a".repeat(64),
      expiresAt: future,
    });
  }
});

function uuid(index: number): string {
  return `72000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function realRevocationScope(input: {
  id: string;
  ownerId: string;
  organizationId: string;
  kind: "project" | "chat";
  resourceId: string;
  parentScopeId?: string;
}) {
  return {
    id: input.id,
    owner_type: "personal" as const,
    owner_id: input.ownerId,
    organization_id: input.organizationId,
    kind: input.kind,
    resource_id: input.resourceId,
    parent_scope_id: input.parentScopeId ?? null,
    membership_mode: input.parentScopeId ? "inherited" as const : "direct" as const,
    lifecycle: "shared" as const,
    revision: 1,
    auth_epoch: 1,
    authority_runtime_id: "vps:reconnect-race",
    authority_generation: 1,
    execution_generation: null,
    execution_eligibility: null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

async function waitForBlockedProjectTransactions(
  db: CollaborationTestDatabase["db"],
  lockHolderPid: number,
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await sql<{ count: string }>`
      with recursive blocked(pid) as (
        select activity.pid
        from pg_stat_activity as activity
        where ${lockHolderPid} = any(pg_blocking_pids(activity.pid))
        union
        select activity.pid
        from pg_stat_activity as activity
        inner join blocked as blocker
          on blocker.pid = any(pg_blocking_pids(activity.pid))
      )
      select count(*)::text as count
      from blocked
    `.execute(db);
    if (Number(result.rows[0]?.count ?? 0) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected} blocked project transactions`);
}

describe("organization project revocation races", () => {
  const org = "org_revocation_team";
  const departedOwner = "user_departed_owner";
  const otherOwner = "user_other_owner";
  const ownedProject = "73000000-0000-4000-8000-000000000001";
  const ownedChat = "73000000-0000-4000-8000-000000000002";
  const otherProject = "73000000-0000-4000-8000-000000000003";
  const otherTerminal = "73000000-0000-4000-8000-000000000004";
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values([
      revocationScope(ownedProject, departedOwner, "project", "project_owned"),
      revocationScope(ownedChat, departedOwner, "chat", "chat_owned", ownedProject),
      revocationScope(otherProject, otherOwner, "project", "project_other"),
      revocationScope(otherTerminal, otherOwner, "terminal", "terminal_other", otherProject),
    ]).execute();
  });

  afterEach(async () => fixture.destroy());

  it("fully drains projects whose owner departs and only that actor from other organization projects", async () => {
    const revoke = vi.fn(() => [] as string[]);
    const drainScope = vi.fn(async () => undefined);
    const enforcer = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke },
      drainScope,
    });

    await enforcer.membershipEnded({ organizationId: org, actorId: departedOwner });

    expect(revoke).toHaveBeenCalledWith({ organizationId: org, actorId: departedOwner });
    expect(revoke).toHaveBeenCalledWith({ scopeId: ownedProject });
    expect(drainScope).toHaveBeenCalledWith(ownedProject);
    expect(drainScope).toHaveBeenCalledWith(ownedChat);
    expect(drainScope).toHaveBeenCalledWith(otherProject, departedOwner);
    expect(drainScope).toHaveBeenCalledWith(otherTerminal, departedOwner);

    expect(await fixture.db.selectFrom("collaboration_scopes")
      .select(["id", "lifecycle", "revision", "auth_epoch"])
      .where("id", "in", [ownedProject, ownedChat, otherProject, otherTerminal])
      .orderBy("id")
      .execute()).toEqual([
      { id: ownedProject, lifecycle: "private", revision: 2, auth_epoch: 2 },
      { id: ownedChat, lifecycle: "private", revision: 2, auth_epoch: 2 },
      { id: otherProject, lifecycle: "shared", revision: 1, auth_epoch: 1 },
      { id: otherTerminal, lifecycle: "shared", revision: 1, auth_epoch: 1 },
    ]);
    const authority = new CollaborationAuthority(new CollaborationRepository(fixture.db), {
      now: () => now,
      organizationPrecondition: allowAllOrganizationPrecondition,
    });
    await expect(authority.authorize({
      scopeId: ownedProject,
      actorId: otherOwner,
      action: "read",
    })).rejects.toMatchObject({ code: "not_found" });
    expect(await fixture.db.selectFrom("collaboration_directory_outbox")
      .select("discovery_state")
      .where("scope_id", "=", ownedProject)
      .execute()).toEqual([{ discovery_state: "revoked" }]);
  });

  it("retries durable owner-project cleanup after a drain fails", async () => {
    let ownedChatFailures = 0;
    const drainScope = vi.fn(async (scopeId: string) => {
      if (scopeId === ownedChat && ownedChatFailures++ === 0) throw new Error("drain interrupted");
    });
    const enforcer = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke: vi.fn(() => [] as string[]) },
      drainScope,
    });

    await expect(enforcer.membershipEnded({ organizationId: org, actorId: departedOwner }))
      .rejects.toThrow("drain interrupted");
    expect(await fixture.db.selectFrom("collaboration_operations")
      .select("status")
      .where("scope_id", "=", ownedProject)
      .where("operation_kind", "=", "membership.departure_cleanup")
      .executeTakeFirstOrThrow()).toEqual({ status: "accepted" });

    const restarted = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke: vi.fn(() => [] as string[]) },
      drainScope,
    });
    await restarted.membershipEnded({ organizationId: org, actorId: departedOwner });

    expect(drainScope.mock.calls.filter(([scope]) => scope === ownedProject)).toHaveLength(2);
    expect(drainScope.mock.calls.filter(([scope]) => scope === ownedChat)).toHaveLength(2);
    expect(await fixture.db.selectFrom("collaboration_operations")
      .select("status")
      .where("scope_id", "=", ownedProject)
      .where("operation_kind", "=", "membership.departure_cleanup")
      .executeTakeFirstOrThrow()).toEqual({ status: "completed" });
  });

  it("joins overlapping owner-departure cleanup redeliveries", async () => {
    let signalDrainStarted!: () => void;
    let releaseDrain!: () => void;
    const drainStarted = new Promise<void>((resolve) => { signalDrainStarted = resolve; });
    const drainReleased = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const drainScope = vi.fn(async (scopeId: string) => {
      if (scopeId === ownedProject && drainScope.mock.calls.filter(([scope]) => scope === ownedProject).length === 1) {
        signalDrainStarted();
        await drainReleased;
      }
    });
    const enforcer = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke: vi.fn(() => [] as string[]) },
      drainScope,
    });

    const first = enforcer.membershipEnded({ organizationId: org, actorId: departedOwner });
    await drainStarted;
    const second = enforcer.membershipEnded({ organizationId: org, actorId: departedOwner });
    const replayState = await Promise.race([
      second.then(() => "settled" as const),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 50)),
    ]);
    try {
      expect(replayState).toBe("waiting");
      expect(drainScope.mock.calls.filter(([scope]) => scope === ownedProject)).toHaveLength(1);
    } finally {
      releaseDrain();
      await Promise.allSettled([first, second]);
    }
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(drainScope.mock.calls.filter(([scope]) => scope === ownedProject)).toHaveLength(1);
    expect(drainScope.mock.calls.filter(([scope]) => scope === ownedChat)).toHaveLength(1);
  });

  it("makes an in-progress share private before acknowledging owner departure", async () => {
    const transitionId = "73000000-0000-4000-8000-000000000005";
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "preparing" })
      .where("id", "in", [ownedProject, ownedChat]).execute();
    await fixture.db.insertInto("collaboration_transitions").values({
      id: transitionId,
      scope_id: ownedProject,
      source_authority_runtime_id: "vps:revocation",
      source_authority_generation: 1,
      destination_authority_runtime_id: "vps:revocation-next",
      destination_authority_generation: 1,
      requested_by: departedOwner,
      inventory_revision: 1,
      inventory_hash: "a".repeat(64),
      intended_membership_hash: "b".repeat(64),
      status: "committing",
      source_fence_epoch: 1,
      staged_manifest_ref: "manifest_11111111111111111111111111111111",
      publication_marker: "publication_11111111111111111111111111111111",
      retry_count: 0,
      error_code: null,
      created_at: now,
      updated_at: now,
    }).execute();
    const enforcer = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke: vi.fn(() => [] as string[]) },
      drainScope: vi.fn(async () => undefined),
    });

    await enforcer.membershipEnded({ organizationId: org, actorId: departedOwner });

    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["id", "lifecycle"])
      .where("id", "in", [ownedProject, ownedChat])
      .orderBy("id")
      .execute()).resolves.toEqual([
      { id: ownedProject, lifecycle: "private" },
      { id: ownedChat, lifecycle: "private" },
    ]);
    const transitions = createProjectTransitionJournal({
      db: fixture.db,
      now: () => now,
      createTransitionId: () => "73000000-0000-4000-8000-000000000006",
    });
    await expect(transitions.get(transitionId)).resolves.toMatchObject({
      status: "failed",
      errorCode: "owner_membership_ended",
    });
    await expect(transitions.activate(transitionId)).rejects.toMatchObject({ code: "conflict" });
    await expect(transitions.prepare({
      scopeId: ownedProject,
      ownerId: departedOwner,
      requestedBy: departedOwner,
      clientRequestId: "73000000-0000-4000-8000-000000000007",
      payloadHash: "c".repeat(64),
      expectedScopeRevision: 2,
      inventoryRevision: 2,
      inventoryHash: "d".repeat(64),
      membershipHash: "e".repeat(64),
      destinationAuthorityRuntimeId: "vps:revocation",
      destinationAuthorityGeneration: 2,
    })).resolves.toMatchObject({ status: "prepared" });
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select("lifecycle").where("id", "=", ownedProject).executeTakeFirstOrThrow())
      .resolves.toEqual({ lifecycle: "preparing" });
  });

  it("lets a rejoined owner explicitly share again with a new authority generation", async () => {
    await fixture.db.insertInto("collaboration_resource_bindings").values({
      id: "73000000-0000-4000-8000-000000000010",
      project_scope_id: ownedProject,
      resource_scope_id: ownedChat,
      resource_kind: "chat",
      resource_id: "chat_owned",
      authority_runtime_id: "vps:revocation",
      authority_generation: 1,
      revision: 1,
      readiness: "ready",
      blocker: null,
      incarnation: null,
      created_at: now,
      updated_at: now,
    }).execute();
    const enforcer = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke: vi.fn(() => [] as string[]) },
      drainScope: vi.fn(async () => undefined),
    });
    await enforcer.membershipEnded({ organizationId: org, actorId: departedOwner });

    const transitions = createProjectTransitionJournal({
      db: fixture.db,
      now: () => now,
      createTransitionId: () => "73000000-0000-4000-8000-000000000011",
    });
    await transitions.prepare({
      scopeId: ownedProject,
      ownerId: departedOwner,
      requestedBy: departedOwner,
      clientRequestId: "73000000-0000-4000-8000-000000000012",
      payloadHash: "f".repeat(64),
      expectedScopeRevision: 2,
      inventoryRevision: 2,
      inventoryHash: "a".repeat(64),
      membershipHash: "b".repeat(64),
      destinationAuthorityRuntimeId: "vps:revocation",
      destinationAuthorityGeneration: 2,
    });
    const inheritance = createProjectInheritanceResolver({
      db: fixture.db,
      now: () => now,
      createBindingId: () => "73000000-0000-4000-8000-000000000013",
      createScopeId: () => "73000000-0000-4000-8000-000000000014",
    });

    await expect(inheritance.bindOwnedResource({
      projectScopeId: ownedProject,
      ownerId: departedOwner,
      kind: "chat",
      resourceId: "chat_owned",
      authorityRuntimeId: "vps:revocation",
      authorityGeneration: 2,
      revision: 1,
      readiness: "ready",
    })).resolves.toMatchObject({
      authorityGeneration: 2,
      resourceScopeId: "73000000-0000-4000-8000-000000000014",
    });
    await expect(fixture.db.selectFrom("collaboration_scopes")
      .select(["id", "authority_generation"])
      .where("id", "=", ownedChat).executeTakeFirst()).resolves.toBeUndefined();
  });

  it("drains the project and every inherited scope after unshare commits", async () => {
    const revoke = vi.fn(() => [] as string[]);
    const drainScope = vi.fn(async () => undefined);
    const enforcer = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke },
      drainScope,
    });

    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "private", revision: 2 })
      .where("id", "in", [ownedProject, ownedChat]).execute();
    await enforcer.unshared({ scopeId: ownedProject, revision: 2 });

    expect(revoke).toHaveBeenCalledWith({ scopeId: ownedProject });
    expect(drainScope.mock.calls).toEqual([[ownedProject], [ownedChat]]);
  });

  it("does not let an old unshare retry drain work admitted by a later share", async () => {
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "private", revision: 2 })
      .where("id", "in", [ownedProject, ownedChat]).execute();
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "shared", revision: 3 })
      .where("id", "in", [ownedProject, ownedChat]).execute();
    const revoke = vi.fn(() => [] as string[]);
    const drainScope = vi.fn(async () => undefined);
    const enforcer = new ProjectAccessRevocationEnforcer({
      db: fixture.db,
      sessions: { revoke },
      drainScope,
    });

    await expect(enforcer.unshared({ scopeId: ownedProject, revision: 2 }))
      .rejects.toThrow("Project revocation fence is unavailable");

    expect(revoke).not.toHaveBeenCalled();
    expect(drainScope).not.toHaveBeenCalled();
  });

  function revocationScope(
    id: string,
    ownerId: string,
    kind: "project" | "chat" | "terminal",
    resourceId: string,
    parentScopeId: string | null = null,
  ) {
    return {
      id,
      owner_type: "personal" as const,
      owner_id: ownerId,
      organization_id: org,
      kind,
      resource_id: resourceId,
      parent_scope_id: parentScopeId,
      membership_mode: parentScopeId ? "inherited" as const : "direct" as const,
      lifecycle: "shared" as const,
      revision: 1,
      auth_epoch: 1,
      authority_runtime_id: "vps:revocation",
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      deleted_at: null,
      created_at: now,
      updated_at: now,
    };
  }
});
