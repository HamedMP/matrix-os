import { z } from "zod/v4";

import { boundedDisplayText, boundedText, referenceId } from "#legacy-contract-primitives";

export const COLLABORATION_HTTP_BODY_LIMIT = 96 * 1024;
export const COLLABORATION_MESSAGE_BYTE_LIMIT = 64 * 1024;
export const COLLABORATION_PAGE_LIMIT = 100;

export const CollaborationIdSchema = z.uuid();
export const CollaborationActorIdSchema = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "Invalid actor identifier");
export const CollaborationRuntimeIdSchema = referenceId(128);
export const CollaborationResourceIdSchema = referenceId(160);
export const CollaborationRevisionSchema = z.string()
  .regex(/^(?:0|[1-9][0-9]{0,18})$/, "Invalid decimal revision");
export const CollaborationRoleSchema = z.enum(["owner", "editor", "viewer"]);
export const CollaborationInviteRoleSchema = z.enum(["editor", "viewer"]);
export const CollaborationScopeKindSchema = z.enum(["chat", "terminal", "project"]);
export const CollaborationMembershipModeSchema = z.enum(["direct", "inherited"]);
export const CollaborationLifecycleSchema = z.enum([
  "private",
  "preparing",
  "shared",
  "archived",
  "deleting",
  "deleted",
  "recovering",
]);
export const CollaborationCapabilityModeSchema = z.enum([
  "off",
  "internal",
  "enabled",
  "read_only",
]);
export const CollaborationSafeErrorCodeSchema = z.enum([
  "not_found",
  "unauthorized",
  "forbidden",
  "invalid_request",
  "conflict",
  "capacity",
  "expired",
  "unavailable",
  "read_only",
  "rate_limited",
]);

export const CollaborationParticipantSchema = z.object({
  actorId: CollaborationActorIdSchema,
  displayName: boundedDisplayText(120, 512),
}).strict();

export const CollaborationCapabilitiesSchema = z.object({
  read: z.boolean(),
  discuss: z.boolean(),
  manageMembers: z.boolean(),
  requestAi: z.boolean(),
}).strict();

export const CollaborationScopeSchema = z.object({
  id: CollaborationIdSchema,
  ownerId: CollaborationActorIdSchema,
  kind: CollaborationScopeKindSchema,
  resourceId: CollaborationResourceIdSchema,
  parentScopeId: CollaborationIdSchema.optional(),
  membershipMode: CollaborationMembershipModeSchema,
  lifecycle: CollaborationLifecycleSchema,
  revision: CollaborationRevisionSchema,
  authEpoch: CollaborationRevisionSchema,
  authorityGeneration: CollaborationRevisionSchema,
  role: CollaborationRoleSchema,
  capabilities: CollaborationCapabilitiesSchema,
}).strict().superRefine((value, context) => {
  if (value.membershipMode === "direct" && value.parentScopeId !== undefined) {
    context.addIssue({ code: "custom", message: "Direct scopes cannot have a parent" });
  }
  if (value.membershipMode === "inherited" && value.parentScopeId === undefined) {
    context.addIssue({ code: "custom", message: "Inherited scopes require a parent" });
  }
});

export const CollaborationScopePreflightRequestSchema = z.object({
  kind: CollaborationScopeKindSchema,
  resourceId: CollaborationResourceIdSchema,
}).strict();

export const CollaborationScopePreflightResponseSchema = z.object({
  eligible: z.boolean(),
  reason: z.enum(["active_work", "unsupported", "unavailable"]).optional(),
  resourceRevision: CollaborationRevisionSchema,
  confirmationToken: z.string().min(64).max(4_096).regex(/^[A-Za-z0-9_.-]+$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.eligible !== (value.confirmationToken !== undefined)) {
    context.addIssue({ code: "custom", message: "Eligible preflights require confirmation" });
  }
});

export const CollaborationCreateScopeRequestSchema = z.object({
  kind: CollaborationScopeKindSchema,
  resourceId: CollaborationResourceIdSchema,
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  confirmationToken: z.string().min(64).max(4_096).regex(/^[A-Za-z0-9_.-]+$/),
}).strict();

