import { z } from "zod/v4";

import { canonicalSafeErrorText } from "#canonical-chat-primitives";
import {
  CollaborationActorIdSchema,
  CollaborationIdSchema,
  CollaborationOrganizationIdSchema,
  CollaborationParticipantSchema,
  CollaborationRevisionSchema,
} from "#collaboration";
import { boundedDisplayText, byteLength } from "#legacy-contract-primitives";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const AppIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const VersionSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

function boundedJson(maxBytes: number) {
  return z.json().refine((value) => byteLength(JSON.stringify(value)) <= maxBytes, {
    message: "JSON value exceeds byte limit",
  });
}

export const CollaborativeAppBuildRefSchema = z.object({
  appId: AppIdSchema,
  catalogId: CollaborationIdSchema,
  registrationIncarnation: Sha256Schema,
  manifestVersion: VersionSchema,
  buildId: Sha256Schema,
  manifestDigest: Sha256Schema,
  schemaDigest: Sha256Schema,
  assetDigest: Sha256Schema,
  bridgeContractVersion: VersionSchema,
  runtimeAbi: VersionSchema,
}).strict();

export const CollaborativeAppReadinessGateCodeSchema = z.enum([
  "declaration",
  "exact_build",
  "owner_postgres",
  "recipient_launch",
  "participant_identity",
  "two_principal_round_trip",
  "idempotent_retry",
  "conflict_write",
  "change_signal",
  "provider_safety",
  "cleanup",
]);
export const CollaborativeAppReadinessGateResultSchema = z.object({
  code: CollaborativeAppReadinessGateCodeSchema,
  status: z.enum(["passed", "blocked", "failed"]),
  action: canonicalSafeErrorText(256, 1_024).optional(),
}).strict().superRefine((result, context) => {
  if ((result.status === "passed") === (result.action !== undefined)) {
    context.addIssue({ code: "custom", path: ["action"], message: "Only non-passing gates require an action" });
  }
});
export const CollaborativeAppReadinessStatusSchema = z.enum([
  "checking",
  "ready",
  "blocked",
  "stale",
  "failed",
]);
export const CollaborativeAppReadinessSchema = z.object({
  readinessId: CollaborationIdSchema,
  build: CollaborativeAppBuildRefSchema,
  status: CollaborativeAppReadinessStatusSchema,
  revision: CollaborationRevisionSchema,
  checks: z.array(CollaborativeAppReadinessGateResultSchema).max(12),
  verifiedAt: z.iso.datetime().optional(),
  invalidatedAt: z.iso.datetime().optional(),
}).strict().superRefine((readiness, context) => {
  if (new Set(readiness.checks.map((check) => check.code)).size !== readiness.checks.length) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Readiness gates must be unique" });
  }
  if (readiness.status !== "checking" && readiness.status !== "stale" && readiness.checks.length === 0) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Completed readiness requires gate results" });
  }
  if (readiness.status === "ready"
    && (!readiness.verifiedAt || readiness.invalidatedAt || readiness.checks.some((check) => check.status !== "passed"))) {
    context.addIssue({ code: "custom", message: "Ready requires verified passing gates without invalidation" });
  }
  if (readiness.status === "blocked" && !readiness.checks.some((check) => check.status === "blocked")) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Blocked readiness requires a blocked gate" });
  }
  if (readiness.status === "failed" && !readiness.checks.some((check) => check.status === "failed")) {
    context.addIssue({ code: "custom", path: ["checks"], message: "Failed readiness requires a failed gate" });
  }
  if ((readiness.status === "stale") !== (readiness.invalidatedAt !== undefined)) {
    context.addIssue({ code: "custom", path: ["invalidatedAt"], message: "Only stale readiness has an invalidation time" });
  }
});

export const CollaborativeAppShareSchema = z.object({
  scopeId: CollaborationIdSchema,
  organizationId: CollaborationOrganizationIdSchema,
  owner: CollaborationParticipantSchema,
  build: CollaborativeAppBuildRefSchema,
  readinessId: CollaborationIdSchema,
  state: z.enum(["active", "needs_recheck", "stopped"]),
  shareRevision: CollaborationRevisionSchema,
  /** CAS token for owner stop/rebind operations; distinct from app data revision. */
  bindingRevision: CollaborationRevisionSchema,
  dataRevision: CollaborationRevisionSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
}).strict();

export const CollaborativeAppDirectoryItemSchema = z.object({
  scopeId: CollaborationIdSchema,
  runtimeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/),
  organizationId: CollaborationOrganizationIdSchema,
  authorityGeneration: z.number().int().positive(),
  appId: AppIdSchema,
  catalogId: CollaborationIdSchema,
  readinessId: CollaborationIdSchema,
  registrationIncarnation: Sha256Schema,
  buildId: Sha256Schema,
  shareRevision: CollaborationRevisionSchema,
  owner: CollaborationParticipantSchema,
}).strict();

