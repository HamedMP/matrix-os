import { z } from "zod/v4";
import {
  AppStoreCapabilitiesSchema,
  AppStoreCategorySchema,
  AppStoreGeneralizationReportSchema,
  AppStoreIdSchema,
  AppStoreLicenseSchema,
  AppStoreListingDetailSchema,
  AppStoreListingSummarySchema,
  AppStoreScanReportSchema,
  AppStoreSemverSchema,
  AppStoreSha256Schema,
  AppStoreSlugSchema,
  AppStoreVersionStatusSchema,
} from "./app-store.js";

/** Gateway-only App Store contracts (spec 631): publishing drafts and local install state. */

const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(SAFE_TEXT);
const Timestamp = z.string().min(10).max(40);
const BundlePath = z.string().min(1).max(240).regex(/^[A-Za-z0-9._@+/-]+$/);

/** Owner app folder names follow the gateway SAFE_SLUG rule. */
export const OwnerAppSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const APP_STORE_DRAFT_STATUSES = ["preparing", "ready", "needs_attention", "failed", "submitting", "submitted"] as const;
export const APP_STORE_DRAFT_STAGES = ["snapshot", "scan", "generalize", "verify", "package", "upload"] as const;
export const APP_STORE_DRAFT_FAILURES = [
  "interrupted", "snapshot_failed", "source_changed", "limits_exceeded", "outside_import", "unsupported_app",
  "generalize_failed", "verify_failed", "build_failed", "upload_failed", "submit_rejected", "slug_taken",
  "version_not_newer", "unavailable",
] as const;

export const AppStoreDraftStatusSchema = z.enum(APP_STORE_DRAFT_STATUSES);
export const AppStoreDraftStageSchema = z.enum(APP_STORE_DRAFT_STAGES);
export const AppStoreDraftFailureSchema = z.enum(APP_STORE_DRAFT_FAILURES);

export const AppStorePublishableAppSchema = z.strictObject({
  slug: OwnerAppSlugSchema,
  name: text(1, 120),
  description: text(0, 500).optional(),
  icon: z.string().max(64).optional(),
  eligible: z.boolean(),
  reason: z.enum(["bundled", "community", "invalid_manifest", "unsupported_runtime"]).optional(),
});
export type AppStorePublishableApp = z.infer<typeof AppStorePublishableAppSchema>;

export const AppStoreListingDraftSchema = z.strictObject({
  slug: AppStoreSlugSchema,
  name: text(1, 60),
  tagline: text(1, 100),
  description: text(1, 2000),
  category: AppStoreCategorySchema,
  version: AppStoreSemverSchema,
  changelog: text(0, 2000),
});
export type AppStoreListingDraft = z.infer<typeof AppStoreListingDraftSchema>;
export const AppStoreListingDraftPatchSchema = AppStoreListingDraftSchema.partial().refine(
  value => Object.keys(value).length > 0, "Empty patch",
);

export const AppStoreDraftSummarySchema = z.strictObject({
  id: AppStoreIdSchema,
  sourceSlug: OwnerAppSlugSchema,
  sourceName: text(1, 120),
  status: AppStoreDraftStatusSchema,
  stage: AppStoreDraftStageSchema,
  failureCode: AppStoreDraftFailureSchema.optional(),
  ai: z.enum(["completed", "unavailable", "failed"]).nullable(),
  blockingFindings: z.number().int().nonnegative(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: Timestamp,
  submission: z.strictObject({
    listingSlug: AppStoreSlugSchema,
    version: AppStoreSemverSchema,
    versionId: AppStoreIdSchema,
    status: AppStoreVersionStatusSchema,
  }).optional(),
});
export type AppStoreDraftSummary = z.infer<typeof AppStoreDraftSummarySchema>;

export const AppStoreDraftDetailSchema = AppStoreDraftSummarySchema.extend({
  findingsBefore: AppStoreScanReportSchema.nullable(),
  findingsAfter: AppStoreScanReportSchema.nullable(),
  report: AppStoreGeneralizationReportSchema.nullable(),
  listing: AppStoreListingDraftSchema.nullable(),
  capabilities: AppStoreCapabilitiesSchema.nullable(),
  changedFiles: z.array(z.strictObject({ path: BundlePath, change: z.enum(["added", "removed", "modified"]) })).max(512),
});
export type AppStoreDraftDetail = z.infer<typeof AppStoreDraftDetailSchema>;

export const AppStoreDraftDiffQuerySchema = z.strictObject({ path: BundlePath });
export const AppStoreDraftDiffSchema = z.strictObject({
  path: BundlePath,
  change: z.enum(["added", "removed", "modified", "unchanged"]),
  binary: z.boolean(),
  truncated: z.boolean(),
  before: z.string().max(256 * 1024).optional(),
  after: z.string().max(256 * 1024).optional(),
});
export type AppStoreDraftDiff = z.infer<typeof AppStoreDraftDiffSchema>;

const AiConsentSchema = z.strictObject({ accessSourceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) });
export const AppStoreCreateDraftSchema = z.strictObject({ app: OwnerAppSlugSchema, aiConsent: AiConsentSchema.optional() });
export const AppStoreReviseDraftSchema = z.strictObject({ instructions: text(1, 1000), aiConsent: AiConsentSchema.optional() });
export const AppStoreGatewayRatingInputSchema = z.strictObject({ stars: z.number().int().min(1).max(5).nullable() });
export const AppStoreSubmitDraftSchema = z.strictObject({ consent: z.literal(true), license: AppStoreLicenseSchema });