export const CollaborationMemberStatusSchema = z.enum([
  "pending",
  "accepted",
  "revoked",
  "expired",
]);

export const CollaborationMemberSchema = z.object({
  actor: CollaborationParticipantSchema,
  role: CollaborationRoleSchema,
  status: CollaborationMemberStatusSchema,
  revision: CollaborationRevisionSchema,
  joinedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
}).strict();

export const CollaborationInvitationSchema = z.object({
  id: CollaborationIdSchema,
  scopeId: CollaborationIdSchema,
  owner: CollaborationParticipantSchema,
  target: CollaborationParticipantSchema,
  scopeKind: CollaborationScopeKindSchema,
  role: CollaborationInviteRoleSchema,
  status: CollaborationMemberStatusSchema,
  expiresAt: z.iso.datetime(),
  revision: CollaborationRevisionSchema,
}).strict();

const CollaborationConditionalMutationSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
}).strict();

export const CollaborationCreateInvitationRequestSchema = z.object({
  targetActorId: CollaborationActorIdSchema,
  role: CollaborationInviteRoleSchema,
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
}).strict();

export const CollaborationAcceptInvitationRequestSchema = CollaborationConditionalMutationSchema;

export const CollaborationMemberPatchRequestSchema = z.object({
  role: CollaborationInviteRoleSchema,
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  expectedMemberRevision: CollaborationRevisionSchema,
}).strict();

export const CollaborationRevokeRequestSchema = CollaborationConditionalMutationSchema.extend({
  expectedMemberRevision: CollaborationRevisionSchema,
}).strict();

export const CollaborationUserStateSchema = z.object({
  readThroughSeq: CollaborationRevisionSchema,
  pinned: z.boolean(),
  muted: z.boolean(),
  lastOpenedAt: z.iso.datetime().optional(),
}).strict();

export const CollaborationUserStatePatchSchema = z.object({
  readThroughSeq: CollaborationRevisionSchema.optional(),
  pinned: z.boolean().optional(),
  muted: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one user-state field is required",
});

export const CollaborationCreateDiscussionRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  text: boundedText(65_536, COLLABORATION_MESSAGE_BYTE_LIMIT),
}).strict();

export const CollaborationHumanMessageSchema = z.object({
  id: CollaborationResourceIdSchema,
  chatId: CollaborationResourceIdSchema,
  sequence: CollaborationRevisionSchema,
  purpose: z.literal("discussion"),
  actor: CollaborationParticipantSchema,
  text: boundedText(65_536, COLLABORATION_MESSAGE_BYTE_LIMIT),
  createdAt: z.iso.datetime(),
}).strict();

export const CollaborationChatSchema = z.object({
  id: CollaborationResourceIdSchema,
  scopeId: CollaborationIdSchema,
  title: boundedDisplayText(200, 1_024),
  lifecycle: z.enum(["active", "archived"]),
  revision: CollaborationRevisionSchema,
  messageCount: CollaborationRevisionSchema,
  lastMessagePreview: boundedDisplayText(512, 2_048).optional(),
}).strict();

export const CollaborationPageRequestSchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(COLLABORATION_PAGE_LIMIT).default(50),
}).strict();

