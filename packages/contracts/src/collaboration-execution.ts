import { z } from "zod/v4";

import { CanonicalChatApprovalDecisionSchema } from "#canonical-chat";
import {
  CanonicalChatExecutionRootRefSchema,
  canonicalBoundedText,
  canonicalReferenceId,
  canonicalSafeLabel,
} from "#canonical-chat-primitives";
import {
  COLLABORATION_MESSAGE_BYTE_LIMIT,
  CollaborationActorIdSchema,
  CollaborationIdSchema,
  CollaborationRevisionSchema,
} from "#collaboration";
import { CollaborationEffectiveSubmitModeSchema, type CollaborationEffectiveSubmitMode } from "#collaboration-capabilities";
import { IsoTimestampSchema, ProviderModelReferenceSchema } from "#contract-primitives";

/**
 * S02 / T012–T013: execution contract. One owner-selected V3 source per
 * execution scope (project or standalone Chat), immutable run bindings, run
 * status on the canonical run, requester/owner control rules and the Git
 * action union executed by the broker under the owner identity.
 */

export const CollaborationSubmitModeSchema = z.enum(["follow_organization", "owner_only"]);
export const CollaborationOrganizationAiSubmissionSchema = z.enum(["members", "owner_only", "absent", "unknown"]);

export function resolveCollaborationEffectiveSubmitMode(input: {
  organizationAiSubmission: CollaborationOrganizationAiSubmission;
  submitMode: CollaborationSubmitMode;
}): CollaborationEffectiveSubmitMode {
  return input.organizationAiSubmission === "members" && input.submitMode === "follow_organization" ? "members" : "owner_only";
}

export const CollaborationExecutionScopeRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), scopeId: CollaborationIdSchema, projectId: canonicalReferenceId(160) }).strict(),
  z.object({ kind: z.literal("standalone_chat"), scopeId: CollaborationIdSchema, chatId: canonicalReferenceId(160) }).strict(),
]);

export const CollaborationSharedHarnessSchema = z.enum(["codex", "claude_code"]);

const V3ReferenceSchema = canonicalReferenceId(128);

export const CollaborationSourceSelectionSchema = z.object({
  accessSourceId: V3ReferenceSchema,
  providerInstanceId: V3ReferenceSchema,
  harness: CollaborationSharedHarnessSchema,
}).strict();

export const CollaborationRunSourceSchema = CollaborationSourceSelectionSchema.extend({
  modelId: ProviderModelReferenceSchema,
}).strict();

export const CollaborationExecutionPolicySchema = z.object({
  scope: CollaborationExecutionScopeRefSchema,
  ownerId: CollaborationActorIdSchema,
  source: CollaborationSourceSelectionSchema,
  submitMode: CollaborationSubmitModeSchema,
  organizationAiSubmission: CollaborationOrganizationAiSubmissionSchema,
  effectiveSubmitMode: CollaborationEffectiveSubmitModeSchema,
  providerTermsAcknowledgedAt: IsoTimestampSchema.nullable(),
  allowedModelIds: z.array(ProviderModelReferenceSchema).min(1).max(64),
  concurrency: z.number().int().min(1).max(8).optional(),
  revision: CollaborationRevisionSchema,
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((policy, ctx) => {
  const expected = resolveCollaborationEffectiveSubmitMode(policy);
  if (policy.effectiveSubmitMode !== expected) {
    ctx.addIssue({ code: "custom", path: ["effectiveSubmitMode"], message: "Effective submit mode must derive from organization metadata and policy" });
  }
  if (policy.effectiveSubmitMode === "members" && policy.providerTermsAcknowledgedAt === null) {
    ctx.addIssue({ code: "custom", path: ["providerTermsAcknowledgedAt"], message: "Member submission requires the owner's provider-terms acknowledgement" });
  }
  if (new Set(policy.allowedModelIds).size !== policy.allowedModelIds.length) {
    ctx.addIssue({ code: "custom", path: ["allowedModelIds"], message: "Duplicate model" });
  }
});

export const CollaborationExecutionPolicyPutRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  accessSourceId: V3ReferenceSchema,
  providerInstanceId: V3ReferenceSchema,
  submitMode: CollaborationSubmitModeSchema,
  acknowledgeProviderTerms: z.boolean(),
  allowedModelIds: z.array(ProviderModelReferenceSchema).min(1).max(64),
  concurrency: z.number().int().min(1).max(8).optional(),
}).strict();

