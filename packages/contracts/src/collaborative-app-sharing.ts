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
  // Legacy persisted blocker from the pre-capability verifier. New proofs do
  // not emit it, but repositories must continue decoding saved rows.
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

const SameOriginPathSchema = z.string().min(1).max(1_024).refine((value) => {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("\0")) return false;
  const [path = ""] = value.split(/[?#]/, 1);
  return path.split("/").every((segment) => segment !== "." && segment !== "..");
}, "Expected a confined same-origin path");

/**
 * Owner artwork: raster images, or SVG without active content. SVG is additionally served
 * sandboxed with `nosniff` and rendered by clients only through <img>.
 */
export const COLLABORATIVE_APP_ARTWORK_MAX_BYTES = 4 * 1024 * 1024;
export const CollaborativeAppArtworkContentTypeSchema = z.enum(["image/png", "image/webp", "image/jpeg", "image/svg+xml"]);
export type CollaborativeAppArtworkContentType = z.infer<typeof CollaborativeAppArtworkContentTypeSchema>;

/** The content type proven by the bytes themselves; never trust a filename or a declared header. */
export function sniffCollaborativeAppArtworkContentType(bytes: Uint8Array): CollaborativeAppArtworkContentType | null {
  const startsWith = (signature: readonly number[], offset = 0) =>
    bytes.byteLength >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return isInertSvg(bytes) ? "image/svg+xml" : null;
}

/** Anything that could run script, embed documents, or expand entities disqualifies the file. */
const SVG_ACTIVE_CONTENT = /<\s*(?:script|foreignObject|iframe|embed|object|handler|listener)\b|\son[a-z]+\s*=|javascript:|<!ENTITY/i;

function isInertSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  return hasSvgRoot(text) && !SVG_ACTIVE_CONTENT.test(text);
}

/**
 * An `<svg>` root, optionally after an XML declaration, comments, and a doctype without an
 * internal subset. A forward-only scan: every step advances, so hostile input stays linear.
 */
function hasSvgRoot(text: string): boolean {
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipWhitespace = () => {
    while (index < text.length && /\s/.test(text[index]!)) index += 1;
  };
  skipWhitespace();
  if (text.startsWith("<?xml", index)) {
    const end = text.indexOf("?>", index + 5);
    if (end < 0) return false;
    index = end + 2;
    skipWhitespace();
  }
  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const end = text.indexOf("-->", index + 4);
      if (end < 0) return false;
      index = end + 3;
    } else if (/^<!DOCTYPE\s+svg\b/i.test(text.slice(index, index + 16))) {
      const end = text.indexOf(">", index);
      if (end < 0 || text.slice(index, end).includes("[")) return false;
      index = end + 1;
    } else {
      break;
    }
    skipWhitespace();
  }
  return /^<svg[\s>/]/i.test(text.slice(index, index + 5));
}

/** Owner home -> platform: the display name and artwork digest the owner's own launcher shows. */
export const CollaborativeAppPresentationPublishSchema = z.object({
  appId: AppIdSchema,
  name: boundedDisplayText(120, 512),
  artwork: z.object({
    sha256: Sha256Schema,
    contentType: CollaborativeAppArtworkContentTypeSchema,
    byteLength: z.number().int().positive().max(COLLABORATIVE_APP_ARTWORK_MAX_BYTES),
  }).strict().nullable(),
}).strict();
export const CollaborativeAppPresentationPublishResponseSchema = z.object({
  artworkRequired: z.boolean(),
}).strict();

/** The member-gated, digest-bound artwork path; a changed icon always gets a new URL. */
export function collaborativeAppArtworkPath(scopeId: string, sha256: string): string {
  return `/api/collaboration/shared-apps/${CollaborationIdSchema.parse(scopeId)}/artwork/${Sha256Schema.parse(sha256)}`;
}

/**
 * Optional so released platforms stay readable. The platform only sends it on
 * request (`presentation=1`) because released clients parse items strictly.
 */
export const CollaborativeAppDirectoryPresentationSchema = z.object({
  name: boundedDisplayText(120, 512),
  iconUrl: SameOriginPathSchema.optional(),
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
  presentation: CollaborativeAppDirectoryPresentationSchema.optional(),
}).strict();

export const CollaborativeAppDirectoryResponseSchema = z.object({
  items: z.array(CollaborativeAppDirectoryItemSchema).max(100),
  nextCursor: z.string().min(1).max(512).optional(),
}).strict();

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
export const CollaborativeAppQueryResponseSchema = z.object({
  result: boundedJson(1024 * 1024),
  revision: CollaborationRevisionSchema,
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
export type CollaborativeAppDirectoryPresentation = z.infer<typeof CollaborativeAppDirectoryPresentationSchema>;
export type CollaborativeAppPresentationPublish = z.infer<typeof CollaborativeAppPresentationPublishSchema>;
export type CollaborativeAppLaunchTarget = z.infer<typeof CollaborativeAppLaunchTargetSchema>;
export type CollaborativeAppLaunchRequest = z.infer<typeof CollaborativeAppLaunchRequestSchema>;
export type CollaborativeAppLaunchResponse = z.infer<typeof CollaborativeAppLaunchResponseSchema>;
export type CollaborativeAppParticipant = z.infer<typeof CollaborativeAppParticipantSchema>;
export type CollaborativeAppMutationRequest = z.infer<typeof CollaborativeAppMutationRequestSchema>;
export type CollaborativeAppMutationResponse = z.infer<typeof CollaborativeAppMutationResponseSchema>;
export type CollaborativeAppChangeSignal = z.infer<typeof CollaborativeAppChangeSignalSchema>;
export type CollaborativeAppSafeError = z.infer<typeof CollaborativeAppSafeErrorSchema>;
