/** Owner-only exact resource identity resolution before a normal Share action. */
import {
  CollaborationOwnerCatalogResolveRequestSchema,
  CollaborationOwnerCatalogResolveResponseSchema,
  CollaborationRuntimeIdSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import { CollaborationAuthorizationError } from "./authority-error.js";
import {
  handle, readJson, requireOwnerCreationProof, verifyHttp,
  type CollaborationRouteOptions,
} from "./route-support.js";

export function registerOwnerCatalogRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  routes.post("/api/collaboration/runtimes/:runtimeId/catalog/resolve", async (c) => handle(c, async () => {
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    requireOwnerCreationProof(proof, CollaborationRuntimeIdSchema.parse(c.req.param("runtimeId")), options.runtimeId);
    const input = CollaborationOwnerCatalogResolveRequestSchema.parse(value);
    const resources = options.resources;
    if (!resources?.driver.inspect || !resources.driver.resolveOwnerNamespace) {
      throw new CollaborationAuthorizationError("unavailable", "Resource catalog is unavailable");
    }
    const resolved = await resources.driver.resolveOwnerNamespace({ ownerId: proof.ownerId, kind: input.kind, path: input.path });
    const namespace = { ownerId: proof.ownerId, projectId: resolved.projectId };
    const observed = await resources.driver.inspect({ ...namespace, kind: input.kind, path: resolved.path });
    const entry = await resources.catalog.db.transaction().execute(async (trx) => {
      const existing = await resources.catalog.getLiveByPath({ ...namespace, kind: input.kind, path: resolved.path }, trx);
      if (existing && existing.incarnation !== observed.incarnation) {
        await resources.catalog.remove({ id: existing.id, expectedRevision: existing.revision, executor: trx });
      }
      return resources.catalog.register({ ...namespace, kind: input.kind, path: resolved.path,
        incarnation: observed.incarnation, executor: trx });
    });
    return c.json(CollaborationOwnerCatalogResolveResponseSchema.parse({
      id: entry.id, kind: entry.kind, path: input.path,
      incarnation: entry.incarnation, revision: String(entry.revision),
    }));
  }));
}
