import { z } from "zod/v4";

import { canonicalSafeLabel } from "#canonical-chat-primitives";
import {
  CollaborationActorIdSchema,
  CollaborationIdSchema,
  CollaborationOrganizationIdSchema,
  CollaborationRevisionSchema,
  CollaborationRuntimeIdSchema,
} from "#collaboration";
import { CollaborationPresetSchema, CollaborationResourceKindSchema } from "#collaboration-capabilities";
import { CollaborationOrganizationAiSubmissionSchema } from "#collaboration-execution";
import { IsoTimestampSchema } from "#contract-primitives";
import { referenceId } from "#legacy-contract-primitives";

/**
 * S02 / T011: direct-transport wire contract. The platform relay forwards
 * these as opaque bytes; the home verifies every ticket, session and request
 * identically whichever ingress delivered it. Tickets bind the logical runtime
 * id and authority generation, never a TLS hostname.
 */

export const COLLABORATION_DIRECT_PROTOCOL_VERSION = 2 as const;
export const CollaborationProtocolVersionSchema = z.literal(COLLABORATION_DIRECT_PROTOCOL_VERSION);

export const COLLABORATION_DIRECT_LIMITS = Object.freeze({
  ticketTtlSeconds: 30,
  identitySessionTtlSeconds: 300,
  organizationEvidenceTtlSeconds: 20,
  evidenceRefreshTargetSeconds: 10,
  streamWatchdogSeconds: 5,
  clockSkewSeconds: 5,
  httpJsonBytes: 96 * 1024,
  webhookBytes: 256 * 1024,
  wsFrameBytes: 64 * 1024,
  pageRows: 100,
  grantsPerScope: 100,
  connectionsPerHome: 256,
  connectionsPerScope: 32,
  connectionsPerActorScope: 4,
  replayCacheEntries: 10_000,
  controlLookupTimeoutMs: 5_000,
  externalApiTimeoutMs: 10_000,
  maxTicketActions: 1_000,
});

const HEX_DIGEST = /^[a-f0-9]{64}$/;
const HEX_NONCE = /^[a-f0-9]{32,128}$/;
const BASE64URL_THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43,88}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{43,172}$/;
const HTTPS_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*(?::[0-9]{1,5})?$/i;
const IPV4_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function secondsBetween(startIso: string, endIso: string): number {
  return (Date.parse(endIso) - Date.parse(startIso)) / 1_000;
}

function originHost(origin: string): string {
  return origin.slice("https://".length).replace(/:\d+$/, "").toLowerCase();
}

export const CollaborationTicketPurposeSchema = z.enum(["direct_session", "events", "terminal", "control", "peer"]);

/** A logical runtime id is an enrollment identity, never a hostname or address. */
export const CollaborationLogicalRuntimeIdSchema = referenceId(128)
  .refine((value) => !value.includes(".") && !value.includes(":"), { message: "Runtime id cannot be a hostname or address" });

const VPS_ENROLLMENT_RUNTIME_ID = /^vps:([0-9a-f-]{36})$/i;

/**
 * The one canonicalization every side of the direct transport must agree on:
 * customer-VPS enrollment names a home `vps:<machine-uuid>`, which the logical
 * form writes as `vps-<machine-uuid>` because a ticket may never carry `:`.
 * Every other enrolled runtime id is already logical and is returned verbatim,
 * case included -- lowercasing one here would make a valid ticket look forged
 * to whichever side canonicalized differently.
 */
export function toLogicalRuntimeId(runtimeId: string): string {
  const vps = VPS_ENROLLMENT_RUNTIME_ID.exec(runtimeId);
  return vps ? `vps-${vps[1]!.toLowerCase()}` : runtimeId;
}

export const CollaborationAuthorityGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const CollaborationLogicalRuntimeRefSchema = z.object({
  runtimeId: CollaborationLogicalRuntimeIdSchema,
  authorityGeneration: CollaborationAuthorityGenerationSchema,
}).strict();

export const CollaborationTicketResourceSchema = z.object({
  scopeId: CollaborationIdSchema,
  kind: CollaborationResourceKindSchema,
  /** Directory-backed organization grant for an accept-only pending session. */
  pendingGrantId: CollaborationIdSchema.optional(),
}).strict();

export const CollaborationConnectionTicketSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  ticketId: CollaborationIdSchema,
  nonce: z.string().regex(HEX_NONCE),
  actorId: CollaborationActorIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  resource: CollaborationTicketResourceSchema,
  purpose: CollaborationTicketPurposeSchema,
  runtime: CollaborationLogicalRuntimeRefSchema,
  proofKeyThumbprint: z.string().regex(BASE64URL_THUMBPRINT),
  maxActions: z.number().int().min(1).max(COLLABORATION_DIRECT_LIMITS.maxTicketActions),
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
}).strict().superRefine((ticket, ctx) => {
  const ttl = secondsBetween(ticket.issuedAt, ticket.expiresAt);
  if (!(ttl > 0) || ttl > COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Ticket must expire within the ticket TTL" });
  }
});

export const CollaborationSigningKeyIdSchema = referenceId(80);

export const CollaborationSignedConnectionTicketSchema = z.object({
  ticket: CollaborationConnectionTicketSchema,
  keyId: CollaborationSigningKeyIdSchema,
  signature: z.string().regex(BASE64URL_SIGNATURE),
}).strict();

/** Owner setup uses its own ticket resource; no shared scope exists yet. */
export const CollaborationOwnerRuntimeConnectionRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  runtimeId: CollaborationRuntimeIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  proofPublicKey: z.string().regex(BASE64URL_KEY),
}).strict();

export const CollaborationOwnerRuntimeTicketSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  ticketId: CollaborationIdSchema,
  nonce: z.string().regex(HEX_NONCE),
  actorId: CollaborationActorIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  resource: z.object({ kind: z.literal("owner_runtime") }).strict(),
  purpose: z.literal("owner_runtime"),
  runtime: CollaborationLogicalRuntimeRefSchema,
  proofKeyThumbprint: z.string().regex(BASE64URL_THUMBPRINT),
  maxActions: z.number().int().min(1).max(COLLABORATION_DIRECT_LIMITS.maxTicketActions),
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
}).strict().superRefine((ticket, ctx) => {
  const ttl = secondsBetween(ticket.issuedAt, ticket.expiresAt);
  if (!(ttl > 0) || ttl > COLLABORATION_DIRECT_LIMITS.ticketTtlSeconds) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Ticket must expire within the ticket TTL" });
  }
});

export const CollaborationSignedOwnerRuntimeTicketSchema = z.object({
  ticket: CollaborationOwnerRuntimeTicketSchema,
  keyId: CollaborationSigningKeyIdSchema,
  signature: z.string().regex(BASE64URL_SIGNATURE),
}).strict();

export const CollaborationClientOriginSchema = z.string().max(253 + 8 + 6).regex(HTTPS_ORIGIN, "Origin must be an https origin without a path");

export const CollaborationOwnerRuntimeSessionRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  signedTicket: CollaborationSignedOwnerRuntimeTicketSchema,
  proofPublicKey: z.string().regex(BASE64URL_KEY),
  possession: z.string().regex(BASE64URL_SIGNATURE),
  clientOrigin: CollaborationClientOriginSchema,
}).strict();

export const CollaborationDirectSessionRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  signedTicket: CollaborationSignedConnectionTicketSchema,
  proofPublicKey: z.string().regex(BASE64URL_KEY),
  possession: z.string().regex(BASE64URL_SIGNATURE),
  clientOrigin: CollaborationClientOriginSchema,
}).strict();

export const CollaborationDirectSessionRenewRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  signedTicket: CollaborationSignedConnectionTicketSchema,
}).strict();

