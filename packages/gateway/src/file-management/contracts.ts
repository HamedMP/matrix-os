import { posix } from "node:path";
import { z } from "zod/v4";

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const RESERVED_PLATFORM_NAME = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fitsUtf8ByteLimit(value: string, limit: number): boolean {
  return Buffer.byteLength(value, "utf8") <= limit;
}

export const FileManagementRequestIdSchema = z.uuid();

export const FileManagementPathSchema = z.string()
  .min(1)
  .max(4_096)
  .refine((value) => fitsUtf8ByteLimit(value, 4_096), "Path exceeds 4,096 UTF-8 bytes")
  .refine((value) => !value.startsWith("/") && !value.includes("\\"), "Path must be relative and slash-normalized")
  .refine((value) => !CONTROL_CHARACTER.test(value), "Path must not contain control characters")
  .refine((value) => value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), "Path must not contain traversal segments");

export const FileManagementDirectoryPathSchema = z.union([
  z.literal(""),
  FileManagementPathSchema,
]);

export const FileManagementNameSchema = z.string()
  .min(1)
  .max(255)
  .refine((value) => fitsUtf8ByteLimit(value, 255), "Name exceeds 255 UTF-8 bytes")
  .refine((value) => value.trim().length > 0 && value !== "." && value !== "..", "Name must not be blank or traversal")
  .refine((value) => !value.includes("/") && !value.includes("\\") && !CONTROL_CHARACTER.test(value), "Name must not contain separators or control characters")
  .refine((value) => !RESERVED_PLATFORM_NAME.test(value.replace(/[ .]+$/, "")), "Name is reserved by the platform");

export const FileEntryCapabilitiesSchema = z.object({
  canRename: z.boolean(),
  canMove: z.boolean(),
  canTrash: z.boolean(),
  readOnlyReason: z.enum(["protected", "policy"]).optional(),
}).strict();

const BatchSourcesSchema = z.array(FileManagementPathSchema)
  .min(1)
  .max(100)
  .superRefine((sources, ctx) => {
    if (new Set(sources).size !== sources.length) {
      ctx.addIssue({ code: "custom", message: "Sources must be unique" });
    }
    const parent = posix.dirname(sources[0] ?? "");
    if (!sources.every((source) => posix.dirname(source) === parent)) {
      ctx.addIssue({ code: "custom", message: "Sources must share a parent directory" });
    }
  });

export const CreateFileRequestSchema = z.object({
  requestId: FileManagementRequestIdSchema,
  parentDirectory: FileManagementDirectoryPathSchema,
  name: FileManagementNameSchema,
  kind: z.enum(["file", "directory"]),
}).strict();

export const RenameFileRequestSchema = z.object({
  requestId: FileManagementRequestIdSchema,
  path: FileManagementPathSchema,
  name: FileManagementNameSchema,
}).strict();

export const BatchMovePreflightRequestSchema = z.object({
  requestId: FileManagementRequestIdSchema,
  sources: BatchSourcesSchema,
  destinationDirectory: FileManagementPathSchema,
  phase: z.literal("preflight"),
}).strict();

export const ConflictChoiceSchema = z.object({
  source: FileManagementPathSchema,
  resolution: z.enum(["keep-both", "skip"]),
}).strict();

export const BatchMoveExecuteRequestSchema = z.object({
  requestId: FileManagementRequestIdSchema,
  phase: z.literal("execute"),
  preflightFingerprint: z.string().min(1).max(512),
  conflictChoices: z.array(ConflictChoiceSchema).max(100).optional(),
}).strict();

export const BatchMoveRequestSchema = z.discriminatedUnion("phase", [
  BatchMovePreflightRequestSchema,
  BatchMoveExecuteRequestSchema,
]);

export const BatchTrashRequestSchema = z.object({
  requestId: FileManagementRequestIdSchema,
  sources: BatchSourcesSchema,
}).strict();

export const FileOperationResultCodeSchema = z.enum([
  "created",
  "renamed",
  "moved",
  "skipped",
  "failed",
  "trashed",
  "source_missing",
  "destination_conflict",
  "protected",
  "invalid_destination",
  "cleanup_failed",
  "request_id_conflict",
]);

export type CreateFileRequest = z.infer<typeof CreateFileRequestSchema>;
export type RenameFileRequest = z.infer<typeof RenameFileRequestSchema>;
export type FileEntryCapabilities = z.infer<typeof FileEntryCapabilitiesSchema>;
export type BatchMovePreflightRequest = z.infer<typeof BatchMovePreflightRequestSchema>;
export type BatchMoveExecuteRequest = z.infer<typeof BatchMoveExecuteRequestSchema>;
export type BatchMoveRequest = z.infer<typeof BatchMoveRequestSchema>;
export type BatchTrashRequest = z.infer<typeof BatchTrashRequestSchema>;
export type FileOperationResultCode = z.infer<typeof FileOperationResultCodeSchema>;
