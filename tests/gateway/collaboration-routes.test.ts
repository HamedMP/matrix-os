import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import { CollaborationChatAdapter } from "../../packages/gateway/src/collaboration/chat-adapter.js";
import { CollaborationChatScopeService } from "../../packages/gateway/src/collaboration/chat-scope.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { createCollaborationRoutes } from "../../packages/gateway/src/collaboration/routes.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  collaborationActors,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const key = "0123456789abcdef0123456789abcdef";
const invitationRequestId = "50000000-0000-4000-8000-000000000001";
const acceptanceRequestId = "50000000-0000-4000-8000-000000000002";
const discussionRequestId = "50000000-0000-4000-8000-000000000003";

describe("collaboration gateway routes", () => {
  let fixture: CollaborationTestDatabase;
  let app: Hono;
  let signer: CollaborationProofSigner;
  let nonce: number;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedChat(fixture);
    const repository = new CollaborationRepository(fixture.db, {
      now: () => now,
      createId: () => collaborationIds.invitation,
    });
    const authority = new CollaborationAuthority(repository, { now: () => now });
    const chatScope = new CollaborationChatScopeService(fixture.db, {
      runtimeId: collaborationIds.runtime,
      preflightSecret: "0123456789abcdef0123456789abcdef",
      now: () => now,
      createScopeId: () => collaborationIds.scope,
    });
    const resolveParticipant = async (actorId: string) => ({
      actorId,
      displayName: actorId === collaborationActors.owner
        ? "Nima Owner"
        : actorId === collaborationActors.editor ? "Ada Editor" : "Vi Viewer",
    });
    const chatAdapter = new CollaborationChatAdapter({
      db: fixture.db,
      authority,
      resolveParticipant,
      now: () => now,
    });
    nonce = 0;
    signer = new CollaborationProofSigner({
      activeKeyId: "collaboration-key-1",
      keys: { "collaboration-key-1": key },
      now: () => now,
      createNonce: () => (++nonce).toString(16).padStart(32, "0"),
    });
    app = new Hono();
    app.route("/", createCollaborationRoutes({
      runtimeId: collaborationIds.runtime,
      verifier: new CollaborationActorProofVerifier({
        runtimeId: collaborationIds.runtime,
        keys: { "collaboration-key-1": key },
        now: () => now,
        authority,
      }),
      authority,
      repository,
      chatScope,
      chatAdapter,
      resolveParticipant,
      now: () => now,
    }));
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("preflights and converts an owner Chat without accepting participant identity", async () => {
    const preflight = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`,
      body: { kind: "chat", resourceId: collaborationIds.chat },
    });
    expect(preflight.status).toBe(200);
    const eligibility = await preflight.json() as { confirmationToken: string; resourceRevision: string };
    const created = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
      body: {
        kind: "chat",
        resourceId: collaborationIds.chat,
        clientRequestId: "50000000-0000-4000-8000-000000000010",
        expectedRevision: eligibility.resourceRevision,
        confirmationToken: eligibility.confirmationToken,
      },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      id: collaborationIds.scope,
      ownerId: collaborationActors.owner,
      kind: "chat",
      role: "owner",
      capabilities: { discuss: true, requestAi: false },
    });
  });

  it("supports owner invite, exact-actor acceptance, history, and attributed discussion", async () => {
    await shareChat();
    const invitation = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        targetActorId: collaborationActors.editor,
        role: "editor",
        clientRequestId: invitationRequestId,
        expectedRevision: "1",
      },
    });
    expect(invitation.status).toBe(201);
    expect(await invitation.json()).toMatchObject({
      id: collaborationIds.invitation,
      target: { actorId: collaborationActors.editor, displayName: "Ada Editor" },
      status: "pending",
    });
    const preview = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}`,
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ scopeKind: "chat", role: "editor", status: "pending" });

    const accepted = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}/accept`,
      body: { clientRequestId: acceptanceRequestId, expectedRevision: "2" },
    });
    expect(accepted.status).toBe(200);
    const chat = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat`,
    });
    expect(chat.status).toBe(200);
    const chatProjection = await chat.json();
    expect(chatProjection).toMatchObject({ id: collaborationIds.chat, title: "Release discussion" });
    expect(JSON.stringify(chatProjection)).not.toContain("project_private");
    const discussion = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`,
      body: {
        clientRequestId: discussionRequestId,
        expectedRevision: "3",
        text: "This is human discussion, not an AI request.",
      },
    });
    expect(discussion.status).toBe(201);
    expect(await discussion.json()).toMatchObject({
      purpose: "discussion",
      actor: { actorId: collaborationActors.editor, displayName: "Ada Editor" },
    });
    const history = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`,
      query: "after=0&limit=50",
    });
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      messages: [{ purpose: "discussion", actor: { actorId: collaborationActors.editor } }],
    });
  });

  it("lets viewers read and keep private state but rejects every discussion write", async () => {
    await shareChat();
    const invitation = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        targetActorId: collaborationActors.viewer,
        role: "viewer",
        clientRequestId: invitationRequestId,
        expectedRevision: "1",
      },
    });
    expect(invitation.status).toBe(201);
    const accepted = await signedJson({
      actorId: collaborationActors.viewer,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}/accept`,
      body: { clientRequestId: acceptanceRequestId, expectedRevision: "2" },
    });
    expect(accepted.status).toBe(200);
    const write = await signedJson({
      actorId: collaborationActors.viewer,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`,
      body: { clientRequestId: discussionRequestId, expectedRevision: "3", text: "Viewer write" },
    });
    expect(write.status).toBe(403);
    const state = await signedJson({
      actorId: collaborationActors.viewer,
      scopeId: collaborationIds.scope,
      method: "PATCH",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/user-state`,
      body: { pinned: true, muted: true, readThroughSeq: "0" },
    });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ pinned: true, muted: true });
    const ownerState = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/user-state`,
    });
    expect(await ownerState.json()).toMatchObject({ pinned: false, muted: false });
  });

  it("rejects unsafe and future read cursors without mutating private state", async () => {
    await shareChat();
    for (const readThroughSeq of ["9007199254740992", "1"]) {
      const response = await signedJson({
        actorId: collaborationActors.owner,
        scopeId: collaborationIds.scope,
        method: "PATCH",
        path: `/api/collaboration/scopes/${collaborationIds.scope}/user-state`,
        body: { readThroughSeq },
      });
      expect(response.status).toBe(400);
    }
    expect(await fixture.db.selectFrom("chat_user_state").selectAll().execute()).toEqual([]);
  });

  it("applies downgrade immediately and revocation removes all live scope access", async () => {
    await shareChat();
    await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        targetActorId: collaborationActors.editor,
        role: "editor",
        clientRequestId: invitationRequestId,
        expectedRevision: "1",
      },
    });
    await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}/accept`,
      body: { clientRequestId: acceptanceRequestId, expectedRevision: "2" },
    });
    const downgraded = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "PATCH",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/members/${collaborationActors.editor}`,
      body: {
        role: "viewer",
        clientRequestId: "50000000-0000-4000-8000-000000000020",
        expectedRevision: "3",
        expectedMemberRevision: "2",
      },
    });
    expect(downgraded.status).toBe(200);
    expect(await downgraded.json()).toMatchObject({ role: "viewer", scopeRevision: 4 });
    expect((await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`,
      body: { clientRequestId: discussionRequestId, expectedRevision: "4", text: "Stale editor" },
    })).status).toBe(403);
    const revoked = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "DELETE",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/members/${collaborationActors.editor}`,
      body: {
        clientRequestId: "50000000-0000-4000-8000-000000000021",
        expectedRevision: "4",
        expectedMemberRevision: "3",
      },
    });
    expect(revoked.status).toBe(200);
    expect((await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}`,
    })).status).toBe(403);
  });

  it("rejects snapshot-token substitution and oversized mutation bodies", async () => {
    const path = `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`;
    expect((await app.request(path, {
      method: "POST",
      headers: { "x-matrix-collaboration-proof": "public-snapshot-token" },
      body: JSON.stringify({ text: "not authorized" }),
    })).status).toBe(401);
    const oversized = "x".repeat(97 * 1024);
    const body = JSON.stringify({
      clientRequestId: discussionRequestId,
      expectedRevision: "1",
      text: oversized,
    });
    const bytes = new TextEncoder().encode(body);
    const proof = signer.signHttp({
      actorId: collaborationActors.owner,
      ownerId: collaborationActors.owner,
      runtimeId: collaborationIds.runtime,
      scopeId: collaborationIds.scope,
      method: "POST",
      path,
      query: "",
      body: bytes,
    });
    expect((await app.request(path, {
      method: "POST",
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/json",
        "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
      },
      body,
    })).status).toBe(413);
  });

  async function shareChat(): Promise<void> {
    const preflightPath = `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`;
    const preflight = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: preflightPath,
      body: { kind: "chat", resourceId: collaborationIds.chat },
    });
    const eligibility = await preflight.json() as { confirmationToken: string; resourceRevision: string };
    await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
      body: {
        kind: "chat",
        resourceId: collaborationIds.chat,
        clientRequestId: "50000000-0000-4000-8000-000000000010",
        expectedRevision: eligibility.resourceRevision,
        confirmationToken: eligibility.confirmationToken,
      },
    });
  }

  async function signedJson(input: {
    actorId: string;
    scopeId?: string;
    method: "GET" | "POST" | "PATCH" | "DELETE";
    path: string;
    query?: string;
    body?: unknown;
  }): Promise<Response> {
    const body = input.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(input.body));
    const proof = signer.signHttp({
      actorId: input.actorId,
      ownerId: collaborationActors.owner,
      runtimeId: collaborationIds.runtime,
      ...(input.scopeId ? { scopeId: input.scopeId } : {}),
      method: input.method,
      path: input.path,
      query: input.query ?? "",
      body,
    });
    return app.request(`${input.path}${input.query ? `?${input.query}` : ""}`, {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
      },
      ...(input.body === undefined ? {} : { body: new TextDecoder().decode(body) }),
    });
  }
});

async function seedChat(fixture: CollaborationTestDatabase): Promise<void> {
  await fixture.db.insertInto("chats").values({
    id: collaborationIds.chat,
    owner_type: "personal",
    owner_id: collaborationActors.owner,
    create_request_id: "request_routes_chat",
    project_id: "project_private",
    title: "Release discussion",
    lifecycle: "active",
    attention: "none",
    revision: 1,
    collaboration: null,
    user_state: null,
    shell_state: null,
    fork_provenance: null,
    last_message_preview: null,
    current_selection: null,
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).execute();
}
