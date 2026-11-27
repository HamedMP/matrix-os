import { z } from "zod/v4";

// Queueing, install, build, snapshot and activation share one server budget.
// Proxy/client margins leave time to return the known result before their aborts.
export const SITE_PUBLISH_TIMEOUT_MS = 270_000;
export const SITE_PUBLISH_PROXY_TIMEOUT_MS = SITE_PUBLISH_TIMEOUT_MS + 15_000;
export const SITE_PUBLISH_CLIENT_TIMEOUT_MS = SITE_PUBLISH_PROXY_TIMEOUT_MS + 15_000;
export const SITE_MAX_FILES = 200;
export const SITE_MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
export const SITE_MAX_FORM_BYTES = 16 * 1024;
export const SITE_MAX_EMAIL_INVITES = 100;
export const SITE_ACCESS_LINK_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SITE_VIEWER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SITE_MANAGEMENT_CONTRACT_VERSION_HEADER = "x-matrix-sites-contract-version";
export const SITE_MANAGEMENT_CONTRACT_VERSION = "3";
/**
 * Sent only on the owner readiness read: this Gateway can show allowlist mode
 * (`emailDelivery: "none"`). Ordinary Sites calls stay on contract 3 so a Platform
 * that predates allowlist mode keeps accepting publish and metadata edits.
 */
export const SITE_ALLOWLIST_READINESS_VERSION = "4";
/** Matrix.page top-level routes a friendly path can never claim. */
export const SITE_RESERVED_SLUGS = ["api", "public", "assets", "frame", "forms", "preview", "admin", "auth", "health", "robots", "favicon", "index", "sites", "www"] as const;
const reserved: ReadonlySet<string> = new Set(SITE_RESERVED_SLUGS);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const siteSlugPattern = /^[a-z][a-z0-9-]{1,62}$/;
export const SiteIdSchema = z.uuid();
export const SiteAppSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const SiteSlugSchema = z.string().regex(siteSlugPattern)
  .refine((s) => !reserved.has(s) && !uuidPattern.test(s), "This URL is unavailable");
/** Local friendly-path check: `invalid` format, `reserved` route, or `valid` (availability still needs the platform). */
export function classifySiteSlug(value: string): "invalid" | "reserved" | "valid" {
  if (!siteSlugPattern.test(value)) return "invalid";
  return reserved.has(value) || uuidPattern.test(value) ? "reserved" : "valid";
}
/** Ordered alternative friendly paths offered when a path is taken. */
export function siteSlugSuggestionCandidates(slug: string, hints: readonly string[] = []): string[] {
  const candidates = [...hints.map((hint) => `${slug}-${hint}`), `${slug}-app`, `${slug}-2`, `${slug}-3`];
  return [...new Set(candidates)].filter((candidate) => candidate !== slug && classifySiteSlug(candidate) === "valid");
}
export const SiteSlugAvailabilityQuerySchema = z.object({ slug: z.string().min(1).max(63) }).strict();
export const SiteSlugAvailabilityStatusSchema = z.enum(["available", "taken", "reserved", "invalid"]);
export const SiteSlugAvailabilitySchema = z.object({
  status: SiteSlugAvailabilityStatusSchema,
  suggestions: z.array(SiteSlugSchema).max(2),
}).strict();
export type SiteSlugAvailability = z.infer<typeof SiteSlugAvailabilitySchema>;
export const SiteReferenceSchema = z.union([SiteIdSchema, SiteSlugSchema]);
export const SiteUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return url.origin === "https://matrix.page" && !url.username && !url.password &&
    !url.search && !url.hash && SiteReferenceSchema.safeParse(url.pathname.slice(1)).success;
}, "Invalid public site URL");
export const SiteFieldNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
  .refine((s) => !["constructor", "prototype", "__proto__"].includes(s));