export const CollaborationActorProofPurposeSchema = z.enum(["http", "events", "terminal"]);
export const CollaborationActorProofSchema = z.object({
  version: z.literal(1),
  keyId: referenceId(80),
  actorId: CollaborationActorIdSchema,
  ownerId: CollaborationActorIdSchema,
  runtimeId: CollaborationRuntimeIdSchema,
  scopeId: CollaborationIdSchema.optional(),
  purpose: CollaborationActorProofPurposeSchema,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1).max(512).regex(/^\/(?!\/)[^?#]*$/, "Invalid canonical path"),
  query: z.string().max(512),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.string().regex(/^[a-f0-9]{32,128}$/),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();

export const CollaborationSignedActorProofSchema = z.object({
  proof: CollaborationActorProofSchema,
  signature: z.string().min(43).max(172).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const CollaborationPolicySchema = z.object({
  milestone: z.enum(["m1", "m2", "m3", "m4"]),
  revision: CollaborationRevisionSchema,
  mode: CollaborationCapabilityModeSchema,
  cohort: z.array(CollaborationActorIdSchema).max(1_000),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();

export const CollaborationSignedPolicySchema = z.object({
  policy: CollaborationPolicySchema,
  keyId: referenceId(80),
  signature: z.string().min(43).max(172).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

export const CollaborationConnectionTicketRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  purpose: z.enum(["events", "terminal"]),
}).strict();

export const CollaborationConnectionTicketResponseSchema = z.object({
  ticket: z.string().min(43).max(256).regex(/^[A-Za-z0-9_-]+$/),
  expiresAt: z.iso.datetime(),
}).strict();

export const CollaborationDirectoryEventSchema = z.object({
  eventId: CollaborationIdSchema,
  scopeId: CollaborationIdSchema,
  runtimeId: CollaborationRuntimeIdSchema,
  ownerId: CollaborationActorIdSchema,
  kind: CollaborationScopeKindSchema,
  authorityGeneration: z.number().int().positive(),
  metadataRevision: z.number().int().nonnegative(),
  recipients: z.array(z.object({
    actorId: CollaborationActorIdSchema,
    status: z.enum(["invited", "accepted", "revoked"]),
  }).strict()).max(8),
}).strict();

const CollaborationEventBaseSchema = z.object({
  version: z.literal(1),
  scopeId: CollaborationIdSchema,
  resourceId: CollaborationResourceIdSchema,
  authorityGeneration: CollaborationRevisionSchema,
}).strict();

export const CollaborationEventFrameSchema = z.discriminatedUnion("type", [
  CollaborationEventBaseSchema.extend({
    type: z.literal("heartbeat"),
    sequence: CollaborationRevisionSchema,
  }).strict(),
  CollaborationEventBaseSchema.extend({
    type: z.literal("ready"),
    sequence: CollaborationRevisionSchema,
  }).strict(),
  CollaborationEventBaseSchema.extend({
    type: z.literal("changed"),
    eventId: CollaborationIdSchema,
    sequence: CollaborationRevisionSchema,
    resourceKind: CollaborationScopeKindSchema,
    revision: CollaborationRevisionSchema,
  }).strict(),
  CollaborationEventBaseSchema.extend({
    type: z.literal("capabilities_changed"),
    sequence: CollaborationRevisionSchema,
  }).strict(),
  CollaborationEventBaseSchema.extend({
    type: z.literal("refresh_required"),
  }).strict(),
  CollaborationEventBaseSchema.extend({
    type: z.literal("unavailable"),
    code: z.enum(["revoked", "expired", "disabled", "deleted", "unavailable"]),
  }).strict(),
]);

export const CollaborationClientFrameSchema = z.discriminatedUnion("type", [
  z.object({ version: z.literal(1), type: z.literal("heartbeat") }).strict(),
  z.object({
    version: z.literal(1),
    type: z.literal("resume"),
    scopeId: CollaborationIdSchema,
    authorityGeneration: CollaborationRevisionSchema,
    sequence: CollaborationRevisionSchema,
  }).strict(),
]);

export type CollaborationActorProof = z.infer<typeof CollaborationActorProofSchema>;
export type CollaborationCapabilities = z.infer<typeof CollaborationCapabilitiesSchema>;
export type CollaborationEventFrame = z.infer<typeof CollaborationEventFrameSchema>;
export type CollaborationHumanMessage = z.infer<typeof CollaborationHumanMessageSchema>;
export type CollaborationInvitation = z.infer<typeof CollaborationInvitationSchema>;
export type CollaborationMember = z.infer<typeof CollaborationMemberSchema>;
export type CollaborationPolicy = z.infer<typeof CollaborationPolicySchema>;
export type CollaborationRole = z.infer<typeof CollaborationRoleSchema>;
export type CollaborationScope = z.infer<typeof CollaborationScopeSchema>;
export type CollaborationUserState = z.infer<typeof CollaborationUserStateSchema>;
