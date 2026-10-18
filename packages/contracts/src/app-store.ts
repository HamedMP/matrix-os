import { z } from "zod/v4";

/** App Store wire contracts (spec 631). Dependency-free besides zod so bundled apps can snapshot it. */

export const APP_STORE_SLUG_PATTERN = /^[a-z][a-z0-9-]{2,47}$/;
export const APP_STORE_CATEGORIES = [
  "productivity", "finance", "health", "education", "social", "games",
  "utilities", "developer", "business", "lifestyle",
] as const;
export const APP_STORE_LICENSES = ["MIT", "Apache-2.0", "BSD-3-Clause", "MPL-2.0", "GPL-3.0-only", "AGPL-3.0-only"] as const;
export const APP_STORE_PERMISSIONS = ["ai"] as const;
export const APP_STORE_VERSION_STATUSES = [
  "awaiting_upload", "scanning", "scan_failed", "in_review", "changes_requested", "rejected",
  "published", "superseded", "withdrawn",
] as const;
export const APP_STORE_LISTING_STATUSES = ["pending", "live", "delisted", "suspended"] as const;
export const APP_STORE_ERROR_CODES = ["invalid", "unauthorized", "forbidden", "not_found", "conflict", "limit", "unavailable"] as const;
export const APP_STORE_COLUMN_TYPES = [
  "text", "string", "boolean", "bool", "integer", "int", "float", "number",
  "date", "timestamptz", "timestamp", "json", "jsonb", "uuid",
] as const;
export const APP_STORE_MAX_SOURCE_BUNDLE_BYTES = 16 * 1024 * 1024;
export const APP_STORE_FIXED_BUILD = {
  install: "pnpm install --frozen-lockfile --ignore-scripts",
  command: "pnpm exec vite build --base ./ --outDir dist",
  output: "dist",
} as const;

const COLUMN_TYPE_CANONICAL: Record<string, string> = {
  text: "text", string: "text", boolean: "boolean", bool: "boolean", integer: "integer", int: "integer",
  float: "float", number: "float", date: "date", timestamptz: "timestamptz", timestamp: "timestamptz",
  json: "jsonb", jsonb: "jsonb", uuid: "uuid",
};

const SAFE_TEXT = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const text = (min: number, max: number) => z.string().trim().min(min).max(max).regex(SAFE_TEXT);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const Timestamp = z.string().min(10).max(40);
const Identifier = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
const ServiceId = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);
const ActionId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const BundlePath = z.string().min(1).max(240).regex(/^[A-Za-z0-9._@+/-]+$/);

export const AppStoreSlugSchema = z.string().regex(APP_STORE_SLUG_PATTERN);
export const AppStoreIdSchema = z.uuid();
export const AppStoreSemverSchema = z.string().regex(/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/);
export const AppStoreCategorySchema = z.enum(APP_STORE_CATEGORIES);
export const AppStoreLicenseSchema = z.enum(APP_STORE_LICENSES);
export const AppStoreVersionStatusSchema = z.enum(APP_STORE_VERSION_STATUSES);
export const AppStoreListingStatusSchema = z.enum(APP_STORE_LISTING_STATUSES);
export const AppStoreErrorCodeSchema = z.enum(APP_STORE_ERROR_CODES);
export const AppStoreErrorSchema = z.strictObject({ error: AppStoreErrorCodeSchema });
export const AppStoreSha256Schema = Sha256;

// ---------------------------------------------------------------- manifest

export const AppStoreServiceDeclSchema = z.strictObject({
  service: ServiceId,
  actions: z.array(ActionId).min(1).max(16).refine(a => new Set(a).size === a.length, "Duplicate action"),
});
export const AppStoreIntegrationsSchema = z.strictObject({
  required: z.array(AppStoreServiceDeclSchema).max(8).default([]),
  optional: z.array(AppStoreServiceDeclSchema).max(8).default([]),
}).superRefine((value, ctx) => {
  const all = [...value.required, ...value.optional].map(s => s.service);
  if (all.length > 8) ctx.addIssue({ code: "custom", message: "At most eight integrations" });
  if (new Set(all).size !== all.length) ctx.addIssue({ code: "custom", message: "Duplicate integration" });
});

