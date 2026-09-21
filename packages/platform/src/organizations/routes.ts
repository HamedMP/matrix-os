/**
 * V1 organization routes (S03 / T018): organization discovery and member
 * listing for verified actors, the verified Clerk webhook ingress, and the
 * runtime-authenticated control routes homes use to pull membership
 * assertions and acknowledge fences. Every mutating route applies
 * `bodyLimit` before buffering; errors are generic.
 */
import { createHash } from "node:crypto";
import {
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationActorIdSchema,
  CollaborationControlAckSchema,
  CollaborationOrganizationIdSchema,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { CollaborationControlAuthority } from "../collaboration/control-authority.js";
import { logicalRuntimeIdFor } from "../collaboration/runtime-identity.js";
import { applyClerkOrganizationEvent } from "./commands.js";
import type { OrganizationMembershipProjection } from "./projection.js";
import { MEMBERSHIP_PAGE_LIMIT, type PlatformOrganizationRepository } from "./repository.js";
import { parseClerkOrganizationWebhook } from "./roles.js";
import { verifyClerkWebhookSignature } from "./webhook-signature.js";

const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const BearerTokenSchema = z.string().min(32).max(4_096).regex(/^[A-Za-z0-9._~-]+$/);
const MembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MEMBERSHIP_PAGE_LIMIT).default(50),
  cursor: z.string().max(256).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const AccessResolveSchema = z.object({
  protocolVersion: z.literal(COLLABORATION_DIRECT_PROTOCOL_VERSION),
  actors: z.array(z.object({
    organizationId: CollaborationOrganizationIdSchema,
    actorId: CollaborationActorIdSchema,
  }).strict()).min(1).max(100),
}).strict();

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503;

