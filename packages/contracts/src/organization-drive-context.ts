import { z } from "zod/v4";
import { CollaborationOrganizationIdSchema } from "#collaboration-identity";
const utf8 = new TextEncoder();
/** Logical path inside one organization drive; never an R2 key or host path. */
export const OrganizationDrivePathSchema = z.string().min(1).max(800).refine((path) => utf8.encode(path).byteLength <= 800 && !path.startsWith("/") && !path.includes("\\")
    && !/[\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."), { message: "Invalid drive path" });
/** Reserve the slash and at least one UTF-8 filename byte; the full file path is validated at upload. */
export const OrganizationDriveUploadFolderSchema = z.union([z.literal(""), OrganizationDrivePathSchema.refine(path => utf8.encode(path).byteLength <= 798)]);
const DriveContextIdentity = { organizationId: CollaborationOrganizationIdSchema, scopeId: z.uuid() };
/** Stable authority references; names and renderer labels never grant access. */
export const OrganizationDriveContextReferenceSchema = z.discriminatedUnion("kind", [
    z.object({ ...DriveContextIdentity, kind: z.literal("drive") }).strict(),
    z.object({ ...DriveContextIdentity, kind: z.literal("folder"), path: OrganizationDrivePathSchema }).strict(),
    z.object({ ...DriveContextIdentity, kind: z.literal("file"), fileId: z.uuid(), version: z.number().int().positive().max(2147483647) }).strict(),
]);
export type OrganizationDriveContextReference = z.infer<typeof OrganizationDriveContextReferenceSchema>;
/** Metadata search is bounded and scope-relative. Content search/indexing is a separate capability. */
export const OrganizationDriveContextSearchSchema = z.object({
    prefix: OrganizationDrivePathSchema.optional(),
    query: z.string().trim().max(200).refine(value => utf8.encode(value).byteLength <= 800 && !/[\u0000-\u001f\u007f]/.test(value)).default(""),
    after: OrganizationDrivePathSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(30),
}).strict();
const ChatDriveReferenceIndexSchema = z.number().int().min(0).max(2);
export const ChatDriveSearchInputSchema = OrganizationDriveContextSearchSchema.omit({ prefix: true }).extend({ referenceIndex: ChatDriveReferenceIndexSchema }).strict();
export const ChatDriveReadInputSchema = z.object({ referenceIndex: ChatDriveReferenceIndexSchema, fileId: z.uuid().optional() }).strict();
