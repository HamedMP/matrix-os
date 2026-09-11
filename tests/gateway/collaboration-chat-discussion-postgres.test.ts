import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationChatAdapter } from "../../packages/gateway/src/collaboration/chat-adapter.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import {
  collaborationActors,
  collaborationIds,
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = "2026-09-07T12:00:00.000Z";
const realDescribe = process.env.MATRIX_TEST_POSTGRES_URL ? describe : describe.skip;

realDescribe("shared Chat discussion real PostgreSQL transactions", () => {
  let fixture: CollaborationTestDatabase;
  let repository: CollaborationRepository;
  let authority: CollaborationAuthority;
  let adapter: CollaborationChatAdapter;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    repository = new CollaborationRepository(fixture.db, { now: () => new Date(now) });
    authority = new CollaborationAuthority(repository, { now: () => new Date(now) });
    adapter = new CollaborationChatAdapter({
      db: fixture.db,
      authority,
      now: () => new Date(now),
      resolveParticipant: async (actorId) => ({ actorId, displayName: actorId }),
    });
    await seedSharedChat(fixture);
  });

  afterEach(async () => {
    if (fixture) await fixture.destroy();
  });

  it("serializes actor-scoped idempotency while allowing another actor to reuse the request id", async () => {
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
    const input = {
      clientRequestId: "71000000-0000-4000-8000-000000000001",
      expectedRevision: "1",
      text: "One durable discussion message",
    };

    const [first, replay] = await Promise.all([
      adapter.appendDiscussion(editor, input),
      adapter.appendDiscussion(editor, input),
    ]);
    expect(replay).toEqual(first);
    await expect(adapter.appendDiscussion(owner, input)).resolves.toMatchObject({ sequence: "2" });
    expect(await countRows(fixture, "chat_messages")).toBe(2);
    expect(await countRows(fixture, "collaboration_operations")).toBe(2);
    expect(await countRows(fixture, "collaboration_events")).toBe(2);
  });

  it("serializes an accepted write against member revocation", async () => {
    const editor = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });
    const [write, revoke] = await Promise.allSettled([
      adapter.appendDiscussion(editor, {
        clientRequestId: "71000000-0000-4000-8000-000000000003",
        expectedRevision: "1",
        text: "This is committed only if it wins the scope lock.",
      }),
      repository.revokeMember({
        scopeId: collaborationIds.scope,
        actorId: collaborationActors.owner,
        targetActorId: collaborationActors.editor,
        clientRequestId: "71000000-0000-4000-8000-000000000004",
        expectedRevision: 1,
        expectedMemberRevision: 1,
        payloadHash: "a".repeat(64),
      }),
    ]);

    expect(revoke.status).toBe("fulfilled");
    expect(["fulfilled", "rejected"]).toContain(write.status);
    expect(await countRows(fixture, "chat_messages")).toBe(write.status === "fulfilled" ? 1 : 0);
    await expect(repository.getMember(collaborationIds.scope, collaborationActors.editor))
      .resolves.toMatchObject({ status: "revoked" });
    await expect(adapter.appendDiscussion(editor, {
      clientRequestId: "71000000-0000-4000-8000-000000000005",
      expectedRevision: "2",
      text: "A delayed write must never pass revocation.",
    })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rolls back the canonical message when its durable collaboration event cannot commit", async () => {
    await sql`
      CREATE FUNCTION reject_discussion_event() RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'chat.discussion_appended' THEN
          RAISE EXCEPTION 'forced collaboration event failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `.execute(fixture.db);
    await sql`
      CREATE TRIGGER reject_discussion_event_trigger
      BEFORE INSERT ON collaboration_events
      FOR EACH ROW EXECUTE FUNCTION reject_discussion_event()
    `.execute(fixture.db);
    const editor = await authority.authorize({
      scopeId: collaborationIds.scope,
      actorId: collaborationActors.editor,
      action: "discuss",
    });

    await expect(adapter.appendDiscussion(editor, {
      clientRequestId: "71000000-0000-4000-8000-000000000002",
      expectedRevision: "1",
      text: "Must not commit halfway",
    })).rejects.toBeInstanceOf(Error);
    expect(await countRows(fixture, "chat_messages")).toBe(0);
    expect(await countRows(fixture, "collaboration_operations")).toBe(0);
    expect(await countRows(fixture, "collaboration_events")).toBe(0);
    const chat = await fixture.db.selectFrom("chats").select(["revision", "message_count"])
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow();
    expect({ revision: Number(chat.revision), messageCount: Number(chat.message_count) })
      .toEqual({ revision: 1, messageCount: 0 });
  });
});

async function countRows(
  fixture: CollaborationTestDatabase,
  table: "chat_messages" | "collaboration_operations" | "collaboration_events",
): Promise<number> {
  const row = await fixture.db.selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

async function seedSharedChat(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    create_request_id: "req_real_postgres_discussion",
    project_id: null,
    title: "Shared Chat",
    lifecycle: "active",
    attention: "none",
    revision: 1,
    message_count: 0,
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
  ]).execute();
}

function member(actorId: string, role: "owner" | "editor") {
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