export const CollaborationDirectSessionSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  id: CollaborationIdSchema,
  actorId: CollaborationActorIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  scopeId: CollaborationIdSchema,
  pendingGrantId: CollaborationIdSchema.optional(),
  runtimeId: CollaborationLogicalRuntimeIdSchema,
  authorityGeneration: CollaborationAuthorityGenerationSchema,
  purpose: CollaborationTicketPurposeSchema,
  proofKeyThumbprint: z.string().regex(BASE64URL_THUMBPRINT),
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  evidenceExpiresAt: IsoTimestampSchema,
  renewAfter: IsoTimestampSchema,
}).strict().superRefine((session, ctx) => {
  const ttl = secondsBetween(session.issuedAt, session.expiresAt);
  if (!(ttl > 0) || ttl > COLLABORATION_DIRECT_LIMITS.identitySessionTtlSeconds) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Session must expire within the identity session TTL" });
  }
  const evidence = secondsBetween(session.issuedAt, session.evidenceExpiresAt);
  if (!(evidence > 0) || evidence > COLLABORATION_DIRECT_LIMITS.organizationEvidenceTtlSeconds) {
    ctx.addIssue({ code: "custom", path: ["evidenceExpiresAt"], message: "Organization evidence must expire within its TTL" });
  }
  if (Date.parse(session.evidenceExpiresAt) > Date.parse(session.expiresAt)) {
    ctx.addIssue({ code: "custom", path: ["evidenceExpiresAt"], message: "Evidence cannot outlive the session" });
  }
  if (Date.parse(session.renewAfter) > Date.parse(session.expiresAt) || Date.parse(session.renewAfter) < Date.parse(session.issuedAt)) {
    ctx.addIssue({ code: "custom", path: ["renewAfter"], message: "Renewal must fall inside the session lifetime" });
  }
});

/** Identity session for exactly three owner-runtime setup routes. */
export const CollaborationOwnerRuntimeSessionSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  id: CollaborationIdSchema,
  actorId: CollaborationActorIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  runtimeId: CollaborationLogicalRuntimeIdSchema,
  authorityGeneration: CollaborationAuthorityGenerationSchema,
  purpose: z.literal("owner_runtime"),
  proofKeyThumbprint: z.string().regex(BASE64URL_THUMBPRINT),
  issuedAt: IsoTimestampSchema,
  expiresAt: IsoTimestampSchema,
  evidenceExpiresAt: IsoTimestampSchema,
  renewAfter: IsoTimestampSchema,
}).strict().superRefine((session, ctx) => {
  const ttl = secondsBetween(session.issuedAt, session.expiresAt);
  if (!(ttl > 0) || ttl > COLLABORATION_DIRECT_LIMITS.identitySessionTtlSeconds) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Session must expire within the identity session TTL" });
  }
  const evidence = secondsBetween(session.issuedAt, session.evidenceExpiresAt);
  if (!(evidence > 0) || evidence > COLLABORATION_DIRECT_LIMITS.organizationEvidenceTtlSeconds
    || Date.parse(session.evidenceExpiresAt) > Date.parse(session.expiresAt)) {
    ctx.addIssue({ code: "custom", path: ["evidenceExpiresAt"], message: "Evidence must expire within its TTL and session" });
  }
  if (Date.parse(session.renewAfter) > Date.parse(session.expiresAt) || Date.parse(session.renewAfter) < Date.parse(session.issuedAt)) {
    ctx.addIssue({ code: "custom", path: ["renewAfter"], message: "Renewal must fall inside the session lifetime" });
  }
});

export const CollaborationDirectRequestSignatureSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  sessionId: CollaborationIdSchema,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(512).regex(/^\/(?!\/)[^?#]*$/, "Invalid canonical path"),
  query: z.string().max(512),
  bodyDigest: z.string().regex(HEX_DIGEST),
  conditionalHeadersDigest: z.string().regex(HEX_DIGEST),
  nonce: z.string().regex(HEX_NONCE),
  issuedAt: IsoTimestampSchema,
}).strict();

export const CollaborationDirectHandshakeFrameSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  type: z.literal("handshake"),
  sessionId: CollaborationIdSchema,
  ticketNonce: z.string().regex(HEX_NONCE),
  possession: z.string().regex(BASE64URL_SIGNATURE),
}).strict();

export const CollaborationRuntimePublicKeySchema = z.object({
  keyId: CollaborationSigningKeyIdSchema,
  algorithm: z.literal("ed25519"),
  publicKey: z.string().regex(BASE64URL_KEY),
}).strict();

