import { OrganizationDrivePathSchema } from "#organization-drive-context";
export { OrganizationDrivePathSchema, OrganizationDriveUploadFolderSchema, OrganizationDriveContextReferenceSchema, OrganizationDriveContextSearchSchema, ChatDriveSearchInputSchema, ChatDriveReadInputSchema, type OrganizationDriveContextReference } from "#organization-drive-context";
import { z } from "zod/v4";
import { CollaborationActorIdSchema, CollaborationOrganizationIdSchema, CollaborationRuntimeIdSchema } from "#collaboration";

const utf8 = new TextEncoder();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Organization-selected authority generation changes whenever the serving home moves. */
export const OrganizationDriveAuthoritySchema = z.object({
  organizationId: CollaborationOrganizationIdSchema,
  runtimeId: CollaborationRuntimeIdSchema,
  generation: z.number().int().positive(),
  quotaBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const OrganizationDriveFileSchema = z.object({
  id: z.uuid(),
  organizationId: CollaborationOrganizationIdSchema,
  path: OrganizationDrivePathSchema,
  version: z.number().int().positive(),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: Sha256Schema,
  updatedBy: CollaborationActorIdSchema,
  updatedAt: z.iso.datetime({ offset: true }),
}).strict();

export const OrganizationDriveUploadRequestSchema = z.object({
  path: OrganizationDrivePathSchema,
  size: z.number().int().positive().max(100 * 1024 * 1024),
  sha256: Sha256Schema,
  requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  baseVersion: z.number().int().nonnegative().optional(),
}).strict();

export const OrganizationDriveSnapshotSchema = z.object({
  organizationId: CollaborationOrganizationIdSchema,
  scopeId: z.uuid(),
  usedBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
  files: z.array(OrganizationDriveFileSchema).max(100),
  nextCursor: OrganizationDrivePathSchema.optional(),
}).strict();

export const OrganizationDriveUploadReservationSchema = z.object({
  uploadId: z.uuid(), putUrl: z.url(), expiresAt: z.iso.datetime({ offset: true }),
}).strict();

export const OrganizationDriveDownloadSchema = z.object({
  file: OrganizationDriveFileSchema, getUrl: z.url(),
}).strict();

export type OrganizationDriveAuthority = z.infer<typeof OrganizationDriveAuthoritySchema>;
export type OrganizationDriveFile = z.infer<typeof OrganizationDriveFileSchema>;
export type OrganizationDriveUploadRequest = z.infer<typeof OrganizationDriveUploadRequestSchema>;

export const OrganizationDriveTextContextSchema = z.discriminatedUnion("status", [
  z.object({status: z.literal("text"), file: OrganizationDriveFileSchema,
    text: z.string().max(32 * 1024).refine(value => utf8.encode(value).byteLength <= 32 * 1024), truncated: z.boolean(), readOnly: z.literal(true)}).strict(),
  z.object({status: z.literal("unsupported"), file: OrganizationDriveFileSchema, readOnly: z.literal(true)}).strict(),
]);

export const OrganizationDriveContextSearchResponseSchema = z.object({
  organizationId: CollaborationOrganizationIdSchema, scopeId: z.uuid(),
  files: z.array(OrganizationDriveFileSchema).max(50), nextCursor: OrganizationDrivePathSchema.optional(),
}).strict();
