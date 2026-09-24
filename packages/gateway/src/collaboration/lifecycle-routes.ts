/** Extracted verbatim from packages/gateway/src/collaboration/routes.ts (S01 / T008). */
import {
  CollaborationIdSchema,
  CollaborationLifecycleRequestSchema,
  CollaborationOperationSchema,
  CollaborationScopeExportSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import {
  CollaborationAuthorizationError,
} from "./authority.js";
import {
  CollaborationRepositoryError,
} from "./repository.js";
import {
  authorizeOwnerScope,
  readJson,
  requireScopeOrganizationMembership,
  requireProjectLifecycle,
  notifyScope,
  digest,
  handle,
  type CollaborationRouteOptions,
} from "./route-support.js";

export function registerLifecycleRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  routes.post("/api/collaboration/scopes/:scopeId/lifecycle", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorizeOwnerScope(options, c, bytes, scopeId);
    await requireScopeOrganizationMembership(options, scopeId, context.actorId);
    const input = CollaborationLifecycleRequestSchema.parse(value);
    const scope = await options.repository.getScope(scopeId);
    if (!scope) throw new CollaborationRepositoryError("not_found", "Collaboration scope not found");
    if (scope.kind === "project") {
      if (input.type === "export" || input.type === "recover") {
        throw new CollaborationAuthorizationError("unavailable", "Lifecycle action is unavailable");
      }
      const lifecycle = requireProjectLifecycle(options.projectLifecycle);
      const common = {
        scopeId,
        actorId: context.actorId,
        clientRequestId: input.clientRequestId,
        expectedRevision: Number(input.expectedRevision),
        payloadHash: digest(bytes),
      };
      const result = input.type === "transfer"
        ? await lifecycle.apply({
          ...common,
          type: "transfer",
          successorActorId: input.successorActorId,
          expectedMemberRevision: Number(input.expectedMemberRevision),
        })
        : await lifecycle.apply({ ...common, type: input.type });
      await notifyScope(options, scopeId);
      return c.json(CollaborationOperationSchema.parse(result));
    }
    if (scope.kind === "terminal") {
      if (input.type !== "export") {
        throw new CollaborationAuthorizationError("unavailable", "Lifecycle action is unavailable");
      }
      const result = await options.repository.applyTerminalExport({
        scopeId,
        actorId: context.actorId,
        type: "export",
        clientRequestId: input.clientRequestId,
        expectedRevision: Number(input.expectedRevision),
        payloadHash: digest(bytes),
      }, () => options.discussionAdapter.prepareTerminalDiscussionExport(scopeId));
      await notifyScope(options, scopeId);
      return c.json(CollaborationOperationSchema.parse(result));
    }
    if (["transfer", "recover"].includes(input.type)) {
      throw new CollaborationAuthorizationError("unavailable", "Lifecycle action is unavailable");
    }
    const result = await options.repository.applyChatLifecycle({
      scopeId,
      actorId: context.actorId,
      type: input.type,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(bytes),
    });
    await notifyScope(options, scopeId);
    return c.json(CollaborationOperationSchema.parse(result));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/operations/:operationId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const operationId = CollaborationIdSchema.parse(c.req.param("operationId"));
    const context = await authorizeOwnerScope(options, c, new Uint8Array(), scopeId);
    await requireScopeOrganizationMembership(options, scopeId, context.actorId);
    const projectOperation = options.projectLifecycle
      ? await options.projectLifecycle.getOperation(scopeId, context.actorId, operationId)
      : null;
    const operation = projectOperation
      ?? await options.repository.getLifecycleOperation(scopeId, context.actorId, operationId);
    if (!operation) throw new CollaborationRepositoryError("not_found", "Lifecycle operation not found");
    return c.json(CollaborationOperationSchema.parse(operation));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/exports/:exportId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const exportId = CollaborationIdSchema.parse(c.req.param("exportId"));
    const context = await authorizeOwnerScope(options, c, new Uint8Array(), scopeId);
    await requireScopeOrganizationMembership(options, scopeId, context.actorId);
    const exported = await options.repository.getScopeExport(scopeId, context.actorId, exportId);
    if (!exported) throw new CollaborationRepositoryError("not_found", "Scope export not found");
    return c.json(CollaborationScopeExportSchema.parse(exported));
  }));
}