const StorageTableSchema = z.strictObject({
  columns: z.record(Identifier, z.enum(APP_STORE_COLUMN_TYPES)).refine(c => Object.keys(c).length <= 64, "Too many columns"),
  indexes: z.array(Identifier).max(16).optional(),
  uniqueIndexes: z.array(Identifier).max(16).optional(),
}).superRefine((table, ctx) => {
  for (const column of [...(table.indexes ?? []), ...(table.uniqueIndexes ?? [])]) {
    if (!(column in table.columns)) ctx.addIssue({ code: "custom", message: "Index column is not declared" });
  }
});
export const AppStoreStorageSchema = z.strictObject({
  tables: z.record(Identifier, StorageTableSchema).refine(t => Object.keys(t).length <= 16, "Too many tables"),
});
export type AppStoreStorage = z.infer<typeof AppStoreStorageSchema>;

export const AppStoreManifestSchema = z.strictObject({
  name: text(1, 60),
  slug: z.string().max(64).optional(),
  description: text(1, 240),
  version: AppStoreSemverSchema,
  runtime: z.literal("vite"),
  runtimeVersion: z.string().max(20).optional(),
  scope: z.literal("personal").optional(),
  category: z.string().max(40).optional(),
  icon: z.string().max(64).optional(),
  author: z.string().max(80).optional(),
  database: z.literal("postgres").optional(),
  build: z.strictObject({
    install: z.string().max(200).optional(),
    command: z.string().max(200),
    output: z.literal("dist"),
    timeout: z.number().int().positive().max(600).optional(),
    sourceGlobs: z.array(z.string().max(120)).max(16).optional(),
  }).optional(),
  integrations: AppStoreIntegrationsSchema.optional(),
  permissions: z.array(z.enum(APP_STORE_PERMISSIONS)).max(APP_STORE_PERMISSIONS.length)
    .refine(p => new Set(p).size === p.length, "Duplicate permission").default([]),
  storage: AppStoreStorageSchema.optional(),
});
export type AppStoreManifest = z.infer<typeof AppStoreManifestSchema>;

export const AppStoreCapabilitiesSchema = z.strictObject({
  integrations: z.strictObject({
    required: z.array(AppStoreServiceDeclSchema).max(8),
    optional: z.array(AppStoreServiceDeclSchema).max(8),
  }),
  permissions: z.array(z.enum(APP_STORE_PERMISSIONS)),
  tables: z.array(z.strictObject({ name: Identifier, columns: z.array(Identifier).max(64) })).max(16),
});
export type AppStoreCapabilities = z.infer<typeof AppStoreCapabilitiesSchema>;

const byService = (a: { service: string }, b: { service: string }) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0);
const sortDecls = (decls: readonly { service: string; actions: readonly string[] }[]) =>
  decls.map(d => ({ service: d.service, actions: [...d.actions].sort() })).sort(byService);

