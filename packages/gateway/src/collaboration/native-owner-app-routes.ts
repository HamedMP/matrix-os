import {
  CollaborationAppActionRequestSchema,
  CollaborationAppActionResponseSchema,
  CollaborationAppViewRequestSchema,
  CollaborativeAppParticipantSchema,
  CollaborativeAppQueryResponseSchema,
  CollaborativeAppShareSchema,
  CollaborationIdSchema,
} from "@matrix-os/contracts";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { hasVerifiedRuntimeBearer, requireRequestPrincipal } from "../request-principal.js";
import { BridgeQueryBodySchema } from "../app-db-contracts.js";
import { CollaborationAuthorizationError } from "./authority.js";
import type { CollaborationRouteOptions } from "./route-support.js";
import { handle } from "./route-support.js";

const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const OwnerMutationSchema = CollaborationAppActionRequestSchema.extend({ scopeId: CollaborationIdSchema });

/** Electron's owner-only bearer path to the same scoped app adapter used by members. */
export function registerNativeOwnerAppRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  const readiness = options.collaborativeAppReadiness;
  const apps = options.resources?.apps;
  if (!readiness?.share || !apps) return;
  const path = "/api/collaboration/apps/:appId/owner-bridge";
  const limit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) });
  const resolve = async (context: Context) => {
    if (!hasVerifiedRuntimeBearer(context)) return null;
    const principal = requireRequestPrincipal(context, { isLocalDevelopment: false });
    if (principal.userId !== readiness.ownerId) return null;
    const appId = AppIdSchema.parse(context.req.param("appId"));
    const raw = await readiness.share!.get(principal.userId, appId);
    if (!raw) return { appId, share: null, authority: null };
    const share = CollaborativeAppShareSchema.parse(raw);
    if (share.state === "stopped") return { appId, share: null, authority: null };
    if (share.state !== "active") throw new CollaborationAuthorizationError("unavailable", "Shared app is unavailable");
    if (share.owner.actorId !== principal.userId || share.build.appId !== appId) return null;
    const authority = await options.authority.authorize({ scopeId: share.scopeId, actorId: principal.userId, action: "read" });
    if (authority.resourceKind !== "app" || authority.organizationId !== share.organizationId) return null;
    const description = await apps.describe(authority, appId);
    if (description.readiness !== "ready" || description.collaborationMode !== "scoped"
      || description.collaborativeBuildId !== share.build.buildId) {
      throw new CollaborationAuthorizationError("unavailable", "Shared app is unavailable");
    }
    return { appId, share, authority, description };
  };

  routes.get(path, async (context) => handle(context, async () => {
    context.header("Cache-Control", "private, no-store");
    const current = await resolve(context);
    if (!current) return context.json({ error: "Collaboration unavailable" }, 401);
    if (!current.share || !current.authority) return context.json({ participant: null, revision: "0", scopeSequence: "0" });
    const latest = await options.resources!.catalog.db.selectFrom("collaboration_events").select("scope_seq")
      .where("scope_id", "=", current.share.scopeId).orderBy("scope_seq", "desc").limit(1).executeTakeFirst();
    return context.json({
      participant: CollaborativeAppParticipantSchema.parse({
        actorId: current.share.owner.actorId,
        displayName: current.share.owner.displayName,
        organizationId: current.share.organizationId,
        scopeId: current.share.scopeId,
        shareRevision: current.share.shareRevision,
        buildId: current.share.build.buildId,
      }),
      revision: String(current.description.revision),
      scopeSequence: String(latest?.scope_seq ?? 0),
    });
  }));

  routes.post(path, limit, async (context): Promise<Response> => handle(context, async (): Promise<Response> => {
    context.header("Cache-Control", "private, no-store");
    const current = await resolve(context);
    if (!current) return context.json({ error: "Collaboration unavailable" }, 401);
    if (!current.share || !current.authority) return context.json({ error: "Collaboration unavailable" }, 409);
    const body = await context.req.json();
    const view = CollaborationAppViewRequestSchema.safeParse(body);
    if (view.success) {
      const response = await apps.query(current.authority, current.appId, BridgeQueryBodySchema.parse(view.data.action));
      return context.json(CollaborativeAppQueryResponseSchema.parse({ result: response.result, revision: String(response.revision) }));
    }
    const mutation = OwnerMutationSchema.parse(body);
    if (mutation.scopeId !== current.share.scopeId) {
      throw new CollaborationAuthorizationError("unavailable", "Shared app is unavailable");
    }
    const authorized = await options.authority.authorize({ scopeId: current.share.scopeId, actorId: current.share.owner.actorId,
      action: "mutate_resource" });
    const result = await apps.mutate(authorized, current.appId, {
      clientRequestId: mutation.clientRequestId,
      expectedRevision: Number(mutation.expectedRevision), action: BridgeQueryBodySchema.parse(mutation.action),
    });
    if (!result.replayed) await options.onScopeCommitted?.(current.share.scopeId);
    return context.json(CollaborationAppActionResponseSchema.parse(result));
  }));
}
