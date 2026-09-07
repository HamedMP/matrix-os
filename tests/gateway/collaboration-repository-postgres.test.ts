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

realDescribe("CollaborationRepository real PostgreSQL serialization", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    repository = new CollaborationRepository(fixture.db, { now: () => now });
  });

  afterEach(async () => fixture.destroy());

  async function createScope() {
    return repository.createDirectScope({
      scopeId: collaborationIds.scope,
      ownerId: collaborationActors.owner,
      kind: "chat",
      resourceId: collaborationIds.chat,
      authorityRuntimeId: collaborationIds.runtime,
    });
  }

  it("serializes the eighth seat across concurrent invitations", async () => {
    const scope = await createScope();
    for (let index = 1; index <= 6; index += 1) {
      await repository.createInvitation({
        scopeId: scope.id, actorId: collaborationActors.owner, targetActorId: `user_existing_${index}`,
        role: "viewer", clientRequestId: uuid(index), expectedRevision: index - 1,
        payloadHash: index.toString(16).padStart(64, "0"), expiresAt: future,
      });
    }
    const results = await Promise.allSettled([7, 8].map((index) => repository.createInvitation({
      scopeId: scope.id, actorId: collaborationActors.owner, targetActorId: `user_racing_${index}`,
      role: "viewer", clientRequestId: uuid(index), expectedRevision: 6,
      payloadHash: index.toString(16).padStart(64, "0"), expiresAt: future,
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await repository.listMembers(scope.id, { includePending: true })).filter(
      (member) => member.status === "accepted" || member.status === "pending",
    )).toHaveLength(8);
  });

  it("uses one scope-first lock order for simultaneous accept and revoke", async () => {
    const scope = await createScope();
    const invitation = await repository.createInvitation({
      scopeId: scope.id, actorId: collaborationActors.owner, targetActorId: collaborationActors.editor,
      role: "editor", clientRequestId: uuid(20), expectedRevision: 0,
      payloadHash: "a".repeat(64), expiresAt: future,
    });
    const results = await Promise.allSettled([
      repository.acceptInvitation({
        invitationId: invitation.invitationId, actorId: collaborationActors.editor,
        clientRequestId: uuid(21), expectedRevision: 1, payloadHash: "b".repeat(64),
      }),
      repository.revokeInvitation({
        scopeId: scope.id, invitationId: invitation.invitationId, actorId: collaborationActors.owner,
        clientRequestId: uuid(22), expectedRevision: 1, expectedMemberRevision: 1,
        payloadHash: "c".repeat(64),
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
  });
});

function uuid(index: number): string {
  return `70000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}
