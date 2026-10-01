import { z } from "zod/v4";
import { OrganizationDriveContextReferenceSchema } from "#organization-drive-context";
import { CanonicalChatIdSchema, CanonicalChatRequestIdSchema } from "#canonical-chat";
const ChatId = CanonicalChatIdSchema;
export const ChatDriveProjectReferenceSchema = OrganizationDriveContextReferenceSchema.options[0];
export const UpdateChatDriveProjectSchema = z.object({
    baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    clientRequestId: CanonicalChatRequestIdSchema,
    reference: ChatDriveProjectReferenceSchema.nullable(),
}).strict();
export const ChatDriveProjectSchema = z.object({ chatId: ChatId, reference: ChatDriveProjectReferenceSchema.nullable(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export const ChatDriveProjectLookupSchema = z.object({ chatIds: z.array(ChatId).max(100) }).strict();
export const ChatDriveProjectLookupResponseSchema = z.object({ associations: z.array(ChatDriveProjectSchema).max(100) }).strict();
export type ChatDriveProject = z.infer<typeof ChatDriveProjectSchema>;
