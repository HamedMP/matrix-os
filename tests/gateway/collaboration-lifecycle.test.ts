import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");

describe("Chat collaboration lifecycle", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seed(fixture);
    repository = new CollaborationRepository(fixture.db, { now: () => now });
  });

  afterEach(async () => fixture.destroy());

  it("archives and restores the scope and canonical Chat atomically", async () => {
    const archived = await repository.applyChatLifecycle({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      type: "archive",
      clientRequestId: request(1),
      expectedRevision: 1,
      payloadHash: "a".repeat(64),
    });
    expect(archived).toMatchObject({ type: "archive", status: "completed", revision: "2" });
    expect(await repository.getScope(collaborationIds.scope)).toMatchObject({ lifecycle: "archived", revision: 2 });
    expect(await fixture.db.selectFrom("chats").select(["lifecycle", "revision"])
      .where("id", "=", collaborationIds.chat).executeTakeFirst()).toMatchObject({ lifecycle: "archived", revision: 2 });

    const restored = await repository.applyChatLifecycle({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      type: "restore",
      clientRequestId: request(2),
      expectedRevision: 2,
      payloadHash: "b".repeat(64),
    });
    expect(restored).toMatchObject({ type: "restore", status: "completed", revision: "3" });
    expect(await repository.getScope(collaborationIds.scope)).toMatchObject({ lifecycle: "shared", revision: 3 });
  });

  it("exports only scope-owned content and necessary content-free metadata", async () => {
    const operation = await repository.applyChatLifecycle({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      type: "export",
      clientRequestId: request(3),
      expectedRevision: 1,
      payloadHash: "c".repeat(64),
    });
    expect(operation).toMatchObject({ id: request(3), exportId: request(3), revision: "1" });
    expect(await repository.getLifecycleOperation(collaborationIds.scope, collaborationActors.owner, request(3)))
      .toEqual(operation);
    const exported = await repository.getScopeExport(collaborationIds.scope, collaborationActors.owner, request(3));
    expect(exported).toMatchObject({ scopeId: collaborationIds.scope, chat: { id: collaborationIds.chat } });
    const encoded = JSON.stringify(exported);
    expect(encoded).toContain("shared message");
    expect(encoded).not.toContain("projects/private-secret.txt");
    expect(encoded).not.toContain("private draft");
    expect(encoded).not.toContain("unrelated message");
    expect(encoded).not.toContain("user_state");
  });

  it("soft-deletes authority, removes only the selected Chat, and retains content-free audit", async () => {
    const deleted = await repository.applyChatLifecycle({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.owner,
      type: "delete",
      clientRequestId: request(4),
      expectedRevision: 1,
      payloadHash: "d".repeat(64),
    });
    expect(deleted).toMatchObject({ type: "delete", status: "completed", revision: "2" });
    expect(await repository.getScope(collaborationIds.scope)).toBeNull();
    expect(await fixture.db.selectFrom("chats").select("id").where("id", "=", collaborationIds.chat).executeTakeFirst())
      .toBeUndefined();
    expect(await fixture.db.selectFrom("chats").select("id").where("id", "=", "chat_unrelated").executeTakeFirst())
      .toEqual({ id: "chat_unrelated" });
    expect(await fixture.db.selectFrom("collaboration_audit").select(["action", "actor_id"])
      .where("scope_id", "=", collaborationIds.scope).execute()).toEqual([
      { action: "scope.deleted", actor_id: collaborationActors.owner },
    ]);
    expect(await repository.getScopeExport(collaborationIds.scope, collaborationActors.owner, request(4))).toBeNull();
  });
});

function request(index: number): string {
  return `50000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

async function seed(fixture: CollaborationTestDatabase): Promise<void> {
  const chat = (id: string, title: string, userState: unknown) => ({
    id,
    owner_type: "personal" as const,
    owner_id: collaborationActors.owner,
    create_request_id: `create_${id}`,
    project_id: null,
    title,
    lifecycle: "active" as const,
    attention: "none" as const,
    revision: 1,
    collaboration: id === collaborationIds.chat ? JSON.stringify({ scopeId: collaborationIds.scope }) : null,
    user_state: userState,
    shell_state: null,
    fork_provenance: null,
    last_message_preview: null,
    current_selection: null,
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  });
  await fixture.db.insertInto("chats").values([
    chat(collaborationIds.chat, "Shared Chat", { draft: "private draft" }),
    chat("chat_unrelated", "Unrelated", null),
  ]).execute();
  await fixture.db.insertInto("chat_messages").values([
    {
      id: "msg_shared", chat_id: collaborationIds.chat, seq: 1, role: "user", state: "committed",
      turn_id: null, run_id: null, actor_id: collaborationActors.editor, purpose: "discussion",
      parts: JSON.stringify([{ type: "attachment_reference", attachmentId: "att_shared", kind: "file", label: "shared message", ownerReference: "projects/private-secret.txt" }]),
      byte_count: 200, search_text: "shared message", created_at: now.toISOString(),
    },
    {
      id: "msg_unrelated", chat_id: "chat_unrelated", seq: 1, role: "user", state: "committed",
      turn_id: null, run_id: null, actor_id: collaborationActors.owner, purpose: "ai_request",
      parts: JSON.stringify([{ type: "text", text: "unrelated message" }]),
      byte_count: 100, search_text: "unrelated message", created_at: now.toISOString(),
    },
  ]).execute();
  await fixture.db.insertInto("chat_attachments").values({
    id: "att_shared", chat_id: collaborationIds.chat, message_id: "msg_shared", kind: "file",
    label: "shared message", mime_type: "text/plain", size_bytes: 12,
    owner_reference: "projects/private-secret.txt", created_at: now.toISOString(),
  }).execute();
  await fixture.db.insertInto("chat_user_state").values({
    chat_id: collaborationIds.chat, principal_id: collaborationActors.editor, read_through_seq: 1,
    pinned: true, muted: false, attention_acknowledged_at: null, last_opened_at: now.toISOString(), updated_at: now.toISOString(),
  }).execute();
  await fixture.db.insertInto("collaboration_scopes").values({
    id: collaborationIds.scope, owner_type: "personal", owner_id: collaborationActors.owner,
    kind: "chat", resource_id: collaborationIds.chat, parent_scope_id: null, membership_mode: "direct",
    lifecycle: "shared", revision: 1, auth_epoch: 1, authority_runtime_id: collaborationIds.runtime,
    authority_generation: 1, execution_generation: null, execution_eligibility: null,
    created_at: now.toISOString(), updated_at: now.toISOString(), deleted_at: null,
  }).execute();
  await fixture.db.insertInto("collaboration_members").values([
    member(collaborationActors.owner, "owner"), member(collaborationActors.editor, "editor"),
  ]).execute();
}

function member(actorId: string, role: "owner" | "editor") {
  return {
    scope_id: collaborationIds.scope, actor_id: actorId, role, status: "accepted" as const,
    invitation_id: null, invited_by: collaborationActors.owner, accepted_at: now.toISOString(), expires_at: null,
    revision: 1, joined_at: now.toISOString(), updated_at: now.toISOString(),
  };
}