/** Relay-routable enrollment handle from existing customer-VPS enrollment; never a caller-supplied URL. */
export const CollaborationRelayHandleSchema = referenceId(160)
  .refine((value) => !/[./:]/.test(value), { message: "Relay handle cannot be an address" });

export const CollaborationFutureDirectOriginSchema = CollaborationClientOriginSchema
  .refine((origin) => {
    const host = originHost(origin);
    return host !== "localhost" && !host.endsWith(".localhost") && !IPV4_LITERAL.test(host) && !host.startsWith("[");
  }, { message: "Direct origin must be a public hostname" });

export const CollaborationRuntimeEndpointRegistrationSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  runtimeId: CollaborationLogicalRuntimeIdSchema,
  ownerId: CollaborationActorIdSchema,
  relayHandle: CollaborationRelayHandleSchema,
  authorityGeneration: CollaborationAuthorityGenerationSchema,
  publicKeys: z.array(CollaborationRuntimePublicKeySchema).min(1).max(8),
  futureDirectOrigin: CollaborationFutureDirectOriginSchema.optional(),
}).strict().superRefine((registration, ctx) => {
  if (new Set(registration.publicKeys.map((key) => key.keyId)).size !== registration.publicKeys.length) {
    ctx.addIssue({ code: "custom", path: ["publicKeys"], message: "Duplicate key id" });
  }
});

export const CollaborationDirectoryCallerStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending") }).strict(),
  z.object({ state: z.literal("active"), preset: CollaborationPresetSchema }).strict(),
  z.object({ state: z.literal("declined") }).strict(),
]);

export const CollaborationResourceDirectoryEntrySchema = z.object({
  scopeId: CollaborationIdSchema,
  resourceKind: CollaborationResourceKindSchema,
  ownerId: CollaborationActorIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  runtimeId: CollaborationLogicalRuntimeIdSchema,
  authorityGeneration: CollaborationAuthorityGenerationSchema,
  title: canonicalSafeLabel(200, 800),
  revision: CollaborationRevisionSchema,
  caller: CollaborationDirectoryCallerStateSchema,
}).strict();

export const CollaborationDenialSchema = z.object({
  organizationId: CollaborationOrganizationIdSchema.optional(),
  actorId: CollaborationActorIdSchema.optional(),
  scopeId: CollaborationIdSchema.optional(),
  generation: CollaborationAuthorityGenerationSchema,
  fencedAt: IsoTimestampSchema,
  ackDeadline: IsoTimestampSchema,
  state: z.enum(["pending", "completed"]),
  acknowledgedAt: IsoTimestampSchema.optional(),
}).strict().superRefine((denial, ctx) => {
  if (denial.organizationId === undefined && denial.actorId === undefined && denial.scopeId === undefined) {
    ctx.addIssue({ code: "custom", message: "A denial names an organization, actor or scope" });
  }
  if ((denial.state === "completed") !== (denial.acknowledgedAt !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["acknowledgedAt"], message: "Completed denials carry the acknowledgement time" });
  }
});

const ControlFrameBase = z.object({ protocolVersion: CollaborationProtocolVersionSchema });

export const CollaborationControlAssertionSchema = z.discriminatedUnion("type", [
  ControlFrameBase.extend({
    type: z.literal("membership_assertion"),
    organizationId: CollaborationOrganizationIdSchema,
    actorId: CollaborationActorIdSchema,
    membershipEpoch: CollaborationRevisionSchema,
    member: z.boolean(),
    /**
     * The organization's projected `collaboration.aiSubmission` policy (S03 → S08).
     * Additive: absent means the platform predates the field and the home treats it
     * as `owner_only`; it is informational and never authority.
     */
    aiSubmission: CollaborationOrganizationAiSubmissionSchema.optional(),
    requestStartedAt: IsoTimestampSchema,
    expiresAt: IsoTimestampSchema,
  }).strict().superRefine((assertion, ctx) => {
    const ttl = secondsBetween(assertion.requestStartedAt, assertion.expiresAt);
    if (!(ttl > 0) || ttl > COLLABORATION_DIRECT_LIMITS.organizationEvidenceTtlSeconds) {
      ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Membership evidence expires within its TTL from request start" });
    }
  }),
  ControlFrameBase.extend({
    type: z.literal("denial"),
    denial: CollaborationDenialSchema,
  }).strict(),
  ControlFrameBase.extend({
    type: z.literal("generation"),
    runtimeId: CollaborationLogicalRuntimeIdSchema,
    authorityGeneration: CollaborationAuthorityGenerationSchema,
  }).strict(),
]);

