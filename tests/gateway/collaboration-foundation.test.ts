import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { SharedChatQueueError } from "../../packages/gateway/src/chat/queue-repository.js";
import {
  bootstrapCollaborationDatabase,
} from "../../packages/gateway/src/collaboration/database.js";
import {
  applyCollaborationBaseSchema,
  COLLABORATION_VERSIONED_MIGRATIONS,
} from "../../packages/gateway/src/collaboration/database-migrations.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationGrantRepository } from "../../packages/gateway/src/collaboration/grant-repository.js";
import { CollaborationLifecycleRepository } from "../../packages/gateway/src/collaboration/lifecycle-repository.js";
import { createCollaborationRoutes } from "../../packages/gateway/src/collaboration/routes.js";
import { registerScopeRoutes } from "../../packages/gateway/src/collaboration/scope-routes.js";
import { registerChatRoutes } from "../../packages/gateway/src/collaboration/chat-routes.js";
import { registerTerminalRoutes } from "../../packages/gateway/src/collaboration/terminal-routes.js";
import { registerProjectRoutes } from "../../packages/gateway/src/collaboration/project-routes.js";
import { registerLifecycleRoutes } from "../../packages/gateway/src/collaboration/lifecycle-routes.js";
import { registerExecutionPolicyRoutes } from "../../packages/gateway/src/collaboration/execution-policy-routes.js";
import { handle } from "../../packages/gateway/src/collaboration/route-support.js";
import {
  collaborationActors,
  collaborationExecutionEligibility,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

/**
 * S01 / T006 characterization for the gateway collaboration seams: route
 * registration, repository delegation, versioned schema bootstrap and the
 * shared Chat queue keep their observable behavior after the T008 extraction.
 * The route baseline below was captured from routes.ts on main 3b4662d28.
 */
const ROUTE_BASELINE: ReadonlyArray<readonly [string, string]> = [
  ["POST", "/api/collaboration/runtimes/:runtimeId/scopes/preflight"],
  ["POST", "/api/collaboration/runtimes/:runtimeId/scopes"],
  ["GET", "/api/collaboration/scopes/:scopeId"],
  ["GET", "/api/collaboration/scopes/:scopeId/members"],
  ["POST", "/api/collaboration/scopes/:scopeId/invitations"],
  ["GET", "/api/collaboration/invitations/:invitationId"],
  ["POST", "/api/collaboration/invitations/:invitationId/accept"],
  ["POST", "/api/collaboration/invitations/:invitationId/decline"],
  ["DELETE", "/api/collaboration/scopes/:scopeId/invitations/:invitationId"],
  ["PATCH", "/api/collaboration/scopes/:scopeId/members/:actorId"],
  ["DELETE", "/api/collaboration/scopes/:scopeId/members/:actorId"],
  ["GET", "/api/collaboration/scopes/:scopeId/user-state"],
  ["PATCH", "/api/collaboration/scopes/:scopeId/user-state"],
  ["GET", "/api/collaboration/scopes/:scopeId/chat"],
  ["GET", "/api/collaboration/scopes/:scopeId/chat/messages"],
  ["POST", "/api/collaboration/scopes/:scopeId/chat/messages"],
  ["GET", "/api/collaboration/scopes/:scopeId/discussion/messages"],
  ["POST", "/api/collaboration/scopes/:scopeId/discussion/messages"],
  ["GET", "/api/collaboration/scopes/:scopeId/discussion/user-state"],
  ["PATCH", "/api/collaboration/scopes/:scopeId/discussion/user-state"],
  ["GET", "/api/collaboration/scopes/:scopeId/chat/requests"],
  ["POST", "/api/collaboration/scopes/:scopeId/chat/requests"],
  ["POST", "/api/collaboration/scopes/:scopeId/chat/requests/:requestId/cancel"],
  ["POST", "/api/collaboration/scopes/:scopeId/chat/requests/:requestId/retry"],
  ["POST", "/api/collaboration/scopes/:scopeId/chat/approvals/:approvalId/decision"],
  ["GET", "/api/collaboration/scopes/:scopeId/terminal"],
  ["POST", "/api/collaboration/scopes/:scopeId/terminal/actions"],
  ["PATCH", "/api/collaboration/scopes/:scopeId/terminal"],
  ["GET", "/api/collaboration/scopes/:scopeId/project"],
  ["GET", "/api/collaboration/scopes/:scopeId/project/inventory"],
  ["POST", "/api/collaboration/scopes/:scopeId/project/confirm"],
  ["POST", "/api/collaboration/scopes/:scopeId/lifecycle"],
  ["GET", "/api/collaboration/scopes/:scopeId/operations/:operationId"],
  ["GET", "/api/collaboration/scopes/:scopeId/exports/:exportId"],
  // S08 execution policy routes register after the S01 baseline.
  ["GET", "/api/collaboration/scopes/:scopeId/execution-policy"],
  ["PUT", "/api/collaboration/scopes/:scopeId/execution-policy"],
];

const stubOptions = {
  runtimeId: collaborationIds.runtime,
  verifier: {} as never,
  authority: {} as never,
  repository: {} as never,
  chatScope: {} as never,
  chatAdapter: {} as never,
  discussionAdapter: {} as never,
  resolveParticipant: async () => ({ actorId: "x", displayName: "x" }) as never,
  resolveInvitationIdentifier: async () => ({ actorId: "x", displayName: "x" }) as never,
};

function handlerRoutes(app: Hono): Array<readonly [string, string]> {
  return app.routes
    .filter((route) => route.method !== "ALL" && !route.path.endsWith("/*"))
    .map((route) => [route.method, route.path] as const);
}

describe("gateway collaboration route registration (S01 foundation)", () => {
  it("registers exactly the baseline handler routes in the baseline order", () => {
    expect(handlerRoutes(createCollaborationRoutes(stubOptions))).toEqual(ROUTE_BASELINE);
  });

  it("keeps the no-store and mutation body-limit middleware on the collaboration prefix", () => {
    const app = createCollaborationRoutes(stubOptions);
    const prefix = app.routes.filter((route) => route.path === "/api/collaboration/*");
    expect(prefix.map((route) => route.method).sort()).toEqual(["ALL", "DELETE", "PATCH", "POST"]);
  });

  it("composes the same handler set from the per-resource registration modules", () => {
    const app = new Hono();
    registerScopeRoutes(app, stubOptions);
    registerChatRoutes(app, stubOptions);
    registerTerminalRoutes(app, stubOptions);
    registerProjectRoutes(app, stubOptions);
    registerLifecycleRoutes(app, stubOptions);
    registerExecutionPolicyRoutes(app, stubOptions);
    expect(handlerRoutes(app)).toEqual(ROUTE_BASELINE);
  });

  it("maps unknown failures to a generic 503 through the shared handler", async () => {
    const app = new Hono();
    app.get("/boom", (c) => handle(c, async () => { throw new Error("secret detail"); }));
    const response = await app.request("/boom");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Collaboration unavailable", code: "unavailable" });
  });
});

describe("gateway collaboration repository delegation (S01 foundation)", () => {
  it("delegates grant and lifecycle methods to the focused repositories", async () => {
    const accept = vi.spyOn(CollaborationGrantRepository.prototype, "acceptInvitation")
      .mockResolvedValue({ invitationId: "i", scopeId: "s", scopeRevision: 2, memberRevision: 1 });
    const revoke = vi.spyOn(CollaborationGrantRepository.prototype, "revokeMember")
      .mockResolvedValue({ scopeId: "s", actorId: "a", role: "editor", status: "revoked", scopeRevision: 2, memberRevision: 1 });
    const operation = vi.spyOn(CollaborationLifecycleRepository.prototype, "getLifecycleOperation")
      .mockResolvedValue(null);
    try {
      const repository = new CollaborationRepository({} as never);
      const input = { invitationId: "i", actorId: "a", clientRequestId: "c", expectedRevision: 1, payloadHash: "h" };
      await repository.acceptInvitation(input);
      await repository.revokeMember({
        scopeId: "s", actorId: "a", targetActorId: "b", clientRequestId: "c",
        expectedRevision: 1, expectedMemberRevision: 1, payloadHash: "h",
      });
      await repository.getLifecycleOperation("s", "a", "o");
      expect(accept).toHaveBeenCalledWith(input);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledWith("s", "a", "o");
    } finally {
      accept.mockRestore();
      revoke.mockRestore();
      operation.mockRestore();
    }
  });
});

describe("gateway collaboration schema bootstrap (S01 foundation)", () => {
  let fixture: CollaborationTestDatabase;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await new ChatRepository(fixture.db).bootstrap();
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("registers the versioned migrations in order and records every version idempotently", async () => {
    expect(COLLABORATION_VERSIONED_MIGRATIONS.map((step) => step.version)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(typeof applyCollaborationBaseSchema).toBe("function");
    await bootstrapCollaborationDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    const versions = await fixture.db.selectFrom("collaboration_schema_migrations")
      .select("version").orderBy("version").execute();
    expect(versions.map((row) => Number(row.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("shared Chat queue behavior (S01 foundation)", () => {
  const now = "2026-09-20T10:00:00.000Z";
  const owner = { type: "personal" as const, ownerId: collaborationActors.owner };
  let fixture: CollaborationTestDatabase;
  let repository: ChatRepository;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    repository = new ChatRepository(fixture.db);
    await repository.bootstrap();
    await bootstrapCollaborationDatabase(fixture.db);
    await fixture.db.insertInto("chats").values({
      id: collaborationIds.chat,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      create_request_id: "req_foundation_chat",
      project_id: null,
      title: "Foundation queue",
      lifecycle: "active",
      attention: "none",
      revision: 1,
      message_count: 0,
      collaboration: JSON.stringify({ scopeId: collaborationIds.scope, mode: "shared_ai", executionFenced: true }),
      user_state: null,
      shell_state: null,
      fork_provenance: null,
      last_message_preview: null,
      current_selection: JSON.stringify({ instanceId: "claude_shared", model: "claude-opus-4-6" }),
      bound_driver_kind: "claude_code",
      bound_instance_id: "claude_shared",
      bound_at_turn_id: "cturn_original_claude",
      created_at: now,
      updated_at: now,
    }).execute();
    await fixture.db.insertInto("collaboration_scopes").values({
      id: collaborationIds.scope,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      kind: "chat",
      organization_id: "org_matrix_team",
      resource_id: collaborationIds.chat,
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      revision: 1,
      auth_epoch: 1,
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1,
      execution_generation: 1,
      execution_eligibility: JSON.stringify(collaborationExecutionEligibility()),
      deleted_at: null,
      created_at: now,
      updated_at: now,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values(
      [[collaborationActors.owner, "owner"], [collaborationActors.editor, "editor"]].map(([actorId, role]) => ({
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
      })),
    ).execute();
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  function request(index: number, actorId: string, expectedRevision: number, clientRequestIndex = index) {
    return {
      chatId: collaborationIds.chat,
      scopeId: collaborationIds.scope,
      queuedTurnId: `qturn_foundation_${index}_${actorId}`,
      clientRequestId: `00000000-0000-4000-8000-${clientRequestIndex.toString().padStart(12, "0")}`,
      requestingActorId: actorId,
      acceptedAuthEpoch: 1,
      payloadHash: index.toString(16).padStart(64, "0"),
      expectedRevision,
      parts: [{ type: "text" as const, text: `Foundation request ${index}` }],
      interactionMode: "default",
      permissionMode: "supervised",
      capabilitySnapshot: {
        revision: "shared-catalog-1", rootChat: true, attachments: [], resources: [], tools: [],
        approvals: true, userInput: false, resume: true, cancellation: true,
        steering: "none" as const, worktrees: "none" as const,
        interactionModes: ["default"], permissionModes: ["supervised"],
      },
      acceptedAt: now,
    };
  }

  it("serializes shared requests FIFO with one active run per Chat and actor-scoped replay", async () => {
    const first = await repository.enqueueSharedQueuedTurn(owner, request(1, collaborationActors.owner, 1));
    const second = await repository.enqueueSharedQueuedTurn(owner, request(2, collaborationActors.editor, 2));
    expect([first.acceptedSequence, second.acceptedSequence]).toEqual([1, 2]);
    expect(second.pendingCount).toBe(2);
    const replay = await repository.enqueueSharedQueuedTurn(owner, request(1, collaborationActors.owner, 3));
    expect(replay).toMatchObject({ id: first.id, acceptedSequence: 1, alreadyAccepted: true });

    // Idempotency is scoped to the requesting actor: the editor reusing the
    // owner's client request ID gets its own queued turn instead of the replay,
    // and the owner's replay keeps deduplicating afterwards.
    const editorSameRequestId = await repository.enqueueSharedQueuedTurn(
      owner,
      request(3, collaborationActors.editor, 3, 1),
    );
    expect(editorSameRequestId.clientRequestId).toBe(first.clientRequestId);
    expect(editorSameRequestId).toMatchObject({
      requestingActorId: collaborationActors.editor,
      acceptedSequence: 3,
      alreadyAccepted: false,
      pendingCount: 3,
    });
    expect(editorSameRequestId.id).not.toBe(first.id);
    const ownerReplayAgain = await repository.enqueueSharedQueuedTurn(owner, request(1, collaborationActors.owner, 4));
    expect(ownerReplayAgain).toMatchObject({ id: first.id, acceptedSequence: 1, alreadyAccepted: true });

    const listed = await repository.listSharedQueuedTurns(owner, collaborationIds.chat);
    expect(listed.map((turn) => [turn.requestingActorId, turn.clientRequestId, turn.state])).toEqual([
      [collaborationActors.owner, first.clientRequestId, "queued"],
      [collaborationActors.editor, request(2, collaborationActors.editor, 2).clientRequestId, "queued"],
      [collaborationActors.editor, first.clientRequestId, "queued"],
    ]);

    const claimed = await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat, turnId: "cturn_f_1", runId: "run_f_1", messageId: "msg_f_1", claimedAt: now,
    });
    expect(claimed?.message).toMatchObject({ actorId: collaborationActors.owner, purpose: "ai_request" });
    const blocked = await repository.claimNextQueuedTurn(owner, {
      chatId: collaborationIds.chat, turnId: "cturn_f_2", runId: "run_f_2", messageId: "msg_f_2", claimedAt: now,
    });
    expect(blocked).toBeNull();
    expect(new SharedChatQueueError("capacity").code).toBe("capacity");
  });
});
