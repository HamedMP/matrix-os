/**
 * S12 / T061–T062: direct resource contracts for files, folders and app
 * instances on the home computer. Every resource is addressed by its catalog
 * id; a path is a display property that may change under a stable id.
 */
import { z } from "zod/v4";
import { CollaborationRevisionSchema } from "#collaboration";

const RequestIdSchema = z.uuid();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/** 64 KiB of UTF-8 keeps a JSON action body under the 96 KiB HTTP limit. */
export const COLLABORATION_INLINE_CONTENT_BYTES = 64 * 1024;
/** Base64 upload parts stay under the HTTP body limit with headroom for the envelope. */
export const COLLABORATION_UPLOAD_PART_BYTES = 48 * 1024;
export const COLLABORATION_UPLOAD_MAX_BYTES = 256 * 1024 * 1024;

export function isSafeCollaborationRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 4_096 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export const CollaborationCatalogIdSchema = z.uuid();
export const CollaborationCatalogKindSchema = z.enum(["file", "folder", "app"]);
export const CollaborationResourcePathSchema = z.string().min(1).max(4_096).refine(isSafeCollaborationRelativePath);
export const CollaborationAppInstanceIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
export const CollaborationAppAssetPathSchema = z.string().min(1).max(1_024)
  .refine((value) => isSafeCollaborationRelativePath(value) && !value.split("/").some((segment) => segment.startsWith(".")));

export const CollaborationCatalogEntrySchema = z.object({
  id: CollaborationCatalogIdSchema,
  kind: CollaborationCatalogKindSchema,
  path: CollaborationResourcePathSchema,
  parentId: CollaborationCatalogIdSchema.nullable(),
  revision: CollaborationRevisionSchema,
  incarnation: z.string().min(1).max(256),
  updatedAt: z.iso.datetime(),
}).strict();

export const CollaborationFileListQuerySchema = z.object({
  cursor: z.string().min(1).max(4_096).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  query: z.string().trim().min(1).max(512).optional(),
}).strict();

export const CollaborationFileListResponseSchema = z.object({
  entries: z.array(CollaborationCatalogEntrySchema).max(100),
  nextCursor: z.string().min(1).max(4_096).optional(),
}).strict();

const InlineContentSchema = z.string().refine((value) => new TextEncoder().encode(value).byteLength <= COLLABORATION_INLINE_CONTENT_BYTES);

export const CollaborationFileActionRequestSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("write"),
    fileId: CollaborationCatalogIdSchema,
    content: InlineContentSchema,
    expectedRevision: CollaborationRevisionSchema,
    clientRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    type: z.literal("create"),
    kind: z.enum(["file", "folder"]),
    parentId: CollaborationCatalogIdSchema.nullable(),
    path: CollaborationResourcePathSchema,
    content: InlineContentSchema.optional(),
    clientRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    type: z.literal("rename"),
    fileId: CollaborationCatalogIdSchema,
    path: CollaborationResourcePathSchema,
    expectedRevision: CollaborationRevisionSchema,
    clientRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    type: z.literal("delete"),
    fileId: CollaborationCatalogIdSchema,
    expectedRevision: CollaborationRevisionSchema,
    clientRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    type: z.literal("upload_stage"),
    fileId: CollaborationCatalogIdSchema.optional(),
    parentId: CollaborationCatalogIdSchema.nullable().optional(),
    path: CollaborationResourcePathSchema.optional(),
    size: z.number().int().min(0).max(COLLABORATION_UPLOAD_MAX_BYTES),
    sha256: Sha256Schema,
    clientRequestId: RequestIdSchema,
  }).strict().refine((value) => (value.fileId !== undefined) !== (value.path !== undefined)),
  z.object({
    type: z.literal("upload_part"),
    uploadId: RequestIdSchema,
    index: z.number().int().min(0).max(1_000_000),
    sha256: Sha256Schema,
    chunk: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/).max(Math.ceil(COLLABORATION_UPLOAD_PART_BYTES / 3) * 4),
  }).strict(),
  z.object({
    type: z.literal("upload_commit"),
    uploadId: RequestIdSchema,
    expectedRevision: CollaborationRevisionSchema,
    clientRequestId: RequestIdSchema,
  }).strict(),
  z.object({
    type: z.literal("upload_cancel"),
    uploadId: RequestIdSchema,
  }).strict(),
]);

export const CollaborationUploadStateSchema = z.enum(["staging", "committed", "cancelled", "expired"]);
export const CollaborationUploadSchema = z.object({
  uploadId: RequestIdSchema,
  state: CollaborationUploadStateSchema,
  receivedBytes: z.number().int().min(0),
  size: z.number().int().min(0),
  expiresAt: z.iso.datetime(),
}).strict();

export const CollaborationFileActionResponseSchema = z.object({
  entry: CollaborationCatalogEntrySchema.optional(),
  upload: CollaborationUploadSchema.optional(),
  replayed: z.boolean(),
}).strict();

export const CollaborationAppInstanceSchema = z.object({
  appId: CollaborationAppInstanceIdSchema,
  catalogId: CollaborationCatalogIdSchema.optional(),
  revision: CollaborationRevisionSchema,
  readiness: z.enum(["ready", "blocked", "unavailable"]),
  collaborationMode: z.enum(["scoped", "unavailable"]),
}).strict();

/** The bridge query is validated on the home against the app's read actions; the wire carries it opaquely. */
export const CollaborationAppViewRequestSchema = z.object({ action: z.unknown() }).strict();
export const CollaborationAppActionRequestSchema = z.object({
  clientRequestId: RequestIdSchema,
  expectedRevision: CollaborationRevisionSchema,
  action: z.unknown(),
}).strict();
export const CollaborationAppActionResponseSchema = z.object({
  result: z.unknown(),
  revision: z.number().int().nonnegative(),
  replayed: z.boolean(),
}).strict();

export type CollaborationCatalogKind = z.infer<typeof CollaborationCatalogKindSchema>;
export type CollaborationCatalogEntry = z.infer<typeof CollaborationCatalogEntrySchema>;
export type CollaborationFileListQuery = z.infer<typeof CollaborationFileListQuerySchema>;
export type CollaborationFileActionRequest = z.infer<typeof CollaborationFileActionRequestSchema>;
export type CollaborationFileActionResponse = z.infer<typeof CollaborationFileActionResponseSchema>;
export type CollaborationUpload = z.infer<typeof CollaborationUploadSchema>;
export type CollaborationAppInstance = z.infer<typeof CollaborationAppInstanceSchema>;
export type CollaborationAppActionRequest = z.infer<typeof CollaborationAppActionRequestSchema>;
