import { z } from "zod/v4";

import { canonicalReferenceId, canonicalSafeErrorText, canonicalSafeLabel } from "#canonical-chat-primitives";
import {
  CollaborationActorIdSchema,
  CollaborationIdSchema,
  CollaborationOrganizationIdSchema,
  CollaborationRevisionSchema,
  CollaborationSafeErrorCodeSchema,
} from "#collaboration";
import { IsoTimestampSchema } from "#contract-primitives";

/**
 * S02 / T013: frozen capability vocabulary for organization collaboration V1.
 * Two presets, two audience kinds, six standalone-shareable resource kinds.
 * No selectors, ceilings, denies, cohorts, personal/group/guest audiences or
 * departure-surviving grants exist in this contract.
 */

export const CollaborationPresetSchema = z.enum(["viewer", "contributor"]);

export const CollaborationCapabilityActionSchema = z.enum([
  "chat.read",
  "discussion.read",
  "files.read",
  "app.view",
  "terminal.observe",
  "discussion.post",
  "ai.submit",
  "ai.cancel_own",
  "files.write",
  "app.mutate",
  "git.commit",
  "git.push",
  "git.pr",
  "terminal.control",
]);

const VIEWER_ACTIONS = [
  "chat.read",
  "discussion.read",
  "files.read",
  "app.view",
  "terminal.observe",
] as const satisfies readonly CollaborationCapabilityAction[];

const CONTRIBUTOR_ACTIONS = [
  ...VIEWER_ACTIONS,
  "discussion.post",
  "ai.submit",
  "ai.cancel_own",
  "files.write",
  "app.mutate",
  "git.commit",
  "git.push",
  "git.pr",
  "terminal.control",
] as const satisfies readonly CollaborationCapabilityAction[];

export const COLLABORATION_PRESET_CAPABILITIES: Readonly<Record<CollaborationPreset, readonly CollaborationCapabilityAction[]>> = Object.freeze({
  viewer: Object.freeze([...VIEWER_ACTIONS]),
  contributor: Object.freeze([...CONTRIBUTOR_ACTIONS]),
});

export function expandCollaborationPreset(preset: CollaborationPreset): readonly CollaborationCapabilityAction[] {
  return COLLABORATION_PRESET_CAPABILITIES[preset];
}

export const CollaborationResourceKindSchema = z.enum([
  "project",
  "chat",
  "terminal",
  "app_instance",
  "file",
  "folder",
]);

export const CollaborationAudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("organization") }).strict(),
  z.object({ kind: z.literal("member"), actorId: CollaborationActorIdSchema }).strict(),
]);

export const CollaborationGrantStateSchema = z.enum(["pending", "active", "revoked", "expired"]);

export const CollaborationGrantSchema = z.object({
  id: CollaborationIdSchema,
  scopeId: CollaborationIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  audience: CollaborationAudienceSchema,
  preset: CollaborationPresetSchema,
  state: CollaborationGrantStateSchema,
  policyVersion: canonicalReferenceId(160),
  expiresAt: IsoTimestampSchema.optional(),
  revision: CollaborationRevisionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
}).strict();

export const CollaborationGrantActivationStateSchema = z.enum(["active", "declined"]);

/** Per-member activation of an organization-wide grant; absence of a row is pending. */
export const CollaborationGrantActivationSchema = z.object({
  grantId: CollaborationIdSchema,
  actorId: CollaborationActorIdSchema,
  state: CollaborationGrantActivationStateSchema,
  decidedAt: IsoTimestampSchema,
  membershipEvidenceEpoch: CollaborationRevisionSchema,
}).strict();

export const CollaborationCreateGrantRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  audience: CollaborationAudienceSchema,
  preset: CollaborationPresetSchema,
  expiresAt: IsoTimestampSchema.optional(),
}).strict();

export const CollaborationPatchGrantRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  expectedGrantRevision: CollaborationRevisionSchema,
  preset: CollaborationPresetSchema,
}).strict();

