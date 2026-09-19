import { createHash } from "node:crypto";
import {
  CollaborationCreateInvitationRequestSchema,
  CollaborationIdSchema,
} from "@matrix-os/contracts";
import type { Context } from "hono";
import { createRateLimiter, type RateLimiter } from "../security/rate-limiter.js";
import { CollaborationParticipantResolverError } from "./participant-resolver.js";
import {
  CollaborationRepositoryError,
  type CollaborationMemberRecord,
  type CollaborationRepository,
} from "./repository.js";

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const INVITATION_RESOLUTION_RATE_LIMIT = {
  maxAttempts: 10,
  windowMs: 60_000,
  lockoutMs: 60_000,
  maxKeys: 10_000,
};

type Participant = { actorId: string; displayName: string };

interface InvitationCreationRouteOptions {
  repository: CollaborationRepository;
  resolveInvitationIdentifier(identifier: string): Promise<Participant>;
  invitationResolutionRateLimiter?: RateLimiter;
  authorize(c: Context, body: Uint8Array, scopeId: string): Promise<{ actorId: string }>;
  projectInvitation(member: CollaborationMemberRecord): Promise<object>;
  notifyScope(scopeId: string): Promise<void>;
  handle(c: Context, operation: () => Promise<Response>): Promise<Response>;
  now?: () => Date;
}

export function createInvitationCreationHandler(options: InvitationCreationRouteOptions) {
  const rateLimiter = options.invitationResolutionRateLimiter
    ?? createRateLimiter(INVITATION_RESOLUTION_RATE_LIMIT);
  const now = options.now ?? (() => new Date());

  return async (c: Context): Promise<Response> => options.handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await options.authorize(c, bytes, scopeId);
    const input = CollaborationCreateInvitationRequestSchema.parse(value);
    if (!rateLimiter.check(context.actorId)) {
      return c.json({ error: "Try again later", code: "rate_limited" }, 429);
    }

    let target: Participant;
    try {
      target = await options.resolveInvitationIdentifier(input.identifier);
    } catch (error: unknown) {
      if (error instanceof CollaborationParticipantResolverError) {
        return c.json({ error: "Invitation could not be created", code: "unavailable" }, 503);
      }
      throw error;
    }

    const result = await options.repository.createInvitation({
      scopeId,
      actorId: context.actorId,
      targetActorId: target.actorId,
      role: input.role,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digestCanonicalInvitation({
        targetActorId: target.actorId,
        role: input.role,
        expectedRevision: input.expectedRevision,
      }),
      expiresAt: new Date(now().getTime() + INVITATION_LIFETIME_MS).toISOString(),
    });
    const member = await options.repository.getInvitation(result.invitationId);
    if (!member) throw new CollaborationRepositoryError("not_found", "Invitation not found");
    await options.notifyScope(scopeId);
    return c.json(await options.projectInvitation(member), 201);
  });
}

async function readJson(c: Context): Promise<{ value: unknown; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown, bytes };
}

function digestCanonicalInvitation(input: {
  targetActorId: string;
  role: "editor" | "viewer";
  expectedRevision: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}