export const SiteFieldSchema = z.object({
  type: z.enum(["text", "email", "number", "boolean"]),
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(4000).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict().refine((f) => f.min === undefined || f.max === undefined || f.min <= f.max, "Invalid limits")
  .refine((f) => f.type === "number" || (f.min === undefined && f.max === undefined), "Numeric limits require a number")
  .refine((f) => f.maxLength === undefined || f.type === "text" || f.type === "email", "Text limit requires text");
export const SiteFormSchema = z.object({
  id: SiteFieldNameSchema,
  title: z.string().trim().min(1).max(200),
  fields: z.record(SiteFieldNameSchema, SiteFieldSchema).refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 30),
}).strict();
export const SitePublishingSchema = z.object({
  data: z.record(SiteFieldNameSchema, z.json()).default({}),
  forms: z.array(SiteFormSchema).max(10).default([]),
}).strict().refine((c) => new TextEncoder().encode(JSON.stringify(c)).byteLength <= 65_536, "Public configuration is too large")
  .refine((c) => new Set(c.forms.map((f) => f.id)).size === c.forms.length, "Duplicate form ID");
export type SitePublishing = z.infer<typeof SitePublishingSchema>;
export type SiteForm = z.infer<typeof SiteFormSchema>;

/** Compile an exact server-side field allowlist; no arbitrary app queries. */
export function validateSiteForm(form: SiteForm, input: unknown) {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(form.fields)) {
    let schema: z.ZodType;
    if (field.type === "boolean") schema = z.boolean();
    else if (field.type === "number") {
      let value = z.number().finite();
      if (field.min !== undefined) value = value.min(field.min);
      if (field.max !== undefined) value = value.max(field.max);
      schema = value;
    } else {
      let value = z.string().max(field.maxLength ?? (field.type === "email" ? 254 : 2000));
      if (field.required) value = value.min(1);
      if (field.type === "email") value = value.email();
      schema = value;
    }
    shape[name] = field.required ? schema : schema.optional();
  }
  return z.object(shape).strict().safeParse(input);
}

const title = z.string().trim().min(1).max(200);
const description = z.string().trim().max(1000);
const baseRevision = z.number().int().min(0).max(2_147_483_647);
// `private_link` (one-time links, spec 2690) is retired for new use (ENG-490). It stays
// readable for legacy records, and write schemas still accept it so older clients that
// echo a legacy site's current mode keep working; the platform rejects any change INTO it.
export const SiteAccessModeSchema = z.enum(["public", "private_link", "private_email"]);
export const SiteOwnerMutationSchema = z.object({
  title: title.optional(), description: description.optional(),
  slug: SiteSlugSchema.nullable().optional(), accessMode: SiteAccessModeSchema.optional(),
  baseRevision: baseRevision.optional(),
}).strict();
export const SiteMetadataSchema = SiteOwnerMutationSchema;
export const SitePublishRequestSchema = SiteMetadataSchema.extend({ reviewedConfig: SitePublishingSchema });
export const SiteRollbackSchema = z.object({ versionId: SiteIdSchema, baseRevision }).strict();
export const SiteAssetPathSchema = z.string().min(1).max(240)
  .regex(/^[A-Za-z0-9_/-][A-Za-z0-9_./-]*$/)
  .refine((p) => !p.startsWith("/") && p.split("/").every((s) => s && !s.startsWith(".")))
  .refine((p) => /\.(?:html|js|mjs|css|json|png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|otf|wasm|txt)$/i.test(p));
function isBoundedBase64(value: string): boolean {
  if (value.length > Math.ceil(SITE_MAX_BUNDLE_BYTES / 3) * 4 || value.length % 4 !== 0) return false;
  // A flat scan avoids V8's stack growth for a repeated four-character group.
  if (/[^A-Za-z0-9+/=]/.test(value)) return false;
  const padding = value.indexOf("=");
  return padding === -1 || (value.length - padding <= 2 && /^={1,2}$/.test(value.slice(padding)));
}
export const SiteAssetSchema = z.object({
  path: SiteAssetPathSchema,
  contentType: z.enum(["text/html", "text/javascript", "application/javascript", "application/json", "text/css", "text/plain", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "font/woff", "font/woff2", "font/ttf", "font/otf", "application/wasm", "application/octet-stream"]),
  body: z.string().max(Math.ceil(SITE_MAX_BUNDLE_BYTES / 3) * 4).refine(isBoundedBase64, "Invalid asset encoding"),
}).strict();
export const SiteDeploymentSchema = z.object({
  title, description: description.default(""), slug: SiteSlugSchema.nullable().optional(),
  accessMode: SiteAccessModeSchema.optional(), baseRevision: baseRevision.optional(), config: SitePublishingSchema,
  files: z.array(SiteAssetSchema).min(1).max(SITE_MAX_FILES),
}).strict().refine((d) => d.files.some((f) => f.path === "index.html"), "App entry point is missing")
  .refine((d) => new Set(d.files.map((f) => f.path)).size === d.files.length, "Duplicate asset")
  .refine((d) => d.files.reduce((sum, f) => sum + f.body.length / 4 * 3 - (f.body.endsWith("==") ? 2 : f.body.endsWith("=") ? 1 : 0), 0) <= SITE_MAX_BUNDLE_BYTES, "App is too large");