export const CollaborationControlAckSchema = z.object({
  protocolVersion: CollaborationProtocolVersionSchema,
  runtimeId: CollaborationLogicalRuntimeIdSchema,
  authorityGeneration: CollaborationAuthorityGenerationSchema,
  fenceAt: IsoTimestampSchema,
}).strict();

export type CollaborationDirectRouteAuth = "U" | "U+O" | "R" | "T" | "D" | "webhook";

export interface CollaborationDirectRoute {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly authority: "platform" | "home";
  readonly auth: CollaborationDirectRouteAuth;
  readonly bodyLimit?: number;
  readonly websocket?: true;
  readonly request?: string;
  readonly response?: string;
}

const HTTP_JSON = COLLABORATION_DIRECT_LIMITS.httpJsonBytes;
const HOME = "/api/collaboration";
const SCOPE = `${HOME}/scopes/:scopeId`;

function platform(method: CollaborationDirectRoute["method"], path: string, auth: CollaborationDirectRouteAuth, extra: Partial<CollaborationDirectRoute> = {}): CollaborationDirectRoute {
  return { method, path, authority: "platform", auth, ...(method === "GET" ? {} : { bodyLimit: HTTP_JSON }), ...extra };
}

function home(method: CollaborationDirectRoute["method"], path: string, extra: Partial<CollaborationDirectRoute> = {}): CollaborationDirectRoute {
  return { method, path, authority: "home", auth: "D", ...(method === "GET" ? {} : { bodyLimit: HTTP_JSON }), ...extra };
}

