import { z } from "zod/v4";

import {
  CanonicalChatApprovalDecisionSchema,
  CanonicalChatMessagePartSchema,
  CanonicalChatModelSelectionSchema,
} from "#canonical-chat";
import { boundedDisplayText, boundedText, referenceId } from "#legacy-contract-primitives";

export const COLLABORATION_HTTP_BODY_LIMIT = 96 * 1024;
export const COLLABORATION_MESSAGE_BYTE_LIMIT = 64 * 1024;
export const COLLABORATION_PAGE_LIMIT = 100;
export const COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT = 32 * 1024;
export const COLLABORATION_TERMINAL_FRAME_BYTE_LIMIT = 64 * 1024;
export const COLLABORATION_CLIENT_REQUEST_ID_HEADER = "x-matrix-client-request-id";
export const COLLABORATION_EXPECTED_REVISION_HEADER = "x-matrix-expected-revision";
export const COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER = "x-matrix-expected-member-revision";
export const COLLABORATION_POLICY_HEADER = "x-matrix-collaboration-policy";

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
  observeTerminal: z.boolean().default(false),
  controlTerminal: z.boolean().default(false),
  stopTerminal: z.boolean().default(false),
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
  invitationId: CollaborationIdSchema.optional(),
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

export const CollaborationDeleteConditionSchema = CollaborationRevokeRequestSchema;

const CollaborationLifecycleBaseSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
}).strict();

export const CollaborationLifecycleRequestSchema = z.discriminatedUnion("type", [
  CollaborationLifecycleBaseSchema.extend({ type: z.literal("archive") }).strict(),
  CollaborationLifecycleBaseSchema.extend({ type: z.literal("restore") }).strict(),
  CollaborationLifecycleBaseSchema.extend({ type: z.literal("export") }).strict(),
  CollaborationLifecycleBaseSchema.extend({ type: z.literal("delete") }).strict(),
  CollaborationLifecycleBaseSchema.extend({
    type: z.literal("transfer"),
    successorActorId: CollaborationActorIdSchema,
    expectedMemberRevision: CollaborationRevisionSchema,
  }).strict(),
  CollaborationLifecycleBaseSchema.extend({ type: z.literal("recover") }).strict(),
]);

export const CollaborationOperationSchema = z.object({
  id: CollaborationIdSchema,
  scopeId: CollaborationIdSchema,
  type: z.enum(["archive", "restore", "export", "delete", "transfer", "recover"]),
  status: z.enum(["accepted", "completed", "failed"]),
  revision: CollaborationRevisionSchema,
  exportId: CollaborationIdSchema.optional(),
  createdAt: z.iso.datetime(),
}).strict();

const CollaborationExportMemberSchema = z.object({
  actorId: CollaborationActorIdSchema,
  role: CollaborationRoleSchema,
  status: CollaborationMemberStatusSchema,
  revision: CollaborationRevisionSchema,
  joinedAt: z.iso.datetime().optional(),
}).strict();

const CollaborationExportAuditSchema = z.object({
  actorId: CollaborationActorIdSchema,
  action: z.string().min(1).max(80),
  outcome: z.string().min(1).max(40),
  revision: CollaborationRevisionSchema,
  reasonCode: z.string().min(1).max(80).optional(),
  createdAt: z.iso.datetime(),
}).strict();

const CollaborationExportChatMessageSchema = z.object({
  id: CollaborationResourceIdSchema,
  sequence: CollaborationRevisionSchema,
  role: z.enum(["user", "assistant", "tool", "system"]),
  state: z.enum(["pending", "committed", "failed"]),
  purpose: z.enum(["discussion", "ai_request", "assistant", "system"]),
  actorId: CollaborationActorIdSchema.optional(),
  parts: z.array(CanonicalChatMessagePartSchema).min(1).max(64),
  createdAt: z.iso.datetime(),
}).strict().superRefine((message, context) => {
  message.parts.forEach((part, index) => {
    if (part.type === "attachment_reference" && part.ownerReference !== undefined) {
      context.addIssue({ code: "custom", path: ["parts", index, "ownerReference"], message: "Owner references are private" });
    }
  });
});