export type SiteDeployment = z.infer<typeof SiteDeploymentSchema>;
export const SiteVersionSchema = z.object({ id: SiteIdSchema, createdAt: z.string().datetime() }).strict();
/** Embedded in every SiteRecord; never add fields here (older strict parsers would reject all site records). */
export const SiteEmailInvitationsCapabilitySchema = z.object({ privateEmailInvitations: z.boolean() }).strict();
/**
 * Owner readiness endpoint only. `emailDelivery: "none"` is allowlist mode (no email is sent).
 * Bundles that predate it parse with the strict schema above and fail closed.
 */
export const SiteEmailInvitationReadinessSchema = z.object({
  privateEmailInvitations: z.boolean(), emailDelivery: z.enum(["none"]).optional(),
}).strict();
export const SiteRecordSchema = z.object({
  id: SiteIdSchema, appSlug: SiteAppSlugSchema, title, description,
  slug: SiteSlugSchema.nullable(), url: SiteUrlSchema, revision: baseRevision,
  status: z.enum(["published", "unpublished"]), activeVersion: SiteIdSchema.nullable(),
  accessMode: SiteAccessModeSchema.default("public"),
  /** 2694: the owner published this public link after visitor data shipped, so visitors may read app data. */
  publicData: z.boolean().optional(),
  capabilities: SiteEmailInvitationsCapabilitySchema.optional(),
  versions: z.array(SiteVersionSchema).max(50), config: SitePublishingSchema,
}).strict();
export type SiteRecord = z.infer<typeof SiteRecordSchema>;
export const SiteAccessLinkSecretSchema = z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/);
export const SiteAccessClaimSchema = z.object({ linkId: SiteIdSchema, token: SiteAccessLinkSecretSchema }).strict();
export const SiteAccessLinkCreateRequestSchema = z.object({ baseRevision }).strict();
export const SiteAccessLinkStatusSchema = z.enum(["unclaimed", "claimed", "expired"]);
export const SiteAccessLinkSummarySchema = z.object({
  id: SiteIdSchema,
  status: SiteAccessLinkStatusSchema,
  createdAt: z.string().datetime(),
  claimExpiresAt: z.string().datetime(),
  claimedAt: z.string().datetime().nullable(),
  sessionExpiresAt: z.string().datetime().nullable(),
}).strict();
export type SiteAccessLinkSummary = z.infer<typeof SiteAccessLinkSummarySchema>;
export const SiteAccessLinkCursorSchema = z.string().max(80).refine((value) => {
  const [createdAt, id, extra] = value.split("|");
  return extra === undefined && Boolean(createdAt)
    && z.string().datetime().safeParse(createdAt).success
    && SiteIdSchema.safeParse(id).success;
}, "Invalid access-link cursor");
export const SiteAccessLinksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: SiteAccessLinkCursorSchema.optional(),
}).strict();
export const SiteAccessLinksResponseSchema = z.object({
  links: z.array(SiteAccessLinkSummarySchema).max(100),
  nextCursor: SiteAccessLinkCursorSchema.nullable(),
}).strict();
export type SiteAccessLinksResponse = z.infer<typeof SiteAccessLinksResponseSchema>;
export const SiteAccessLinkCreateResponseSchema = z.object({
  link: SiteAccessLinkSummarySchema,
  url: z.url().refine(value => {
    const url = new URL(value);
    const [linkId, token, extra] = url.hash.slice(1).replace(/^access=/, "").split(".");
    return url.origin === "https://matrix.page" && !url.username && !url.password && !url.search
      && /^#access=/.test(url.hash) && extra === undefined
      && SiteIdSchema.safeParse(url.pathname.slice(1)).success
      && SiteIdSchema.safeParse(linkId).success && SiteAccessLinkSecretSchema.safeParse(token).success;
  }, "Invalid access link URL"),
}).strict();
export type SiteAccessLinkCreateResponse = z.infer<typeof SiteAccessLinkCreateResponseSchema>;
const invitationRevision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const invitationGeneration = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const invitationEmail = z.email().max(254);
export const SiteEmailInvitationStateSchema = z.enum(["pending", "accepted", "expired", "revoked"]);
export const SiteEmailInvitationDeliveryStateSchema = z.enum(["queued", "sending", "sent", "failed", "ambiguous", "suppressed"]);
export const SiteEmailInvitationCreateRequestSchema = z.object({
  emailAddresses: z.array(z.string().max(320)).min(1).max(SITE_MAX_EMAIL_INVITES),
  baseRevision,
}).strict();
export const SiteEmailInvitationMutationRequestSchema = z.object({ baseRevision, invitationRevision }).strict();
export const SiteEmailInvitationSummarySchema = z.object({
  id: SiteIdSchema, emailAddress: invitationEmail,
  state: SiteEmailInvitationStateSchema, deliveryState: SiteEmailInvitationDeliveryStateSchema,
  generation: invitationGeneration, revision: invitationRevision,
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  acceptedAt: z.iso.datetime().nullable().optional(), revokedAt: z.iso.datetime().nullable().optional(),
  updatedAt: z.iso.datetime(),
}).strict();
const invitationInputIndex = z.number().int().min(0).max(SITE_MAX_EMAIL_INVITES - 1);
export const SiteEmailInvitationInputResultSchema = z.discriminatedUnion("outcome", [
  z.object({ inputIndex: invitationInputIndex, outcome: z.literal("queued"), invitation: SiteEmailInvitationSummarySchema }).strict(),
  z.object({ inputIndex: invitationInputIndex, outcome: z.literal("existing"), invitation: SiteEmailInvitationSummarySchema }).strict(),
  z.object({ inputIndex: invitationInputIndex, outcome: z.literal("invalid") }).strict(),
  z.object({ inputIndex: invitationInputIndex, outcome: z.literal("duplicate_in_batch") }).strict(),
  z.object({ inputIndex: invitationInputIndex, outcome: z.literal("policy_rejected") }).strict(),
]);
export const SiteEmailInvitationCreateResponseSchema = z.object({
  results: z.array(SiteEmailInvitationInputResultSchema).min(1).max(SITE_MAX_EMAIL_INVITES),
  siteRevision: baseRevision,
}).strict();
export const SiteEmailInvitationMutationResponseSchema = z.object({
  invitation: SiteEmailInvitationSummarySchema, siteRevision: baseRevision,
}).strict();
export const SiteEmailInvitationCursorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const SiteEmailInvitationListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(SITE_MAX_EMAIL_INVITES).default(50),
  cursor: SiteEmailInvitationCursorSchema.optional(),
}).strict();
export const SiteEmailInvitationPageSchema = z.object({
  invitations: z.array(SiteEmailInvitationSummarySchema).max(SITE_MAX_EMAIL_INVITES),
  nextCursor: SiteEmailInvitationCursorSchema.nullable(), siteRevision: baseRevision,
}).strict();
export const SiteEmailViewerExchangeSchema = z.object({}).strict();
export type SiteEmailInvitationSummary = z.infer<typeof SiteEmailInvitationSummarySchema>;
export type SiteEmailInvitationInputResult = z.infer<typeof SiteEmailInvitationInputResultSchema>;
export type SiteEmailInvitationPage = z.infer<typeof SiteEmailInvitationPageSchema>;
export type SiteEmailInvitationsCapability = z.infer<typeof SiteEmailInvitationsCapabilitySchema>;
export type SiteEmailInvitationReadiness = z.infer<typeof SiteEmailInvitationReadinessSchema>;
export const SiteInvitationAuditEventTypeSchema = z.enum([
  "invitation_created", "invitation_resent", "invitation_accepted", "invitation_revoked",
  "delivery_sent", "delivery_failed", "grant_revoked", "mode_changed", "unpublished",
]);
export const SiteInvitationAuditDetailsSchema = z.object({
  generation: invitationGeneration.optional(),
  reason: z.enum(["owner", "duplicate_identity", "mode_changed", "unpublished", "recipient_inactive", "recipient_deleted", "reinvited", "configuration", "throttled", "rejected", "timeout", "unavailable", "unknown"]).optional(),
  fromMode: SiteAccessModeSchema.optional(), toMode: SiteAccessModeSchema.optional(),
}).strict();
export const SiteInvitationAuditEventSchema = z.object({
  id: SiteIdSchema, invitationId: SiteIdSchema.nullable(),
  type: SiteInvitationAuditEventTypeSchema,
  actorKind: z.enum(["owner", "viewer", "system"]),
  occurredAt: z.iso.datetime(), details: SiteInvitationAuditDetailsSchema,
}).strict();
export const SiteInvitationAuditCursorSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const SiteInvitationAuditPageSchema = z.object({
  events: z.array(SiteInvitationAuditEventSchema).max(100), nextCursor: SiteInvitationAuditCursorSchema.nullable(),
}).strict();
export type SiteInvitationAuditEvent = z.infer<typeof SiteInvitationAuditEventSchema>;
export type SiteInvitationAuditDetails = z.infer<typeof SiteInvitationAuditDetailsSchema>;
export const SiteIdempotencyKeySchema = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
export const SiteFormFieldsSchema = z.record(SiteFieldNameSchema, z.union([z.string().max(4000), z.number().finite(), z.boolean()]));
export const SiteFormSubmissionSchema = z.object({ fields: SiteFormFieldsSchema, idempotencyKey: SiteIdempotencyKeySchema }).strict();
export const SiteSubmitCapabilitySchema = z.object({
  siteId: SiteIdSchema, appSlug: SiteAppSlugSchema, versionId: SiteIdSchema,
  config: SitePublishingSchema, formId: SiteFieldNameSchema,
  fields: SiteFormFieldsSchema, idempotencyKey: SiteIdempotencyKeySchema,
}).strict();
export const SiteSubmissionSchema = z.object({
  id: SiteIdSchema, siteId: SiteIdSchema, formId: SiteFieldNameSchema,
  fields: SiteFormFieldsSchema, createdAt: z.string().datetime(),
}).strict();
export type SiteSubmission = z.infer<typeof SiteSubmissionSchema>;
/** Stable keyset boundary; timestamp keeps Postgres microseconds, ID breaks ties. */
export const SiteSubmissionCursorSchema = z.string().length(64).refine((value) => {
  const [createdAt, id, extra] = value.split("|");
  return extra === undefined && Boolean(createdAt) && !createdAt!.startsWith("0000-")
    && z.string().datetime({ precision: 6 }).safeParse(createdAt).success
    && SiteIdSchema.safeParse(id).success;
}, "Invalid submission cursor");
export const SiteSubmissionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: SiteSubmissionCursorSchema.optional(),
}).strict();
export const SiteSubmissionsResponseSchema = z.object({
  submissions: z.array(SiteSubmissionSchema).max(100), nextCursor: SiteSubmissionCursorSchema.nullable(),
}).strict();
export type SiteSubmissionsResponse = z.infer<typeof SiteSubmissionsResponseSchema>;
export const SITE_SAFE_ERRORS = ["Site unavailable", "Site URL unavailable", "Site changed; reload and try again", "App needs a public build", "Invalid submission", "Submission unavailable", "Invitation unavailable", "Too many requests"] as const;
export function siteSafeError(value: unknown, fallback = "Site unavailable"): string {
  return typeof value === "string" && SITE_SAFE_ERRORS.some((s) => s === value) ? value : fallback;
}