export const CollaborationAccessReasonSchema = z.enum([
  "organization_required",
  "membership_required",
  "activation_required",
  "grant_expired",
  "grant_revoked",
  "scope_unavailable",
  "host_offline",
  "precondition_denied",
]);

function sameActionSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const expectedSet = new Set(expected);
  return actual.every((action) => expectedSet.has(action)) && new Set(actual).size === actual.length;
}

export const CollaborationEffectiveAccessSchema = z.object({
  scopeId: CollaborationIdSchema,
  actorId: CollaborationActorIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  preset: CollaborationPresetSchema.nullable(),
  actions: z.array(CollaborationCapabilityActionSchema).max(CONTRIBUTOR_ACTIONS.length),
  reasons: z.array(CollaborationAccessReasonSchema).max(8),
  evidenceExpiresAt: IsoTimestampSchema,
}).strict().superRefine((access, ctx) => {
  if (access.preset === null) {
    if (access.actions.length > 0) {
      ctx.addIssue({ code: "custom", path: ["actions"], message: "Denied access carries no actions" });
    }
    if (access.reasons.length === 0) {
      ctx.addIssue({ code: "custom", path: ["reasons"], message: "Denied access requires a safe reason" });
    }
    return;
  }
  if (!sameActionSet(access.actions, expandCollaborationPreset(access.preset))) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "Actions must be exactly the preset expansion" });
  }
  if (access.reasons.length > 0) {
    ctx.addIssue({ code: "custom", path: ["reasons"], message: "Allowed access carries no denial reasons" });
  }
});

export const CollaborationReadinessStateSchema = z.enum([
  "ready",
  "owner_setup_needed",
  "host_offline",
  "unsupported",
]);

export const CollaborationOwnerSetupItemSchema = z.enum(["git_identity", "forge_credential", "ai_source"]);

export const CollaborationReadinessItemKindSchema = z.enum([
  "ai_source",
  "submit_mode",
  "git_identity",
  "chat_root_inventory",
]);

const EXECUTION_READINESS_ITEMS = [
  "ai_source",
  "submit_mode",
  "git_identity",
  "chat_root_inventory",
] as const satisfies readonly CollaborationReadinessItemKind[];

export function readinessItemsForResourceKind(kind: CollaborationResourceKind): readonly CollaborationReadinessItemKind[] {
  return kind === "project" || kind === "chat" ? EXECUTION_READINESS_ITEMS : [];
}

const ReadinessItemStatusSchema = z.enum(["ready", "missing", "unavailable"]);

export const CollaborationReadinessItemSchema = z.discriminatedUnion("item", [
  z.object({ item: z.literal("ai_source"), status: ReadinessItemStatusSchema }).strict(),
  z.object({ item: z.literal("submit_mode"), status: ReadinessItemStatusSchema }).strict(),
  z.object({
    item: z.literal("git_identity"),
    status: ReadinessItemStatusSchema,
    identityLabel: canonicalSafeLabel(200, 800).optional(),
  }).strict(),
  z.object({
    item: z.literal("chat_root_inventory"),
    status: ReadinessItemStatusSchema,
    chatRootCount: z.number().int().nonnegative().max(100_000).optional(),
    dirtyRootCount: z.number().int().nonnegative().max(100_000).optional(),
  }).strict(),
]);

export const CollaborationSourceKindSchema = z.enum([
  "matrix_included",
  "owner_account",
  "owner_api_key",
  "matrix_addon",
]);

export const CollaborationEffectiveSubmitModeSchema = z.enum(["members", "owner_only"]);

