import { OrganizationCreateRequestSchema, OrganizationCreateResponseSchema } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ClerkActorIdSchema } from "./roles.js";
import { OrganizationAdminRepository, OrganizationCreateLimitError } from "./admin-repository.js";
import type { ClerkOrganizationAdmin } from "./clerk-admin-client.js";
import type { OrganizationMembershipProjection } from "./projection.js";
import { timingSafeTokenEquals } from "../platform-token.js";

export function createOrganizationAdminRoutes(options: {
  repository: OrganizationAdminRepository;
  clerk?: ClerkOrganizationAdmin;
  projection: OrganizationMembershipProjection;
  platformSecret?: string;
  resolveActor(c: Context): Promise<string | null>;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  const jsonLimit = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) });

  app.get("/api/operator/organizations/readiness", async (c) => {
    if (!options.platformSecret) return c.json({ error: "Platform admin not configured" }, 503);
    const authorization = c.req.header("authorization");
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (!timingSafeTokenEquals(bearer, options.platformSecret)) return c.json({ error: "Unauthorized" }, 401);
    try {
      c.header("Cache-Control", "no-store");
      return c.json(await options.repository.readinessCounts());
    } catch (error: unknown) {
      console.warn("[organizations] create readiness failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Organizations unavailable" }, 503);
    }
  });

  app.post("/api/organizations", jsonLimit, async (c) => {
    let actorId: string;
    try {
      actorId = ClerkActorIdSchema.parse(await options.resolveActor(c));
    } catch (error: unknown) {
      console.warn("[organizations] create authentication failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Unauthorized" }, 401);
    }
    let body: ReturnType<typeof OrganizationCreateRequestSchema.parse>;
    try {
      body = OrganizationCreateRequestSchema.parse(await c.req.json());
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request too large" }, 413);
      if (!(error instanceof SyntaxError)) console.warn("[organizations] create request invalid", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Invalid request" }, 422);
    }
    try {
      if (!options.clerk) {
        // Keep exact-key replays readable during a configuration outage, but
        // never insert a new intent or charge the daily counter without a client.
        const existing = await options.repository.getRequest(actorId, body.clientRequestId);
        if (!existing) return c.json({ error: "Organizations unavailable" }, 503);
        if (existing.name !== body.name) return c.json({ error: "Conflicting request" }, 409);
        if (existing.state === "needs_review" || existing.state === "failed") return c.json({ error: "Organizations unavailable" }, 503);
        c.header("Cache-Control", "private, no-store");
        return c.json(OrganizationCreateResponseSchema.parse({
          ...(existing.organizationId ? { organizationId: existing.organizationId } : {}),
          name: existing.name, state: existing.state === "listed" ? "listed" : "setting_up",
        }), 201);
      }
      const { request, inserted } = await options.repository.beginCreate(actorId, body.clientRequestId, body.name);
      if (request.name !== body.name) return c.json({ error: "Conflicting request" }, 409);
      if (!inserted) {
        if (request.state === "needs_review" || request.state === "failed") return c.json({ error: "Organizations unavailable" }, 503);
        c.header("Cache-Control", "private, no-store");
        return c.json(OrganizationCreateResponseSchema.parse({
          ...(request.organizationId ? { organizationId: request.organizationId } : {}),
          name: request.name, state: request.state === "listed" ? "listed" : "setting_up",
        }), 201);
      }
      const created = await options.clerk.createOrganization({ actorId, name: request.name, requestId: request.clientRequestId });
      await options.repository.markCreated(request, created.organizationId);
      let verified = false;
      try {
        verified = (await options.projection.reconcile(created.organizationId)).verified
          && await options.projection.isCurrentMember({ organizationId: created.organizationId, actorId });
      } catch (error: unknown) {
        console.warn("[organizations] create reconciliation deferred", error instanceof Error ? error.name : "UnknownError");
      }
      if (verified) await options.repository.markListed({ ...request, state: "created", organizationId: created.organizationId });
      c.header("Cache-Control", "private, no-store");
      return c.json(OrganizationCreateResponseSchema.parse({
        organizationId: created.organizationId, name: request.name, state: verified ? "listed" : "setting_up",
      }), 201);
    } catch (error: unknown) {
      if (error instanceof OrganizationCreateLimitError) {
        c.header("Retry-After", String(error.retryAfterSeconds));
        return c.json({ error: "Too many requests" }, 429);
      }
      console.warn("[organizations] create failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Organizations unavailable" }, 503);
    }
  });
  return app;
}