export const AppStoreInstallRequestSchema = z.strictObject({
  versionId: AppStoreIdSchema,
  consent: z.strictObject({ capabilitiesDigest: AppStoreSha256Schema }),
});
export type AppStoreInstallRequest = z.infer<typeof AppStoreInstallRequestSchema>;
export const AppStoreInstallJobSchema = z.strictObject({
  id: AppStoreIdSchema,
  status: z.enum(["queued", "building", "installed", "failed"]),
  error: z.enum(["unavailable", "build_failed", "invalid"]).optional(),
  appSlug: OwnerAppSlugSchema.optional(),
  launchPath: z.string().max(200).optional(),
});
export type AppStoreInstallJob = z.infer<typeof AppStoreInstallJobSchema>;

export const AppStoreLocalInstallResultSchema = z.strictObject({
  status: z.enum(["installed", "updated", "already_installed"]),
  appSlug: OwnerAppSlugSchema,
  launchPath: z.string().max(200),
});
export type AppStoreLocalInstallResult = z.infer<typeof AppStoreLocalInstallResultSchema>;

export const AppStoreLocalStateSchema = z.strictObject({
  installed: z.boolean(),
  appSlug: OwnerAppSlugSchema.optional(),
  launchPath: z.string().max(200).optional(),
  versionId: AppStoreIdSchema.optional(),
  version: AppStoreSemverSchema.optional(),
  updateAvailable: z.boolean(),
});
export type AppStoreLocalState = z.infer<typeof AppStoreLocalStateSchema>;

export const AppStoreGatewayListingSummarySchema = AppStoreListingSummarySchema.extend({ local: AppStoreLocalStateSchema });
export type AppStoreGatewayListingSummary = z.infer<typeof AppStoreGatewayListingSummarySchema>;
export const AppStoreGatewayCatalogPageSchema = z.strictObject({
  listings: z.array(AppStoreGatewayListingSummarySchema).max(50),
  nextCursor: z.string().max(200).optional(),
});
export const AppStoreGatewayListingDetailSchema = AppStoreListingDetailSchema.extend({ local: AppStoreLocalStateSchema });
export type AppStoreGatewayListingDetail = z.infer<typeof AppStoreGatewayListingDetailSchema>;

/** Gateway-owned provenance for community installs (`~/system/app-store/installs.json`). */
export const AppStoreInstallRecordSchema = z.strictObject({
  listingSlug: AppStoreSlugSchema,
  appSlug: OwnerAppSlugSchema,
  versionId: AppStoreIdSchema,
  version: AppStoreSemverSchema,
  sourceSha256: AppStoreSha256Schema,
  installedSourceSha256: AppStoreSha256Schema,
  toolchain: z.strictObject({
    nodeVersion: z.string().min(1).max(40), pnpmVersion: z.string().min(1).max(40), policyDigest: AppStoreSha256Schema,
  }),
  distSha256: AppStoreSha256Schema,
  capabilities: AppStoreCapabilitiesSchema,
  installedAt: Timestamp,
  updatedAt: Timestamp,
});
export type AppStoreInstallRecord = z.infer<typeof AppStoreInstallRecordSchema>;
export const AppStoreProvenanceFileSchema = z.strictObject({
  version: z.literal(1),
  installs: z.array(AppStoreInstallRecordSchema).max(500),
});
export type AppStoreProvenanceFile = z.infer<typeof AppStoreProvenanceFileSchema>;