export const CollaborationReadinessSchema = z.object({
  resourceKind: CollaborationResourceKindSchema,
  state: CollaborationReadinessStateSchema,
  missingOwnerSetup: z.array(CollaborationOwnerSetupItemSchema).max(3),
  sourceKind: CollaborationSourceKindSchema.optional(),
  effectiveSubmitMode: CollaborationEffectiveSubmitModeSchema.optional(),
  items: z.array(CollaborationReadinessItemSchema).max(4),
}).strict().superRefine((readiness, ctx) => {
  const expected = readinessItemsForResourceKind(readiness.resourceKind);
  if (!sameActionSet(readiness.items.map((item) => item.item), expected)) {
    ctx.addIssue({ code: "custom", path: ["items"], message: "Readiness items must match the resource kind" });
  }
  if (expected.length === 0 && (readiness.sourceKind !== undefined || readiness.effectiveSubmitMode !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["sourceKind"], message: "Only execution scopes report a source or submit mode" });
  }
  if (expected.length > 0 && readiness.state === "ready") {
    if (readiness.sourceKind === undefined) {
      ctx.addIssue({ code: "custom", path: ["sourceKind"], message: "A ready execution scope names its source kind" });
    }
    if (readiness.effectiveSubmitMode === undefined) {
      ctx.addIssue({ code: "custom", path: ["effectiveSubmitMode"], message: "A ready execution scope names its effective submit mode" });
    }
  }
  if ((readiness.state === "owner_setup_needed") !== (readiness.missingOwnerSetup.length > 0)) {
    ctx.addIssue({ code: "custom", path: ["missingOwnerSetup"], message: "Owner setup items are reported only when setup is needed" });
  }
  if (new Set(readiness.missingOwnerSetup).size !== readiness.missingOwnerSetup.length) {
    ctx.addIssue({ code: "custom", path: ["missingOwnerSetup"], message: "Duplicate owner setup item" });
  }
});

export const CollaborationDirectErrorCodeSchema = z.enum([
  ...CollaborationSafeErrorCodeSchema.options,
  "upgrade_required",
  "organization_required",
  "membership_required",
  "activation_required",
  "owner_setup_required",
  "host_offline",
  "unsupported",
  "precondition_denied",
]);

export const CollaborationDirectErrorSchema = z.object({
  code: CollaborationDirectErrorCodeSchema,
  safeMessage: canonicalSafeErrorText(180, 720),
  retryable: z.boolean(),
}).strict();

export type CollaborationPreset = z.infer<typeof CollaborationPresetSchema>;
export type CollaborationCapabilityAction = z.infer<typeof CollaborationCapabilityActionSchema>;
export type CollaborationResourceKind = z.infer<typeof CollaborationResourceKindSchema>;
export type CollaborationAudience = z.infer<typeof CollaborationAudienceSchema>;
export type CollaborationGrantState = z.infer<typeof CollaborationGrantStateSchema>;
export type CollaborationGrant = z.infer<typeof CollaborationGrantSchema>;
export type CollaborationGrantActivation = z.infer<typeof CollaborationGrantActivationSchema>;
export type CollaborationCreateGrantRequest = z.infer<typeof CollaborationCreateGrantRequestSchema>;
export type CollaborationPatchGrantRequest = z.infer<typeof CollaborationPatchGrantRequestSchema>;
export type CollaborationAccessReason = z.infer<typeof CollaborationAccessReasonSchema>;
export type CollaborationEffectiveAccess = z.infer<typeof CollaborationEffectiveAccessSchema>;
export type CollaborationReadinessState = z.infer<typeof CollaborationReadinessStateSchema>;
export type CollaborationOwnerSetupItem = z.infer<typeof CollaborationOwnerSetupItemSchema>;
export type CollaborationReadinessItemKind = z.infer<typeof CollaborationReadinessItemKindSchema>;
export type CollaborationReadinessItem = z.infer<typeof CollaborationReadinessItemSchema>;
export type CollaborationSourceKind = z.infer<typeof CollaborationSourceKindSchema>;
export type CollaborationEffectiveSubmitMode = z.infer<typeof CollaborationEffectiveSubmitModeSchema>;
export type CollaborationReadiness = z.infer<typeof CollaborationReadinessSchema>;
export type CollaborationDirectErrorCode = z.infer<typeof CollaborationDirectErrorCodeSchema>;
export type CollaborationDirectError = z.infer<typeof CollaborationDirectErrorSchema>;
