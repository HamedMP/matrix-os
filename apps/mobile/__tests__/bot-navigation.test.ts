import { fetchNativeBotNavigation } from "@/lib/requests/bot-navigation";
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
const gateway = "https://app.matrix-os.com/vm/test";
afterEach(() => jest.restoreAllMocks());
it("classifies all loaded IDs with bounded requests, including ordinary history beyond200", async () => {
  let live = 0, peak = 0;
  const request = jest.spyOn(global, "fetch").mockImplementation(async (input) => {
    live++; peak = Math.max(peak, live);
    await new Promise(resolve => setTimeout(resolve, 0));
    live--;
    const path = String(input);
    const body = path.endsWith("/api/chat-agents") ? { enabled: false, agents: [] }
      : path.endsWith("/chat_bot/bot") ? { agentId: "bot_research1" }
        : { agentId: null };
    if (path.endsWith("/interactions")) return { ok: true, json: async () => ({ interactions: [] }) } as Response;
    return { ok: true, json: async () => body } as Response;
  });
  const ids = ["chat_bot", ...Array.from({ length: 205 }, (_, index) => `chat_old_${index}`)];
  const index = await fetchNativeBotNavigation("token", gateway, ids);
  expect(index.ordinaryChatIds).toHaveLength(205);
  expect(index.ordinaryChatIds).toContain("chat_old_204");
  expect(index.bots.map(bot => bot.chatId)).toEqual(["chat_bot"]);
  expect(index.unresolvedChatIds).toEqual([]);
  expect(peak).toBeLessThanOrEqual(4);
  expect(request.mock.calls.every(call => (call[1]?.headers as Record<string, string>)?.Authorization === "Bearer token")).toBe(true);
});
it("retains known Bot classification on attention failure and keeps failed identity recoverable", async () => {
  jest.spyOn(global, "fetch").mockImplementation(async input => {
    const path = String(input);
    if (path.endsWith("/api/chat-agents")) return { ok: true, json: async () => ({ enabled: false, agents: [] }) } as Response;
    if (path.endsWith("/chat_bot/bot")) return { ok: true, json: async () => ({ agentId: "bot_research1" }) } as Response;
    if (path.endsWith("/chat_ordinary/bot")) return { ok: true, json: async () => ({ agentId: null }) } as Response;
    throw new Error("private gateway detail");
  });
  const index = await fetchNativeBotNavigation("token", gateway, ["chat_bot", "chat_ordinary", "chat_unknown"]);
  expect(index.ordinaryChatIds).toEqual(["chat_ordinary"]);
  expect(index.bots[0]).toMatchObject({ chatId: "chat_bot", pendingApprovalCount: 0 });
  expect(index.unresolvedChatIds).toEqual(["chat_unknown"]);
  expect(index.unavailable).toBe(true);
});
it("counts only pending approval interactions from the authenticated Bot history", async () => {
  jest.spyOn(global, "fetch").mockImplementation(async input => {
    const path = String(input);
    const body = path.endsWith("/api/chat-agents") ? { enabled: false, agents: [] }
      : path.endsWith("/bot") ? { agentId: "bot_research1" }
        : { interactions: [
          { interactionId: "in_abcdefgh", chatId: "chat_bot", agentId: "bot_research1", taskId: "task_abcdefgh",
            kind: "approval", status: "pending", blocking: true, expiresAt: "2099-01-01T00:00:00.000Z", revision: 1 },
          { interactionId: "in_ijklmnop", chatId: "chat_bot", agentId: "bot_research1", taskId: "task_abcdefgh",
            kind: "approval", status: "resolved", blocking: true, expiresAt: "2099-01-01T00:00:00.000Z", revision: 2 },
          { interactionId: "in_qrstuvwx", chatId: "chat_bot", agentId: "bot_research1", taskId: "task_abcdefgh",
            kind: "question", status: "pending", blocking: true, expiresAt: "2099-01-01T00:00:00.000Z", revision: 1 },
          { interactionId: "in_yzabcdef", chatId: "chat_bot", agentId: "bot_research1", taskId: "task_abcdefgh",
            kind: "approval", status: "pending", blocking: true, expiresAt: "2000-01-01T00:00:00.000Z", revision: 1 },
        ] };
    return { ok: true, json: async () => body } as Response;
  });
  const index = await fetchNativeBotNavigation("token", gateway, ["chat_bot"]);
  expect(index.bots[0]?.pendingApprovalCount).toBe(1);
  expect(index.unavailable).toBe(false);
});
it("does not start reads for an abandoned runtime batch", async () => {
  const request = jest.spyOn(global, "fetch");
  const controller = new AbortController();
  controller.abort();
  await fetchNativeBotNavigation("token", gateway, ["chat_old"], controller.signal);
  expect(request).not.toHaveBeenCalled();
});

it("discovers persistent recipe Bot chats outside the recent window and deduplicates loaded histories", async () => {
  const agent = { id: "bot_research1", revision: 1, name: "Research", description: "", instructions: "Research",
    selection: { instanceId: "matrix_pi_default", model: "cloudflare:@cf/zai-org/glm-5.3-flash" },
    recipeRef: { recipeId: "research", version: "v1" }, archived: false,
    createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" };
  const request = jest.spyOn(global, "fetch").mockImplementation(async input => {
    const path = String(input);
    const body = path.endsWith("/api/chat-agents") ? { enabled: true, agents: [agent] }
      : path.endsWith("/direct-chat") ? { chatId: "chat_old_bot" }
        : path.endsWith("/interactions") ? { interactions: [] }
          : { agentId: null };
    return { ok: true, json: async () => body } as Response;
  });
  const old = await fetchNativeBotNavigation("token", gateway, []);
  expect(old.bots).toEqual([{ chatId: "chat_old_bot", agentId: agent.id, name: agent.name, pendingApprovalCount: 0 }]);
  request.mockClear();
  const loaded = await fetchNativeBotNavigation("token", gateway, ["chat_old_bot", "chat_ordinary"]);
  expect(loaded.bots).toHaveLength(1);
  expect(loaded.ordinaryChatIds).toEqual(["chat_ordinary"]);
  expect(request.mock.calls.some(call => String(call[0]).endsWith("/chat_old_bot/bot"))).toBe(false);
});

it("does not queue bindings or attention reads after a runtime is abandoned", async () => {
  const controller = new AbortController();
  const request = jest.spyOn(global, "fetch").mockImplementation(async input => {
    const path = String(input);
    if (path.endsWith("/api/chat-agents")) return { ok: true, json: async () => ({ enabled: false, agents: [] }) } as Response;
    controller.abort();
    return { ok: true, json: async () => ({ agentId: "bot_research1" }) } as Response;
  });
  await fetchNativeBotNavigation("token", gateway, ["chat_first", "chat_second", "chat_third", "chat_fourth", "chat_fifth"], controller.signal);
  expect(request.mock.calls.some(call => String(call[0]).endsWith("/interactions"))).toBe(false);
  expect(request.mock.calls.some(call => String(call[0]).endsWith("/chat_fifth/bot"))).toBe(false);
});
