import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { CollaborationChatCommands } from "../../packages/gateway/src/chat/collaboration-commands.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { CollaborationActorProofVerifier } from "../../packages/gateway/src/collaboration/actor-proof.js";
import { CollaborationAuthority } from "../../packages/gateway/src/collaboration/authority.js";
import {
  createOrganizationPrecondition,
  type OrganizationPrecondition,
} from "../../packages/gateway/src/collaboration/organization-precondition.js";
import { CollaborationChatAdapter } from "../../packages/gateway/src/collaboration/chat-adapter.js";
import { CollaborationChatExecutionAdapter } from "../../packages/gateway/src/collaboration/chat-execution-adapter.js";
import { CollaborationChatScopeService } from "../../packages/gateway/src/collaboration/chat-scope.js";
import { bootstrapCollaborationDatabase } from "../../packages/gateway/src/collaboration/database.js";
import { CollaborationDiscussionAdapter } from "../../packages/gateway/src/collaboration/discussion-adapter.js";
import { CollaborationRepository } from "../../packages/gateway/src/collaboration/repository.js";
import { CollaborationParticipantResolverError } from "../../packages/gateway/src/collaboration/participant-resolver.js";
import { createCollaborationProjectLifecycle } from "../../packages/gateway/src/collaboration/project-lifecycle.js";
import { CollaborationProjectScopeService } from "../../packages/gateway/src/collaboration/project-scope.js";
import { createProjectSharingService } from "../../packages/gateway/src/collaboration/project-sharing.js";
import { createProjectTransitionJournal } from "../../packages/gateway/src/collaboration/project-transition.js";
import { createCollaborationRoutes } from "../../packages/gateway/src/collaboration/routes.js";
import { CollaborationTerminalAdapter } from "../../packages/gateway/src/collaboration/terminal-adapter.js";
import { TerminalControlCoordinator } from "../../packages/gateway/src/collaboration/terminal-control.js";
import { CollaborationTerminalDispatcher } from "../../packages/gateway/src/collaboration/terminal-dispatcher.js";
import { CollaborationProofSigner } from "../../packages/platform/src/collaboration/proof.js";
import {
  collaborationActors,
  collaborationExecutionEligibility,
  collaborationIds,
  createCollaborationTestDatabase,
  type CollaborationTestDatabase,
  allowAllOrganizationPrecondition,
} from "./collaboration-test-support.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const key = "0123456789abcdef0123456789abcdef";
const invitationRequestId = "50000000-0000-4000-8000-000000000001";
const acceptanceRequestId = "50000000-0000-4000-8000-000000000002";
const discussionRequestId = "50000000-0000-4000-8000-000000000003";
const terminalId = "terminal_release";
const terminalIncarnation = `terminal-${"a".repeat(32)}`;
const projectScopeId = "10000000-0000-4000-8000-000000000401";