export const CollaborationRunSubmitRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  text: canonicalBoundedText(65_536, COLLABORATION_MESSAGE_BYTE_LIMIT),
  harness: CollaborationSharedHarnessSchema.optional(),
  modelId: ProviderModelReferenceSchema.optional(),
  executionRoot: CanonicalChatExecutionRootRefSchema.optional(),
}).strict();

const HEX_DIGEST = /^[a-f0-9]{64}$/;

/** Immutable once admitted; carries no status. Status lives on the canonical run. */
export const CollaborationRunBindingSchema = z.object({
  runId: canonicalReferenceId(160),
  requestId: canonicalReferenceId(160),
  scope: CollaborationExecutionScopeRefSchema,
  requestingActorId: CollaborationActorIdSchema,
  executingOwnerId: CollaborationActorIdSchema,
  payerActorId: CollaborationActorIdSchema,
  source: CollaborationRunSourceSchema,
  policyRevision: CollaborationRevisionSchema,
  audienceGeneration: CollaborationRevisionSchema,
  executionRoot: CanonicalChatExecutionRootRefSchema,
  rootFingerprint: z.string().regex(HEX_DIGEST),
  sessionGeneration: CollaborationRevisionSchema,
  admittedAt: IsoTimestampSchema,
}).strict().superRefine((binding, ctx) => {
  if (binding.payerActorId !== binding.executingOwnerId) {
    ctx.addIssue({ code: "custom", path: ["payerActorId"], message: "The owner funds every V1 shared run" });
  }
});

export const CollaborationRunStatusSchema = z.enum([
  "queued",
  "claimed",
  "running",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const CollaborationRunInterruptionReasonSchema = z.enum([
  "gateway_restart",
  "scope_runtime_crash",
  "run_unit_exit",
  "control_partition",
]);

export const CollaborationRunControlRelationSchema = z.enum(["requester", "scope_owner"]);
export const CollaborationRunActorRelationSchema = z.enum(["requester", "scope_owner", "contributor", "viewer"]);

export const CollaborationRunDecisionActorSchema = z.object({
  actorId: CollaborationActorIdSchema,
  relation: CollaborationRunControlRelationSchema,
}).strict();

export const CollaborationRunSchema = z.object({
  runId: canonicalReferenceId(160),
  requestId: canonicalReferenceId(160),
  scopeId: CollaborationIdSchema,
  requestingActorId: CollaborationActorIdSchema,
  scopeOwnerId: CollaborationActorIdSchema.optional(),
  status: CollaborationRunStatusSchema,
  interruptedReason: CollaborationRunInterruptionReasonSchema.optional(),
  decidedBy: CollaborationRunDecisionActorSchema.optional(),
  updatedAt: IsoTimestampSchema,
}).strict().superRefine((run, ctx) => {
  if ((run.status === "interrupted") !== (run.interruptedReason !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["interruptedReason"], message: "Interrupted runs carry exactly one loss reason" });
  }
  if ((run.status === "cancelled") !== (run.decidedBy !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["decidedBy"], message: "Cancelled runs name the deciding actor" });
  }
  if (run.decidedBy?.relation === "requester" && run.decidedBy.actorId !== run.requestingActorId) {
    ctx.addIssue({ code: "custom", path: ["decidedBy", "actorId"], message: "A requester decision must come from the requesting actor" });
  }
  if (run.decidedBy?.relation === "scope_owner") {
    if (run.scopeOwnerId === undefined) {
      ctx.addIssue({ code: "custom", path: ["scopeOwnerId"], message: "An owner decision requires the scope owner identity" });
    } else if (run.decidedBy.actorId !== run.scopeOwnerId) {
      ctx.addIssue({ code: "custom", path: ["decidedBy", "actorId"], message: "An owner decision must come from the scope owner" });
    }
    if (run.decidedBy.actorId === run.requestingActorId && run.scopeOwnerId !== run.requestingActorId) {
      ctx.addIssue({ code: "custom", path: ["decidedBy", "relation"], message: "The requesting actor decides as requester, not owner" });
    }
  }
});

