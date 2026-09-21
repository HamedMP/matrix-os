/** Owner-only exact resource identity resolution before a normal Share action. */
import {
  CollaborationOwnerCatalogResolveRequestSchema,
  CollaborationOwnerCatalogResolveResponseSchema,
  CollaborationRuntimeIdSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import { CollaborationAuthorizationError } from "./authority-error.js";
import {
  handle, ownerRuntimeIdentity, readJson,
  type CollaborationRouteOptions,
} from "./route-support.js";

export function registerOwnerCatalogRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  routes.post("/api/collaboration/runtimes/:runtimeId/catalog/resolve", async (c) => handle(c, async () => {
    const { value, bytes } = await readJson(c);
    const input = CollaborationOwnerCatalogResolveRequestSchema.parse(value);
    const proof = await ownerRuntimeIdentity(options, c, bytes,
      CollaborationRuntimeIdSchema.parse(c.req.param("runtimeId")), input.organizationId);
    const resources = options.resources;
    if (!resources?.driver.resolveOwnerNamespace || (input.kind !== "app" && !resources.driver.inspect)
      || (input.kind === "app" && !resources.resolveAppIncarnation)) {
      throw new CollaborationAuthorizationError("unavailable", "Resource catalog is unavailable");
    }
    const resolved = await resources.driver.resolveOwnerNamespace({ ownerId: proof.ownerId, kind: input.kind, path: input.path });
    const namespace = { ownerId: proof.ownerId, projectId: resolved.projectId };
    const incarnation = input.kind === "app"
      ? await resources.resolveAppIncarnation!({ ...namespace, appId: resolved.path })
      : (await resources.driver.inspect!({ ...namespace, kind: input.kind, path: resolved.path })).incarnation;
    if (!incarnation) throw new CollaborationAuthorizationError("not_found", "Resource is unavailable");
    const entry = await resources.catalog.db.transaction().execute(async (trx) => {
      const existing = await resources.catalog.getLiveByPath({ ...namespace, kind: input.kind, path: resolved.path }, trx);
      if (existing && existing.incarnation !== incarnation) {
        await resources.catalog.remove({ id: existing.id, expectedRevision: existing.revision, executor: trx });
      }
      return resources.catalog.register({ ...namespace, kind: input.kind, path: resolved.path,
        incarnation, executor: trx });
    });
    return c.json(CollaborationOwnerCatalogResolveResponseSchema.parse({
      id: entry.id, kind: entry.kind, path: input.path,
      incarnation: entry.incarnation, revision: String(entry.revision),
    }));
  }));
}