/** Exact V1 route allowlist. No catch-all forwarding route exists; deferred packets add nothing here. */
export const COLLABORATION_DIRECT_ROUTES: readonly CollaborationDirectRoute[] = Object.freeze([
  platform("GET", "/api/organizations", "U"),
  platform("GET", "/api/organizations/:orgId/members", "U+O"),
  platform("GET", `${HOME}/shared`, "U+O", { response: "CollaborationResourceDirectoryEntrySchema[]" }),
  platform("GET", `${HOME}/inbox`, "U+O", { response: "CollaborationResourceDirectoryEntrySchema[]" }),
  platform("POST", `${HOME}/connections`, "U+O", { request: "CollaborationConnectionRequestSchema", response: "CollaborationSignedConnectionTicketSchema" }),
  platform("POST", `${HOME}/owner-runtime/connections`, "U+O", { request: "CollaborationOwnerRuntimeConnectionRequestSchema", response: "CollaborationSignedOwnerRuntimeTicketSchema" }),
  platform("POST", "/internal/collaboration/runtime-endpoints", "R", { request: "CollaborationRuntimeEndpointRegistrationSchema" }),
  platform("GET", "/internal/collaboration/control", "R", { websocket: true, response: "CollaborationControlAssertionSchema" }),
  platform("POST", "/internal/organizations/access/resolve", "R", { response: "CollaborationControlAssertionSchema[]" }),
  platform("POST", "/internal/collaboration/control/ack", "R", { request: "CollaborationControlAckSchema" }),
  platform("PUT", "/internal/collaboration/directory", "R", { request: "CollaborationResourceDirectoryEntrySchema" }),
  platform("POST", "/webhooks/clerk/organizations", "webhook", { bodyLimit: COLLABORATION_DIRECT_LIMITS.webhookBytes }),
  home("POST", `${HOME}/direct-sessions`, { auth: "T", request: "CollaborationDirectSessionRequestSchema", response: "CollaborationDirectSessionSchema" }),
  home("POST", `${HOME}/owner-runtime/sessions`, { auth: "T", request: "CollaborationOwnerRuntimeSessionRequestSchema", response: "CollaborationOwnerRuntimeSessionSchema" }),
  home("POST", `${HOME}/direct-sessions/:sessionId/renew`, { auth: "T", request: "CollaborationDirectSessionRenewRequestSchema", response: "CollaborationDirectSessionSchema" }),
  home("DELETE", `${HOME}/direct-sessions/:sessionId`),
  home("POST", `${HOME}/runtimes/:runtimeId/scopes/preflight`, { request: "CollaborationScopePreflightRequestSchema" }),
  home("POST", `${HOME}/runtimes/:runtimeId/scopes`, { request: "CollaborationCreateScopeRequestSchema" }),
  home("POST", `${HOME}/runtimes/:runtimeId/catalog/resolve`, { request: "CollaborationOwnerCatalogResolveRequestSchema", response: "CollaborationOwnerCatalogResolveResponseSchema" }),
  home("GET", SCOPE, { response: "CollaborationScopeSchema" }),
  home("GET", `${SCOPE}/access`, { response: "CollaborationEffectiveAccessSchema" }),
  home("GET", `${SCOPE}/grants`, { response: "CollaborationGrantSchema[]" }),
  home("POST", `${SCOPE}/grants`, { request: "CollaborationCreateGrantRequestSchema", response: "CollaborationGrantSchema" }),
  home("PATCH", `${SCOPE}/grants/:grantId`, { request: "CollaborationPatchGrantRequestSchema", response: "CollaborationGrantSchema" }),
  home("DELETE", `${SCOPE}/grants/:grantId`, { request: "CollaborationRevokeRequestSchema" }),
  home("POST", `${SCOPE}/invitations`, { request: "CollaborationCreateInvitationRequestSchema" }),
  home("GET", `${HOME}/invitations/:invitationId`, { response: "CollaborationInvitationSchema" }),
  home("POST", `${HOME}/invitations/:invitationId/accept`, { request: "CollaborationAcceptInvitationRequestSchema", response: "CollaborationGrantActivationSchema" }),
  home("POST", `${HOME}/invitations/:invitationId/decline`, { request: "CollaborationDeclineInvitationRequestSchema", response: "CollaborationGrantActivationSchema" }),
  home("GET", `${SCOPE}/policy`),
  home("PUT", `${SCOPE}/policy`),
  home("POST", `${SCOPE}/policy/preflight`, { response: "CollaborationReadinessSchema" }),
  home("GET", `${SCOPE}/chat`, { response: "CollaborationChatSchema" }),
  home("GET", `${SCOPE}/chat/messages`, { response: "CollaborationChatMessagesResponseSchema" }),
  home("POST", `${SCOPE}/chat/messages`, { request: "CollaborationCreateDiscussionRequestSchema" }),
  home("GET", `${SCOPE}/discussion/messages`, { response: "CollaborationDiscussionMessagesResponseSchema" }),
  home("POST", `${SCOPE}/discussion/messages`, { request: "CollaborationCreateDiscussionRequestSchema" }),
  home("GET", `${SCOPE}/user-state`, { response: "CollaborationUserStateSchema" }),
  home("PATCH", `${SCOPE}/user-state`, { request: "CollaborationUserStatePatchSchema" }),
  home("GET", `${SCOPE}/chat/requests`, { response: "CollaborationRunQueueSchema" }),
  home("POST", `${SCOPE}/chat/requests`, { request: "CollaborationRunSubmitRequestSchema", response: "CollaborationRunSchema" }),
  home("POST", `${SCOPE}/chat/requests/:requestId/cancel`, { request: "CollaborationRunCancelRequestSchema" }),
  home("POST", `${SCOPE}/chat/requests/:requestId/retry`, { request: "CollaborationRunRetryRequestSchema" }),
  home("POST", `${SCOPE}/chat/approvals/:approvalId/decision`, { request: "CollaborationToolApprovalDecisionRequestSchema" }),
  home("GET", `${SCOPE}/project`, { response: "CollaborationProjectSchema" }),
  home("GET", `${SCOPE}/project/inventory`, { response: "CollaborationProjectInventorySchema" }),
  home("POST", `${SCOPE}/project/confirm`, { request: "CollaborationProjectConfirmRequestSchema" }),
  home("POST", `${SCOPE}/project/chats`),
  home("POST", `${SCOPE}/project/terminals`),
  home("GET", `${SCOPE}/project/git`, { response: "CollaborationGitOperationSchema[]" }),
  home("POST", `${SCOPE}/project/git/actions`, { request: "CollaborationGitActionRequestSchema", response: "CollaborationGitOperationSchema" }),
  home("GET", `${SCOPE}/project/layout`),
  home("PATCH", `${SCOPE}/project/layout`),
  home("GET", `${SCOPE}/files`),
  home("GET", `${SCOPE}/files/:fileId/content`),
  home("POST", `${SCOPE}/files/actions`),
  home("GET", `${SCOPE}/apps/:appId`),
  home("POST", `${SCOPE}/apps/:appId/view`),
  home("GET", `${SCOPE}/apps/:appId/assets/:assetPath`),
  home("POST", `${SCOPE}/apps/:appId/actions`),
  home("GET", `${SCOPE}/terminal`, { response: "CollaborationTerminalSchema" }),
  home("POST", `${SCOPE}/terminal/actions`, { request: "CollaborationTerminalActionSchema" }),
  home("GET", `${SCOPE}/terminal/ws`, { websocket: true, response: "CollaborationTerminalFrameSchema" }),
  home("GET", `${SCOPE}/events`, { websocket: true, response: "CollaborationEventFrameSchema" }),
  home("GET", `${SCOPE}/sync/events`, { websocket: true }),
  home("GET", `${SCOPE}/execution-policy`, { response: "CollaborationExecutionPolicySchema" }),
  home("PUT", `${SCOPE}/execution-policy`, { request: "CollaborationExecutionPolicyPutRequestSchema", response: "CollaborationExecutionPolicySchema" }),
  home("POST", `${SCOPE}/lifecycle`, { request: "CollaborationLifecycleRequestSchema", response: "CollaborationOperationSchema" }),
  home("GET", `${SCOPE}/operations/:operationId`, { response: "CollaborationOperationSchema" }),
  home("GET", `${SCOPE}/exports/:exportId`, { response: "CollaborationScopeExportSchema" }),
]);