export const COLLABORATION_RUN_CONTROL_ACTORS = Object.freeze({
  cancel: Object.freeze(["requester", "scope_owner"] as const),
  tool_approval: Object.freeze(["requester", "scope_owner"] as const),
  retry: Object.freeze(["requester"] as const),
});

export type CollaborationRunControlAction = keyof typeof COLLABORATION_RUN_CONTROL_ACTORS;

export function collaborationRunControlPermitted(action: CollaborationRunControlAction, relation: CollaborationRunActorRelation): boolean {
  return (COLLABORATION_RUN_CONTROL_ACTORS[action] as readonly string[]).includes(relation);
}

const RunControlSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
}).strict();

export const CollaborationRunCancelRequestSchema = RunControlSchema;
export const CollaborationRunRetryRequestSchema = RunControlSchema;

/** `:approvalId` is a path parameter; the body pins the run the approval belongs to, matching the existing handler and CLI. */
export const CollaborationToolApprovalDecisionRequestSchema = RunControlSchema.extend({
  runId: canonicalReferenceId(160),
  decision: CanonicalChatApprovalDecisionSchema,
}).strict();

export const CollaborationQueuedRunRequestSchema = z.object({
  requestId: canonicalReferenceId(160),
  requestingActorId: CollaborationActorIdSchema,
  acceptedAt: IsoTimestampSchema,
  membershipEvidenceFresh: z.boolean(),
}).strict();

export const CollaborationRunQueueSchema = z.object({
  scopeId: CollaborationIdSchema,
  chatId: canonicalReferenceId(160),
  active: CollaborationRunSchema.nullable(),
  queued: z.array(CollaborationQueuedRunRequestSchema).max(100),
  revision: CollaborationRevisionSchema,
}).strict();

const BRANCH_FORBIDDEN_CHARS = /[\x00-\x20 ~^:?*[\]\\]/;

/**
 * Mirrors the gateway's `isValidGitBranchName` (project-manager.ts): the
 * git-check-ref-format rules tightened for argv safety. The contract cannot
 * import the gateway, so the rule set is duplicated verbatim and pinned by a
 * contract test against the same corpus the gateway validator uses.
 */
export function isCollaborationGitBranchName(value: string): boolean {
  if (value.length < 1 || value.length > 200) return false;
  if (BRANCH_FORBIDDEN_CHARS.test(value)) return false;
  if (value.startsWith("-") || value.startsWith(".") || value.startsWith("/")) return false;
  if (value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")) return false;
  if (value.includes("..") || value.includes("@{") || value.includes("//")) return false;
  if (value.split("/").some((component) => component.startsWith(".") || component.endsWith(".lock"))) return false;
  if (value === "@") return false;
  if (value.startsWith("refs/")) return false;
  return true;
}

export const CollaborationGitBranchSchema = z.string().min(1).max(200)
  .refine(isCollaborationGitBranchName, { message: "Invalid branch name" });
export const CollaborationGitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);

const GitActionBase = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  payloadHash: z.string().regex(HEX_DIGEST),
});

export const CollaborationGitActionRequestSchema = z.discriminatedUnion("type", [
  GitActionBase.extend({ type: z.literal("status") }).strict(),
  GitActionBase.extend({ type: z.literal("diff"), baseRef: CollaborationGitBranchSchema.optional() }).strict(),
  GitActionBase.extend({
    type: z.literal("commit"),
    message: canonicalBoundedText(4_096, 16 * 1024),
    expectedHeadSha: CollaborationGitShaSchema,
  }).strict(),
  GitActionBase.extend({
    type: z.literal("push"),
    branch: CollaborationGitBranchSchema,
    expectedHeadSha: CollaborationGitShaSchema,
  }).strict(),
  GitActionBase.extend({
    type: z.literal("pr"),
    title: canonicalSafeLabel(200, 800),
    body: canonicalBoundedText(65_536, 256 * 1024).optional(),
    baseBranch: CollaborationGitBranchSchema,
    headBranch: CollaborationGitBranchSchema,
    expectedHeadSha: CollaborationGitShaSchema,
  }).strict(),
]);

