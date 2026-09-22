/** Extracted verbatim from packages/gateway/src/collaboration/routes.ts (S01 / T008). */
import {
  CollaborationIdSchema,
  CollaborationProjectSchema,
  CollaborationProjectConfirmRequestSchema,
  CollaborationProjectInventorySchema,
  CollaborationProjectTransitionSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import {
  authorize,
  verifyHttp,
  requireProjectSharing,
  readJson,
  requireOwnerLifecycleProof,
  requireScopeOrganizationMembership,
  digest,
  handle,
  type CollaborationRouteOptions,
} from "./route-support.js";

export function registerProjectRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  routes.get("/api/collaboration/scopes/:scopeId/project", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    return c.json(CollaborationProjectSchema.parse(
      await requireProjectSharing(options.projectSharing).read({ scopeId }),
    ));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/project/inventory", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const proof = await verifyHttp(options.verifier, c, new Uint8Array());
    requireOwnerLifecycleProof(proof, scopeId);
    await requireScopeOrganizationMembership(options, scopeId, proof.actorId);
    const inventory = await requireProjectSharing(options.projectSharing).preview({
      scopeId,
      actorId: proof.actorId,
    });
    const membershipEffects = await Promise.all(inventory.membershipEffects.map(async (effect) => ({
      actor: await options.resolveParticipant(effect.actorId),
      role: effect.role,
      effect: effect.effect,
      ...(effect.resourceKind ? { resourceKind: effect.resourceKind } : {}),
      ...(effect.resourceId ? { resourceId: effect.resourceId } : {}),
    })));
    return c.json(CollaborationProjectInventorySchema.parse({
      ...inventory,
      projectRevision: String(inventory.projectRevision),
      scopeRevision: String(inventory.scopeRevision),
      membershipEffects,
    }));
  }));

  routes.post("/api/collaboration/scopes/:scopeId/project/confirm", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    requireOwnerLifecycleProof(proof, scopeId);
    await requireScopeOrganizationMembership(options, scopeId, proof.actorId);
    const input = CollaborationProjectConfirmRequestSchema.parse(value);
    const transition = await requireProjectSharing(options.projectSharing).confirm({
      scopeId,
      actorId: proof.actorId,
      clientRequestId: input.clientRequestId,
      payloadHash: digest(bytes),
      expectedScopeRevision: Number(input.expectedScopeRevision),
      expectedProjectRevision: Number(input.expectedProjectRevision),
      inventoryHash: input.inventoryHash,
      membershipHash: input.membershipHash,
      inventoryToken: input.inventoryToken,
    });
    return c.json(CollaborationProjectTransitionSchema.parse({
      id: transition.id,
      scopeId: transition.scopeId,
      status: transition.status,
      inventoryRevision: String(transition.inventoryRevision),
      createdAt: transition.createdAt,
      updatedAt: transition.updatedAt,
      ...(transition.errorCode && ["inventory_changed", "resource_blocked", "unavailable"].includes(transition.errorCode)
        ? { errorCode: transition.errorCode }
        : {}),
    }), 202);
  }));
}
