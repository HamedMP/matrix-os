import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationChatAdapter } from "../../packages/gateway/src/collaboration/chat-adapter.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationDiscussionAdapter } from "../../packages/gateway/src/collaboration/discussion-adapter.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
  allowAllOrganizationPrecondition,
} from "./collaboration-test-support.js";

const now = "2026-09-17T12:00:00.000Z";
const requestId = "50000000-0000-4000-8000-000000000011";

describe("CollaborationDiscussionAdapter terminal discussion", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;
  let authority: CollaborationAuthority;
  let adapter: CollaborationDiscussionAdapter;
  const committedScopes: string[] = [];

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedTerminalScope(fixture);
    repository = new CollaborationRepository(fixture.db, { now: () => new Date(now) });
    authority = new CollaborationAuthority(repository, { now: () => new Date(now), organizationPrecondition: allowAllOrganizationPrecondition });
    const chatAdapter = new CollaborationChatAdapter({
      db: fixture.db,
      authority,
      now: () => new Date(now),
      resolveParticipant,
    });
    committedScopes.length = 0;
    adapter = new CollaborationDiscussionAdapter({
      db: fixture.db,
      authority,
      chatAdapter,
      now: () => new Date(now),
      createId: () => "discussion_terminal_1",
      resolveParticipant,
      onCommitted: async (scopeId) => { committedScopes.push(scopeId); },
    });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("appends and pages attributed terminal notes without creating terminal actions", async () => {
    const editor = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });
    await expect(adapter.append(editor, {
      clientRequestId: requestId,
      expectedRevision: "1",
      text: "Do not paste this into the terminal.",
    })).resolves.toMatchObject({
      id: "discussion_terminal_1",
      scopeId: collaborationIds.scope,
      sequence: "1",
      actor: { actorId: collaborationActors.editor, displayName: "Ada Editor" },
      text: "Do not paste this into the terminal.",
    });

    const viewer = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.viewer,
      action: "read",
    });
    await expect(adapter.list(viewer, { afterSequence: "0", limit: 50 })).resolves.toMatchObject({
      latestSequence: "1",
      messages: [{ text: "Do not paste this into the terminal." }],
    });
    expect(committedScopes).toEqual([collaborationIds.scope]);
  });

  it("resolves participant metadata before opening the scope-locking transaction", async () => {
    const editor = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });
    let participantResolved = false;
    const transaction = fixture.db.transaction.bind(fixture.db);
    const transactionSpy = vi.spyOn(fixture.db, "transaction").mockImplementation(() => {
      expect(participantResolved).toBe(true);
      return transaction();
    });
    const lockSafeAdapter = new CollaborationDiscussionAdapter({
      db: fixture.db,
      authority,
      chatAdapter: new CollaborationChatAdapter({
        db: fixture.db,
        authority,
        now: () => new Date(now),
        resolveParticipant,
      }),
      now: () => new Date(now),
      createId: () => "discussion_terminal_lock_safe",
      resolveParticipant: async (actorId) => {
        participantResolved = true;
        return resolveParticipant(actorId);
      },
    });

    try {
      await expect(lockSafeAdapter.append(editor, {
        clientRequestId: requestId,
        expectedRevision: "1",
        text: "Resolve me before taking the row lock.",
      })).resolves.toMatchObject({ id: "discussion_terminal_lock_safe" });
    } finally {
      transactionSpy.mockRestore();
    }
  });

  it("keeps viewers read-only and read state actor-local", async () => {
    const viewer = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.viewer,
      action: "read",
    });
    await expect(adapter.append(viewer, {
      clientRequestId: requestId,
      expectedRevision: "1",
      text: "Viewer note",
    })).rejects.toMatchObject({ code: "forbidden" });

    await expect(adapter.getUserState(viewer)).resolves.toEqual({ readThroughSeq: "0" });
    await expect(adapter.updateUserState(viewer, { readThroughSeq: "1" }))
      .rejects.toMatchObject({ code: "invalid_request" });
  });

  it("exports only bounded shared notes and deletes terminal discussion with its authority scope", async () => {
    const editor = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });
    await adapter.append(editor, {
      clientRequestId: requestId,
      expectedRevision: "1",
      text: "Shared export note",
    });
    await adapter.updateUserState(editor, { readThroughSeq: "1" });

    const exported = await adapter.exportTerminalDiscussion(collaborationIds.scope);
    expect(exported).toMatchObject([{ text: "Shared export note" }]);
    expect(JSON.stringify(exported)).not.toContain("readThroughSeq");

    await fixture.db.deleteFrom("collaboration_scopes")
      .where("id", "=", collaborationIds.scope).execute();
    await expect(fixture.db.selectFrom("collaboration_discussion_messages").selectAll().execute())
      .resolves.toEqual([]);
    await expect(fixture.db.selectFrom("collaboration_discussion_user_state").selectAll().execute())
      .resolves.toEqual([]);
  });

  it("includes notes committed after export preparation but before the scope lock", async () => {
    const editor = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });
    const operation = await repository.applyTerminalExport({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      type: "export",
      clientRequestId: "50000000-0000-4000-8000-000000000012",
      expectedRevision: 1,
      payloadHash: "a".repeat(64),
    }, async () => {
      const projection = await adapter.prepareTerminalDiscussionExport(collaborationIds.scope);
      await adapter.append(editor, {
        clientRequestId: requestId,
        expectedRevision: "1",
        text: "Committed before the export lock",
      });
      return projection;
    });

    const exported = await repository.getScopeExport(
      collaborationIds.scope,
      collaborationActors.owner,
      operation.exportId!,
    );
    expect(exported).toMatchObject({
      scope: { kind: "terminal" },
      discussion: [{ text: "Committed before the export lock" }],
    });
  });
});

async function resolveParticipant(actorId: string) {
  return {
    actorId,
    displayName: actorId === collaborationActors.editor ? "Ada Editor" : "Viewer",
  };
}

async function seedTerminalScope(fixture: CollaborationTestDatabase) {
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    kind: "terminal",
    resource_id: "terminal_shared",
    parent_scope_id: null,
    membership_mode: "direct",
    lifecycle: "shared",
    revision: 1,
    auth_epoch: 1,
    authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1,
    execution_generation: 1,
    execution_eligibility: JSON.stringify({ profileId: "scope-runtime-terminal-v1" }),
    deleted_at: null,
    created_at: now,
    updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_members").values([
    member(collaborationActors.owner, "owner"),
    member(collaborationActors.editor, "editor"),
    member(collaborationActors.viewer, "viewer"),
  ]).execute();
}

function member(actorId: string, role: "owner" | "editor" | "viewer") {
  return {
    scope_id: collaborationIds.scope,
    actor_id: actorId,
    role,
    status: "accepted" as const,
    invitation_id: null,
    invited_by: collaborationActors.owner,
    accepted_at: now,
    expires_at: null,
    revision: 1,
    joined_at: now,
    updated_at: now,
  };
}
