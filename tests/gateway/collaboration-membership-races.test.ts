import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  collaborationActors,
  collaborationIds,
  createRealCollaborationTestDatabase,
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
      ownerId: collaborationActors.owner,
      kind: "chat",
      resourceId: collaborationIds.chat,
      authorityRuntimeId: collaborationIds.runtime,
    });
  });

  afterEach(async () => fixture.destroy());

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
