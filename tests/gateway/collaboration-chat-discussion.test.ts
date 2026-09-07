import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationChatAdapter } from "../../packages/gateway/src/collaboration/chat-adapter.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-07T12:00:00.000Z";
const requestId = "50000000-0000-4000-8000-000000000001";

describe("CollaborationChatAdapter discussion", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;
  let authority: CollaborationAuthority;
  let adapter: CollaborationChatAdapter;
  let committedScopes: string[];

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedSharedChat(fixture);
    repository = new CollaborationRepository(fixture.db, { now: () => new Date(now) });
    authority = new CollaborationAuthority(repository, { now: () => new Date(now) });
    committedScopes = [];
    adapter = new CollaborationChatAdapter({
      db: fixture.db,
      authority,
      now: () => new Date(now),
      resolveParticipant: async (actorId) => ({
        actorId,
        displayName: actorId === collaborationActors.editor ? "Ada Editor" : "Nima Owner",
      }),
      onCommitted: async (scopeId) => {
        committedScopes.push(scopeId);
      },
    });
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("appends an attributed human discussion atomically without creating AI work", async () => {
    const context = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });
    const message = await adapter.appendDiscussion(context, {
      clientRequestId: requestId,
      expectedRevision: "1",
      text: "Let’s discuss the release boundary.",
    });
    expect(message).toMatchObject({
      chatId: collaborationIds.chat,
      sequence: "1",
      purpose: "discussion",
      actor: { actorId: collaborationActors.editor, displayName: "Ada Editor" },
      text: "Let’s discuss the release boundary.",
    });

    const counts = await Promise.all([
      fixture.db.selectFrom("chat_turns").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      fixture.db.selectFrom("chat_runs").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
      fixture.db.selectFrom("chat_queued_turns").select(({ fn }) => fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    ]);
    expect(counts.map(({ count }) => Number(count))).toEqual([0, 0, 0]);
    expect(await fixture.db.selectFrom("collaboration_events").select(["event_type", "payload"]).execute())
      .toEqual([{ event_type: "chat.discussion_appended", payload: {} }]);
    expect(committedScopes).toEqual([collaborationIds.scope]);
  });

  it("replays one actor request exactly and scopes the same ID to that actor", async () => {
    const editor = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });
    const owner = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      action: "discuss",
    });
    const input = { clientRequestId: requestId, expectedRevision: "1", text: "First note" };
    const first = await adapter.appendDiscussion(editor, input);
    expect(await adapter.appendDiscussion(editor, input)).toEqual(first);
    expect(committedScopes).toEqual([collaborationIds.scope]);
    const ownerMessage = await adapter.appendDiscussion(owner, input);
    expect(ownerMessage.sequence).toBe("2");
    expect(await fixture.db.selectFrom("chat_messages").selectAll().execute()).toHaveLength(2);

    await expect(adapter.appendDiscussion(editor, { ...input, text: "Changed replay" }))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("keeps viewers read-only and rechecks revocation inside the write transaction", async () => {
    const viewer = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.viewer,
      action: "read",
    });
    await expect(adapter.appendDiscussion(viewer, {
      clientRequestId: requestId,
      expectedRevision: "1",
      text: "Viewer write",
    })).rejects.toMatchObject({ code: "forbidden" });

    const editor = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });
    await fixture.db.updateTable("collaboration_members").set({ status: "revoked" })
      .where("scope_id", "=", collaborationIds.scope)
      .where("actor_id", "=", collaborationActors.editor).execute();
    await expect(adapter.appendDiscussion(editor, {
      clientRequestId: requestId,
      expectedRevision: "1",
      text: "Stale editor write",
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("returns canonical history while making owner-home attachment destinations inert", async () => {
    await fixture.db.insertInto("chat_messages").values({
      id: "msg_historical",
      chat_id: collaborationIds.chat,
      seq: 1,
      role: "user",
      state: "committed",
      turn_id: null,
      run_id: null,
      actor_id: null,
      purpose: "ai_request",
      parts: JSON.stringify([{
        type: "attachment_reference",
        attachmentId: "attachment_private",
        kind: "file",
        label: "private.txt",
        ownerReference: "projects/private.txt",
      }]),
      byte_count: 100,
      search_text: "private.txt",
      created_at: now,
    }).execute();
    const reader = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.viewer,
      action: "read",
    });
    const history = await adapter.listMessages(reader, { afterSequence: "0", limit: 50 });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ actor: { displayName: "Unknown participant" } });
    expect(JSON.stringify(history)).not.toContain("projects/private.txt");
  });
});

async function seedSharedChat(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    create_request_id: "req_shared_chat",
    project_id: "project_private",
    title: "Release discussion",
    lifecycle: "active",
    attention: "none",
    revision: 1,
    collaboration: JSON.stringify({
      scopeId: collaborationIds.scope,
      mode: "discussion_only",
      executionFenced: true,
    }),
    user_state: null,
    shell_state: null,
    fork_provenance: null,
    last_message_preview: null,
    current_selection: null,
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
    created_at: now,
    updated_at: now,
  }).execute();
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    kind: "chat",
    resource_id: collaborationIds.chat,
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
