/**
 * A shared project's Chats are inherited scopes. The owner's home publishes each one's route to the
 * platform directory, beside its project, so members who accepted the project can open them; it
 * describes the project to members by name with its Chats; and ending someone's project access
 * also closes the Chats they have open in it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationDirectoryOutbox } from "../../packages/gateway/src/collaboration/directory-outbox.js";
import { CollaborationEventRegistry } from "../../packages/gateway/src/collaboration/events.js";
import { createProjectInheritanceResolver } from "../../packages/gateway/src/collaboration/project-inheritance.js";
import {
  PROJECT_CHAT_ROUTE_EVENT,
  publishMissingProjectChatRoutes,
  publishProjectChatRoutes,
  readProjectOverview,
} from "../../packages/gateway/src/collaboration/project-chat-routes.js";
import { createProjectTransitionJournal } from "../../packages/gateway/src/collaboration/project-transition.js";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";

const PROJECT_SCOPE = "10000000-0000-4000-8000-000000000a51";
const TRANSITION_ID = "20000000-0000-4000-8000-000000000a51";
const OWNER_ID = "user_project_owner";
const MEMBER_ID = "user_project_member";
const ORGANIZATION_ID = "org_matrix_team";
const SOURCE_RUNTIME = "runtime_project_owner";
const DESTINATION_RUNTIME = "vps:runtime_project_shared";
const HASH = "a".repeat(64);
const NOW = new Date("2026-10-03T12:00:00.000Z");
const LATER = new Date("2026-10-03T12:05:00.000Z");

const chats = [
  { id: "chat_release_plan", scope: "10000000-0000-4000-8000-000000000c01", title: "Release plan", updatedAt: NOW },
  { id: "chat_bug_triage", scope: "10000000-0000-4000-8000-000000000c02", title: "Bug triage", updatedAt: LATER },
];
const TERMINAL_SCOPE = "10000000-0000-4000-8000-000000000c03";

async function seedChat(fixture: CollaborationTestDatabase, chat: { id: string; title: string; updatedAt: Date }) {
  await fixture.db.insertInto("chats").values({
    id: chat.id, owner_type: "personal", owner_id: OWNER_ID, create_request_id: `req_${chat.id}`,
    project_id: "proj_alpha", title: chat.title, lifecycle: "active", attention: "none", revision: 1,
    message_count: 0, collaboration: null, user_state: null, shell_state: null, fork_provenance: null,
    last_message_preview: null, current_selection: null,
    bound_driver_kind: null, bound_instance_id: null, bound_at_turn_id: null, created_at: NOW, updated_at: chat.updatedAt,
  } as never).execute();
}

async function seedChild(fixture: CollaborationTestDatabase, input: { scope: string; kind: "chat" | "terminal"; resourceId: string; lifecycle: string; binding: string }) {
  await fixture.db.insertInto("collaboration_scopes").values({
    id: input.scope, owner_type: "personal", owner_id: OWNER_ID, kind: input.kind, organization_id: ORGANIZATION_ID,
    resource_id: input.resourceId, parent_scope_id: PROJECT_SCOPE, membership_mode: "inherited", lifecycle: input.lifecycle,
    revision: 2, auth_epoch: 0, authority_runtime_id: DESTINATION_RUNTIME, authority_generation: 1,
    execution_generation: null, execution_eligibility: null, created_at: NOW, updated_at: NOW, deleted_at: null,
  } as never).execute();
  await fixture.db.insertInto("collaboration_resource_bindings").values({
    id: input.binding, project_scope_id: PROJECT_SCOPE, resource_scope_id: input.scope,
    resource_kind: input.kind, resource_id: input.resourceId, authority_runtime_id: DESTINATION_RUNTIME,
    authority_generation: 1, revision: 2, readiness: "ready", blocker: null,
    incarnation: input.kind === "terminal" ? "incarnation_1" : null, created_at: NOW, updated_at: NOW,
  } as never).execute();
}

async function deliver(fixture: CollaborationTestDatabase, at = NOW): Promise<Array<Record<string, unknown>>> {
  const sent: Array<Record<string, unknown>> = [];
  const outbox = new CollaborationDirectoryOutbox({
    db: fixture.db, platformBaseUrl: "https://platform.internal", runtimeId: DESTINATION_RUNTIME,
    serviceToken: "s".repeat(32), now: () => at, startTimer: false,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  try {
    await outbox.runOnce();
  } finally {
    await outbox.shutdown();
  }
  return sent;
}

describe("shared project Chats on the owner's home", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("collaboration_scopes").values({
      id: PROJECT_SCOPE, owner_type: "personal", owner_id: OWNER_ID, kind: "project", organization_id: ORGANIZATION_ID,
      resource_id: "proj_alpha", parent_scope_id: null, membership_mode: "direct", lifecycle: "private",
      revision: 4, auth_epoch: 0, authority_runtime_id: SOURCE_RUNTIME, authority_generation: 3,
      execution_generation: null, execution_eligibility: null, created_at: NOW, updated_at: NOW, deleted_at: null,
    } as never).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: PROJECT_SCOPE, actor_id: OWNER_ID, role: "owner", status: "accepted", organization_id: ORGANIZATION_ID,
      invitation_id: null, invited_by: OWNER_ID, accepted_at: NOW, expires_at: null, revision: 1,
      joined_at: NOW, updated_at: NOW,
    } as never).execute();
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  async function shareProject(options: { withChildren?: boolean } = {}) {
    const transitions = createProjectTransitionJournal({ db: fixture.db, now: () => NOW, createTransitionId: () => TRANSITION_ID });
    await transitions.prepare({
      scopeId: PROJECT_SCOPE, ownerId: OWNER_ID, requestedBy: OWNER_ID,
      clientRequestId: "50000000-0000-4000-8000-000000000a51", payloadHash: "c".repeat(64),
      expectedScopeRevision: 4, inventoryRevision: 7, inventoryHash: HASH, membershipHash: "b".repeat(64),
      destinationAuthorityRuntimeId: DESTINATION_RUNTIME, destinationAuthorityGeneration: 1,
    });
    if (options.withChildren !== false) {
      for (const [index, chat] of chats.entries()) {
        await seedChat(fixture, chat);
        await seedChild(fixture, { scope: chat.scope, kind: "chat", resourceId: chat.id, lifecycle: "preparing", binding: `30000000-0000-4000-8000-00000000000${index + 1}` });
      }
      await seedChild(fixture, { scope: TERMINAL_SCOPE, kind: "terminal", resourceId: "terminal_dev", lifecycle: "preparing", binding: "30000000-0000-4000-8000-000000000009" });
    }
    await transitions.beginStaging(TRANSITION_ID);
    await transitions.recordStagedManifest(TRANSITION_ID, "manifest_11111111111111111111111111111111");
    await transitions.markFenced({
      transitionId: TRANSITION_ID, sourceFenceEpoch: 8, currentInventoryRevision: 7,
      currentInventoryHash: HASH, currentMembershipHash: "b".repeat(64),
    });
    await transitions.beginCommit(TRANSITION_ID);
    await transitions.recordPublication(TRANSITION_ID, "publication_11111111111111111111111111111111");
    await transitions.activate(TRANSITION_ID);
    return transitions;
  }

  function routes(sent: Array<Record<string, unknown>>) {
    return sent.filter((event) => event.parentScopeId !== undefined);
  }

  it("publishes a route for each Chat beside the project when the project is shared, exactly once", async () => {
    const transitions = await shareProject();
    await transitions.activate(TRANSITION_ID);
    const sent = await deliver(fixture);
    expect(sent.find((event) => event.scopeId === PROJECT_SCOPE)).toMatchObject({ kind: "project", audience: "organization" });
    expect(routes(sent).sort((a, b) => String(a.scopeId).localeCompare(String(b.scopeId)))).toEqual(chats.map((chat) => ({
      eventId: expect.any(String),
      scopeId: chat.scope,
      runtimeId: DESTINATION_RUNTIME,
      ownerId: OWNER_ID,
      kind: "chat",
      organizationId: ORGANIZATION_ID,
      authorityGeneration: 1,
      metadataRevision: 3,
      recipients: [],
      parentScopeId: PROJECT_SCOPE,
    })));
    // A project's terminals are not opened by members, so they get no route.
    expect(sent.some((event) => event.scopeId === TERMINAL_SCOPE)).toBe(false);
    expect(await fixture.db.selectFrom("collaboration_events").select("scope_id")
      .where("event_type", "=", PROJECT_CHAT_ROUTE_EVENT).execute()).toHaveLength(chats.length);
  });

  it("routes a Chat that was shared with the organization before its project, without its old grant", async () => {
    await shareProject();
    await deliver(fixture);
    // The Chat's own organization grant from its earlier direct share is still active.
    await fixture.db.insertInto("collaboration_grants").values({
      id: "50000000-0000-4000-8000-000000000c01", scope_id: chats[0]!.scope, organization_id: ORGANIZATION_ID,
      audience_kind: "organization", audience_actor_id: null, preset: "viewer", state: "active", policy_version: "v1",
      source_id: null, legacy_ceiling: null, expires_at: null, revision: 1, created_by: OWNER_ID,
      created_at: NOW, updated_at: NOW, revoked_at: null,
    } as never).execute();
    await fixture.db.deleteFrom("collaboration_events").where("event_type", "=", PROJECT_CHAT_ROUTE_EVENT).execute();
    expect(await publishMissingProjectChatRoutes(fixture.db, { now: () => LATER })).toBe(chats.length);
    const sent = await deliver(fixture, LATER);
    const route = routes(sent).find((event) => event.scopeId === chats[0]!.scope);
    expect(route).toMatchObject({ parentScopeId: PROJECT_SCOPE, recipients: [] });
    expect(route).not.toHaveProperty("audience");
    expect(route).not.toHaveProperty("organizationGrantId");
    expect(await fixture.db.selectFrom("collaboration_directory_outbox").select("event_id")
      .where("delivered_at", "is", null).execute()).toEqual([]);
  });

  it("publishes every Chat of a project however many batches it takes", async () => {
    await shareProject();
    await fixture.db.deleteFrom("collaboration_events").where("event_type", "=", PROJECT_CHAT_ROUTE_EVENT).execute();
    const published = await fixture.db.transaction().execute((trx) => publishProjectChatRoutes(trx, {
      projectScopeId: PROJECT_SCOPE, now: LATER, limit: 1,
    }));
    expect(published).toBe(chats.length);
    expect(await publishMissingProjectChatRoutes(fixture.db, { now: () => LATER })).toBe(0);
  });

  it("publishes a route for a Chat added to a project that is already shared", async () => {
    await shareProject({ withChildren: false });
    await deliver(fixture);
    const added = { id: "chat_added_later", title: "Added later", updatedAt: LATER };
    await seedChat(fixture, added);
    const inheritance = createProjectInheritanceResolver({ db: fixture.db, now: () => LATER, createScopeId: () => "10000000-0000-4000-8000-000000000c09" });
    await inheritance.bindOwnedResource({
      projectScopeId: PROJECT_SCOPE, ownerId: OWNER_ID, kind: "chat", resourceId: added.id,
      authorityRuntimeId: DESTINATION_RUNTIME, authorityGeneration: 1, revision: 1, readiness: "ready",
    });
    // Binding the same Chat again publishes nothing new.
    await inheritance.bindOwnedResource({
      projectScopeId: PROJECT_SCOPE, ownerId: OWNER_ID, kind: "chat", resourceId: added.id,
      authorityRuntimeId: DESTINATION_RUNTIME, authorityGeneration: 1, revision: 1, readiness: "ready",
    });
    const sent = await deliver(fixture, LATER);
    expect(routes(sent)).toEqual([expect.objectContaining({
      scopeId: "10000000-0000-4000-8000-000000000c09", kind: "chat", parentScopeId: PROJECT_SCOPE, recipients: [],
    })]);
  });

  it("backfills routes for Chats of projects shared before routes existed, and only once", async () => {
    await shareProject();
    // A project shared by an earlier version has no Chat routes.
    const published = await fixture.db.selectFrom("collaboration_events").select("event_id")
      .where("event_type", "=", PROJECT_CHAT_ROUTE_EVENT).execute();
    await fixture.db.deleteFrom("collaboration_directory_outbox")
      .where("event_id", "in", published.map((row) => row.event_id)).execute();
    await fixture.db.deleteFrom("collaboration_audit").where("action", "=", PROJECT_CHAT_ROUTE_EVENT).execute();
    await fixture.db.deleteFrom("collaboration_events").where("event_type", "=", PROJECT_CHAT_ROUTE_EVENT).execute();
    await deliver(fixture);

    expect(await publishMissingProjectChatRoutes(fixture.db, { now: () => LATER })).toBe(chats.length);
    expect(await publishMissingProjectChatRoutes(fixture.db, { now: () => LATER })).toBe(0);
    const sent = await deliver(fixture, LATER);
    expect(routes(sent).map((event) => event.scopeId).sort()).toEqual(chats.map((chat) => chat.scope).sort());
  });

  it("never publishes routes for a project that is not shared, or for removed Chats", async () => {
    await fixture.db.insertInto("collaboration_scopes").values({
      id: "10000000-0000-4000-8000-000000000c05", owner_type: "personal", owner_id: OWNER_ID, kind: "chat",
      organization_id: ORGANIZATION_ID, resource_id: "chat_private_project", parent_scope_id: PROJECT_SCOPE,
      membership_mode: "inherited", lifecycle: "shared", revision: 1, auth_epoch: 0,
      authority_runtime_id: SOURCE_RUNTIME, authority_generation: 1, execution_generation: null,
      execution_eligibility: null, created_at: NOW, updated_at: NOW, deleted_at: null,
    } as never).execute();
    expect(await publishMissingProjectChatRoutes(fixture.db, { now: () => LATER })).toBe(0);
    await shareProject();
    await fixture.db.updateTable("collaboration_scopes").set({ lifecycle: "deleted", deleted_at: LATER } as never)
      .where("id", "=", chats[0]!.scope).execute();
    await fixture.db.deleteFrom("collaboration_events").where("event_type", "=", PROJECT_CHAT_ROUTE_EVENT).execute();
    expect(await publishMissingProjectChatRoutes(fixture.db, { now: () => LATER })).toBe(1);
  });

  it("describes a shared project to members by name with its Chats, newest first", async () => {
    await shareProject();
    await fixture.db.updateTable("chats").set({ title: "Fix /home/ paths", updated_at: NOW }).where("id", "=", chats[0]!.id).execute();
    await fixture.db.updateTable("chats").set({ updated_at: LATER }).where("id", "=", chats[1]!.id).execute();
    const overview = await readProjectOverview(fixture.db, {
      scopeId: PROJECT_SCOPE,
      projectName: async (ownerId, projectId) => (ownerId === OWNER_ID && projectId === "proj_alpha" ? "Collab testing" : null),
    });
    expect(overview).toEqual({
      projectId: "proj_alpha",
      scopeId: PROJECT_SCOPE,
      name: "Collab testing",
      status: "active",
      chats: [
        { scopeId: chats[1]!.scope, chatId: chats[1]!.id, title: "Bug triage", updatedAt: LATER.toISOString() },
        // A title that is not safe to show members is replaced, never sent as is.
        { scopeId: chats[0]!.scope, chatId: chats[0]!.id, title: "Untitled Chat", updatedAt: NOW.toISOString() },
      ],
    });
    await expect(readProjectOverview(fixture.db, { scopeId: PROJECT_SCOPE, projectName: async () => null }))
      .resolves.toMatchObject({ name: "Shared project" });
  });

  it("does not describe a project that is not shared", async () => {
    await expect(readProjectOverview(fixture.db, { scopeId: PROJECT_SCOPE, projectName: async () => "Alpha" }))
      .rejects.toMatchObject({ code: "not_found" });
  });

  it("closes a member's open project Chat when their project access ends", async () => {
    await shareProject();
    const frames: string[] = [];
    const registry = new CollaborationEventRegistry({
      db: fixture.db,
      startTimers: false,
      now: () => NOW,
      authorize: async (scopeId, actorId) => ({
        actorId, ownerId: OWNER_ID, organizationId: ORGANIZATION_ID, scopeId, membershipScopeId: PROJECT_SCOPE,
        resourceKind: "chat", resourceId: chats[0]!.id, role: "editor", authEpoch: 0,
        authorityRuntimeId: DESTINATION_RUNTIME, authorityGeneration: 1, capability: "read",
      }) as never,
    });
    try {
      await registry.open({
        connectionId: "connection_member", scopeId: chats[0]!.scope, actorId: MEMBER_ID, authorityGeneration: 1,
        socket: { send: (value) => { frames.push(value); }, close: () => undefined },
      });
      registry.notifyRevoked("10000000-0000-4000-8000-0000000000ff", MEMBER_ID);
      registry.notifyRevoked(PROJECT_SCOPE, OWNER_ID);
      expect(frames.some((frame) => frame.includes("\"unavailable\""))).toBe(false);
      registry.notifyRevoked(PROJECT_SCOPE, MEMBER_ID);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(frames.map((frame) => JSON.parse(frame) as { type: string; scopeId: string })
        .filter((frame) => frame.type === "unavailable")).toEqual([expect.objectContaining({ scopeId: chats[0]!.scope })]);
    } finally {
      registry.shutdown();
    }
  });
});