function request(index: number): string {
  return `50000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

// Tests switch this to a real precondition to prove proof-only owner operations are gated.
let activePrecondition: OrganizationPrecondition = allowAllOrganizationPrecondition;
const switchablePrecondition: OrganizationPrecondition = {
  require: (input) => activePrecondition.require(input),
  registerSource: (source) => activePrecondition.registerSource(source),
  describe: () => activePrecondition.describe(),
};

describe("collaboration gateway routes", () => {
  let fixture: CollaborationTestDatabase;
  let app: Hono;
  let signer: CollaborationProofSigner;
  let nonce: number;
  let chatScope: CollaborationChatScopeService;
  let resolveInvitationIdentifier: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fixture = await createCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await bootstrapCollaborationDatabase(fixture.db);
    await seedChat(fixture);
    const repository = new CollaborationRepository(fixture.db, {
      now: () => now,
      createId: () => collaborationIds.invitation,
    });
    const authority = new CollaborationAuthority(repository, { now: () => now, organizationPrecondition: switchablePrecondition });
    chatScope = new CollaborationChatScopeService(fixture.db, {
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
    resolveInvitationIdentifier = vi.fn(async (identifier: string) => {
      const normalized = identifier.trim().replace(/^@/, "").toLowerCase();
      if ([collaborationActors.editor.toLowerCase(), "nimanaderi", "person@example.com"].includes(normalized)) {
        return resolveParticipant(collaborationActors.editor);
      }
      if ([collaborationActors.viewer.toLowerCase(), "viewer"].includes(normalized)) {
        return resolveParticipant(collaborationActors.viewer);
      }
      if ([collaborationActors.owner.toLowerCase(), "owner"].includes(normalized)) {
        return resolveParticipant(collaborationActors.owner);
      }
      throw new CollaborationParticipantResolverError();
    });
    const chatAdapter = new CollaborationChatAdapter({
      db: fixture.db,
      authority,
      resolveParticipant,
      now: () => now,
    });
    const discussionAdapter = new CollaborationDiscussionAdapter({
      db: fixture.db,
      authority,
      chatAdapter,
      resolveParticipant,
      now: () => now,
    });
    const chatRepository = new ChatRepository(fixture.db);
    const chatExecutionAdapter = new CollaborationChatExecutionAdapter({
      repository: chatRepository,
      commands: new CollaborationChatCommands({
        db: fixture.db,
        now: () => now,
        submitApproval: async () => undefined,
      }),
      resolveParticipant,
      resolveResourceRevision: async (_scopeId, chatId) => {
        const row = await fixture.db.selectFrom("chats").select("revision")
          .where("id", "=", chatId).executeTakeFirst();
        return row ? Number(row.revision) : null;
      },
      resolveEligibility: async (scopeId) => {
        const row = await fixture.db.selectFrom("collaboration_scopes")
          .select("execution_eligibility").where("id", "=", scopeId).executeTakeFirst();
        return typeof row?.execution_eligibility === "string"
          ? JSON.parse(row.execution_eligibility) as unknown
          : row?.execution_eligibility;
      },
      // This fixture exercises the organization-enabled member submission path.
      resolveEffectiveSubmitMode: async () => "members",
      resolveCanonicalProviderAuthority: async (_ownerId, selection) =>
        selection.instanceId === "claude_code_default" && selection.model === "opus"
          ? { driverKind: "claude_code", selection }
          : null,
      requestDispatch: async () => undefined,
      now: () => now,
      createQueuedTurnId: () => "qturn_shared_route_1",
    });
    const terminalSession: Record<string, unknown> = {
      name: terminalId,
      status: "active",
      createdAt: now.toISOString(),
      incarnationVerified: true,
      creatorActorId: collaborationActors.owner,
      sessionIncarnation: terminalIncarnation,
      executionGeneration: 4,
      sharedControlMode: "eligible",
    };
    const terminalRuntime = {
      input: async () => undefined,
      paste: async () => undefined,
      resize: async () => undefined,
      stop: async () => undefined,
    };
    const terminalAdapter = new CollaborationTerminalAdapter({
      repository,
      registry: {
        get: async () => terminalSession,
        bindCollaboration: async (_name, input) => {
          terminalSession.collaborationScopeId = input.scopeId;
          terminalSession.sharedControlMode = "shared";
          return terminalSession;
        },
        unbindCollaboration: async () => undefined,
      },
      runtime: terminalRuntime,
      runtimeId: collaborationIds.runtime,
      executionEligibility: {
        profileId: "scope-runtime-terminal-v1",
        profileVersion: 1,
        profileDigest: "c".repeat(64),
        adapterId: "terminal",
        harnessVersion: "1.0.0",
      },
      preflightSecret: key,
      now: () => now,
      createScopeId: () => collaborationIds.scope,
    });
    const terminalDispatcher = new CollaborationTerminalDispatcher({
      authority,
      terminal: terminalAdapter,
      control: new TerminalControlCoordinator({ startTimer: false }),
      resolveParticipant,
    });
    const projectLifecycle = createCollaborationProjectLifecycle({
      db: fixture.db,
      now: () => now,
      stageTransfer: async () => ({
        destinationAuthorityRuntimeId: "runtime_project_successor",
        destinationAuthorityGeneration: 1,
        publicationMarker: "publication_project_transfer",
      }),
      deleteProject: async () => undefined,
    });
    const projectScope = new CollaborationProjectScopeService(fixture.db, {
      runtimeId: collaborationIds.runtime,
      preflightSecret: key,
      now: () => now,
      createScopeId: () => collaborationIds.scope,
      createEventId: () => "60000000-0000-4000-8000-000000000001",
      source: {
        getProject: async (ownerId, projectId) => ownerId === collaborationActors.owner && projectId === "proj_alpha"
          ? { id: projectId, ownerId, revision: 7 }
          : null,
      },
    });
    const projectSharing = createProjectSharingService({
      db: fixture.db,
      inventory: {
        preview: async ({ projectId, membershipEffects }) => ({
          projectId,
          projectRevision: 7,
          ownedItems: [{ kind: "file", id: "README.md", revision: "1", compatibility: "ready" }],
          externalReferences: [],
          blockers: [],
          membershipEffects,
          inventoryHash: "a".repeat(64),
          membershipHash: "b".repeat(64),
          inventoryToken: "c".repeat(64),
          expiresAt: "2026-09-11T12:10:00.000Z",
        }),
        verifyConfirmation: async () => undefined,
      },
      transitions: createProjectTransitionJournal({
        db: fixture.db,
        now: () => now,
        createTransitionId: () => "70000000-0000-4000-8000-000000000001",
      }),
      resolveDestination: async () => ({
        runtimeId: "runtime_project_shared",
        authorityGeneration: 2,
      }),
    });
    nonce = 0;
    signer = new CollaborationProofSigner({
      activeKeyId: "collaboration-key-1",
      keys: { "collaboration-key-1": key },
      now: () => now,
      createNonce: () => (++nonce).toString(16).padStart(32, "0"),
    });
    app = new Hono();
    // Production mounts the global owner bearer middleware before these
    // routes. Collaboration must pass through to its scoped actor-proof
    // verifier without possessing or impersonating the owner's credential.
    app.use("*", authMiddleware("owner-gateway-token"));
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
      discussionAdapter,
      chatExecutionAdapter,
      terminalAdapter,
      terminalDispatcher,
      projectLifecycle,
      projectScope,
      projectSharing,
      resolveParticipant,
      resolveInvitationIdentifier,
      now: () => now,
    }));
  });

  afterEach(async () => {
    activePrecondition = allowAllOrganizationPrecondition;
    await fixture.destroy();
  });

  it("denies every proof-only owner operation once the owner's organization membership is revoked", async () => {
    await shareChat();
    const scopeRows = await fixture.db.selectFrom("collaboration_scopes").select("organization_id").execute();
    expect(scopeRows).toEqual([{ organization_id: "org_matrix_team" }]);
    const exported = await signedJson({
      actorId: collaborationActors.owner, scopeId: collaborationIds.scope, method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/lifecycle`,
      body: { type: "export", clientRequestId: request(70), expectedRevision: "1" },
    });
    expect(exported.status).toBe(200);
    const operationId = ((await exported.json()) as { id: string }).id;
    const current = await signedJson({
      actorId: collaborationActors.owner, scopeId: collaborationIds.scope, method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}`,
    });
    const revision = ((await current.json()) as { revision: string }).revision;
    const invited = await signedJson({
      actorId: collaborationActors.owner, scopeId: collaborationIds.scope, method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: { identifier: "nimanaderi", role: "editor", clientRequestId: request(71), expectedRevision: revision },
    });
    expect(invited.status).toBe(201);

    const revoked = new Set([collaborationActors.owner, collaborationActors.editor]);
    const precondition = createOrganizationPrecondition({ now: () => now });
    precondition.registerSource({
      assertMembership: async ({ actorId }) => revoked.has(actorId)
        ? { member: false }
        : { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() },
    });
    activePrecondition = precondition;

    const denied = [
      signedJson({ actorId: collaborationActors.owner, scopeId: collaborationIds.scope, method: "POST",
        path: `/api/collaboration/scopes/${collaborationIds.scope}/lifecycle`,
        body: { type: "export", clientRequestId: request(72), expectedRevision: "3" } }),
      signedJson({ actorId: collaborationActors.owner, scopeId: collaborationIds.scope, method: "GET",
        path: `/api/collaboration/scopes/${collaborationIds.scope}/operations/${operationId}` }),
      signedJson({ actorId: collaborationActors.owner, scopeId: collaborationIds.scope, method: "GET",
        path: `/api/collaboration/scopes/${collaborationIds.scope}/exports/${operationId}` }),
      signedJson({ actorId: collaborationActors.owner, scopeId: collaborationIds.scope, method: "GET",
        path: `/api/collaboration/scopes/${collaborationIds.scope}/project/inventory` }),
      signedJson({ actorId: collaborationActors.owner, scopeId: collaborationIds.scope, method: "POST",
        path: `/api/collaboration/scopes/${collaborationIds.scope}/project/confirm`,
        body: { clientRequestId: request(73), expectedScopeRevision: "3", expectedProjectRevision: "1",
          inventoryHash: "a".repeat(64), membershipHash: "b".repeat(64), inventoryToken: "c".repeat(64) } }),
      signedJson({ actorId: collaborationActors.owner, method: "POST",
        path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`,
        body: { kind: "chat", resourceId: collaborationIds.chat, organizationId: "org_matrix_team" } }),
      signedJson({ actorId: collaborationActors.owner, method: "POST",
        path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
        body: { kind: "chat", resourceId: collaborationIds.chat, organizationId: "org_matrix_team",
          clientRequestId: request(74), expectedRevision: "0", confirmationToken: "d".repeat(64) } }),
      signedJson({ actorId: collaborationActors.editor, scopeId: collaborationIds.scope, method: "GET",
        path: `/api/collaboration/invitations/${collaborationIds.invitation}` }),
      signedJson({ actorId: collaborationActors.editor, scopeId: collaborationIds.scope, method: "POST",
        path: `/api/collaboration/invitations/${collaborationIds.invitation}/accept`,
        body: { clientRequestId: request(75), expectedRevision: "1" } }),
      signedJson({ actorId: collaborationActors.editor, scopeId: collaborationIds.scope, method: "POST",
        path: `/api/collaboration/invitations/${collaborationIds.invitation}/decline`,
        body: { clientRequestId: request(76), expectedRevision: "1" } }),
    ];
    for (const response of await Promise.all(denied)) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Collaboration unavailable", code: "not_found" });
    }
    const member = await fixture.db.selectFrom("collaboration_members").select("status")
      .where("actor_id", "=", collaborationActors.editor).executeTakeFirstOrThrow();
    expect(member.status).toBe("pending");
  });

  it("rejects a foreign organizationId before any scope is written and binds the organization into the confirmation", async () => {
    const precondition = createOrganizationPrecondition({ now: () => now });
    precondition.registerSource({
      assertMembership: async ({ organizationId }) => organizationId === "org_matrix_team"
        ? { member: true, expiresAt: new Date(now.getTime() + 20_000).toISOString() }
        : { member: false },
    });
    activePrecondition = precondition;
    const preflightPath = `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`;
    const foreign = await signedJson({
      actorId: collaborationActors.owner, method: "POST", path: preflightPath,
      body: { kind: "chat", resourceId: collaborationIds.chat, organizationId: "org_other_company" },
    });
    expect(foreign.status).toBe(404);
    const preflight = await signedJson({
      actorId: collaborationActors.owner, method: "POST", path: preflightPath,
      body: { kind: "chat", resourceId: collaborationIds.chat, organizationId: "org_matrix_team" },
    });
    expect(preflight.status).toBe(200);
    const eligibility = await preflight.json() as { confirmationToken: string; resourceRevision: string };
    // A confirmation issued for org_matrix_team cannot create the scope under another organization.
    activePrecondition = allowAllOrganizationPrecondition;
    const swapped = await signedJson({
      actorId: collaborationActors.owner, method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
      body: { kind: "chat", resourceId: collaborationIds.chat, organizationId: "org_other_company",
        clientRequestId: request(77), expectedRevision: eligibility.resourceRevision,
        confirmationToken: eligibility.confirmationToken },
    });
    expect(swapped.status).toBe(409);
    expect(await fixture.db.selectFrom("collaboration_scopes").selectAll().execute()).toEqual([]);
  });

  it("preflights and converts an owner Chat without accepting participant identity", async () => {
    const preflight = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`,
      body: { kind: "chat", resourceId: collaborationIds.chat, organizationId: "org_matrix_team" },
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

        organizationId: "org_matrix_team",
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

  it("projects requestAi for the current actor, role and runtime capability", async () => {
    const executionEligibility = collaborationExecutionEligibility();
    await chatScope.reconcileExecutionEligibility({ executionGeneration: 9, eligibility: executionEligibility });
    await shareChat();
    await fixture.db.insertInto("collaboration_members").values([
      {
        scope_id: collaborationIds.scope,
        actor_id: collaborationActors.editor,
        role: "editor",
        status: "accepted",
        invitation_id: null,
        invited_by: collaborationActors.owner,
        accepted_at: now.toISOString(),
        expires_at: null,
        revision: 1,
        joined_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      {
        scope_id: collaborationIds.scope,
        actor_id: collaborationActors.viewer,
        role: "viewer",
        status: "accepted",
        invitation_id: null,
        invited_by: collaborationActors.owner,
        accepted_at: now.toISOString(),
        expires_at: null,
        revision: 1,
        joined_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
    ]).execute();
    const path = `/api/collaboration/scopes/${collaborationIds.scope}`;
    const capability = async (actorId: string): Promise<boolean> => {
      const response = await signedJson({
        actorId,
        scopeId: collaborationIds.scope,
        method: "GET",
        path,
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { capabilities: { requestAi: boolean } }).capabilities.requestAi;
    };

    await expect(capability(collaborationActors.owner)).resolves.toBe(true);
    await expect(capability(collaborationActors.editor)).resolves.toBe(true);
    await expect(capability(collaborationActors.viewer)).resolves.toBe(false);

    await fixture.db.updateTable("collaboration_scopes")
      .set({ execution_generation: 10 })
      .where("id", "=", collaborationIds.scope).execute();
    await expect(capability(collaborationActors.owner)).resolves.toBe(false);
  });

  it("prepares a private project scope for the owner runtime", async () => {
    const preflightPath = `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`;
    const body = { kind: "project", resourceId: "proj_alpha", organizationId: "org_matrix_team" };
    const preflight = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: preflightPath,
      body,
    });
    expect(preflight.status).toBe(200);
    const eligibility = await preflight.json() as { confirmationToken: string; resourceRevision: string };
    const created = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
      body: {
        ...body,
        clientRequestId: request(92),
        expectedRevision: eligibility.resourceRevision,
        confirmationToken: eligibility.confirmationToken,
      },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      id: collaborationIds.scope,
      kind: "project",
      lifecycle: "private",
      role: "owner",
      capabilities: { read: false, manageMembers: true },
    });
    const reopened = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: preflightPath,
      body,
    });
    await expect(reopened.json()).resolves.toMatchObject({
      existingScopeId: collaborationIds.scope,
      existingLifecycle: "private",
    });
  });

  it("returns one owner-derived inventory and accepts only its exact confirmation", async () => {
    const preflightPath = `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`;
    const preflight = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: preflightPath,
      body: { kind: "project", resourceId: "proj_alpha", organizationId: "org_matrix_team" },
    });
    const eligibility = await preflight.json() as { confirmationToken: string; resourceRevision: string };
    await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
      body: {
        kind: "project",
        resourceId: "proj_alpha",
        organizationId: "org_matrix_team",

        clientRequestId: request(93),
        expectedRevision: eligibility.resourceRevision,
        confirmationToken: eligibility.confirmationToken,
      },
    });
    const inventoryPath = `/api/collaboration/scopes/${collaborationIds.scope}/project/inventory`;
    const inventoryResponse = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: inventoryPath,
    });
    expect(inventoryResponse.status).toBe(200);
    const inventory = await inventoryResponse.json() as Record<string, unknown>;
    expect(inventory).toMatchObject({
      scopeId: collaborationIds.scope,
      projectId: "proj_alpha",
      projectRevision: "7",
      scopeRevision: "0",
      ownedItems: [{ kind: "file", id: "README.md" }],
    });
    const confirmed = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/project/confirm`,
      body: {
        clientRequestId: request(94),
        expectedScopeRevision: inventory.scopeRevision,
        expectedProjectRevision: inventory.projectRevision,
        inventoryHash: inventory.inventoryHash,
        membershipHash: inventory.membershipHash,
        inventoryToken: inventory.inventoryToken,
      },
    });
    expect(confirmed.status).toBe(202);
    expect(await confirmed.json()).toMatchObject({ status: "prepared", inventoryRevision: "7" });

    await fixture.db.updateTable("collaboration_scopes").set({
      lifecycle: "shared",
      revision: 1,
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 2,
    }).where("id", "=", collaborationIds.scope).execute();
    await fixture.db.insertInto("collaboration_resource_bindings").values({
      id: "80000000-0000-4000-8000-000000000001",
      project_scope_id: collaborationIds.scope,
      resource_scope_id: null,
      resource_kind: "file",
      resource_id: "README.md",
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 2,
      revision: 1,
      readiness: "ready",
      blocker: null,
      incarnation: null,
      created_at: now,
      updated_at: now,
    }).execute();
    const project = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/project`,
    });
    expect(project.status).toBe(200);
    await expect(project.json()).resolves.toMatchObject({
      id: "proj_alpha",
      scopeId: collaborationIds.scope,
      status: "active",
      resources: [{ kind: "file", id: "README.md", readiness: "ready" }],
    });
  });

  it("preflights, shares, reads, and controls a terminal through the authority", async () => {
    const preflightPath = `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`;
    const preflight = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: preflightPath,
      body: { kind: "terminal", resourceId: terminalId, organizationId: "org_matrix_team" },
    });
    const eligibility = await preflight.json() as { confirmationToken: string; resourceRevision: string };
    expect(preflight.status).toBe(200);
    const created = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
      body: {
        kind: "terminal",
        resourceId: terminalId,

        organizationId: "org_matrix_team",
        clientRequestId: request(90),
        expectedRevision: eligibility.resourceRevision,
        confirmationToken: eligibility.confirmationToken,
      },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      kind: "terminal",
      resourceId: terminalId,

      organizationId: "org_matrix_team",
      capabilities: { observeTerminal: true, controlTerminal: true, stopTerminal: true },
    });

    const terminalPath = `/api/collaboration/scopes/${collaborationIds.scope}/terminal`;
    const terminal = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: terminalPath,
    });
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toMatchObject({ id: terminalId, incarnation: terminalIncarnation });

    const action = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `${terminalPath}/actions`,
      body: {
        type: "acquire",
        clientRequestId: request(91),
        incarnation: terminalIncarnation,
        connectionId: "connection_owner",
      },
    });
    expect(action.status).toBe(200);
    expect(await action.json()).toMatchObject({
      action: "acquired",
      terminal: { controller: { actor: { actorId: collaborationActors.owner }, leaseEpoch: "1" } },
    });
  });

  it("exports terminal discussion through the owner lifecycle route", async () => {
    const preflightPath = `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`;
    const preflight = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: preflightPath,
      body: { kind: "terminal", resourceId: terminalId, organizationId: "org_matrix_team" },
    });
    const eligibility = await preflight.json() as { confirmationToken: string; resourceRevision: string };
    const created = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
      body: {
        kind: "terminal",
        resourceId: terminalId,

        organizationId: "org_matrix_team",
        clientRequestId: request(92),
        expectedRevision: eligibility.resourceRevision,
        confirmationToken: eligibility.confirmationToken,
      },
    });
    expect(created.status).toBe(201);

    const discussion = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/discussion/messages`,
      body: {
        clientRequestId: request(93),
        expectedRevision: "1",
        text: "Shared terminal export note",
      },
    });
    expect(discussion.status).toBe(201);

    const lifecyclePath = `/api/collaboration/scopes/${collaborationIds.scope}/lifecycle`;
    const exported = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: lifecyclePath,
      body: { type: "export", clientRequestId: request(94), expectedRevision: "1" },
    });
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({ exportId: request(94), status: "completed" });

    const artifact = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/exports/${request(94)}`,
    });
    expect(artifact.status).toBe(200);
    expect(await artifact.json()).toMatchObject({
      scope: { kind: "terminal", resourceId: terminalId },
      discussion: [{ text: "Shared terminal export note" }],
    });
  });

  it("accepts an invitation using the revision returned by its projection", async () => {
    await shareChat();
    const invitation = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        identifier: collaborationActors.editor,
        role: "editor",
        clientRequestId: invitationRequestId,
        expectedRevision: "1",
      },
    });
    expect(invitation.status).toBe(201);
    const created = await invitation.json() as { revision: string };
    expect(created.revision).toBe("2");

    const preview = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}`,
    });
    expect(preview.status).toBe(200);
    const projection = await preview.json() as { revision: string };
    expect(projection.revision).toBe(created.revision);

    const accepted = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}/accept`,
      body: { clientRequestId: acceptanceRequestId, expectedRevision: projection.revision },
    });
    expect(accepted.status).toBe(200);
  });

  it("lets the exact pending target decline without owner authority", async () => {
    await shareChat();
    const invitation = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        identifier: collaborationActors.editor,
        role: "editor",
        clientRequestId: invitationRequestId,
        expectedRevision: "1",
      },
    });
    const created = await invitation.json() as { revision: string };
    const path = `/api/collaboration/invitations/${collaborationIds.invitation}/decline`;
    const declined = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path,
      body: { clientRequestId: request(121), expectedRevision: created.revision },
    });
    expect(declined.status).toBe(200);
    expect(await declined.json()).toMatchObject({
      actorId: collaborationActors.editor,
      status: "revoked",
      scopeRevision: 3,
    });
    expect((await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path,
      body: { clientRequestId: request(122), expectedRevision: "3" },
    })).status).toBe(403);
  });

  it("projects Chat discussion through generic scope routes", async () => {
    await shareChat();
    const path = `/api/collaboration/scopes/${collaborationIds.scope}/discussion/messages`;
    const created = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path,
      body: {
        clientRequestId: discussionRequestId,
        expectedRevision: "1",
        text: "Human-only note",
      },
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      scopeId: collaborationIds.scope,
      sequence: "1",
      text: "Human-only note",
    });
    const listed = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path,
      query: "after=0&limit=50",
    });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      latestSequence: "1",
      messages: [{ text: "Human-only note" }],
    });
  });

  it("rejects acceptance when the scope changes after the invitation projection", async () => {
    await shareChat();
    await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        identifier: collaborationActors.editor,
        role: "editor",
        clientRequestId: invitationRequestId,
        expectedRevision: "1",
      },
    });
    const preview = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}`,
    });
    expect(preview.status).toBe(200);
    const projection = await preview.json() as { revision: string };
    await fixture.db.updateTable("collaboration_scopes")
      .set({ revision: Number(projection.revision) + 1, updated_at: now })
      .where("id", "=", collaborationIds.scope)
      .execute();

    const accepted = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}/accept`,
      body: { clientRequestId: acceptanceRequestId, expectedRevision: projection.revision },
    });
    expect(accepted.status).toBe(409);
    expect(await accepted.json()).toEqual({ error: "Collaboration state changed", code: "conflict" });
    await expect(fixture.db.selectFrom("collaboration_members")
      .select("status")
      .where("invitation_id", "=", collaborationIds.invitation)
      .executeTakeFirstOrThrow()).resolves.toEqual({ status: "pending" });
  });

  it.each([
    { state: "revoked" as const, expectedStatus: 409, expectedCode: "conflict" },
    { state: "expired" as const, expectedStatus: 410, expectedCode: "expired" },
  ])("does not accept a $state invitation", async ({ state, expectedStatus, expectedCode }) => {
    await shareChat();
    const invitation = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        identifier: collaborationActors.editor,
        role: "editor",
        clientRequestId: invitationRequestId,
        expectedRevision: "1",
      },
    });
    expect(invitation.status).toBe(201);
    const created = await invitation.json() as { revision: string };
    if (state === "revoked") {
      const revoked = await signedJson({
        actorId: collaborationActors.owner,
        scopeId: collaborationIds.scope,
        method: "DELETE",
        path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations/${collaborationIds.invitation}`,
        deleteConditions: {
          clientRequestId: request(120),
          expectedRevision: created.revision,
          expectedMemberRevision: "1",
        },
      });
      expect(revoked.status).toBe(200);
    } else {
      await fixture.db.updateTable("collaboration_members")
        .set({ expires_at: new Date(now.getTime() - 1).toISOString(), updated_at: now })
        .where("invitation_id", "=", collaborationIds.invitation)
        .execute();
    }
    const preview = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}`,
    });
    expect(preview.status).toBe(200);
    const projection = await preview.json() as { revision: string };

    const accepted = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}/accept`,
      body: { clientRequestId: acceptanceRequestId, expectedRevision: projection.revision },
    });
    expect(accepted.status).toBe(expectedStatus);
    expect(await accepted.json()).toEqual({ error: "Collaboration state changed", code: expectedCode });
    await expect(fixture.db.selectFrom("collaboration_members")
      .select("status")
      .where("invitation_id", "=", collaborationIds.invitation)
      .executeTakeFirstOrThrow()).resolves.toEqual({ status: state });
  });

  it("supports owner invite, exact-actor acceptance, history, and attributed discussion", async () => {
    await shareChat();
    const invitation = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        identifier: "nimanaderi",
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
    expect(resolveInvitationIdentifier).toHaveBeenCalledWith("nimanaderi", "org_matrix_team");
    const preview = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}`,
    });
    expect(preview.status).toBe(200);
    const previewProjection = await preview.json() as { revision: string };
    expect(previewProjection).toMatchObject({ scopeKind: "chat", role: "editor", status: "pending" });

    const accepted = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/invitations/${collaborationIds.invitation}/accept`,
      body: { clientRequestId: acceptanceRequestId, expectedRevision: previewProjection.revision },
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

  it("does not persist an email identifier or a digest derived from the raw invitation body", async () => {
    await shareChat();
    const body = {
      identifier: "person@example.com",
      role: "editor" as const,
      clientRequestId: request(69),
      expectedRevision: "1",
    };
    const response = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body,
    });
    expect(response.status).toBe(201);

    const operation = await fixture.db.selectFrom("collaboration_operations")
      .select(["payload_hash", "result_ref"])
      .where("client_request_id", "=", body.clientRequestId)
      .executeTakeFirstOrThrow();
    const rawBodyHash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    expect(operation.payload_hash).not.toBe(rawBodyHash);
    expect(JSON.stringify(operation)).not.toContain(body.identifier);
    await expect(fixture.db.selectFrom("collaboration_members")
      .select("actor_id")
      .where("scope_id", "=", collaborationIds.scope)
      .where("actor_id", "=", collaborationActors.editor)
      .executeTakeFirst()).resolves.toEqual({ actor_id: collaborationActors.editor });
  });

  it("authorizes before lookup and creates no partial row for unavailable or self identifiers", async () => {
    await shareChat();
    const path = `/api/collaboration/scopes/${collaborationIds.scope}/invitations`;
    const unauthorized = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path,
      body: {
        identifier: "nimanaderi",
        role: "editor",
        clientRequestId: request(70),
        expectedRevision: "1",
      },
    });
    expect([403, 404]).toContain(unauthorized.status);
    expect(resolveInvitationIdentifier).not.toHaveBeenCalled();

    for (const [identifier, expectedStatus] of [["missing-person", 503], ["@owner", 409]] as const) {
      const response = await signedJson({
        actorId: collaborationActors.owner,
        scopeId: collaborationIds.scope,
        method: "POST",
        path,
        body: {
          identifier,
          role: "editor",
          clientRequestId: request(identifier === "missing-person" ? 71 : 72),
          expectedRevision: "1",
        },
      });
      expect(response.status).toBe(expectedStatus);
    }
    expect(await fixture.db.selectFrom("collaboration_members").select("actor_id").execute())
      .toEqual([{ actor_id: collaborationActors.owner }]);
  });

  it("returns one generic failure for unresolved identities and rate limits enumeration", async () => {
    await shareChat();
    const path = `/api/collaboration/scopes/${collaborationIds.scope}/invitations`;
    const responses: Response[] = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(await signedJson({
        actorId: collaborationActors.owner,
        scopeId: collaborationIds.scope,
        method: "POST",
        path,
        body: {
          identifier: `unknown-${index}`,
          role: "viewer",
          clientRequestId: request(200 + index),
          expectedRevision: "1",
        },
      }));
    }
    expect(responses.slice(0, 10).map((response) => response.status)).toEqual(Array(10).fill(503));
    for (const response of responses.slice(0, 10)) {
      expect(await response.json()).toEqual({
        error: "Invitation could not be created",
        code: "unavailable",
      });
    }
    expect(responses[10]!.status).toBe(429);
    expect(await fixture.db.selectFrom("collaboration_members").select("actor_id").execute())
      .toEqual([{ actor_id: collaborationActors.owner }]);
  });

  it("admits and lists AI requests through the authority evaluator", async () => {
    await shareChat();
    await fixture.db.updateTable("collaboration_scopes").set({
      execution_generation: 1,
      execution_eligibility: JSON.stringify(collaborationExecutionEligibility()),
    }).where("id", "=", collaborationIds.scope).execute();
    const path = `/api/collaboration/scopes/${collaborationIds.scope}/chat/requests`;
    const body = {
      clientRequestId: request(80),
      expectedRevision: "2",
      text: "Summarize our discussion",
    };
    const tampered = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path,
      body: {
        ...body,
        clientRequestId: request(81),
        selection: { instanceId: "claude_shared", model: "claude-opus-4-6" },
      },
    });
    expect(tampered.status).toBe(400);
    const admitted = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path,
      body,
    });
    expect(admitted.status).toBe(201);
    expect(await admitted.json()).toMatchObject({
      resourceRevision: "3",
      request: {
        id: "qturn_shared_route_1",
        acceptedSequence: "1",
        actor: { actorId: collaborationActors.owner, displayName: "Nima Owner" },
        state: "queued",
      },
    });
    const listed = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path,
    });
    const listedBody = await listed.json();
    expect(listed.status, JSON.stringify(listedBody)).toBe(200);
    expect(listedBody).toMatchObject({
      requests: [{ id: "qturn_shared_route_1" }],
      resourceRevision: "3",
    });
  });

  it("keeps history and discussion available when the bound Provider is unsupported", async () => {
    await shareChat();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: collaborationIds.scope,
      actor_id: collaborationActors.editor,
      role: "editor",
      status: "accepted",
      invitation_id: null,
      invited_by: collaborationActors.owner,
      accepted_at: now,
      expires_at: null,
      revision: 1,
      joined_at: now,
      updated_at: now,
    }).execute();
    await fixture.db.updateTable("collaboration_scopes").set({
      execution_generation: 1,
      execution_eligibility: JSON.stringify(collaborationExecutionEligibility()),
    }).where("id", "=", collaborationIds.scope).execute();
    await fixture.db.updateTable("chats").set({
      current_selection: JSON.stringify({ instanceId: "codex_default", model: "gpt-5.6-sol" }),
      bound_driver_kind: "codex",
      bound_instance_id: "codex_default",
      bound_at_turn_id: "cturn_existing_codex",
    }).where("id", "=", collaborationIds.chat).execute();
    const requestPath = `/api/collaboration/scopes/${collaborationIds.scope}/chat/requests`;

    const capabilityResponse = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: requestPath,
    });
    expect(capabilityResponse.status).toBe(200);
    const capabilityBody = await capabilityResponse.json() as { resourceRevision: string };
    expect(capabilityBody).toMatchObject({
      capability: {
        status: "unavailable",
        effectiveSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      },
    });
    expect((await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`,
      query: "after=0&limit=50",
    })).status).toBe(200);
    const scope = await fixture.db.selectFrom("collaboration_scopes").select("revision")
      .where("id", "=", collaborationIds.scope).executeTakeFirstOrThrow();
    const discussionResponse = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`,
      body: {
        clientRequestId: request(82),
        expectedRevision: String(scope.revision),
        text: "Discussion still works",
      },
    });
    expect(discussionResponse.status).toBe(201);
    expect((await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: requestPath,
      body: {
        clientRequestId: request(83),
        expectedRevision: String(Number(capabilityBody.resourceRevision) + 1),
        text: "Do not switch this Chat",
      },
    })).status).toBe(503);
    await expect(fixture.db.selectFrom("chats")
      .select(["current_selection", "bound_driver_kind", "bound_instance_id"])
      .where("id", "=", collaborationIds.chat).executeTakeFirstOrThrow())
      .resolves.toMatchObject({
        current_selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        bound_driver_kind: "codex",
        bound_instance_id: "codex_default",
      });
  });

  it("admits an editor Codex request through the strict route only when the exact adapter is eligible", async () => {
    await shareChat();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: collaborationIds.scope,
      actor_id: collaborationActors.editor,
      role: "editor",
      status: "accepted",
      invitation_id: null,
      invited_by: collaborationActors.owner,
      accepted_at: now,
      expires_at: null,
      revision: 1,
      joined_at: now,
      updated_at: now,
    }).execute();
    await fixture.db.updateTable("collaboration_scopes").set({
      execution_generation: 7,
      execution_eligibility: JSON.stringify(
        collaborationExecutionEligibility({ adapters: ["claude-code", "codex"] }),
      ),
    }).where("id", "=", collaborationIds.scope).execute();
    await fixture.db.updateTable("chats").set({
      current_selection: JSON.stringify({ instanceId: "codex_default", model: "gpt-5.6-sol" }),
      bound_driver_kind: "codex",
      bound_instance_id: "codex_default",
      bound_at_turn_id: "cturn_existing_codex",
    }).where("id", "=", collaborationIds.chat).execute();
    const path = `/api/collaboration/scopes/${collaborationIds.scope}/chat/requests`;

    const response = await signedJson({
      actorId: collaborationActors.editor,
      scopeId: collaborationIds.scope,
      method: "POST",
      path,
      body: {
        clientRequestId: request(84),
        expectedRevision: "2",
        text: "Use the owner's exact Codex binding",
      },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      request: {
        actor: { actorId: collaborationActors.editor },
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      },
    });
    await expect(fixture.db.selectFrom("chat_queued_turns")
      .select(["driver_kind", "instance_id", "selection", "accepted_execution_generation"])
      .where("collaboration_scope_id", "=", collaborationIds.scope)
      .executeTakeFirstOrThrow()).resolves.toMatchObject({
        driver_kind: "codex",
        instance_id: "codex_default",
        selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
        accepted_execution_generation: 7,
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
        identifier: "viewer",
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

  it("exposes owner-only Chat archive, restore, export, operation, and delete routes", async () => {
    await shareChat();
    const lifecyclePath = `/api/collaboration/scopes/${collaborationIds.scope}/lifecycle`;
    const archived = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: lifecyclePath,
      body: { type: "archive", clientRequestId: request(30), expectedRevision: "1" },
    });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ type: "archive", revision: "2" });
    const archivedScope = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}`,
    });
    expect(await archivedScope.json()).toMatchObject({
      lifecycle: "archived",
      capabilities: { read: true, discuss: false, manageMembers: false, requestAi: false },
    });
    expect((await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat/messages`,
      body: { clientRequestId: request(31), expectedRevision: "2", text: "Archived write" },
    })).status).toBe(503);

    const restored = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: lifecyclePath,
      body: { type: "restore", clientRequestId: request(32), expectedRevision: "2" },
    });
    expect(restored.status).toBe(200);
    const exported = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: lifecyclePath,
      body: { type: "export", clientRequestId: request(33), expectedRevision: "3" },
    });
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({ exportId: request(33), status: "completed" });
    const operation = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/operations/${request(33)}`,
    });
    expect(operation.status).toBe(200);
    expect(await operation.json()).toMatchObject({ type: "export", exportId: request(33) });
    const artifact = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/exports/${request(33)}`,
    });
    expect(artifact.status).toBe(200);
    expect(await artifact.json()).toMatchObject({ scopeId: collaborationIds.scope, chat: { id: collaborationIds.chat } });

    const deleted = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: lifecyclePath,
      body: { type: "delete", clientRequestId: request(34), expectedRevision: "3" },
    });
    expect(deleted.status).toBe(200);
    expect((await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}`,
    })).status).toBe(404);
  });

  it("routes project lifecycle operations through the project service", async () => {
    await fixture.db.insertInto("collaboration_scopes").values({
      id: projectScopeId,
      owner_type: "personal",
      owner_id: collaborationActors.owner,
      kind: "project",
      organization_id: "org_matrix_team",
      resource_id: "proj_routes",
      parent_scope_id: null,
      membership_mode: "direct",
      lifecycle: "shared",
      revision: 1,
      auth_epoch: 1,
      authority_runtime_id: collaborationIds.runtime,
      authority_generation: 1,
      execution_generation: null,
      execution_eligibility: null,
      created_at: now,
      updated_at: now,
      deleted_at: null,
    }).execute();
    await fixture.db.insertInto("collaboration_members").values({
      scope_id: projectScopeId,
      actor_id: collaborationActors.owner,
      role: "owner",
      status: "accepted",
      invitation_id: null,
      invited_by: collaborationActors.owner,
      accepted_at: now,
      expires_at: null,
      revision: 1,
      joined_at: now,
      updated_at: now,
    }).execute();

    const archived = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: projectScopeId,
      method: "POST",
      path: `/api/collaboration/scopes/${projectScopeId}/lifecycle`,
      body: { type: "archive", clientRequestId: request(110), expectedRevision: "1" },
    });

    expect(archived.status).toBe(200);
    expect(await archived.json()).toMatchObject({ type: "archive", status: "completed", revision: "2" });
    const operation = await signedJson({
      actorId: collaborationActors.owner,
      scopeId: projectScopeId,
      method: "GET",
      path: `/api/collaboration/scopes/${projectScopeId}/operations/${request(110)}`,
    });
    expect(operation.status).toBe(200);
    expect(await operation.json()).toMatchObject({ type: "archive", status: "completed" });
  });

  it("applies downgrade immediately and revocation removes all live scope access", async () => {
    await shareChat();
    await signedJson({
      actorId: collaborationActors.owner,
      scopeId: collaborationIds.scope,
      method: "POST",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/invitations`,
      body: {
        identifier: "person@example.com",
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
      deleteConditions: {
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
    })).status).toBe(404);
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

    // The shared mutation limit is registered for every mutating method on the collaboration
    // composition, so the terminal PATCH is bounded before its handler buffers anything.
    const terminalPath = `/api/collaboration/scopes/${collaborationIds.scope}/terminal`;
    const patchBody = JSON.stringify({ contributorControl: true, padding: oversized });
    const patchBytes = new TextEncoder().encode(patchBody);
    const patchProof = signer.signHttp({
      actorId: collaborationActors.owner,
      ownerId: collaborationActors.owner,
      runtimeId: collaborationIds.runtime,
      scopeId: collaborationIds.scope,
      method: "PATCH",
      path: terminalPath,
      query: "",
      body: patchBytes,
    });
    expect((await app.request(terminalPath, {
      method: "PATCH",
      headers: {
        "content-length": String(patchBytes.byteLength),
        "content-type": "application/json",
        "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(patchProof)).toString("base64url"),
      },
      body: patchBody,
    })).status).toBe(413);
  });

  it("returns generic not-found to outsiders without weakening viewer denials", async () => {
    await shareChat();
    const outsider = await signedJson({
      actorId: collaborationActors.outsider,
      scopeId: collaborationIds.scope,
      method: "GET",
      path: `/api/collaboration/scopes/${collaborationIds.scope}/chat`,
    });
    expect(outsider.status).toBe(404);
    expect(await outsider.json()).toEqual({ error: "Collaboration unavailable", code: "not_found" });
  });

  async function shareChat(): Promise<void> {
    const preflightPath = `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes/preflight`;
    const preflight = await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: preflightPath,
      body: { kind: "chat", resourceId: collaborationIds.chat, organizationId: "org_matrix_team" },
    });
    const eligibility = await preflight.json() as { confirmationToken: string; resourceRevision: string };
    await signedJson({
      actorId: collaborationActors.owner,
      method: "POST",
      path: `/api/collaboration/runtimes/${collaborationIds.runtime}/scopes`,
      body: {
        kind: "chat",
        resourceId: collaborationIds.chat,

        organizationId: "org_matrix_team",
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
    deleteConditions?: { clientRequestId: string; expectedRevision: string; expectedMemberRevision: string };
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
      ...(input.deleteConditions ? { conditionalHeaders: input.deleteConditions } : {}),
    });
    return app.request(`${input.path}${input.query ? `?${input.query}` : ""}`, {
      method: input.method,
      headers: {
        "content-type": "application/json",
        "x-matrix-collaboration-proof": Buffer.from(JSON.stringify(proof)).toString("base64url"),
        ...(input.deleteConditions ? {
          "x-matrix-client-request-id": input.deleteConditions.clientRequestId,
          "x-matrix-expected-revision": input.deleteConditions.expectedRevision,
          "x-matrix-expected-member-revision": input.deleteConditions.expectedMemberRevision,
        } : {}),
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
    current_selection: JSON.stringify({ instanceId: "claude_code_default", model: "opus" }),
    bound_driver_kind: null,
    bound_instance_id: null,
    bound_at_turn_id: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }).execute();
}
