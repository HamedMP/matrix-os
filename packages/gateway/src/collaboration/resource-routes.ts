/**
 * S12 / T061, T062, T064: files, folders and app instances behind the frozen
 * direct routes. Project scopes and standalone shares use the same handlers;
 * the catalog decides what a scope can reach and the authority decides what
 * the preset allows. Bytes stream straight from the home; no storage URL is
 * ever issued.
 */
import {
  CollaborationAppActionRequestSchema,
  CollaborationAppActionResponseSchema,
  CollaborationAppAssetPathSchema,
  CollaborationAppInstanceIdSchema,
  CollaborationAppInstanceSchema,
  CollaborationAppViewRequestSchema,
  CollaborationCatalogEntrySchema,
  CollaborationCatalogIdSchema,
  CollaborationFileActionRequestSchema,
  CollaborationFileActionResponseSchema,
  CollaborationFileListQuerySchema,
  CollaborationFileListResponseSchema,
  CollaborationIdSchema,
} from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { CollaborationAuthorizationError, type AuthorizedCollaborationContext } from "./authority.js";
import { readDirectCredentials } from "./direct-routes.js";
import type { AppInstanceAdapter } from "./app-instance-adapter.js";
import { authorize, exactQuery, handle, readJson, type CollaborationRouteOptions } from "./route-support.js";
import { createFileActionExecutor, type CollaborationResourceDriver } from "./resource-actions.js";
import { CollaborationResourceCatalog, ResourceCatalogError, type CatalogEntryRecord } from "./resource-catalog.js";
import type { CollaborationUploadStager } from "./upload-stages.js";

export type { CollaborationResourceDriver } from "./resource-actions.js";

export interface CollaborationResourceServices {
  catalog: CollaborationResourceCatalog;
  driver: CollaborationResourceDriver;
  apps?: AppInstanceAdapter;
  uploads?: CollaborationUploadStager;
  createEventId?: () => string;
}

const MAX_STREAM_BYTES = 256 * 1024 * 1024;

function entryProjection(entry: CatalogEntryRecord) {
  return CollaborationCatalogEntrySchema.parse({
    id: entry.id,
    kind: entry.kind,
    path: entry.path,
    parentId: entry.parentId,
    revision: String(entry.revision),
    incarnation: entry.incarnation,
    updatedAt: entry.updatedAt,
  });
}

function requireResources(options: CollaborationRouteOptions): CollaborationResourceServices {
  if (!options.resources) throw new CollaborationAuthorizationError("unavailable", "Shared resources are unavailable");
  return options.resources;
}

function requireApps(resources: CollaborationResourceServices): AppInstanceAdapter {
  if (!resources.apps) throw new CollaborationAuthorizationError("unavailable", "Shared apps are unavailable");
  return resources.apps;
}

/** The mutation action for the scope kind: projects keep their historical name. */
function mutationAction(context: Pick<AuthorizedCollaborationContext, "resourceKind">): "mutate_project" | "mutate_resource" {
  return context.resourceKind === "project" ? "mutate_project" : "mutate_resource";
}

/** Closes a stream on overrun, short read, or lease loss; each transfer has a five-second watchdog. */
export function watchResourceStream(
  source: ReadableStream<Uint8Array>,
  declaredSize: number,
  leaseActive: () => boolean,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let received = 0;
  let closed = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  const error = new Error("Shared resource stream unavailable");
  const stop = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    if (watchdog) clearInterval(watchdog);
    controller.error(error);
    void reader.cancel().catch((cancelError: unknown) => {
      console.warn("[collaboration-resources] stream cancel failed", cancelError instanceof Error ? cancelError.name : "UnknownError");
    });
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      watchdog = setInterval(() => {
        if (!leaseActive()) stop(controller);
      }, 5_000);
      watchdog.unref();
    },
    async pull(controller) {
      if (!leaseActive()) { stop(controller); return; }
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) {
          if (received !== declaredSize) { stop(controller); return; }
          closed = true;
          if (watchdog) clearInterval(watchdog);
          controller.close();
          return;
        }
        received += next.value.byteLength;
        if (received > declaredSize || received > MAX_STREAM_BYTES) { stop(controller); return; }
        controller.enqueue(next.value);
      } catch (readError: unknown) {
        console.warn("[collaboration-resources] stream read failed", readError instanceof Error ? readError.name : "UnknownError");
        stop(controller);
      }
    },
    async cancel(reason) {
      closed = true;
      if (watchdog) clearInterval(watchdog);
      await reader.cancel(reason);
    },
  });
}