export const CollaborativeAppDirectoryResponseSchema = z.object({
  items: z.array(CollaborativeAppDirectoryItemSchema).max(100),
  nextCursor: z.string().min(1).max(512).optional(),
}).strict();

const SameOriginPathSchema = z.string().min(1).max(1_024).refine((value) => {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("\0")) return false;
  const [path = ""] = value.split(/[?#]/, 1);
  return path.split("/").every((segment) => segment !== "." && segment !== "..");
}, "Expected a confined same-origin path");
export const CollaborativeAppLaunchTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("owner"),
    slug: AppIdSchema,
    registrationIncarnation: Sha256Schema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("shared"),
    scopeId: CollaborationIdSchema,
    organizationId: CollaborationOrganizationIdSchema,
    appId: AppIdSchema,
    catalogId: CollaborationIdSchema,
    buildId: Sha256Schema,
    name: boundedDisplayText(120, 512),
    iconUrl: SameOriginPathSchema.optional(),
    owner: CollaborationParticipantSchema,
    shareRevision: CollaborationRevisionSchema,
  }).strict(),
]);

export const CollaborativeAppLaunchRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedShareRevision: CollaborationRevisionSchema,
  expectedBuildId: Sha256Schema,
}).strict();

export const CollaborativeAppLaunchResponseSchema = z.object({
  target: CollaborativeAppLaunchTargetSchema.refine((target) => target.kind === "shared"),
  launchId: CollaborationIdSchema,
  entryUrl: SameOriginPathSchema,
  expiresAt: z.iso.datetime(),
}).strict();

export const CollaborativeAppParticipantSchema = z.object({
  actorId: CollaborationActorIdSchema,
  displayName: boundedDisplayText(120, 512),
  organizationId: CollaborationOrganizationIdSchema,
  scopeId: CollaborationIdSchema,
  shareRevision: CollaborationRevisionSchema,
  buildId: Sha256Schema,
}).strict();

export const CollaborativeAppMutationRequestSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  action: boundedJson(64 * 1024),
}).strict();
export const CollaborativeAppMutationResponseSchema = z.object({
  result: boundedJson(1024 * 1024),
  revision: CollaborationRevisionSchema,
  replayed: z.boolean(),
}).strict();

export const CollaborativeAppChangeSignalSchema = z.object({
  type: z.enum(["resource.app.changed", "share.access_ended", "share.needs_recheck", "refresh_required"]),
  eventId: CollaborationIdSchema,
  scopeSequence: CollaborationRevisionSchema,
  scopeId: CollaborationIdSchema,
  appId: AppIdSchema,
  buildId: Sha256Schema,
  revision: CollaborationRevisionSchema,
  occurredAt: z.iso.datetime(),
}).strict();

export const CollaborativeAppSafeErrorCodeSchema = z.enum([
  "invalid_request",
  "not_found",
  "conflict",
  "host_offline",
  "access_ended",
  "needs_recheck",
  "unavailable",
  "rate_limited",
]);
export const CollaborativeAppSafeErrorSchema = z.object({
  code: CollaborativeAppSafeErrorCodeSchema,
  safeMessage: canonicalSafeErrorText(180, 720),
  retryable: z.boolean(),
}).strict();

export type CollaborativeAppBuildRef = z.infer<typeof CollaborativeAppBuildRefSchema>;
export type CollaborativeAppReadiness = z.infer<typeof CollaborativeAppReadinessSchema>;
export type CollaborativeAppShare = z.infer<typeof CollaborativeAppShareSchema>;
export type CollaborativeAppDirectoryItem = z.infer<typeof CollaborativeAppDirectoryItemSchema>;
export type CollaborativeAppLaunchTarget = z.infer<typeof CollaborativeAppLaunchTargetSchema>;
export type CollaborativeAppLaunchRequest = z.infer<typeof CollaborativeAppLaunchRequestSchema>;
export type CollaborativeAppLaunchResponse = z.infer<typeof CollaborativeAppLaunchResponseSchema>;
export type CollaborativeAppParticipant = z.infer<typeof CollaborativeAppParticipantSchema>;
export type CollaborativeAppMutationRequest = z.infer<typeof CollaborativeAppMutationRequestSchema>;
export type CollaborativeAppMutationResponse = z.infer<typeof CollaborativeAppMutationResponseSchema>;
export type CollaborativeAppChangeSignal = z.infer<typeof CollaborativeAppChangeSignalSchema>;
export type CollaborativeAppSafeError = z.infer<typeof CollaborativeAppSafeErrorSchema>;
