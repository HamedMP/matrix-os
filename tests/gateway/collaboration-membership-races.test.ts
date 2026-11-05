import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { ProjectAccessRevocationEnforcer } from "../../packages/gateway/src/collaboration/revocation-enforcer.js";
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
