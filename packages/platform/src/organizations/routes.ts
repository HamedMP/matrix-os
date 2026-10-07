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
  CollaborationOrganizationMembersCursorSchema,
  ORGANIZATION_LOGO_MAX_BYTES,
  OrganizationManagementInviteInputSchema,
  OrganizationManagementInvitationsSchema,
  OrganizationManagementListSchema,
  OrganizationManagementMembersPageSchema,
  OrganizationManagementMutationResultSchema,
  OrganizationManagementRenameInputSchema,
  OrganizationManagementRoleInputSchema,
  type OrganizationManagementRole,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { CollaborationControlAuthority } from "../collaboration/control-authority.js";
import { logicalRuntimeIdFor } from "../collaboration/runtime-identity.js";
import { applyClerkOrganizationEvent } from "./commands.js";
import { MAX_INFLIGHT_RECONCILIATIONS, type OrganizationMembershipProjection } from "./projection.js";
import { MEMBERSHIP_PAGE_LIMIT, type PlatformOrganizationRepository } from "./repository.js";
import { parseClerkOrganizationWebhook } from "./roles.js";
import { verifyClerkWebhookSignature } from "./webhook-signature.js";
import type { OrganizationManagementDirectory, OrganizationManagementUpstream } from "./management.js";

const RuntimeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const BearerTokenSchema = z.string().min(32).max(4_096).regex(/^[A-Za-z0-9._~-]+$/);
const MembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MEMBERSHIP_PAGE_LIMIT).default(50),
  cursor: CollaborationOrganizationMembersCursorSchema.optional(),
}).strict();
const AccessResolveSchema = z.object({
  protocolVersion: z.literal(COLLABORATION_DIRECT_PROTOCOL_VERSION),
  actors: z.array(z.object({
    organizationId: CollaborationOrganizationIdSchema,
    actorId: CollaborationActorIdSchema,
  }).strict()).min(1).max(100),
}).strict();
const InvitationIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:-]+$/);
const LOGO_UPLOAD_BODY_LIMIT = ORGANIZATION_LOGO_MAX_BYTES + 64 * 1024;
const ORGANIZATION_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503;