export type CollaborationTicketPurpose = z.infer<typeof CollaborationTicketPurposeSchema>;
export type CollaborationLogicalRuntimeRef = z.infer<typeof CollaborationLogicalRuntimeRefSchema>;
export type CollaborationConnectionTicket = z.infer<typeof CollaborationConnectionTicketSchema>;
export type CollaborationSignedConnectionTicket = z.infer<typeof CollaborationSignedConnectionTicketSchema>;
export type CollaborationDirectSessionRequest = z.infer<typeof CollaborationDirectSessionRequestSchema>;
export type CollaborationDirectSessionRenewRequest = z.infer<typeof CollaborationDirectSessionRenewRequestSchema>;
export type CollaborationDirectSession = z.infer<typeof CollaborationDirectSessionSchema>;
export type CollaborationOwnerRuntimeTicket = z.infer<typeof CollaborationOwnerRuntimeTicketSchema>;
export type CollaborationSignedOwnerRuntimeTicket = z.infer<typeof CollaborationSignedOwnerRuntimeTicketSchema>;
export type CollaborationOwnerRuntimeSession = z.infer<typeof CollaborationOwnerRuntimeSessionSchema>;
export type CollaborationDirectRequestSignature = z.infer<typeof CollaborationDirectRequestSignatureSchema>;
export type CollaborationDirectHandshakeFrame = z.infer<typeof CollaborationDirectHandshakeFrameSchema>;
export type CollaborationRuntimeEndpointRegistration = z.infer<typeof CollaborationRuntimeEndpointRegistrationSchema>;
export type CollaborationResourceDirectoryEntry = z.infer<typeof CollaborationResourceDirectoryEntrySchema>;
export type CollaborationDenial = z.infer<typeof CollaborationDenialSchema>;
export type CollaborationControlAssertion = z.infer<typeof CollaborationControlAssertionSchema>;
export type CollaborationControlAck = z.infer<typeof CollaborationControlAckSchema>;
