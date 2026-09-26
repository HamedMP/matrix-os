import { z } from "zod/v4";
import { CollaborationActorIdSchema, CollaborationOrganizationIdSchema, CollaborationRuntimeIdSchema } from "#collaboration";

const utf8 = new TextEncoder();
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** Logical path inside one organization drive; never an R2 key or host path. */
export const OrganizationDrivePathSchema = z.string().min(1).max(800).refine((path) =>
  utf8.encode(path).byteLength <= 800 && !path.startsWith("/") && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
  { message: "Invalid drive path" },
);

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
