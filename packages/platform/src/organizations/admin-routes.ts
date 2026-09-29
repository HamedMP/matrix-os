import { OrganizationCreateRequestSchema, OrganizationCreateResponseSchema } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { ClerkActorIdSchema, ClerkOrganizationIdSchema } from "./roles.js";
import { OrganizationAdminRepository, OrganizationCreateLimitError, OrganizationInvitationConflictError, OrganizationInvitationLimitError } from "./admin-repository.js";
import type { ClerkOrganizationAdmin } from "./clerk-admin-client.js";
import type { OrganizationMembershipProjection } from "./projection.js";
import type { PlatformOrganizationRepository } from "./repository.js";
import { timingSafeTokenEquals } from "../platform-token.js";

const InvitationIdSchema = z.string().regex(/^orginv_[A-Za-z0-9_]{1,120}$/);
const InviteSchema = z.object({
  emailAddress: z.string().trim().pipe(z.email().max(320)).transform((value) => value.toLowerCase()),
  role: z.enum(["org:admin", "org:member"]),
  clientRequestId: z.uuid(),
}).strict();
const InviteQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(50), offset: z.coerce.number().int().min(0).max(500).default(0) }).strict();

export function createOrganizationAdminRoutes(options: {
  repository: OrganizationAdminRepository;
  clerk?: ClerkOrganizationAdmin;
  projection: OrganizationMembershipProjection;
  membershipRepository?: Pick<PlatformOrganizationRepository, "getMembership">;
  platformSecret?: string;
  appOrigin?: string;
  resolveActor(c: Context): Promise<string | null>;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  const now = options.now ?? (() => new Date());
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

  async function requireAdmin(c: Context): Promise<{ actorId: string; organizationId: string } | Response> {
    let actor: string | null;
    try { actor = await options.resolveActor(c); }
    catch (error: unknown) {
      console.warn("[organizations] invitation actor resolution failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Organizations unavailable" }, 503);
    }
    const actorResult = ClerkActorIdSchema.safeParse(actor);
    if (!actorResult.success) return c.json({ error: "Unauthorized" }, 401);
    const actorId = actorResult.data;
    const parsed = ClerkOrganizationIdSchema.safeParse(c.req.param("orgId"));
    if (!parsed.success) return c.json({ error: "Invalid request" }, 422);
    const organizationId = parsed.data;
    if (!options.clerk || !options.membershipRepository || !options.platformSecret || !options.appOrigin) {
      return c.json({ error: "Organizations unavailable" }, 503);
    }
    try {
      const fresh = await options.projection.reconcileFresh(organizationId);
      if (!fresh.verified) return c.json({ error: "Organizations unavailable" }, 503);
      const membership = await options.membershipRepository.getMembership({ organizationId, actorId });
      if (membership?.state !== "active" || membership.role !== "org:admin") return c.json({ error: "Forbidden" }, 403);
      return { actorId, organizationId };
    } catch (error: unknown) {
      console.warn("[organizations] invitation authorization failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Organizations unavailable" }, 503);
    }
  }

  app.post("/api/organizations/:orgId/invitations", jsonLimit, async (c) => {
    const authority = await requireAdmin(c);
    if (authority instanceof Response) return authority;
    let body: z.infer<typeof InviteSchema>;
    try { body = InviteSchema.parse(await c.req.json()); }
    catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request too large" }, 413);
      return c.json({ error: "Invalid request" }, 422);
    }
    try {
      const addressDigest = options.repository.invitationDigest(body.emailAddress, options.platformSecret!);
      const { record, claimed, reclaim } = await options.repository.beginInvitation({ ...authority, addressDigest, clientRequestId: body.clientRequestId, role: body.role });
      if (record.role !== body.role) throw new OrganizationInvitationConflictError();
      if (record.invitationId) return c.json({ invitationId: record.invitationId, status: "pending" }, 201);
      if (!claimed) {
        // Another request owns the external call. Bound the wait and let the caller retry.
        for (let attempt = 0; attempt < 48; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const settled = await options.repository.getInvitation(authority.organizationId, addressDigest);
          if (settled?.invitationId) {
            if (settled.role !== body.role) throw new OrganizationInvitationConflictError();
            return c.json({ invitationId: settled.invitationId, status: "pending" }, 201);
          }
        }
        c.header("Retry-After", String(Math.max(1, Math.ceil((record.leaseUntil.getTime() - now().getTime()) / 1000))));
        return c.json({ error: "Organizations unavailable" }, 503);
      }
      let invitation: { invitationId: string; expiresAt: Date } | undefined;
      if (reclaim) {
        // A prior Clerk response may have been lost before the row was updated.
        for (let offset = 0; offset < 500; offset += 50) {
          const page = await options.clerk!.listInvitations({ organizationId: authority.organizationId, limit: 50, offset });
          const match = page.invitations.find((entry) => entry.status === "pending" && entry.emailAddress.trim().toLowerCase() === body.emailAddress);
          if (match) {
            if (match.role !== record.role) throw new OrganizationInvitationConflictError();
            invitation = { invitationId: match.invitationId, expiresAt: match.expiresAt };
            break;
          }
          if (offset + 50 >= page.totalCount) break;
          if (offset === 450) throw new Error("Invitation adoption scan exceeded limit");
        }
      }
      invitation ??= await options.clerk!.createInvitation({
        organizationId: authority.organizationId, actorId: authority.actorId,
        emailAddress: body.emailAddress, role: record.role,
        requestId: record.attemptRequestId,
        redirectUrl: `${options.appOrigin}/shared/organization-invitation`,
      });
      const completed = await options.repository.completeInvitation(record, invitation.invitationId, invitation.expiresAt);
      c.header("Cache-Control", "private, no-store");
      return c.json({ invitationId: completed.invitationId, status: "pending" }, 201);
    } catch (error: unknown) {
      if (error instanceof OrganizationInvitationConflictError) return c.json({ error: "Conflicting invitation" }, 409);
      if (error instanceof OrganizationInvitationLimitError || (error instanceof Error && error.name === "OrganizationInvitationLimitError")) {
        c.header("Retry-After", String((error as OrganizationInvitationLimitError).retryAfterSeconds));
        return c.json({ error: "Too many requests" }, 429);
      }
      console.warn("[organizations] invite failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Organizations unavailable" }, 503);
    }
  });

  app.get("/api/organizations/:orgId/invitations", async (c) => {
    const authority = await requireAdmin(c);
    if (authority instanceof Response) return authority;
    const query = InviteQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: "Invalid request" }, 422);
    try {
      const page = await options.clerk!.listInvitations({ organizationId: authority.organizationId, ...query.data });
      c.header("Cache-Control", "private, no-store");
      return c.json(page);
    } catch (error: unknown) {
      console.warn("[organizations] invitation listing failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Organizations unavailable" }, 503);
    }
  });

  app.delete("/api/organizations/:orgId/invitations/:invitationId", jsonLimit, async (c) => {
    try { await c.req.text(); } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request too large" }, 413);
      console.warn("[organizations] invitation revoke body failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Invalid request" }, 422);
    }
    const authority = await requireAdmin(c);
    if (authority instanceof Response) return authority;
    const invitationId = InvitationIdSchema.safeParse(c.req.param("invitationId"));
    if (!invitationId.success) return c.json({ error: "Invalid request" }, 422);
    try {
      await options.clerk!.revokeInvitation({ organizationId: authority.organizationId, invitationId: invitationId.data, actorId: authority.actorId });
      await options.repository.deleteInvitation(authority.organizationId, invitationId.data);
      return c.body(null, 204);
    } catch (error: unknown) {
      console.warn("[organizations] invitation revocation failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Organizations unavailable" }, 503);
    }
  });
  return app;
}
