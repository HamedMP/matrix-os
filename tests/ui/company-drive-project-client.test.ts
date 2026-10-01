import { expect, it, vi } from "vitest";
import { createChatDriveProjectClient } from "../../packages/ui/src/organization-drive/chat-project-client.js";
it("batches loaded Chat IDs without widening owner scope or trusting malformed associations", async () => {
    const request = vi.fn(async (_path: string, _method: string, body: unknown) => ({ associations: [] }));
    const client = createChatDriveProjectClient(request);
    await client.lookup(Array.from({ length: 230 }, (_, index) => `chat_${index}`));
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(call => (call[2] as {
        chatIds: string[];
    }).chatIds.length <= 100)).toBe(true);
    expect(request.mock.calls.every(call => call[0] === "/api/chat-drive-projects/lookup" && call[1] === "POST")).toBe(true);
    request.mockResolvedValueOnce({ associations: [{ chatId: "chat_other", reference: null, revision: 1 }] } as never);
    await expect(client.lookup(["chat_1"])).rejects.toThrow();
});
