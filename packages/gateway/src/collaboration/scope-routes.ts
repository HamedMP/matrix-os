/** Extracted verbatim from packages/gateway/src/collaboration/routes.ts (S01 / T008). */
import {
  CollaborationAcceptInvitationRequestSchema,
  CollaborationDeclineInvitationRequestSchema,
  CollaborationActorIdSchema,
  CollaborationCreateScopeRequestSchema,
  CollaborationIdSchema,
  CollaborationMemberPatchRequestSchema,
  CollaborationRuntimeIdSchema,
  CollaborationScopePreflightRequestSchema,
  CollaborationScopePreflightResponseSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import {
  CollaborationAuthorizationError,
} from "./authority.js";
import {
  createInvitationCreationHandler,
} from "./invitation-creation-route.js";
import {
  authorize,
  deleteConditions,
  verifyHttp,
  digestDeleteConditions,
  requireTerminalAdapter,
  requireProjectScope,
  readJson,
  requireOwnerCreationProof,
  requireOrganizationMembership,
  requireScopeOrganizationMembership,
  scopeProjection,
  projectPreparationProjection,
  memberProjection,
  invitationProjection,
  requireScope,
  requireInvitation,
  notifyScope,
  digest,
  handle,
  type CollaborationRouteOptions,
} from "./route-support.js";

export function registerScopeRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  const now = options.now ?? (() => new Date());
  routes.post("/api/collaboration/runtimes/:runtimeId/scopes/preflight", async (c) => handle(c, async () => {
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    requireOwnerCreationProof(proof, CollaborationRuntimeIdSchema.parse(c.req.param("runtimeId")), options.runtimeId);
    const input = CollaborationScopePreflightRequestSchema.parse(value);
    // The owner must be a current member of the organization the share is scoped to (S20 / T101).
    await requireOrganizationMembership(options, proof.actorId, input.organizationId);
    const result = input.kind === "chat"
      ? await options.chatScope.preflight({
          ownerId: proof.ownerId,
          organizationId: input.organizationId,
          chatId: input.resourceId,
        })
      : input.kind === "terminal"
        ? await requireTerminalAdapter(options.terminalAdapter).preflight({
            ownerId: proof.ownerId,
            organizationId: input.organizationId,
            terminalId: input.resourceId,
          })
        : await requireProjectScope(options.projectScope).preflight({
            ownerId: proof.ownerId,
            organizationId: input.organizationId,
            projectId: input.resourceId,
          });
    return c.json(CollaborationScopePreflightResponseSchema.parse({
      eligible: result.eligible,
      ...("reason" in result && result.reason ? { reason: result.reason } : {}),
      resourceRevision: String("chatRevision" in result
        ? result.chatRevision
        : "projectRevision" in result ? result.projectRevision : result.resourceRevision),
      ...(result.confirmationToken ? { confirmationToken: result.confirmationToken } : {}),
      ...(input.kind === "project" && "existingScopeId" in result && result.existingScopeId
        ? { existingScopeId: result.existingScopeId, existingLifecycle: result.existingLifecycle }
        : {}),
    }));
  }));

  routes.post("/api/collaboration/runtimes/:runtimeId/scopes", async (c) => handle(c, async () => {
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    requireOwnerCreationProof(proof, CollaborationRuntimeIdSchema.parse(c.req.param("runtimeId")), options.runtimeId);
    const input = CollaborationCreateScopeRequestSchema.parse(value);
    // Membership is proven before any write; the confirmation token also binds this organization.
    await requireOrganizationMembership(options, proof.actorId, input.organizationId);
    const scope = input.kind === "chat"
      ? await options.chatScope.shareChat({
          ownerId: proof.ownerId,
          organizationId: input.organizationId,
          chatId: input.resourceId,
          clientRequestId: input.clientRequestId,
          payloadHash: digest(bytes),
          expectedChatRevision: Number(input.expectedRevision),
          confirmationToken: input.confirmationToken,
        })
      : input.kind === "terminal"
        ? await requireTerminalAdapter(options.terminalAdapter).shareTerminal({
            ownerId: proof.ownerId,
            organizationId: input.organizationId,
            terminalId: input.resourceId,
            clientRequestId: input.clientRequestId,
            payloadHash: digest(bytes),
            expectedResourceRevision: Number(input.expectedRevision),
            confirmationToken: input.confirmationToken,
          })
        : await requireProjectScope(options.projectScope).prepare({
            ownerId: proof.ownerId,
            organizationId: input.organizationId,
            projectId: input.resourceId,
            clientRequestId: input.clientRequestId,
            payloadHash: digest(bytes),
            expectedProjectRevision: Number(input.expectedRevision),
            confirmationToken: input.confirmationToken,
          });
    if (scope.kind === "project") {
      await notifyScope(options, scope.id);
      return c.json(projectPreparationProjection(scope), 201);
    }
    const context = await options.authority.authorize({
      scopeId: scope.id,
      actorId: proof.actorId,
      action: "read",
    });
    await notifyScope(options, scope.id);
    return c.json(await scopeProjection(
      scope,
      context,
      options.authority,
      options.chatScope,
    ), 201);
  }));

  routes.get("/api/collaboration/scopes/:scopeId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const scope = await requireScope(options.repository, scopeId);
    return c.json(await scopeProjection(
      scope,
      context,
      options.authority,
      options.chatScope,
    ));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/members", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const members = await options.repository.listMembers(context.membershipScopeId, {
      includePending: context.role === "owner",
    });
    return c.json({ members: await Promise.all(members.map((member) => memberProjection(options, member))) });
  }));

  routes.post("/api/collaboration/scopes/:scopeId/invitations", createInvitationCreationHandler({
    repository: options.repository,
    resolveInvitationIdentifier: options.resolveInvitationIdentifier,
    invitationResolutionRateLimiter: options.invitationResolutionRateLimiter,
    authorize: (c, bytes, scopeId) => authorize(options, c, bytes, "manage_members", scopeId),
    projectInvitation: (member) => invitationProjection(options, member),
    notifyScope: (scopeId) => notifyScope(options, scopeId),
    handle,
    now,
  }));

  routes.get("/api/collaboration/invitations/:invitationId", async (c) => handle(c, async () => {
    const invitationId = CollaborationIdSchema.parse(c.req.param("invitationId"));
    const proof = await verifyHttp(options.verifier, c, new Uint8Array());
    const member = await requireInvitation(options.repository, invitationId);
    const scope = await requireScope(options.repository, member.scopeId);
    if (proof.scopeId !== scope.id || proof.ownerId !== scope.ownerId
      || ![member.actorId, member.invitedBy].includes(proof.actorId)) {
      throw new CollaborationAuthorizationError("forbidden", "Invitation access is required");
    }
    await requireOrganizationMembership(options, proof.actorId, scope.organizationId ?? null);
    return c.json(await invitationProjection(options, member));
  }));

  routes.post("/api/collaboration/invitations/:invitationId/accept", async (c) => handle(c, async () => {
    const invitationId = CollaborationIdSchema.parse(c.req.param("invitationId"));
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    const input = CollaborationAcceptInvitationRequestSchema.parse(value);
    const member = await requireInvitation(options.repository, invitationId);
    if (proof.scopeId !== member.scopeId || proof.actorId !== member.actorId) {
      throw new CollaborationAuthorizationError("forbidden", "Invitation access is required");
    }
    await requireScopeOrganizationMembership(options, member.scopeId, proof.actorId);
    const result = await options.repository.acceptInvitation({
      invitationId,
      actorId: proof.actorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(bytes),
    });
    await notifyScope(options, result.scopeId);
    return c.json(result);
  }));

  routes.post("/api/collaboration/invitations/:invitationId/decline", async (c) => handle(c, async () => {
    const invitationId = CollaborationIdSchema.parse(c.req.param("invitationId"));
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    const input = CollaborationDeclineInvitationRequestSchema.parse(value);
    const member = await requireInvitation(options.repository, invitationId);
    if (proof.scopeId !== member.scopeId || proof.actorId !== member.actorId) {
      throw new CollaborationAuthorizationError("forbidden", "Invitation access is required");
    }
    await requireScopeOrganizationMembership(options, member.scopeId, proof.actorId);
    const result = await options.repository.declineInvitation({
      invitationId,
      actorId: proof.actorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(bytes),
    });
    await notifyScope(options, result.scopeId);
    return c.json(result);
  }));

  routes.delete("/api/collaboration/scopes/:scopeId/invitations/:invitationId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const invitationId = CollaborationIdSchema.parse(c.req.param("invitationId"));
    const bytes = new Uint8Array();
    const input = deleteConditions(c);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    const result = await options.repository.revokeInvitation({
      scopeId,
      invitationId,
      actorId: context.actorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      expectedMemberRevision: Number(input.expectedMemberRevision),
      payloadHash: digestDeleteConditions(input),
    });
    options.onRevoked?.(scopeId, result.actorId);
    await notifyScope(options, scopeId);
    return c.json(result);
  }));

  routes.patch("/api/collaboration/scopes/:scopeId/members/:actorId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const targetActorId = CollaborationActorIdSchema.parse(c.req.param("actorId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    const input = CollaborationMemberPatchRequestSchema.parse(value);
    const result = await options.repository.changeMemberRole({
      scopeId,
      actorId: context.actorId,
      targetActorId,
      role: input.role,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      expectedMemberRevision: Number(input.expectedMemberRevision),
      payloadHash: digest(bytes),
    });
    options.onRoleChanged?.(scopeId, result.actorId, result.role);
    await notifyScope(options, scopeId);
    return c.json(result);
  }));

  routes.delete("/api/collaboration/scopes/:scopeId/members/:actorId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const targetActorId = CollaborationActorIdSchema.parse(c.req.param("actorId"));
    const bytes = new Uint8Array();
    const input = deleteConditions(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    if (proof.scopeId !== scopeId) throw new CollaborationAuthorizationError("forbidden", "Member access is required");
    const context = proof.actorId === targetActorId
      ? await options.authority.authorize({ scopeId, actorId: proof.actorId, action: "read" })
      : await options.authority.authorize({ scopeId, actorId: proof.actorId, action: "manage_members" });
    const result = await options.repository.revokeMember({
      scopeId,
      actorId: context.actorId,
      targetActorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      expectedMemberRevision: Number(input.expectedMemberRevision),
      payloadHash: digestDeleteConditions(input),
    });
    options.onRevoked?.(scopeId, result.actorId);
    await notifyScope(options, scopeId);
    return c.json(result);
  }));
}