export const CollaborationScopeExportSchema = z.object({
  version: z.literal(1),
  id: CollaborationIdSchema,
  scopeId: CollaborationIdSchema,
  exportedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  scope: z.object({
    kind: z.literal("chat"),
    resourceId: CollaborationResourceIdSchema,
    lifecycle: CollaborationLifecycleSchema,
    revision: CollaborationRevisionSchema,
  }).strict(),
  members: z.array(CollaborationExportMemberSchema).max(8),
  audit: z.array(CollaborationExportAuditSchema).max(10_000),
  chat: z.object({
    id: CollaborationResourceIdSchema,
    title: boundedDisplayText(200, 1_024),
    lifecycle: z.enum(["active", "archived"]),
    revision: CollaborationRevisionSchema,
    messages: z.array(CollaborationExportChatMessageSchema).max(100_000),
    attachments: z.array(z.object({
      id: CollaborationResourceIdSchema,
      messageId: CollaborationResourceIdSchema,
      kind: z.enum(["file", "image", "diff", "structured_ref"]),
      label: boundedDisplayText(512, 2_048),
      mimeType: z.string().min(1).max(256).optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
    }).strict()).max(100_000),
  }).strict(),
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

export const CollaborationSharedChatMessageSchema = z.object({
  id: CollaborationResourceIdSchema,
  chatId: CollaborationResourceIdSchema,
  sequence: CollaborationRevisionSchema,
  role: z.enum(["user", "assistant", "tool", "system"]),
  state: z.enum(["pending", "committed", "failed"]),
  purpose: z.enum(["discussion", "ai_request", "assistant", "system"]),
  actor: CollaborationParticipantSchema,
  parts: z.array(CanonicalChatMessagePartSchema).min(1).max(64),
  createdAt: z.iso.datetime(),
}).strict().superRefine((message, context) => {
  message.parts.forEach((part, index) => {
    if (part.type === "attachment_reference" && part.ownerReference !== undefined) {
      context.addIssue({ code: "custom", path: ["parts", index, "ownerReference"], message: "Owner references are private" });
    }
  });
});

export const CollaborationChatMessagesResponseSchema = z.object({
  messages: z.array(CollaborationSharedChatMessageSchema).max(COLLABORATION_PAGE_LIMIT),
}).strict();

export const CollaborationAiRequestStateSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "unauthorized",
  "unavailable",
]);

export const CollaborationCreateAiRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  text: boundedText(65_536, COLLABORATION_MESSAGE_BYTE_LIMIT),
  selection: CanonicalChatModelSelectionSchema,
}).strict();

export const CollaborationAiRequestControlSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
}).strict();

export const CollaborationApprovalDecisionRequestSchema = CollaborationAiRequestControlSchema.extend({
  runId: CollaborationResourceIdSchema,
  decision: CanonicalChatApprovalDecisionSchema,
}).strict();