export function createPlatformOrganizationRoutes(options: {
  repository: PlatformOrganizationRepository;
  projection: OrganizationMembershipProjection;
  controlAuthority: CollaborationControlAuthority;
  webhookSigningSecret?: string;
  resolveActor(c: Context): Promise<string | null>;
  authenticateRuntime(input: { runtimeId: string; bearerToken: string }): Promise<{ runtimeId: string; ownerId: string } | null>;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  const now = options.now ?? (() => new Date());
  const jsonLimit = bodyLimit({ maxSize: COLLABORATION_DIRECT_LIMITS.httpJsonBytes, onError: (c) => safeJson(c, "Request too large", 413) });
  const webhookLimit = bodyLimit({ maxSize: COLLABORATION_DIRECT_LIMITS.webhookBytes, onError: (c) => safeJson(c, "Request too large", 413) });

  app.get("/api/organizations", async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    try {
      const memberships = await options.repository.listOrganizationsForActor(actorId);
      const organizations = [];
      for (const entry of memberships) {
        if (!(await options.projection.isCurrentMember({ organizationId: entry.organization.organizationId, actorId }))) continue;
        organizations.push({
          organizationId: entry.organization.organizationId,
          name: entry.organization.name,
          slug: entry.organization.slug,
          role: entry.membership.role,
          aiSubmission: entry.organization.aiSubmission,
          membershipEpoch: entry.organization.membershipEpoch,
        });
      }
      c.header("Cache-Control", "private, no-store");
      return c.json({ organizations });
    } catch (error: unknown) {
      console.warn("[organizations] organization listing failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Organizations unavailable", 503);
    }
  });

  app.get("/api/organizations/:orgId/members", async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    const organizationId = CollaborationOrganizationIdSchema.safeParse(c.req.param("orgId"));
    const query = MembersQuerySchema.safeParse(c.req.query());
    if (!organizationId.success || !query.success) return safeJson(c, "Invalid request", 422);
    try {
      if (!(await options.projection.isCurrentMember({ organizationId: organizationId.data, actorId }))) {
        return safeJson(c, "Organization not found", 404);
      }
      const afterActorId = query.data.cursor ? decodeCursor(query.data.cursor) : undefined;
      if (query.data.cursor && !afterActorId) return safeJson(c, "Invalid request", 422);
      const page = await options.repository.listMembers(organizationId.data, { limit: query.data.limit, afterActorId });
      c.header("Cache-Control", "private, no-store");
      return c.json({
        members: page.members.map((member) => ({ actorId: member.actorId, role: member.role, joinedAt: member.sourceUpdatedAt.toISOString() })),
        ...(page.nextActorId ? { nextCursor: Buffer.from(page.nextActorId, "utf8").toString("base64url") } : {}),
      });
    } catch (error: unknown) {
      console.warn("[organizations] member listing failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Organizations unavailable", 503);
    }
  });

  app.post("/webhooks/clerk/organizations", webhookLimit, async (c) => {
    if (!options.webhookSigningSecret) {
      console.warn("[organizations] webhook refused: signing secret is not configured");
      return safeJson(c, "Webhook unavailable", 503);
    }
    const body = await c.req.text();
    const verification = verifyClerkWebhookSignature({
      signingSecret: options.webhookSigningSecret,
      body,
      headers: { "svix-id": c.req.header("svix-id"), "svix-timestamp": c.req.header("svix-timestamp"), "svix-signature": c.req.header("svix-signature") },
      now,
    });
    if (!verification.ok) {
      console.warn("[organizations] webhook signature rejected", verification.reason);
      return safeJson(c, verification.reason === "invalid_secret" ? "Webhook unavailable" : "Invalid signature", verification.reason === "invalid_secret" ? 503 : 400);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        console.warn("[organizations] webhook body parse failed", error instanceof Error ? error.name : "UnknownError");
      }
      return safeJson(c, "Invalid request", 400);
    }
    const parsed = parseClerkOrganizationWebhook(verification.eventId, payload);
    if (parsed.kind === "invalid") return safeJson(c, "Invalid request", 400);
    c.header("Cache-Control", "no-store");
    if (parsed.kind === "ignored") return c.json({ received: true, outcome: "ignored" });
    try {
      const result = await applyClerkOrganizationEvent(options.repository, parsed.event, {
        payloadHash: createHash("sha256").update(body).digest("hex"),
      });
      if (result.outcome === "conflict") return safeJson(c, "Conflicting delivery", 409);
      // The membership transition and its revocation intent are already durable; draining
      // here is best-effort and the recurring sweep retries anything that fails now.
      if (result.endedMemberships.length > 0) {
        try {
          await options.controlAuthority.drainRevocations();
        } catch (error: unknown) {
          console.warn("[organizations] revocation drain deferred", error instanceof Error ? error.name : "UnknownError");
        }
      }
      return c.json({ received: true, outcome: result.outcome });
    } catch (error: unknown) {
      console.warn("[organizations] webhook application failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Webhook unavailable", 503);
    }
  });

  app.post("/internal/organizations/access/resolve", jsonLimit, async (c) => {
    const runtime = await requireRuntime(c, options.authenticateRuntime);
    if (!runtime) return safeJson(c, "Unauthorized", 401);
    const request = await parseJson(c, AccessResolveSchema);
    if (!request) return safeJson(c, "Invalid request", 422);
    try {
      for (const actor of request.actors) options.projection.touch(actor.organizationId);
      const assertions = await options.controlAuthority.assertActors({ runtimeId: runtime.runtimeId, ownerId: runtime.ownerId }, request.actors);
      c.header("Cache-Control", "no-store");
      return c.json(assertions);
    } catch (error: unknown) {
      console.warn("[organizations] access resolution failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Organizations unavailable", 503);
    }
  });

  app.post("/internal/collaboration/control/ack", jsonLimit, async (c) => {
    const runtime = await requireRuntime(c, options.authenticateRuntime);
    if (!runtime) return safeJson(c, "Unauthorized", 401);
    const ack = await parseJson(c, CollaborationControlAckSchema);
    if (!ack) return safeJson(c, "Invalid request", 422);
    const logicalRuntimeId = logicalRuntimeIdFor(runtime.runtimeId);
    if (!logicalRuntimeId || ack.runtimeId !== logicalRuntimeId) return safeJson(c, "Forbidden", 403);
    try {
      await options.controlAuthority.acknowledge(logicalRuntimeId, ack);
      c.header("Cache-Control", "no-store");
      return c.body(null, 204);
    } catch (error: unknown) {
      console.warn("[organizations] control acknowledgement failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Organizations unavailable", 503);
    }
  });

  return app;
}

function decodeCursor(cursor: string): string | undefined {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  return CollaborationActorIdSchema.safeParse(decoded).success ? decoded : undefined;
}

async function resolveValidatedActor(c: Context, resolveActor: (c: Context) => Promise<string | null>): Promise<string | null> {
  try {
    const parsed = CollaborationActorIdSchema.safeParse(await resolveActor(c));
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    console.warn("[organizations] actor authentication failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

async function requireRuntime(
  c: Context,
  authenticate: (input: { runtimeId: string; bearerToken: string }) => Promise<{ runtimeId: string; ownerId: string } | null>,
) {
  const runtimeId = RuntimeIdSchema.safeParse(c.req.header("x-matrix-runtime-id"));
  const authorization = c.req.header("authorization");
  const bearer = BearerTokenSchema.safeParse(authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined);
  if (!runtimeId.success || !bearer.success) return null;
  try {
    return await authenticate({ runtimeId: runtimeId.data, bearerToken: bearer.data });
  } catch (error: unknown) {
    console.warn("[organizations] runtime authentication failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[organizations] request parsing failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
}

function safeJson(c: Context, error: string, status: ErrorStatus) {
  c.header("Cache-Control", "no-store");
  return c.json({ error }, status);
}
