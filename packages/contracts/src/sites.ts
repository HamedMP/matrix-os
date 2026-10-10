import { z } from "zod/v4";

export const SITE_MAX_FILES = 200;
export const SITE_MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
export const SITE_MAX_FORM_BYTES = 16 * 1024;
const reserved = new Set(["api", "public", "assets", "frame", "forms", "preview", "admin", "auth", "health", "robots", "favicon", "index", "sites", "www"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SiteIdSchema = z.uuid();
export const SiteAppSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const SiteSlugSchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/)
  .refine((s) => !reserved.has(s) && !uuidPattern.test(s), "This URL is unavailable");
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
export const SiteOwnerMutationSchema = z.object({
  title: title.optional(), description: description.optional(),
  slug: SiteSlugSchema.nullable().optional(), baseRevision: baseRevision.optional(),
}).strict();
export const SiteMetadataSchema = SiteOwnerMutationSchema;
export const SitePublishRequestSchema = SiteMetadataSchema.extend({ reviewedConfig: SitePublishingSchema });
export const SiteRollbackSchema = z.object({ versionId: SiteIdSchema, baseRevision }).strict();
export const SiteAssetPathSchema = z.string().min(1).max(240)
  .regex(/^[A-Za-z0-9_/-][A-Za-z0-9_./-]*$/)
  .refine((p) => !p.startsWith("/") && p.split("/").every((s) => s && !s.startsWith(".")))
  .refine((p) => /\.(?:html|js|mjs|css|json|png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|otf|wasm|txt)$/i.test(p));
export const SiteAssetSchema = z.object({
  path: SiteAssetPathSchema,
  contentType: z.enum(["text/html", "text/javascript", "application/javascript", "application/json", "text/css", "text/plain", "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml", "image/x-icon", "font/woff", "font/woff2", "font/ttf", "font/otf", "application/wasm", "application/octet-stream"]),
  body: z.string().max(Math.ceil(SITE_MAX_BUNDLE_BYTES / 3) * 4).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict();
export const SiteDeploymentSchema = z.object({
  title, description: description.default(""), slug: SiteSlugSchema.nullable().optional(),
  baseRevision: baseRevision.optional(), config: SitePublishingSchema,
  files: z.array(SiteAssetSchema).min(1).max(SITE_MAX_FILES),
}).strict().refine((d) => d.files.some((f) => f.path === "index.html"), "App entry point is missing")
  .refine((d) => new Set(d.files.map((f) => f.path)).size === d.files.length, "Duplicate asset")
  .refine((d) => d.files.reduce((sum, f) => sum + f.body.length / 4 * 3 - (f.body.endsWith("==") ? 2 : f.body.endsWith("=") ? 1 : 0), 0) <= SITE_MAX_BUNDLE_BYTES, "App is too large");
export type SiteDeployment = z.infer<typeof SiteDeploymentSchema>;
export const SiteVersionSchema = z.object({ id: SiteIdSchema, createdAt: z.string().datetime() }).strict();
export const SiteRecordSchema = z.object({
  id: SiteIdSchema, appSlug: SiteAppSlugSchema, title, description,
  slug: SiteSlugSchema.nullable(), url: SiteUrlSchema, revision: baseRevision,
  status: z.enum(["published", "unpublished"]), activeVersion: SiteIdSchema.nullable(),
  versions: z.array(SiteVersionSchema).max(50), config: SitePublishingSchema,
}).strict();
export type SiteRecord = z.infer<typeof SiteRecordSchema>;
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
export const SITE_SAFE_ERRORS = ["Site unavailable", "Site URL unavailable", "Site changed; reload and try again", "App needs a public build", "Invalid submission", "Submission unavailable", "Too many requests"] as const;
export function siteSafeError(value: unknown, fallback = "Site unavailable"): string {
  return typeof value === "string" && SITE_SAFE_ERRORS.some((s) => s === value) ? value : fallback;
}
