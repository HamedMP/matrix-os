import { z } from "zod/v4";
import { OrganizationDriveContextReferenceSchema } from "#organization-drive-context";
const ChatId = z.string().regex(/^chat_[A-Za-z0-9_-]{1,120}$/);
export const ChatDriveProjectReferenceSchema = OrganizationDriveContextReferenceSchema.options[0];
export const UpdateChatDriveProjectSchema = z.object({
    baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    clientRequestId: z.string().regex(/^req_[A-Za-z0-9_-]{1,120}$/),
    reference: ChatDriveProjectReferenceSchema.nullable(),
}).strict();
export const ChatDriveProjectSchema = z.object({ chatId: ChatId, reference: ChatDriveProjectReferenceSchema.nullable(), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
export const ChatDriveProjectLookupSchema = z.object({ chatIds: z.array(ChatId).max(100) }).strict();
export const ChatDriveProjectLookupResponseSchema = z.object({ associations: z.array(ChatDriveProjectSchema).max(100) }).strict();
export type ChatDriveProject = z.infer<typeof ChatDriveProjectSchema>;