const CREDENTIAL_LOOKALIKE = /ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]+/;
const OwnerIdentityLabelSchema = canonicalSafeLabel(200, 800)
  .refine((value) => !CREDENTIAL_LOOKALIKE.test(value), { message: "Identity label cannot carry a credential" });

export const CollaborationGitOperationTypeSchema = z.enum(["status", "diff", "commit", "push", "pr"]);
export const CollaborationGitOperationStateSchema = z.enum(["pending", "running", "completed", "failed", "unknown", "reconciling"]);

export const CollaborationGitOperationSchema = z.object({
  id: canonicalReferenceId(160),
  scopeId: CollaborationIdSchema,
  type: CollaborationGitOperationTypeSchema,
  state: CollaborationGitOperationStateSchema,
  requestingActorId: CollaborationActorIdSchema,
  runId: canonicalReferenceId(160).optional(),
  ownerIdentityLabel: OwnerIdentityLabelSchema,
  commitSha: CollaborationGitShaSchema.optional(),
  remoteBranch: CollaborationGitBranchSchema.optional(),
  prUrl: z.string().max(512).regex(/^https:\/\/[^\s?#]+(\/[^\s?#]*)?$/, "PR URL must be https").optional(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export type CollaborationSubmitMode = z.infer<typeof CollaborationSubmitModeSchema>;
export type CollaborationOrganizationAiSubmission = z.infer<typeof CollaborationOrganizationAiSubmissionSchema>;
export type CollaborationExecutionScopeRef = z.infer<typeof CollaborationExecutionScopeRefSchema>;
export type CollaborationSharedHarness = z.infer<typeof CollaborationSharedHarnessSchema>;
export type CollaborationSourceSelection = z.infer<typeof CollaborationSourceSelectionSchema>;
export type CollaborationRunSource = z.infer<typeof CollaborationRunSourceSchema>;
export type CollaborationExecutionPolicy = z.infer<typeof CollaborationExecutionPolicySchema>;
export type CollaborationExecutionPolicyPutRequest = z.infer<typeof CollaborationExecutionPolicyPutRequestSchema>;
export type CollaborationRunSubmitRequest = z.infer<typeof CollaborationRunSubmitRequestSchema>;
export type CollaborationRunBinding = z.infer<typeof CollaborationRunBindingSchema>;
export type CollaborationRunStatus = z.infer<typeof CollaborationRunStatusSchema>;
export type CollaborationRunInterruptionReason = z.infer<typeof CollaborationRunInterruptionReasonSchema>;
export type CollaborationRunActorRelation = z.infer<typeof CollaborationRunActorRelationSchema>;
export type CollaborationRunDecisionActor = z.infer<typeof CollaborationRunDecisionActorSchema>;
export type CollaborationRun = z.infer<typeof CollaborationRunSchema>;
export type CollaborationRunCancelRequest = z.infer<typeof CollaborationRunCancelRequestSchema>;
export type CollaborationRunRetryRequest = z.infer<typeof CollaborationRunRetryRequestSchema>;
export type CollaborationToolApprovalDecisionRequest = z.infer<typeof CollaborationToolApprovalDecisionRequestSchema>;
export type CollaborationQueuedRunRequest = z.infer<typeof CollaborationQueuedRunRequestSchema>;
export type CollaborationRunQueue = z.infer<typeof CollaborationRunQueueSchema>;
export type CollaborationGitActionRequest = z.infer<typeof CollaborationGitActionRequestSchema>;
export type CollaborationGitOperationType = z.infer<typeof CollaborationGitOperationTypeSchema>;
export type CollaborationGitOperationState = z.infer<typeof CollaborationGitOperationStateSchema>;
export type CollaborationGitOperation = z.infer<typeof CollaborationGitOperationSchema>;