export function createPlatformOrganizationRoutes(options: {
  repository: PlatformOrganizationRepository;
  projection: OrganizationMembershipProjection;
  controlAuthority: CollaborationControlAuthority;
  managementDirectory?: OrganizationManagementDirectory;
  managementUpstream?: OrganizationManagementUpstream;
  webhookSigningSecret?: string;
  resolveActor(c: Context): Promise<string | null>;
  authenticateRuntime(input: { runtimeId: string; bearerToken: string }): Promise<{ runtimeId: string; ownerId: string } | null>;
  now?: () => Date;
}): Hono {
  const app = new Hono();
  const now = options.now ?? (() => new Date());
  const jsonLimit = bodyLimit({ maxSize: COLLABORATION_DIRECT_LIMITS.httpJsonBytes, onError: (c) => safeJson(c, "Request too large", 413) });
  const emptyLimit = bodyLimit({ maxSize: 1, onError: (c) => safeJson(c, "Request too large", 413) });
  const logoLimit = bodyLimit({ maxSize: LOGO_UPLOAD_BODY_LIMIT, onError: (c) => safeJson(c, "Request too large", 413) });
  const webhookLimit = bodyLimit({ maxSize: COLLABORATION_DIRECT_LIMITS.webhookBytes, onError: (c) => safeJson(c, "Request too large", 413) });

  app.get("/api/organizations", async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    try {
      const discovery = await options.projection.discoverOrganizationsForActor(actorId);
      const memberships = await options.repository.listOrganizationsForActor(actorId);
      // The repository caps this request at 100 entries. Use at most the
      // global pool's capacity, so one supported listing can refresh every
      // entry without rejecting its own excess work or waiting serially.
      const decisions: Array<{ organizationId: string; member: boolean }> = new Array(memberships.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(MAX_INFLIGHT_RECONCILIATIONS, memberships.length) }, async () => {
        while (next < memberships.length) {
          const index = next++;
          const organizationId = memberships[index]!.organization.organizationId;
          decisions[index] = { organizationId, member: await options.projection.isCurrentMember({ organizationId, actorId }) };
        }
      }));
      const permitted = new Set(decisions.filter((decision) => decision.member).map((decision) => decision.organizationId));
      // Request-local set is bounded by the repository's 100-entry limit.
      // Refresh may change role, policy, epoch or remove membership entirely.
      const refreshed = await options.repository.listOrganizationsForActor(actorId);
      const memberCounts = await options.repository.listMemberCounts(
        refreshed.map((entry) => entry.organization.organizationId),
      );
      const organizations = [];
      for (const entry of refreshed) {
        if (!permitted.has(entry.organization.organizationId)) continue;
        organizations.push({
          organizationId: entry.organization.organizationId,
          name: entry.organization.name,
          slug: entry.organization.slug,
          role: managementRole(entry.membership.role),
          memberCount: memberCounts.get(entry.organization.organizationId) ?? 0,
          aiSubmission: entry.organization.aiSubmission,
          membershipEpoch: entry.organization.membershipEpoch,
        });
      }
      c.header("Cache-Control", "private, no-store");
      return c.json(OrganizationManagementListSchema.parse({ organizations, complete: discovery.complete }));
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
      const profiles = options.managementDirectory
        ? await options.managementDirectory.resolveMemberProfiles(page.members.map((member) => member.actorId))
        : new Map();
      c.header("Cache-Control", "private, no-store");
      return c.json(OrganizationManagementMembersPageSchema.parse({
        members: page.members.map((member) => {
          const profile = profiles.get(member.actorId);
          return {
            actorId: member.actorId,
            displayName: member.displayName ?? profile?.displayName ?? member.actorId,
            ...(member.email ? { emailAddress: member.email }
              : profile?.emailAddress ? { emailAddress: profile.emailAddress } : {}),
            role: managementRole(member.role),
            joinedAt: member.sourceUpdatedAt.toISOString(),
          };
        }),
        ...(page.nextActorId ? { nextCursor: Buffer.from(page.nextActorId, "utf8").toString("base64url") } : {}),
      }));
    } catch (error: unknown) {
      console.warn("[organizations] member listing failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Organizations unavailable", 503);
    }
  });

  app.get("/api/organizations/:orgId/invitations", async (c) => {
    const actorId = await resolveValidatedActor(c, options.resolveActor);
    if (!actorId) return safeJson(c, "Unauthorized", 401);
    const organizationId = CollaborationOrganizationIdSchema.safeParse(c.req.param("orgId"));
    if (!organizationId.success) return safeJson(c, "Invalid request", 422);
    try {
      const membership = await options.repository.getMembership({ organizationId: organizationId.data, actorId });
      if (!membership || membership.state !== "active"
        || !(await options.projection.isCurrentMember({ organizationId: organizationId.data, actorId }))) {
        return safeJson(c, "Organization not found", 404);
      }
      if (managementRole(membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
      if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
      const invitations = (await options.managementUpstream.listPendingInvitations(organizationId.data)).map((invitation) => ({
        invitationId: invitation.invitationId,
        emailAddress: invitation.emailAddress,
        role: managementRole(invitation.role),
        createdAt: invitation.createdAt.toISOString(),
        expiresAt: invitation.expiresAt.toISOString(),
      }));
      c.header("Cache-Control", "private, no-store");
      return c.json(OrganizationManagementInvitationsSchema.parse({ invitations }));
    } catch (error: unknown) {
      console.warn("[organizations] invitation listing failed", error instanceof Error ? error.name : "UnknownError");
      return safeJson(c, "Organizations unavailable", 503);
    }
  });

  app.patch("/api/organizations/:orgId", jsonLimit, async (c) => {
    const context = await mutationContext(c, options);
    if (context instanceof Response) return context;
    if (managementRole(context.membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
    const request = await parseJson(c, OrganizationManagementRenameInputSchema);
    if (!request) return safeJson(c, "Invalid request", 422);
    if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
    try {
      await options.managementUpstream.renameOrganization(context.organizationId, request.name);
      await options.projection.reconcile(context.organizationId);
      return mutationResult(c);
    } catch (error: unknown) {
      return mutationFailure(c, "rename", error);
    }
  });

  app.patch("/api/organizations/:orgId/logo", logoLimit, async (c) => {
    const context = await mutationContext(c, options);
    if (context instanceof Response) return context;
    if (managementRole(context.membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
    if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
    try {
      const form = await c.req.formData();
      const file = form.get("file");
      if (!(file instanceof Blob) || file.size === 0 || file.size > ORGANIZATION_LOGO_MAX_BYTES || !ORGANIZATION_LOGO_TYPES.has(file.type)) {
        return safeJson(c, "Invalid request", 422);
      }
      await options.managementUpstream.updateOrganizationLogo(context.organizationId, file);
      return mutationResult(c);
    } catch (error: unknown) {
      return mutationFailure(c, "logo update", error);
    }
  });

  app.post("/api/organizations/:orgId/invitations", jsonLimit, async (c) => {
    const context = await mutationContext(c, options);
    if (context instanceof Response) return context;
    if (managementRole(context.membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
    const request = await parseJson(c, OrganizationManagementInviteInputSchema);
    if (!request) return safeJson(c, "Invalid request", 422);
    if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
    try {
      await options.managementUpstream.createInvitations(context.organizationId, request.emailAddresses, request.role);
      return mutationResult(c);
    } catch (error: unknown) {
      return mutationFailure(c, "invitation creation", error);
    }
  });

  app.post("/api/organizations/:orgId/invitations/:invitationId/resend", jsonLimit, async (c) => {
    const context = await mutationContext(c, options);
    if (context instanceof Response) return context;
    if (managementRole(context.membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
    const invitationId = InvitationIdSchema.safeParse(c.req.param("invitationId"));
    if (!invitationId.success) return safeJson(c, "Invalid request", 422);
    if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
    try {
      await options.managementUpstream.resendInvitation(context.organizationId, invitationId.data);
      return mutationResult(c);
    } catch (error: unknown) {
      return mutationFailure(c, "invitation resend", error);
    }
  });

  app.delete("/api/organizations/:orgId/invitations/:invitationId", emptyLimit, async (c) => {
    const context = await mutationContext(c, options);
    if (context instanceof Response) return context;
    if (managementRole(context.membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
    const invitationId = InvitationIdSchema.safeParse(c.req.param("invitationId"));
    if (!invitationId.success) return safeJson(c, "Invalid request", 422);
    if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
    try {
      await options.managementUpstream.revokeInvitation(context.organizationId, invitationId.data);
      return mutationResult(c);
    } catch (error: unknown) {
      return mutationFailure(c, "invitation revocation", error);
    }
  });

  app.patch("/api/organizations/:orgId/members/:actorId", jsonLimit, async (c) => {
    const context = await mutationContext(c, options);
    if (context instanceof Response) return context;
    if (managementRole(context.membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
    const targetActorId = CollaborationActorIdSchema.safeParse(c.req.param("actorId"));
    const request = await parseJson(c, OrganizationManagementRoleInputSchema);
    if (!targetActorId.success || !request) return safeJson(c, "Invalid request", 422);
    if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
    try {
      const target = await options.repository.getMembership({ organizationId: context.organizationId, actorId: targetActorId.data });
      if (!target || target.state !== "active") return safeJson(c, "Organization member not found", 404);
      if (managementRole(target.role) === "org:admin" && request.role !== "org:admin"
        && await isLastAdmin(options.repository, context.organizationId)) return safeJson(c, "Assign another admin first", 409);
      await options.managementUpstream.updateMemberRole(context.organizationId, targetActorId.data, request.role);
      await options.projection.reconcile(context.organizationId);
      return mutationResult(c);
    } catch (error: unknown) {
      return mutationFailure(c, "member role update", error);
    }
  });

  app.delete("/api/organizations/:orgId/members/:actorId", emptyLimit, async (c) => {
    const context = await mutationContext(c, options);
    if (context instanceof Response) return context;
    const targetActorId = CollaborationActorIdSchema.safeParse(c.req.param("actorId"));
    if (!targetActorId.success) return safeJson(c, "Invalid request", 422);
    const removingSelf = targetActorId.data === context.actorId;
    if (!removingSelf && managementRole(context.membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
    if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
    try {
      const target = await options.repository.getMembership({ organizationId: context.organizationId, actorId: targetActorId.data });
      if (!target || target.state !== "active") return safeJson(c, "Organization member not found", 404);
      if (managementRole(target.role) === "org:admin" && await isLastAdmin(options.repository, context.organizationId)) {
        return safeJson(c, "Assign another admin first", 409);
      }
      await options.managementUpstream.removeMember(context.organizationId, targetActorId.data);
      await options.projection.reconcile(context.organizationId);
      return mutationResult(c);
    } catch (error: unknown) {
      return mutationFailure(c, "member removal", error);
    }
  });

  app.delete("/api/organizations/:orgId", emptyLimit, async (c) => {
    const context = await mutationContext(c, options);
    if (context instanceof Response) return context;
    if (managementRole(context.membership.role) !== "org:admin") return safeJson(c, "Forbidden", 403);
    if (!options.managementUpstream) return safeJson(c, "Organizations unavailable", 503);
    try {
      await options.managementUpstream.deleteOrganization(context.organizationId);
      return mutationResult(c);
    } catch (error: unknown) {
      return mutationFailure(c, "organization deletion", error);
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
      // Tracking happens inside the authority, only for organizations that pass the owner-membership gate.
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

function managementRole(role: string): OrganizationManagementRole {
  return role === "org:admin" ? "org:admin" : "org:member";
}

async function mutationContext(c: Context, options: {
  repository: PlatformOrganizationRepository;
  projection: OrganizationMembershipProjection;
  resolveActor(c: Context): Promise<string | null>;
}) {
  const actorId = await resolveValidatedActor(c, options.resolveActor);
  if (!actorId) return safeJson(c, "Unauthorized", 401);
  const organizationId = CollaborationOrganizationIdSchema.safeParse(c.req.param("orgId"));
  if (!organizationId.success) return safeJson(c, "Invalid request", 422);
  try {
    await options.projection.reconcile(organizationId.data);
    const membership = await options.repository.getMembership({ organizationId: organizationId.data, actorId });
    if (!membership || membership.state !== "active") return safeJson(c, "Organization not found", 404);
    return { organizationId: organizationId.data, actorId, membership };
  } catch (error: unknown) {
    console.warn("[organizations] mutation authorization failed", error instanceof Error ? error.name : "UnknownError");
    return safeJson(c, "Organizations unavailable", 503);
  }
}

async function isLastAdmin(repository: PlatformOrganizationRepository, organizationId: string): Promise<boolean> {
  let afterActorId: string | undefined;
  let admins = 0;
  do {
    const page = await repository.listMembers(organizationId, { limit: MEMBERSHIP_PAGE_LIMIT, ...(afterActorId ? { afterActorId } : {}) });
    admins += page.members.filter((member) => managementRole(member.role) === "org:admin").length;
    if (admins > 1) return false;
    afterActorId = page.nextActorId;
  } while (afterActorId);
  return admins <= 1;
}

function mutationResult(c: Context) {
  c.header("Cache-Control", "no-store");
  return c.json(OrganizationManagementMutationResultSchema.parse({ ok: true }));
}

function mutationFailure(c: Context, action: string, error: unknown) {
  console.warn(`[organizations] ${action} failed`, error instanceof Error ? error.name : "UnknownError");
  return safeJson(c, "Organization update failed", 503);
}
