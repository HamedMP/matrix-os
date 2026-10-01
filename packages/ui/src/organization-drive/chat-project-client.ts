import { CanonicalChatIdSchema, ChatDriveProjectLookupResponseSchema, ChatDriveProjectSchema, UpdateChatDriveProjectSchema, type ChatDriveProject } from "@matrix-os/contracts";
import type { z } from "zod/v4";
export function createChatDriveProjectClient(request: (path: string, method: "POST" | "PATCH", body: unknown) => Promise<unknown>) {
    return {
        async lookup(chatIds: string[]): Promise<ChatDriveProject[]> {
            const ids = [...new Set(chatIds.slice(0, 1000).map(id => CanonicalChatIdSchema.parse(id)))];
            const results: ChatDriveProject[] = [];
            for (let offset = 0; offset < ids.length; offset += 100) {
                const batch = ids.slice(offset, offset + 100);
                const parsed = ChatDriveProjectLookupResponseSchema.parse(await request('/api/chat-drive-projects/lookup', 'POST', { chatIds: batch }));
                if (new Set(parsed.associations.map(item => item.chatId)).size !== parsed.associations.length || parsed.associations.some(item => !batch.includes(item.chatId)))
                    throw new Error("DriveProjectResponseInvalid");
                results.push(...parsed.associations);
            }
            return results;
        },
        async update(chatId: string, input: z.input<typeof UpdateChatDriveProjectSchema>): Promise<ChatDriveProject> {
            const id = CanonicalChatIdSchema.parse(chatId);
            const parsed = ChatDriveProjectSchema.parse(await request(`/api/chats/${encodeURIComponent(id)}/drive-project`, 'PATCH', UpdateChatDriveProjectSchema.parse(input)));
            if (parsed.chatId !== id)
                throw new Error("DriveProjectResponseInvalid");
            return parsed;
        },
    };
}
export type ChatDriveProjectClient = ReturnType<typeof createChatDriveProjectClient>;
