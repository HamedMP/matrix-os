import {fetchSavedBotChatIdentity} from "../lib/requests/bot-chat-identity";
afterEach(() => jest.restoreAllMocks());
it("reads the exact retained binding with normal auth, Computer slot and timeout, without a write", async () => {
  const request = jest.spyOn(global, "fetch").mockResolvedValue({ok: true, json: async () => ({agentId: "bot_saved001"})} as Response);
  await expect(fetchSavedBotChatIdentity("fixture", "https://app.matrix-os.com/vm/preview?runtime=dev", "chat_saved")).resolves.toBe("bot_saved001");
  expect(request.mock.calls[0][0]).toBe("https://app.matrix-os.com/vm/preview/api/chats/chat_saved/bot?runtime=dev");
  const options = request.mock.calls[0][1]!;
  expect(options.method ?? "GET").toBe("GET");
  expect(options.signal).toBeDefined();
  expect(options.body).toBeUndefined();
});
it("rejects a malformed Chat id before issuing any request", async () => {
  const request = jest.spyOn(global, "fetch");
  await expect(fetchSavedBotChatIdentity("fixture", "https://preview.test", "../chat")).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