export function deriveAppStoreCapabilities(manifest: AppStoreManifest): AppStoreCapabilities {
  return {
    integrations: {
      required: sortDecls(manifest.integrations?.required ?? []),
      optional: sortDecls(manifest.integrations?.optional ?? []),
    },
    permissions: [...manifest.permissions].sort(),
    tables: Object.entries(manifest.storage?.tables ?? {})
      .map(([name, table]) => ({ name, columns: Object.keys(table.columns).sort() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the canonical capabilities; WebCrypto so Node and bundled apps agree. */
export async function capabilitiesDigest(capabilities: AppStoreCapabilities): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(capabilities));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

export function compareStoreStorage(
  previous: AppStoreStorage | undefined,
  next: AppStoreStorage | undefined,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const [table, definition] of Object.entries(previous?.tables ?? {})) {
    const nextTable = next?.tables[table];
    if (!nextTable) { issues.push(`table_removed:${table}`); continue; }
    for (const [column, type] of Object.entries(definition.columns)) {
      const nextType = nextTable.columns[column];
      if (!nextType) issues.push(`column_removed:${table}.${column}`);
      else if (COLUMN_TYPE_CANONICAL[nextType] !== COLUMN_TYPE_CANONICAL[type]) issues.push(`column_type_changed:${table}.${column}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  if (!AppStoreSemverSchema.safeParse(version).success) return null;
  const [major, minor, patch] = version.split(".").map(Number);
  return { major, minor, patch };
}

export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error("Invalid semver");
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

// ---------------------------------------------------------------- reports

export const AppStoreScanFindingSchema = z.strictObject({
  rule: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/),
  category: z.enum(["secret", "personal", "owner_config", "unsafe_code", "manifest", "policy"]),
  severity: z.enum(["high", "medium", "low"]),
  file: BundlePath,
  line: z.number().int().positive().optional(),
  message: text(1, 200),
});
export type AppStoreScanFinding = z.infer<typeof AppStoreScanFindingSchema>;
export const AppStoreScanReportSchema = z.strictObject({
  findings: z.array(AppStoreScanFindingSchema).max(500),
  truncated: z.boolean(),
  blocking: z.boolean(),
});
export type AppStoreScanReport = z.infer<typeof AppStoreScanReportSchema>;

export const AppStoreChangeCategorySchema = z.enum(["secret", "personal", "account", "data", "branding", "config", "manifest", "other"]);
export const AppStoreGeneralizationReportSchema = z.strictObject({
  ai: z.enum(["completed", "unavailable", "failed"]),
  changes: z.array(z.strictObject({ category: AppStoreChangeCategorySchema, file: BundlePath, summary: text(1, 300) })).max(200),
  notes: text(0, 2000).optional(),
});
export type AppStoreGeneralizationReport = z.infer<typeof AppStoreGeneralizationReportSchema>;

// ---------------------------------------------------------------- catalog

export const AppStoreCatalogQuerySchema = z.strictObject({
  q: text(1, 80).optional(),
  category: AppStoreCategorySchema.optional(),
  sort: z.enum(["popular", "rating", "new"]).default("popular"),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
});
export type AppStoreCatalogQuery = z.infer<typeof AppStoreCatalogQuerySchema>;

const Metrics = {
  installCount: z.number().int().nonnegative(),
  activeInstallCount: z.number().int().nonnegative(),
  ratingAverage: z.number().min(1).max(5).nullable(),
  ratingCount: z.number().int().nonnegative(),
};

export const AppStoreListingSummarySchema = z.strictObject({
  id: AppStoreIdSchema,
  slug: AppStoreSlugSchema,
  name: text(1, 60),
  tagline: text(1, 100),
  category: AppStoreCategorySchema,
  status: AppStoreListingStatusSchema,
  publisher: z.strictObject({ handle: z.string().min(1).max(64) }),
  version: AppStoreSemverSchema.nullable(),
  hasIcon: z.boolean(),
  integrations: z.array(z.strictObject({ service: ServiceId, optional: z.boolean() })).max(8),
  updatedAt: Timestamp,
  ...Metrics,
});
export type AppStoreListingSummary = z.infer<typeof AppStoreListingSummarySchema>;
export const AppStoreCatalogPageSchema = z.strictObject({
  listings: z.array(AppStoreListingSummarySchema).max(50),
  nextCursor: z.string().max(200).optional(),
});

export const AppStoreListingDetailSchema = AppStoreListingSummarySchema.extend({
  description: text(1, 2000),
  currentVersion: z.strictObject({
    id: AppStoreIdSchema, version: AppStoreSemverSchema, changelog: text(0, 2000),
    license: AppStoreLicenseSchema, publishedAt: Timestamp,
  }).nullable(),
  capabilities: AppStoreCapabilitiesSchema.nullable(),
  capabilitiesDigest: Sha256.nullable(),
  myRating: z.number().int().min(1).max(5).nullable(),
  myInstall: z.strictObject({ versionId: AppStoreIdSchema, version: AppStoreSemverSchema, active: z.boolean() }).nullable(),
  isPublisher: z.boolean(),
  notice: z.enum(["removed"]).optional(),
});
export type AppStoreListingDetail = z.infer<typeof AppStoreListingDetailSchema>;

const ObjectRef = z.strictObject({ url: z.url().max(4096), sha256: Sha256, size: z.number().int().positive() });
export const AppStoreDownloadRequestSchema = z.strictObject({ versionId: AppStoreIdSchema });
export const AppStoreDownloadGrantSchema = z.strictObject({
  versionId: AppStoreIdSchema,
  version: AppStoreSemverSchema,
  source: ObjectRef,
  approval: z.strictObject({ keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) }),
  capabilities: AppStoreCapabilitiesSchema,
  capabilitiesDigest: Sha256,
  manifest: AppStoreManifestSchema,
});
export type AppStoreDownloadGrant = z.infer<typeof AppStoreDownloadGrantSchema>;

export const AppStoreInstallStateSchema = z.strictObject({
  installed: z.boolean(),
  versionId: AppStoreIdSchema.nullable(),
  installCount: Metrics.installCount,
  activeInstallCount: Metrics.activeInstallCount,
});
export const AppStoreRatingInputSchema = z.strictObject({ stars: z.number().int().min(1).max(5) });
export const AppStoreRatingStateSchema = z.strictObject({
  myRating: z.number().int().min(1).max(5).nullable(),
  ratingAverage: Metrics.ratingAverage,
  ratingCount: Metrics.ratingCount,
});
export type AppStoreRatingState = z.infer<typeof AppStoreRatingStateSchema>;
export const AppStoreStatusSchema = z.strictObject({
  enabled: z.boolean(), reviewer: z.boolean(),
  generalizer: z.strictObject({ available: z.boolean(), label: text(1, 120), accessSourceId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).optional(),
  signingKeys: z.array(z.strictObject({ keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), publicKey: z.string().min(1).max(1024) })).max(4).default([]),
});
export type AppStoreStatus = z.infer<typeof AppStoreStatusSchema>;

// ---------------------------------------------------------------- submissions

export const AppStoreListingInputSchema = z.strictObject({
  slug: AppStoreSlugSchema,
  name: text(1, 60),
  tagline: text(1, 100),
  description: text(1, 2000),
  category: AppStoreCategorySchema,
});
export type AppStoreListingInput = z.infer<typeof AppStoreListingInputSchema>;

export const AppStoreCreateSubmissionSchema = z.strictObject({
  submissionKey: z.string().regex(/^[a-z0-9][a-z0-9:._-]{7,199}$/),
  listing: AppStoreListingInputSchema,
  version: AppStoreSemverSchema,
  changelog: text(0, 2000),
  license: AppStoreLicenseSchema,
  manifest: z.unknown(),
  source: z.strictObject({ sha256: Sha256, size: z.number().int().positive().max(APP_STORE_MAX_SOURCE_BUNDLE_BYTES) }),
  generalizationReport: AppStoreGeneralizationReportSchema,
});
export type AppStoreCreateSubmission = z.infer<typeof AppStoreCreateSubmissionSchema>;
export const AppStoreCreateSubmissionResultSchema = z.strictObject({
  versionId: AppStoreIdSchema,
  status: AppStoreVersionStatusSchema,
  upload: z.strictObject({ url: z.url().max(4096), expiresAt: Timestamp }).optional(),
});

export const AppStoreSubmissionSummarySchema = z.strictObject({
  versionId: AppStoreIdSchema,
  listingId: AppStoreIdSchema,
  listingSlug: AppStoreSlugSchema,
  name: text(1, 60),
  version: AppStoreSemverSchema,
  status: AppStoreVersionStatusSchema,
  reviewerMessage: text(0, 2000).nullable(),
  scan: z.strictObject({ blocking: z.boolean(), findingCount: z.number().int().nonnegative() }).nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AppStoreSubmissionSummary = z.infer<typeof AppStoreSubmissionSummarySchema>;
export const AppStorePublisherListingSchema = z.strictObject({
  id: AppStoreIdSchema,
  slug: AppStoreSlugSchema,
  name: text(1, 60),
  status: AppStoreListingStatusSchema,
  currentVersion: AppStoreSemverSchema.nullable(),
  ...Metrics,
});
export type AppStorePublisherListing = z.infer<typeof AppStorePublisherListingSchema>;
export const AppStoreSubmissionsPageSchema = z.strictObject({
  submissions: z.array(AppStoreSubmissionSummarySchema).max(100),
  listings: z.array(AppStorePublisherListingSchema).max(100),
  nextCursor: z.string().max(200).optional(),
});

// ---------------------------------------------------------------- review

export const AppStoreReviewQueueQuerySchema = z.strictObject({
  status: z.enum(["in_review", "changes_requested"]).default("in_review"),
  cursor: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).optional(),
});
export const AppStoreReviewQueueItemSchema = z.strictObject({
  versionId: AppStoreIdSchema,
  listingId: AppStoreIdSchema,
  listingSlug: AppStoreSlugSchema,
  name: text(1, 60),
  version: AppStoreSemverSchema,
  status: AppStoreVersionStatusSchema,
  publisherHandle: z.string().min(1).max(64),
  isUpdate: z.boolean(),
  submittedAt: Timestamp,
  updatedAt: Timestamp,
  scan: z.strictObject({ blocking: z.boolean(), high: z.number().int().nonnegative(), medium: z.number().int().nonnegative(), low: z.number().int().nonnegative() }),
  integrationCount: z.number().int().nonnegative(),
});
export type AppStoreReviewQueueItem = z.infer<typeof AppStoreReviewQueueItemSchema>;
export const AppStoreReviewQueuePageSchema = z.strictObject({
  items: z.array(AppStoreReviewQueueItemSchema).max(50),
  nextCursor: z.string().max(200).optional(),
});

export const AppStoreReviewFileEntrySchema = z.strictObject({
  path: BundlePath, size: z.number().int().nonnegative(), sha256: Sha256,
  change: z.enum(["added", "modified", "unchanged"]),
});
export const AppStoreModerationEventSchema = z.strictObject({
  action: z.string().regex(/^[a-z_]{2,40}$/),
  actorKind: z.enum(["reviewer", "publisher", "system"]),
  message: text(0, 2000).nullable(),
  createdAt: Timestamp,
});
export const AppStoreReviewDetailSchema = z.strictObject({
  item: AppStoreReviewQueueItemSchema,
  listing: z.strictObject({
    id: AppStoreIdSchema, slug: AppStoreSlugSchema, status: AppStoreListingStatusSchema,
    currentVersion: AppStoreSemverSchema.nullable(),
  }),
  proposed: AppStoreListingInputSchema.omit({ slug: true }).extend({ changelog: text(0, 2000), license: AppStoreLicenseSchema }),
  capabilities: AppStoreCapabilitiesSchema,
  previousCapabilities: AppStoreCapabilitiesSchema.nullable(),
  scanReport: AppStoreScanReportSchema.nullable(),
  generalizationReport: AppStoreGeneralizationReportSchema,
  files: z.array(AppStoreReviewFileEntrySchema).max(512),
  removedFiles: z.array(BundlePath).max(512),
  events: z.array(AppStoreModerationEventSchema).max(100),
});
export type AppStoreReviewDetail = z.infer<typeof AppStoreReviewDetailSchema>;
export const AppStoreReviewFileQuerySchema = z.strictObject({ path: BundlePath, previous: z.enum(["1"]).optional() });
export const AppStoreReviewFileSchema = z.strictObject({
  path: BundlePath, size: z.number().int().nonnegative(), binary: z.boolean(), truncated: z.boolean(),
  text: z.string().max(512 * 1024).optional(),
});

const ReviewerMessage = text(1, 2000);
export const AppStoreReviewDecisionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("approve"), message: text(0, 2000).optional() }),
  z.strictObject({ type: z.literal("request_changes"), message: ReviewerMessage }),
  z.strictObject({ type: z.literal("reject"), message: ReviewerMessage }),
]);
export type AppStoreReviewDecision = z.infer<typeof AppStoreReviewDecisionSchema>;
export const AppStoreListingActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("delist"), message: ReviewerMessage }),
  z.strictObject({ type: z.literal("suspend"), message: ReviewerMessage }),
  z.strictObject({ type: z.literal("reinstate"), message: ReviewerMessage }),
]);
export type AppStoreListingAction = z.infer<typeof AppStoreListingActionSchema>;

