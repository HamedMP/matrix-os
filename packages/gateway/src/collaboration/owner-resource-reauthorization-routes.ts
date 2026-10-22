/** Bounded owner-only inspection and explicit recovery of existing share IDs. */
import {
  CollaborationCatalogIdSchema, CollaborationRuntimeIdSchema,
  CollaborationOwnerResourceReauthorizationInspectRequestSchema,
  CollaborationOwnerResourceReauthorizationConfirmRequestSchema,
  CollaborationOwnerResourceReauthorizationInspectionResponseSchema,
  CollaborationOwnerResourceReauthorizationResponseSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import { ResourceCatalogError } from "./resource-catalog.js";
import { createOwnerResourceReauthorization } from "./resource-reauthorization.js";
import { handle, ownerRuntimeIdentity, readJson, type CollaborationRouteOptions } from "./route-support.js";

export function registerOwnerResourceReauthorizationRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  for (const action of ["inspect", "confirm"] as const) {
    routes.post(`/api/collaboration/runtimes/:runtimeId/catalog/:resourceId/reauthorization/${action}`, async c => handle(c, async () => {
      const { value, bytes } = await readJson(c);
      const input = action === "inspect" ? CollaborationOwnerResourceReauthorizationInspectRequestSchema.parse(value)
        : CollaborationOwnerResourceReauthorizationConfirmRequestSchema.parse(value);
      const proof = await ownerRuntimeIdentity(options, c, bytes,
        CollaborationRuntimeIdSchema.parse(c.req.param("runtimeId")), input.organizationId);
      if (!options.resources?.driver.inspect) throw new ResourceCatalogError("unavailable");
      const service = createOwnerResourceReauthorization(options.resources);
      const bound = { ...input, ownerId: proof.ownerId, runtimeId: proof.runtimeId,
        resourceId: CollaborationCatalogIdSchema.parse(c.req.param("resourceId")), authorityGeneration: proof.authorityGeneration };
      if (action === "inspect") return c.json(CollaborationOwnerResourceReauthorizationInspectionResponseSchema.parse(await service.inspect(bound)));
      const confirmation = CollaborationOwnerResourceReauthorizationConfirmRequestSchema.parse(input);
      const entry = await service.confirm({ ...bound, ...confirmation });
      await options.onScopeCommitted?.(input.scopeId);
      return c.json(CollaborationOwnerResourceReauthorizationResponseSchema.parse({ scopeId: input.scopeId,
        entry: { id: entry.id, kind: entry.kind, path: entry.path, incarnation: entry.incarnation, revision: String(entry.revision) } }));
    }));
  }
}