function streamResponse(
  c: Context,
  input: { stream: ReadableStream<Uint8Array>; size: number; contentType?: string },
  fileName: string,
  options: CollaborationRouteOptions,
): Response {
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_STREAM_BYTES) throw new ResourceCatalogError("unavailable");
  const credentials = readDirectCredentials(c);
  const leaseActive = () => {
    if (!credentials) return true;
    const session = options.directSessions?.describe(credentials.sessionId);
    return Boolean(session && new Date(session.evidenceExpiresAt).getTime() > Date.now());
  };
  c.header("Content-Type", input.contentType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(input.contentType) ? input.contentType : "application/octet-stream");
  c.header("Content-Length", String(input.size));
  c.header("Content-Disposition", `attachment; filename="${encodeURIComponent(fileName)}"`);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "private, no-store");
  return c.body(watchResourceStream(input.stream, input.size, leaseActive));
}

export function registerResourceRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  routes.get("/api/collaboration/scopes/:scopeId/files", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const resources = requireResources(options);
    const query = CollaborationFileListQuerySchema.parse(exactQuery(c, ["cursor", "limit", "query"]));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const page = await resources.catalog.listForScope(context, query);
    return c.json(CollaborationFileListResponseSchema.parse({
      entries: page.entries.map(entryProjection),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    }));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/files/:fileId/content", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const fileId = CollaborationCatalogIdSchema.parse(c.req.param("fileId"));
    const resources = requireResources(options);
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const entry = await resources.catalog.resolveForScope(context, fileId);
    if (entry.kind !== "file") throw new ResourceCatalogError("not_found");
    const namespace = await resources.catalog.namespaceForScope(context);
    const content = await resources.driver.read({ ownerId: namespace.ownerId, projectId: namespace.projectId, path: entry.path, expectedIncarnation: entry.incarnation });
    return streamResponse(c, content, entry.path.split("/").at(-1) ?? "file", options);
  }));

  routes.post("/api/collaboration/scopes/:scopeId/files/actions", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const resources = requireResources(options);
    const { value, bytes } = await readJson(c);
    const action = CollaborationFileActionRequestSchema.parse(value);
    // Authorize with the scope's mutation action before any lookup; a viewer never learns whether the id exists.
    const probe = await authorize(options, c, bytes, "read", scopeId);
    const context = action.type === "upload_cancel"
      ? probe
      : await options.authority.authorize({ scopeId, actorId: probe.actorId, action: mutationAction(probe) });
    if (action.type === "upload_stage" || action.type === "upload_part" || action.type === "upload_commit" || action.type === "upload_cancel") {
      if (!resources.uploads) throw new CollaborationAuthorizationError("unavailable", "Uploads are unavailable");
      const result = await resources.uploads.handle(context, action);
      return c.json(CollaborationFileActionResponseSchema.parse({
        ...(result.entry ? { entry: entryProjection(result.entry) } : {}),
        ...(result.upload ? { upload: result.upload } : {}),
        replayed: result.replayed,
      }), result.entry && !result.replayed ? 201 : 200);
    }
    const executor = createFileActionExecutor({
      db: resources.catalog.db, catalog: resources.catalog, driver: resources.driver,
      ...(options.now ? { now: options.now } : {}),
      ...(resources.createEventId ? { createEventId: resources.createEventId } : {}),
    });
    const result = await executor.execute(context, action);
    await notify(options, scopeId, result.replayed);
    return c.json(CollaborationFileActionResponseSchema.parse({ entry: entryProjection(result.entry), replayed: result.replayed }),
      action.type === "create" && !result.replayed ? 201 : 200);
  }));

  routes.get("/api/collaboration/scopes/:scopeId/apps/:appId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const appId = CollaborationAppInstanceIdSchema.parse(c.req.param("appId"));
    const apps = requireApps(requireResources(options));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const instance = await apps.describe(context, appId);
    return c.json(CollaborationAppInstanceSchema.parse({
      appId: instance.appId,
      ...(instance.catalogId ? { catalogId: instance.catalogId } : {}),
      revision: String(instance.revision),
      readiness: instance.readiness,
      collaborationMode: instance.collaborationMode,
    }));
  }));

  routes.post("/api/collaboration/scopes/:scopeId/apps/:appId/view", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const appId = CollaborationAppInstanceIdSchema.parse(c.req.param("appId"));
    const apps = requireApps(requireResources(options));
    const { value, bytes } = await readJson(c);
    const input = CollaborationAppViewRequestSchema.parse(value);
    const context = await authorize(options, c, bytes, "read", scopeId);
    return c.json({ result: await apps.query(context, appId, input.action) });
  }));

  routes.get("/api/collaboration/scopes/:scopeId/apps/:appId/assets/:assetPath{.+}", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const appId = CollaborationAppInstanceIdSchema.parse(c.req.param("appId"));
    const assetPath = CollaborationAppAssetPathSchema.parse(c.req.param("assetPath"));
    const resources = requireResources(options);
    const apps = requireApps(resources);
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const instance = await apps.describe(context, appId);
    if (instance.readiness !== "ready" || instance.collaborationMode !== "scoped") throw new ResourceCatalogError("unavailable");
    const asset = await resources.driver.readAppAsset({ ...instance.assetNamespace, appId, assetPath });
    try {
      // Recheck after the file is opened: a same-slug unregister/re-register
      // between authorization and open must never stream the new app's bytes.
      const current = await apps.describe(context, appId);
      if (current.incarnation !== instance.incarnation || current.readiness !== "ready"
        || current.collaborationMode !== "scoped") throw new ResourceCatalogError("unavailable");
    } catch (error: unknown) {
      await asset.stream.cancel().catch((cancelError: unknown) => {
        console.warn("[collaboration-resources] stale asset stream cleanup failed", cancelError instanceof Error ? cancelError.name : "UnknownError");
      });
      throw error;
    }
    return streamResponse(c, asset, assetPath.split("/").at(-1) ?? "asset", options);
  }));

  routes.post("/api/collaboration/scopes/:scopeId/apps/:appId/actions", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const appId = CollaborationAppInstanceIdSchema.parse(c.req.param("appId"));
    const apps = requireApps(requireResources(options));
    const { value, bytes } = await readJson(c);
    const input = CollaborationAppActionRequestSchema.parse(value);
    const probe = await authorize(options, c, bytes, "read", scopeId);
    const context = await options.authority.authorize({ scopeId, actorId: probe.actorId, action: mutationAction(probe) });
    const result = await apps.mutate(context, appId, {
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      action: input.action,
    });
    await notify(options, scopeId, result.replayed);
    return c.json(CollaborationAppActionResponseSchema.parse(result));
  }));
}

async function notify(options: CollaborationRouteOptions, scopeId: string, replayed: boolean): Promise<void> {
  if (replayed || !options.onScopeCommitted) return;
  try {
    await options.onScopeCommitted(scopeId);
  } catch (error: unknown) {
    console.warn("[collaboration-resources] committed event delivery failed", error instanceof Error ? error.name : "UnknownError");
  }
}
