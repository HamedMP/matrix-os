import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import {
  CollaborationRepository,
  CollaborationRepositoryError,
} from "../../packages/gateway/src/collaboration/repository.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const instant = new Date("2026-09-07T12:00:00.000Z");
const future = "2026-09-14T12:00:00.000Z";

function uuid(index: number): string {
  return `20000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

describe("CollaborationRepository", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    repository = new CollaborationRepository(fixture.db, { now: () => instant });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  async function createScope() {
    return repository.createDirectScope({
      scopeId: collaborationIds.scope,
      ownerId: collaborationActors.owner,
      kind: "chat",
      resourceId: collaborationIds.chat,
      authorityRuntimeId: collaborationIds.runtime,
    });
  }

  it("creates one logical scope and accepted owner under concurrent retries", async () => {
    const [first, second] = await Promise.all([
      createScope(),
      repository.createDirectScope({
        scopeId: "10000000-0000-4000-8000-000000000002",
        ownerId: collaborationActors.owner,
        kind: "chat",
        resourceId: collaborationIds.chat,
        authorityRuntimeId: collaborationIds.runtime,
      }),
    ]);

    expect(second.id).toBe(first.id);
    const members = await repository.listMembers(first.id, { includePending: true });
    expect(members).toMatchObject([{
      actorId: collaborationActors.owner,
      role: "owner",
      status: "accepted",
    }]);
  });

  it("reserves at most seven invitation seats in addition to the owner", async () => {
    const scope = await createScope();
    for (let index = 1; index <= 7; index += 1) {
      await repository.createInvitation({
        scopeId: scope.id,
        actorId: collaborationActors.owner,
        targetActorId: `user_invited_${index}`,
        role: index % 2 === 0 ? "viewer" : "editor",
        clientRequestId: uuid(index),
        expectedRevision: index - 1,
        payloadHash: index.toString(16).padStart(64, "0"),
        expiresAt: future,
      });
    }

    await expect(repository.createInvitation({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: "user_invited_8",
      role: "viewer",
      clientRequestId: uuid(8),
      expectedRevision: 7,
      payloadHash: "8".padStart(64, "0"),
      expiresAt: future,
    })).rejects.toMatchObject({ code: "capacity" });
  });

  it("expires an invitation instead of granting access from an old identity", async () => {
    const scope = await createScope();
    const invitation = await repository.createInvitation({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "editor",
      clientRequestId: uuid(20),
      expectedRevision: 0,
      payloadHash: "a".repeat(64),
      expiresAt: "2026-09-07T11:59:59.000Z",
    });

    await expect(repository.acceptInvitation({
      invitationId: invitation.invitationId,
      actorId: collaborationActors.editor,
      clientRequestId: uuid(21),
      expectedRevision: 1,
      payloadHash: "b".repeat(64),
    })).rejects.toMatchObject({ code: "expired" });
    expect(await repository.getMember(scope.id, collaborationActors.editor)).toMatchObject({
      status: "expired",
    });
  });

  it("does not silently mutate other expired invitations while creating an invitation", async () => {
    const scope = await createScope();
    await repository.createInvitation({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "editor",
      clientRequestId: uuid(22),
      expectedRevision: 0,
      payloadHash: "c".repeat(64),
      expiresAt: "2026-09-07T11:59:59.000Z",
    });

    await repository.createInvitation({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.viewer,
      role: "viewer",
      clientRequestId: uuid(23),
      expectedRevision: 1,
      payloadHash: "d".repeat(64),
      expiresAt: future,
    });

    expect(await repository.getMember(scope.id, collaborationActors.editor)).toMatchObject({
      status: "pending",
      revision: 1,
    });
  });

  it("replays the same actor operation and rejects a changed payload", async () => {
    const scope = await createScope();
    const input = {
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.viewer,
      role: "viewer" as const,
      clientRequestId: uuid(30),
      expectedRevision: 0,
      payloadHash: "c".repeat(64),
      expiresAt: future,
    };
    const first = await repository.createInvitation(input);
    const replay = await repository.createInvitation(input);
    expect(replay).toEqual(first);

    await expect(repository.createInvitation({
      ...input,
      role: "editor",
      payloadHash: "d".repeat(64),
    })).rejects.toBeInstanceOf(CollaborationRepositoryError);
    await expect(repository.createInvitation({
      ...input,
      role: "editor",
      payloadHash: "d".repeat(64),
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("commits membership, event, audit, operation, and directory outbox atomically", async () => {
    const scope = await createScope();
    await repository.createInvitation({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "editor",
      clientRequestId: uuid(40),
      expectedRevision: 0,
      payloadHash: "e".repeat(64),
      expiresAt: future,
    });

    const counts = await Promise.all([
      fixture.db.selectFrom("collaboration_members").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      fixture.db.selectFrom("collaboration_operations").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      fixture.db.selectFrom("collaboration_events").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      fixture.db.selectFrom("collaboration_audit").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      fixture.db.selectFrom("collaboration_directory_outbox").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    ]);
    expect(counts.map(({ count }) => Number(count))).toEqual([2, 1, 1, 1, 1]);
  });

  it("conditionally changes roles, revokes members, and protects the final owner", async () => {
    const scope = await createScope();
    const invitation = await repository.createInvitation({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "editor",
      clientRequestId: uuid(50),
      expectedRevision: 0,
      payloadHash: "5".repeat(64),
      expiresAt: future,
    });
    await repository.acceptInvitation({
      invitationId: invitation.invitationId,
      actorId: collaborationActors.editor,
      clientRequestId: uuid(51),
      expectedRevision: 1,
      payloadHash: "6".repeat(64),
    });

    const downgraded = await repository.changeMemberRole({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "viewer",
      clientRequestId: uuid(52),
      expectedRevision: 2,
      expectedMemberRevision: 2,
      payloadHash: "7".repeat(64),
    });
    expect(downgraded).toMatchObject({ role: "viewer", scopeRevision: 3 });

    await repository.revokeMember({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      clientRequestId: uuid(53),
      expectedRevision: 3,
      expectedMemberRevision: 3,
      payloadHash: "8".repeat(64),
    });
    expect(await repository.getMember(scope.id, collaborationActors.editor)).toMatchObject({
      status: "revoked",
    });

    await expect(repository.revokeMember({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.owner,
      clientRequestId: uuid(54),
      expectedRevision: 4,
      expectedMemberRevision: 1,
      payloadHash: "9".repeat(64),
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("previews and conditionally revokes a pending invitation", async () => {
    const scope = await createScope();
    const invitation = await repository.createInvitation({
      scopeId: scope.id,
      actorId: collaborationActors.owner,
      targetActorId: collaborationActors.editor,
      role: "editor",
      clientRequestId: uuid(60),
      expectedRevision: 0,
      payloadHash: "a".repeat(64),
      expiresAt: future,
    });
    await expect(repository.getInvitation(invitation.invitationId)).resolves.toMatchObject({
      scopeId: scope.id,
      actorId: collaborationActors.editor,
      invitedBy: collaborationActors.owner,
      status: "pending",
    });
    await expect(repository.revokeInvitation({
      scopeId: scope.id,
      invitationId: invitation.invitationId,
      actorId: collaborationActors.owner,
      clientRequestId: uuid(61),
      expectedRevision: 1,
      expectedMemberRevision: 1,
      payloadHash: "b".repeat(64),
    })).resolves.toMatchObject({ status: "revoked", scopeRevision: 2 });
    await expect(repository.acceptInvitation({
      invitationId: invitation.invitationId,
      actorId: collaborationActors.editor,
      clientRequestId: uuid(62),
      expectedRevision: 2,
      payloadHash: "c".repeat(64),
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps read, pin, mute, and opened state local to each Chat participant", async () => {
    await fixture.db.insertInto("chats").values({
      id: collaborationIds.chat,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      create_request_id: "request_user_state_chat",
      project_id: null,
      title: "Shared Chat",
      lifecycle: "active",
      attention: "none",
      revision: 0,
      collaboration: null,
      user_state: null,
      shell_state: null,
      fork_provenance: null,
      last_message_preview: null,
      current_selection: null,
      bound_driver_kind: null,
      bound_instance_id: null,
      bound_at_turn_id: null,
      created_at: instant.toISOString(),
      updated_at: instant.toISOString(),
    }).execute();
    await createScope();
    await repository.updateChatUserState({
      chatId: collaborationIds.chat,
      actorId: collaborationActors.owner,
      readThroughSeq: 12,
      pinned: true,
      muted: false,
      openedAt: instant.toISOString(),
    });
    expect(await repository.getChatUserState(collaborationIds.chat, collaborationActors.owner)).toEqual({
      readThroughSeq: 12,
      pinned: true,
      muted: false,
      lastOpenedAt: instant.toISOString(),
    });
    expect(await repository.getChatUserState(collaborationIds.chat, collaborationActors.editor)).toEqual({
      readThroughSeq: 0,
      pinned: false,
      muted: false,
    });
  });
});