export const CollaborationAiRequestSchema = z.object({
  id: CollaborationResourceIdSchema,
  chatId: CollaborationResourceIdSchema,
  acceptedSequence: CollaborationRevisionSchema,
  actor: CollaborationParticipantSchema,
  state: CollaborationAiRequestStateSchema,
  text: boundedText(65_536, COLLABORATION_MESSAGE_BYTE_LIMIT),
  selection: CanonicalChatModelSelectionSchema,
  retryOfRequestId: CollaborationResourceIdSchema.optional(),
  runId: CollaborationResourceIdSchema.optional(),
  acceptedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const CollaborationAiRequestAcceptedResponseSchema = z.object({
  request: CollaborationAiRequestSchema,
  resourceRevision: CollaborationRevisionSchema,
}).strict();

export const CollaborationApprovalSchema = z.object({
  approvalId: CollaborationResourceIdSchema,
  runId: CollaborationResourceIdSchema,
  requestId: CollaborationResourceIdSchema,
  title: boundedDisplayText(160, 640),
  risk: z.enum(["low", "medium", "high"]),
  allowedDecisions: z.array(CanonicalChatApprovalDecisionSchema).min(1).max(4),
  state: z.enum(["pending", "accepted", "completed", "reconciling"]),
}).strict();

export const CollaborationAiRequestsResponseSchema = z.object({
  requests: z.array(CollaborationAiRequestSchema).max(COLLABORATION_PAGE_LIMIT),
  approvals: z.array(CollaborationApprovalSchema).max(COLLABORATION_PAGE_LIMIT),
  defaultSelection: CanonicalChatModelSelectionSchema,
  resourceRevision: CollaborationRevisionSchema,
}).strict();

const CollaborationDirectoryBaseSchema = z.object({
  scopeId: CollaborationIdSchema,
  runtimeId: CollaborationRuntimeIdSchema,
  ownerId: CollaborationActorIdSchema,
  kind: z.literal("chat"),
  authorityGeneration: z.number().int().positive(),
});

export const CollaborationDiscoveryItemSchema = z.discriminatedUnion("status", [
  CollaborationDirectoryBaseSchema.extend({
    status: z.literal("invited"),
    invitationId: CollaborationIdSchema,
    resource: CollaborationInvitationSchema,
  }).strict(),
  CollaborationDirectoryBaseSchema.extend({
    status: z.literal("accepted"),
    resource: z.object({
      scope: CollaborationScopeSchema,
      chat: CollaborationChatSchema,
    }).strict(),
  }).strict(),
]);

export const CollaborationDiscoveryResponseSchema = z.object({
  items: z.array(CollaborationDiscoveryItemSchema).max(100),
  nextCursor: z.string().min(1).max(512).optional(),
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
  conditionalHeadersDigest: z.string().regex(/^[a-f0-9]{64}$/),
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

export const CollaborationTerminalIncarnationSchema = CollaborationResourceIdSchema;
export const CollaborationTerminalConnectionIdSchema = CollaborationResourceIdSchema;

const CollaborationTerminalActionBaseSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  incarnation: CollaborationTerminalIncarnationSchema,
}).strict();

const CollaborationTerminalConnectionActionBaseSchema = CollaborationTerminalActionBaseSchema.extend({
  connectionId: CollaborationTerminalConnectionIdSchema,
}).strict();

const CollaborationTerminalLeaseActionBaseSchema = CollaborationTerminalConnectionActionBaseSchema.extend({
  leaseEpoch: CollaborationRevisionSchema,
}).strict();

export const CollaborationTerminalActionSchema = z.discriminatedUnion("type", [
  CollaborationTerminalConnectionActionBaseSchema.extend({ type: z.literal("acquire") }).strict(),
  CollaborationTerminalLeaseActionBaseSchema.extend({ type: z.literal("release") }).strict(),
  CollaborationTerminalLeaseActionBaseSchema.extend({ type: z.literal("renew") }).strict(),
  CollaborationTerminalConnectionActionBaseSchema.extend({ type: z.literal("takeover") }).strict(),
  CollaborationTerminalLeaseActionBaseSchema.extend({
    type: z.literal("input"),
    data: boundedText(COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT, COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT),
  }).strict(),
  CollaborationTerminalLeaseActionBaseSchema.extend({
    type: z.literal("paste"),
    data: boundedText(COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT, COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT),
  }).strict(),
  CollaborationTerminalLeaseActionBaseSchema.extend({
    type: z.literal("resize"),
    cols: z.number().int().min(1).max(1_000),
    rows: z.number().int().min(1).max(1_000),
  }).strict(),
  CollaborationTerminalActionBaseSchema.extend({ type: z.literal("stop") }).strict(),
]);

export const CollaborationTerminalControllerSchema = z.object({
  actor: CollaborationParticipantSchema,
  leaseEpoch: CollaborationRevisionSchema,
  expiresAt: z.iso.datetime(),
}).strict();

export const CollaborationTerminalSchema = z.object({
  id: CollaborationResourceIdSchema,
  scopeId: CollaborationIdSchema,
  incarnation: CollaborationTerminalIncarnationSchema,
  executionGeneration: CollaborationRevisionSchema,
  status: z.enum(["active", "exited"]),
  createdBy: CollaborationParticipantSchema,
  controller: CollaborationTerminalControllerSchema.optional(),
  createdAt: z.iso.datetime(),
  exitedAt: z.iso.datetime().optional(),
}).strict();

export const CollaborationTerminalActionResultSchema = z.object({
  terminal: CollaborationTerminalSchema,
  action: z.enum(["acquired", "released", "renewed", "taken_over", "accepted", "stopped"]),
}).strict();

const CollaborationTerminalFrameBaseSchema = z.object({
  version: z.literal(1),
  scopeId: CollaborationIdSchema,
  resourceId: CollaborationResourceIdSchema,
  authorityGeneration: CollaborationRevisionSchema,
  incarnation: CollaborationTerminalIncarnationSchema,
}).strict();

export const CollaborationTerminalFrameSchema = z.discriminatedUnion("type", [
  CollaborationTerminalFrameBaseSchema.extend({
    type: z.literal("terminal.ready"),
    connectionId: CollaborationTerminalConnectionIdSchema,
    sequence: CollaborationRevisionSchema,
    terminal: CollaborationTerminalSchema,
  }).strict(),
  CollaborationTerminalFrameBaseSchema.extend({
    type: z.literal("terminal.output"),
    sequence: CollaborationRevisionSchema,
    data: boundedText(COLLABORATION_TERMINAL_FRAME_BYTE_LIMIT, COLLABORATION_TERMINAL_FRAME_BYTE_LIMIT),
  }).strict(),
  CollaborationTerminalFrameBaseSchema.extend({
    type: z.literal("terminal.state"),
    sequence: CollaborationRevisionSchema,
    terminal: CollaborationTerminalSchema,
  }).strict(),
  CollaborationTerminalFrameBaseSchema.extend({
    type: z.literal("terminal.refresh_required"),
    sequence: CollaborationRevisionSchema,
  }).strict(),
  CollaborationTerminalFrameBaseSchema.extend({
    type: z.literal("terminal.unavailable"),
    code: z.enum(["revoked", "expired", "disabled", "exited", "unavailable"]),
  }).strict(),
]);

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
    invitationId: CollaborationIdSchema.optional(),
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
    sequence: CollaborationRevisionSchema,
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
export type CollaborationApproval = z.infer<typeof CollaborationApprovalSchema>;
export type CollaborationAiRequestAcceptedResponse = z.infer<typeof CollaborationAiRequestAcceptedResponseSchema>;
export type CollaborationAiRequest = z.infer<typeof CollaborationAiRequestSchema>;
export type CollaborationAiRequestState = z.infer<typeof CollaborationAiRequestStateSchema>;
export type CollaborationDeleteCondition = z.infer<typeof CollaborationDeleteConditionSchema>;
export type CollaborationCapabilities = z.infer<typeof CollaborationCapabilitiesSchema>;
export type CollaborationEventFrame = z.infer<typeof CollaborationEventFrameSchema>;
export type CollaborationHumanMessage = z.infer<typeof CollaborationHumanMessageSchema>;
export type CollaborationInvitation = z.infer<typeof CollaborationInvitationSchema>;
export type CollaborationLifecycleRequest = z.infer<typeof CollaborationLifecycleRequestSchema>;
export type CollaborationMember = z.infer<typeof CollaborationMemberSchema>;
export type CollaborationOperation = z.infer<typeof CollaborationOperationSchema>;
export type CollaborationParticipant = z.infer<typeof CollaborationParticipantSchema>;
export type CollaborationPolicy = z.infer<typeof CollaborationPolicySchema>;
export type CollaborationRole = z.infer<typeof CollaborationRoleSchema>;
export type CollaborationScope = z.infer<typeof CollaborationScopeSchema>;
export type CollaborationScopeExport = z.infer<typeof CollaborationScopeExportSchema>;
export type CollaborationTerminal = z.infer<typeof CollaborationTerminalSchema>;
export type CollaborationTerminalAction = z.infer<typeof CollaborationTerminalActionSchema>;
export type CollaborationTerminalActionResult = z.infer<typeof CollaborationTerminalActionResultSchema>;
export type CollaborationTerminalController = z.infer<typeof CollaborationTerminalControllerSchema>;
export type CollaborationTerminalFrame = z.infer<typeof CollaborationTerminalFrameSchema>;
export type CollaborationUserState = z.infer<typeof CollaborationUserStateSchema>;
