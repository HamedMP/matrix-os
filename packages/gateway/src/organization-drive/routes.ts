import { CollaborationIdSchema, OrganizationDriveUploadRequestSchema } from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { z } from "zod/v4";
import { CollaborationAuthorizationError, type AuthorizedCollaborationContext } from "../collaboration/authority.js";
import { authorize, handle, readJson, type CollaborationRouteOptions } from "../collaboration/route-support.js";
import { OrganizationDriveError, type OrganizationDriveService } from "./service.js";

const IdSchema = z.uuid();
type RouteOptions = Pick<CollaborationRouteOptions, "authority" | "directSessions" | "verifier" | "onScopeCommitted"> & {
  organizationDrive?: OrganizationDriveService;
};

function required(options: RouteOptions): OrganizationDriveService {
  if (!options.organizationDrive) throw new CollaborationAuthorizationError("unavailable", "Organization drive is unavailable");
  return options.organizationDrive;
}

function identity(context: AuthorizedCollaborationContext) {
  if (context.resourceKind !== "folder" || context.scopeId !== context.membershipScopeId) {
    throw new CollaborationAuthorizationError("not_found", "Drive scope is unavailable");
  }
  return { organizationId: context.organizationId, scopeId: context.scopeId,
    authorityRuntimeId: context.authorityRuntimeId, authorityGeneration: context.authorityGeneration };
}

async function driveContext(options: RouteOptions, c: Context, bytes: Uint8Array, action: "read" | "manage_members" | "mutate_resource") {
  const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
  const context = await authorize(options, c, bytes, action, scopeId);
  identity(context);
  return context;
}

async function driveHandle(c: Context, operation: () => Promise<Response>): Promise<Response> {
  return handle(c, async () => {
    try { return await operation(); }
    catch (error: unknown) {
      if (!(error instanceof OrganizationDriveError)) throw error;
      const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409
        : error.code === "quota" ? 413 : error.code === "checksum" ? 422 : 503;
      return c.json({ error: "Organization drive operation failed", code: error.code }, status);
    }
  });
}

export function registerOrganizationDriveRoutes(routes: Hono, options: RouteOptions): void {
  const base = "/api/collaboration/scopes/:scopeId/drive";
  routes.put(base, async (c) => driveHandle(c, async () => {
    const { value, bytes } = await readJson(c);
    z.object({}).strict().parse(value);
    const context = await driveContext(options, c, bytes, "manage_members");
    if (context.role !== "owner") throw new CollaborationAuthorizationError("forbidden", "Owner required");
    const service = required(options);
    await service.enable({ ...identity(context), runtimeId: context.authorityRuntimeId,
      generation: context.authorityGeneration });
    return c.json({ organizationId: context.organizationId, scopeId: context.scopeId,
      ...(await service.usage(identity(context))) });
  }));

  routes.get(base, async (c) => driveHandle(c, async () => {
    const context = await driveContext(options, c, new Uint8Array(), "read");
    const service = required(options);
    return c.json({ organizationId: context.organizationId, scopeId: context.scopeId,
      ...(await service.usage(identity(context))), files: await service.list(identity(context)) });
  }));

  routes.post(`${base}/uploads`, async (c) => driveHandle(c, async () => {
    const { value, bytes } = await readJson(c);
    const request = OrganizationDriveUploadRequestSchema.parse(value);
    const context = await driveContext(options, c, bytes, "mutate_resource");
    const result = await required(options).reserve({ ...identity(context), actorId: context.actorId, request });
    return c.json(result, 201);
  }));

  routes.post(`${base}/uploads/:uploadId/commit`, async (c) => driveHandle(c, async () => {
    const uploadId = IdSchema.parse(c.req.param("uploadId"));
    const { value, bytes } = await readJson(c);
    z.object({}).strict().parse(value);
    const context = await driveContext(options, c, bytes, "mutate_resource");
    const file = await required(options).commit({ ...identity(context), actorId: context.actorId, uploadId,
      revalidate: async () => {
        const fresh = await options.authority.authorize({ scopeId: context.scopeId, actorId: context.actorId,
          action: "mutate_resource" });
        if (fresh.authEpoch !== context.authEpoch || fresh.authorityGeneration !== context.authorityGeneration) {
          throw new CollaborationAuthorizationError("forbidden", "Drive access changed");
        }
      } });
    await options.onScopeCommitted?.(context.scopeId);
    return c.json(file);
  }));

  routes.delete(`${base}/uploads/:uploadId`, async (c) => driveHandle(c, async () => {
    const uploadId = IdSchema.parse(c.req.param("uploadId"));
    const context = await driveContext(options, c, new Uint8Array(), "read");
    await required(options).abort({ ...identity(context), actorId: context.actorId, uploadId });
    return c.body(null, 204);
  }));

  routes.get(`${base}/files/:fileId`, async (c) => driveHandle(c, async () => {
    const fileId = IdSchema.parse(c.req.param("fileId"));
    const context = await driveContext(options, c, new Uint8Array(), "read");
    return c.json(await required(options).get({ ...identity(context), fileId }));
  }));
}
