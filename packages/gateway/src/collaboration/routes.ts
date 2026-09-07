import { createHash } from "node:crypto";
import {
  COLLABORATION_HTTP_BODY_LIMIT,
  CollaborationAcceptInvitationRequestSchema,
  CollaborationActorIdSchema,
  CollaborationCreateDiscussionRequestSchema,
  CollaborationCreateInvitationRequestSchema,
  CollaborationCreateScopeRequestSchema,
  CollaborationIdSchema,
  CollaborationInvitationSchema,
  CollaborationMemberPatchRequestSchema,
  CollaborationMemberSchema,
  CollaborationRevisionSchema,
  CollaborationRevokeRequestSchema,
  CollaborationRuntimeIdSchema,
  CollaborationScopePreflightRequestSchema,
  CollaborationScopePreflightResponseSchema,
  CollaborationScopeSchema,
  CollaborationUserStatePatchSchema,
  CollaborationUserStateSchema,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CollaborationActorProofError, type CollaborationActorProofVerifier } from "./actor-proof.js";
import {
  CollaborationAuthorizationError,
  type AuthorizedCollaborationContext,
  type CollaborationAction,
  type CollaborationAuthority,
} from "./authority.js";
import type { CollaborationChatAdapter } from "./chat-adapter.js";
import { CollaborationChatScopeError, type CollaborationChatScopeService } from "./chat-scope.js";
import {
  CollaborationRepositoryError,
  type CollaborationMemberRecord,
  type CollaborationRepository,
  type CollaborationScopeRecord,
} from "./repository.js";