/** 2694: anonymous public-site visitors use the owner app bridge for exactly one app. */
export const SITE_PUBLIC_DATA_REQUEST_MAX_BYTES = 64 * 1024;
export const SITE_PUBLIC_DATA_RESPONSE_MAX_BYTES = 1024 * 1024;
export const SITE_PUBLIC_DATA_MAX_ROWS = 500;
export const SITE_PUBLIC_DATA_MAX_BULK = 50;
export const SITE_PUBLIC_DATA_READ_ONLY = "Public app data is read-only";
export const SITE_PUBLIC_DATA_SAFE_ERRORS = ["Shared data is unavailable", "Try again later", "Invalid change", SITE_PUBLIC_DATA_READ_ONLY] as const;
const SitePublicDataNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const SitePublicDataIdSchema = z.string().min(1).max(512);
const SitePublicDataComparableSchema = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const SitePublicDataOrderedSchema = z.union([z.string().max(4000), z.number().finite()]);
const SitePublicDataOperatorSchema = z.object({
  $eq: SitePublicDataComparableSchema.optional(), $ne: SitePublicDataComparableSchema.optional(),
  $lt: SitePublicDataOrderedSchema.optional(), $lte: SitePublicDataOrderedSchema.optional(),
  $gt: SitePublicDataOrderedSchema.optional(), $gte: SitePublicDataOrderedSchema.optional(),
  $in: z.array(SitePublicDataComparableSchema).max(200).optional(),
  $like: z.string().max(4000).optional(), $ilike: z.string().max(4000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Empty filter operator");
const SitePublicDataFilterSchema = z.record(SitePublicDataNameSchema, z.union([SitePublicDataComparableSchema, SitePublicDataOperatorSchema]))
  .refine((value) => Object.keys(value).length <= 32, "Too many filters");
const SitePublicDataRowSchema = z.record(SitePublicDataNameSchema, z.json())
  .refine((value) => Object.keys(value).length > 0 && Object.keys(value).length <= 64, "Invalid row");
const table = { table: SitePublicDataNameSchema };
export const SitePublicDbActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("find"), ...table, filter: SitePublicDataFilterSchema.optional(),
    orderBy: z.record(SitePublicDataNameSchema, z.enum(["asc", "desc"])).refine((value) => Object.keys(value).length <= 4, "Too many sort keys").optional(),
    limit: z.number().int().min(0).max(SITE_PUBLIC_DATA_MAX_ROWS).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
  }).strict(),
  z.object({ action: z.literal("findOne"), ...table, id: SitePublicDataIdSchema }).strict(),
  z.object({ action: z.literal("count"), ...table, filter: SitePublicDataFilterSchema.optional() }).strict(),
  z.object({ action: z.literal("insert"), ...table, data: SitePublicDataRowSchema }).strict(),
  z.object({ action: z.literal("bulkInsert"), ...table, rows: z.array(SitePublicDataRowSchema).min(1).max(SITE_PUBLIC_DATA_MAX_BULK) }).strict(),
  z.object({ action: z.literal("update"), ...table, id: SitePublicDataIdSchema, data: SitePublicDataRowSchema }).strict(),
  z.object({
    action: z.literal("bulkUpdate"), ...table,
    updates: z.array(z.object({ id: SitePublicDataIdSchema, data: SitePublicDataRowSchema }).strict()).min(1).max(SITE_PUBLIC_DATA_MAX_BULK)
      .refine((updates) => new Set(updates.map((update) => update.id)).size === updates.length, "Duplicate row"),
  }).strict(),
  z.object({
    action: z.literal("compareAndSwap"), ...table, id: SitePublicDataIdSchema,
    expectedPayload: z.record(z.string().max(128), z.json()), data: SitePublicDataRowSchema,
  }).strict(),
  z.object({ action: z.literal("delete"), ...table, id: SitePublicDataIdSchema }).strict(),
  z.object({ action: z.literal("appInfo") }).strict(),
  z.object({ action: z.literal("schema") }).strict(),
]);
export type SitePublicDbAction = z.infer<typeof SitePublicDbActionSchema>;
export const SitePublicDataKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const SitePublicDataRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("db"), action: SitePublicDbActionSchema }).strict(),
  z.object({ kind: z.literal("kvRead"), key: SitePublicDataKeySchema }).strict(),
  z.object({ kind: z.literal("kvWrite"), key: SitePublicDataKeySchema, value: z.string().max(32 * 1024) }).strict(),
]);
export type SitePublicDataRequest = z.infer<typeof SitePublicDataRequestSchema>;
/** Platform-signed request to the owner gateway; the visitor never names the app. */
export const SitePublicDataCapabilitySchema = z.object({
  siteId: SiteIdSchema, appSlug: SiteAppSlugSchema, versionId: SiteIdSchema,
  visitor: z.string().regex(/^[a-f0-9]{64}$/), request: SitePublicDataRequestSchema,
}).strict();
export type SitePublicDataCapability = z.infer<typeof SitePublicDataCapabilitySchema>;
/** Whether a visitor request changes owner data (write admission, rate class, write log). */
export function isSitePublicDataWrite(request: SitePublicDataRequest): boolean {
  if (request.kind === "kvRead") return false;
  if (request.kind !== "db") return true;
  return !["find", "findOne", "count", "appInfo", "schema"].includes(request.action.action);
}

/** Visitor writes stay disabled until the public app data permission model is defined. */
export function publicSiteDataWritesEnabled(): boolean {
  return false;
}
export function sitePublicDataSafeError(value: unknown): (typeof SITE_PUBLIC_DATA_SAFE_ERRORS)[number] {
  return SITE_PUBLIC_DATA_SAFE_ERRORS.find((error) => error === value) ?? "Shared data is unavailable";
}