const PROOF_HEADER = "x-matrix-collaboration-proof";
const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const MessageQuerySchema = z.object({
  after: CollaborationRevisionSchema.default("0"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

type Participant = { actorId: string; displayName: string };

export function createCollaborationRoutes(options: {
  runtimeId: string;
  verifier: CollaborationActorProofVerifier;
  authority: CollaborationAuthority;
  repository: CollaborationRepository;
  chatScope: CollaborationChatScopeService;
  chatAdapter: CollaborationChatAdapter;
  resolveParticipant(actorId: string): Promise<Participant>;
  onScopeCommitted?(scopeId: string): Promise<void>;
  onRevoked?(scopeId: string, actorId: string): void;
  now?: () => Date;
}): Hono {
  const routes = new Hono();
  const now = options.now ?? (() => new Date());
  const mutationLimit = bodyLimit({
    maxSize: COLLABORATION_HTTP_BODY_LIMIT,
    onError: (c) => c.json({ error: "Collaboration request too large", code: "invalid_request" }, 413),
  });
  routes.use("/api/collaboration/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  routes.on(["POST", "PATCH", "DELETE"], "/api/collaboration/*", mutationLimit);

  routes.post("/api/collaboration/runtimes/:runtimeId/scopes/preflight", async (c) => handle(c, async () => {
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    requireOwnerCreationProof(proof, CollaborationRuntimeIdSchema.parse(c.req.param("runtimeId")), options.runtimeId);
    const input = CollaborationScopePreflightRequestSchema.parse(value);
    if (input.kind !== "chat") return c.json(CollaborationScopePreflightResponseSchema.parse({
      eligible: false,
      reason: "unsupported",
      resourceRevision: "0",
    }));
    const result = await options.chatScope.preflight({ ownerId: proof.ownerId, chatId: input.resourceId });
    return c.json(CollaborationScopePreflightResponseSchema.parse({
      eligible: result.eligible,
      ...(result.reason ? { reason: result.reason } : {}),
      resourceRevision: String(result.chatRevision),
      ...(result.confirmationToken ? { confirmationToken: result.confirmationToken } : {}),
    }));
  }));

  routes.post("/api/collaboration/runtimes/:runtimeId/scopes", async (c) => handle(c, async () => {
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    requireOwnerCreationProof(proof, CollaborationRuntimeIdSchema.parse(c.req.param("runtimeId")), options.runtimeId);
    const input = CollaborationCreateScopeRequestSchema.parse(value);
    if (input.kind !== "chat") throw new CollaborationAuthorizationError("unavailable", "Scope kind is unavailable");
    const scope = await options.chatScope.shareChat({
      ownerId: proof.ownerId,
      chatId: input.resourceId,
      expectedChatRevision: Number(input.expectedRevision),
      confirmationToken: input.confirmationToken,
    });
    const context = await options.authority.authorize({
      scopeId: scope.id,
      actorId: proof.actorId,
      action: "read",
    });
    await notifyScope(options, scope.id);
    return c.json(scopeProjection(scope, context), 201);
  }));

  routes.get("/api/collaboration/scopes/:scopeId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const scope = await requireScope(options.repository, scopeId);
    return c.json(scopeProjection(scope, context));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/members", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const members = await options.repository.listMembers(context.membershipScopeId, {
      includePending: context.role === "owner",
    });
    return c.json({ members: await Promise.all(members.map((member) => memberProjection(options, member))) });
  }));

  routes.post("/api/collaboration/scopes/:scopeId/invitations", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    const input = CollaborationCreateInvitationRequestSchema.parse(value);
    await options.resolveParticipant(input.targetActorId);
    const result = await options.repository.createInvitation({
      scopeId,
      actorId: context.actorId,
      targetActorId: input.targetActorId,
      role: input.role,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(bytes),
      expiresAt: new Date(now().getTime() + INVITATION_LIFETIME_MS).toISOString(),
    });
    const member = await requireInvitation(options.repository, result.invitationId);
    await notifyScope(options, scopeId);
    return c.json(await invitationProjection(options, member), 201);
  }));

  routes.get("/api/collaboration/invitations/:invitationId", async (c) => handle(c, async () => {
    const invitationId = CollaborationIdSchema.parse(c.req.param("invitationId"));
    const proof = await verifyHttp(options.verifier, c, new Uint8Array());
    const member = await requireInvitation(options.repository, invitationId);
    const scope = await requireScope(options.repository, member.scopeId);
    if (proof.scopeId !== scope.id || proof.ownerId !== scope.ownerId
      || ![member.actorId, member.invitedBy].includes(proof.actorId)) {
      throw new CollaborationAuthorizationError("forbidden", "Invitation access is required");
    }
    return c.json(await invitationProjection(options, member));
  }));

  routes.post("/api/collaboration/invitations/:invitationId/accept", async (c) => handle(c, async () => {
    const invitationId = CollaborationIdSchema.parse(c.req.param("invitationId"));
    const { value, bytes } = await readJson(c);
    const proof = await verifyHttp(options.verifier, c, bytes);
    const input = CollaborationAcceptInvitationRequestSchema.parse(value);
    const member = await requireInvitation(options.repository, invitationId);
    if (proof.scopeId !== member.scopeId || proof.actorId !== member.actorId) {
      throw new CollaborationAuthorizationError("forbidden", "Invitation access is required");
    }
    const result = await options.repository.acceptInvitation({
      invitationId,
      actorId: proof.actorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      payloadHash: digest(bytes),
    });
    await notifyScope(options, result.scopeId);
    return c.json(result);
  }));

  routes.delete("/api/collaboration/scopes/:scopeId/invitations/:invitationId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const invitationId = CollaborationIdSchema.parse(c.req.param("invitationId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    const input = CollaborationRevokeRequestSchema.parse(value);
    const result = await options.repository.revokeInvitation({
      scopeId,
      invitationId,
      actorId: context.actorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      expectedMemberRevision: Number(input.expectedMemberRevision),
      payloadHash: digest(bytes),
    });
    options.onRevoked?.(scopeId, result.actorId);
    await notifyScope(options, scopeId);
    return c.json(result);
  }));

  routes.patch("/api/collaboration/scopes/:scopeId/members/:actorId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const targetActorId = CollaborationActorIdSchema.parse(c.req.param("actorId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "manage_members", scopeId);
    const input = CollaborationMemberPatchRequestSchema.parse(value);
    const result = await options.repository.changeMemberRole({
      scopeId,
      actorId: context.actorId,
      targetActorId,
      role: input.role,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      expectedMemberRevision: Number(input.expectedMemberRevision),
      payloadHash: digest(bytes),
    });
    await notifyScope(options, scopeId);
    return c.json(result);
  }));

  routes.delete("/api/collaboration/scopes/:scopeId/members/:actorId", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const targetActorId = CollaborationActorIdSchema.parse(c.req.param("actorId"));
    const { value, bytes } = await readJson(c);
    const input = CollaborationRevokeRequestSchema.parse(value);
    const proof = await verifyHttp(options.verifier, c, bytes);
    if (proof.scopeId !== scopeId) throw new CollaborationAuthorizationError("forbidden", "Member access is required");
    const context = proof.actorId === targetActorId
      ? await options.authority.authorize({ scopeId, actorId: proof.actorId, action: "read" })
      : await options.authority.authorize({ scopeId, actorId: proof.actorId, action: "manage_members" });
    const result = await options.repository.revokeMember({
      scopeId,
      actorId: context.actorId,
      targetActorId,
      clientRequestId: input.clientRequestId,
      expectedRevision: Number(input.expectedRevision),
      expectedMemberRevision: Number(input.expectedMemberRevision),
      payloadHash: digest(bytes),
    });
    options.onRevoked?.(scopeId, result.actorId);
    await notifyScope(options, scopeId);
    return c.json(result);
  }));

  routes.get("/api/collaboration/scopes/:scopeId/user-state", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    requireChatContext(context);
    const state = await options.repository.getChatUserState(context.resourceId, context.actorId);
    return c.json(CollaborationUserStateSchema.parse({
      readThroughSeq: String(state.readThroughSeq),
      pinned: state.pinned,
      muted: state.muted,
      ...(state.lastOpenedAt ? { lastOpenedAt: state.lastOpenedAt } : {}),
    }));
  }));

  routes.patch("/api/collaboration/scopes/:scopeId/user-state", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "read", scopeId);
    requireChatContext(context);
    const input = CollaborationUserStatePatchSchema.parse(value);
    await options.repository.updateChatUserState({
      chatId: context.resourceId,
      actorId: context.actorId,
      ...(input.readThroughSeq === undefined ? {} : { readThroughSeq: Number(input.readThroughSeq) }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.muted === undefined ? {} : { muted: input.muted }),
      openedAt: now().toISOString(),
    });
    const state = await options.repository.getChatUserState(context.resourceId, context.actorId);
    return c.json(CollaborationUserStateSchema.parse({
      readThroughSeq: String(state.readThroughSeq),
      pinned: state.pinned,
      muted: state.muted,
      ...(state.lastOpenedAt ? { lastOpenedAt: state.lastOpenedAt } : {}),
    }));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/chat", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    return c.json(await options.chatAdapter.getChat(context));
  }));

  routes.get("/api/collaboration/scopes/:scopeId/chat/messages", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    const query = MessageQuerySchema.parse(exactQuery(c, ["after", "limit"]));
    return c.json({
      messages: await options.chatAdapter.listMessages(context, {
        afterSequence: query.after,
        limit: query.limit,
      }),
    });
  }));

  routes.post("/api/collaboration/scopes/:scopeId/chat/messages", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const context = await authorize(options, c, bytes, "discuss", scopeId);
    const input = CollaborationCreateDiscussionRequestSchema.parse(value);
    return c.json(await options.chatAdapter.appendDiscussion(context, input), 201);
  }));

  return routes;
}

async function authorize(
  options: { verifier: CollaborationActorProofVerifier },
  c: Context,
  body: Uint8Array,
  action: CollaborationAction,
  scopeId: string,
): Promise<AuthorizedCollaborationContext> {
  const context = await options.verifier.verifyAndAuthorize({
    signedProof: decodeProof(c),
    method: method(c),
    path: c.req.path,
    query: rawQuery(c),
    body,
    action,
  });
  if (context.scopeId !== scopeId) throw new CollaborationAuthorizationError("forbidden", "Scope access is required");
  return context;
}

async function verifyHttp(verifier: CollaborationActorProofVerifier, c: Context, body: Uint8Array) {
  return verifier.verifyHttp({
    signedProof: decodeProof(c),
    method: method(c),
    path: c.req.path,
    query: rawQuery(c),
    body,
  });
}

function decodeProof(c: Context): unknown {
  const encoded = c.req.header(PROOF_HEADER);
  if (!encoded || encoded.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new CollaborationActorProofError("invalid_proof", "Collaboration proof is invalid");
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[collaboration-routes] proof decode failed", error instanceof Error ? error.name : "UnknownError");
    }
    throw new CollaborationActorProofError("invalid_proof", "Collaboration proof is invalid");
  }
}

async function readJson(c: Context): Promise<{ value: unknown; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return { value: JSON.parse(new TextDecoder().decode(bytes)) as unknown, bytes };
}

function requireOwnerCreationProof(
  proof: { actorId: string; ownerId: string; runtimeId: string; scopeId?: string },
  requestedRuntimeId: string,
  runtimeId: string,
): void {
  if (proof.actorId !== proof.ownerId || proof.runtimeId !== requestedRuntimeId
    || requestedRuntimeId !== runtimeId || proof.scopeId !== undefined) {
    throw new CollaborationAuthorizationError("forbidden", "Owner runtime access is required");
  }
}

function scopeProjection(scope: CollaborationScopeRecord, context: AuthorizedCollaborationContext) {
  return CollaborationScopeSchema.parse({
    id: scope.id,
    ownerId: scope.ownerId,
    kind: scope.kind,
    resourceId: scope.resourceId,
    ...(scope.parentScopeId ? { parentScopeId: scope.parentScopeId } : {}),
    membershipMode: scope.membershipMode,
    lifecycle: scope.lifecycle,
    revision: String(scope.revision),
    authEpoch: String(context.authEpoch),
    authorityGeneration: String(scope.authorityGeneration),
    role: context.role,
    capabilities: {
      read: true,
      discuss: context.role !== "viewer" && scope.lifecycle === "shared",
      manageMembers: context.role === "owner" && scope.membershipMode === "direct",
      requestAi: false,
    },
  });
}

async function memberProjection(
  options: { resolveParticipant(actorId: string): Promise<Participant> },
  member: CollaborationMemberRecord,
) {
  return CollaborationMemberSchema.parse({
    actor: await options.resolveParticipant(member.actorId),
    role: member.role,
    status: member.status,
    revision: String(member.revision),
    ...(member.joinedAt ? { joinedAt: member.joinedAt } : {}),
    updatedAt: member.updatedAt,
  });
}

async function invitationProjection(
  options: {
    repository: CollaborationRepository;
    resolveParticipant(actorId: string): Promise<Participant>;
  },
  member: CollaborationMemberRecord,
) {
  const scope = await requireScope(options.repository, member.scopeId);
  if (!member.invitationId || !member.expiresAt || member.role === "owner") {
    throw new CollaborationRepositoryError("not_found", "Invitation not found");
  }
  return CollaborationInvitationSchema.parse({
    id: member.invitationId,
    scopeId: member.scopeId,
    owner: await options.resolveParticipant(scope.ownerId),
    target: await options.resolveParticipant(member.actorId),
    scopeKind: scope.kind,
    role: member.role,
    status: member.status,
    expiresAt: member.expiresAt,
    revision: String(member.revision),
  });
}

async function requireScope(repository: CollaborationRepository, scopeId: string): Promise<CollaborationScopeRecord> {
  const scope = await repository.getScope(scopeId);
  if (!scope) throw new CollaborationRepositoryError("not_found", "Scope not found");
  return scope;
}

async function requireInvitation(
  repository: CollaborationRepository,
  invitationId: string,
): Promise<CollaborationMemberRecord> {
  const invitation = await repository.getInvitation(invitationId);
  if (!invitation) throw new CollaborationRepositoryError("not_found", "Invitation not found");
  return invitation;
}

function requireChatContext(context: AuthorizedCollaborationContext): void {
  if (context.resourceKind !== "chat") {
    throw new CollaborationAuthorizationError("unavailable", "Chat scope is unavailable");
  }
}

async function notifyScope(
  options: { onScopeCommitted?(scopeId: string): Promise<void> },
  scopeId: string,
): Promise<void> {
  if (!options.onScopeCommitted) return;
  try {
    await options.onScopeCommitted(scopeId);
  } catch (error: unknown) {
    console.warn("[collaboration-routes] committed event delivery failed", error instanceof Error ? error.name : "UnknownError");
  }
}

function exactQuery(c: Context, allowed: readonly string[]): Record<string, string> {
  const parameters = new URL(c.req.url).searchParams;
  const output: Record<string, string> = {};
  for (const key of parameters.keys()) {
    if (!allowed.includes(key) || key in output) throw new SyntaxError("Invalid query");
    output[key] = parameters.get(key)!;
  }
  return output;
}

function rawQuery(c: Context): string {
  return new URL(c.req.url).search.slice(1);
}

function method(c: Context): "GET" | "POST" | "PUT" | "PATCH" | "DELETE" {
  return c.req.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function handle(c: Context, operation: () => Promise<Response>): Promise<Response> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof CollaborationActorProofError) {
      return c.json({ error: "Collaboration authentication failed", code: "unauthorized" }, 401);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return c.json({ error: "Invalid collaboration request", code: "invalid_request" }, 400);
    }
    if (error instanceof CollaborationAuthorizationError) {
      const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 503;
      return c.json({ error: "Collaboration unavailable", code: error.code }, status);
    }
    if (error instanceof CollaborationChatScopeError) {
      const status = error.code === "not_found" ? 404
        : error.code === "active_work" || error.code === "conflict" || error.code === "invalid_confirmation" ? 409
          : 503;
      return c.json({ error: "Collaboration state changed", code: error.code }, status);
    }
    if (error instanceof CollaborationRepositoryError) {
      const status = error.code === "not_found" ? 404
        : error.code === "forbidden" ? 403
          : error.code === "capacity" ? 429
            : error.code === "expired" ? 410 : 409;
      return c.json({ error: "Collaboration state changed", code: error.code }, status);
    }
    console.warn("[collaboration-routes] request failed", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Collaboration unavailable", code: "unavailable" }, 503);
  }
}
