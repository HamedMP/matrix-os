import { describe, expect, it, vi } from "vitest";
import { loadGettingStartedBots, openGettingStartedBotChat } from "../../packages/ui/src/get-started/getting-started-bots.js";

const AT = "2026-10-23T09:00:00.000Z";
const CHAT_ID = "chat_brief0001";

function agent(id: string, recipeId: string, extra: Record<string, unknown> = {}) {
  return {
    id, name: recipeId, description: "", instructions: "", archived: false, revision: 1, createdAt: AT, updatedAt: AT,
    recipeRef: { recipeId, version: 1 }, ...extra,
  };
}

function gateway(routes: Record<string, unknown>) {
  return vi.fn(async (path: string) => {
    if (!(path in routes)) throw new Error(`unexpected ${path}`);
    const value = routes[path];
    if (value instanceof Error) throw value;
    return value;
  });
}

describe("Getting started bots", () => {
  it("ticks a bot once its chat has messages and leaves the rest to do", async () => {
    const request = gateway({
      "/api/chat-agents": { enabled: true, agents: [agent("bot_brief001", "personal-daily-brief"), agent("bot_write001", "writing-bot")] },
      "/api/chat-agents/bot_brief001/direct-chat": { chatId: CHAT_ID },
      [`/api/chats/${CHAT_ID}?limit=1`]: { record: { messageCount: 2 } },
      "/api/chat-agents/bot_write001/direct-chat": { chatId: null },
    });
    const result = await loadGettingStartedBots(request, ["personal-daily-brief", "writing-bot"]);
    expect(result).toEqual({
      statuses: { "personal-daily-brief": "complete", "writing-bot": "incomplete" },
      agentIds: { "personal-daily-brief": "bot_brief001", "writing-bot": "bot_write001" },
    });
  });

  it("drops bots the owner removed or archived", async () => {
    const request = gateway({
      "/api/chat-agents": { enabled: true, agents: [agent("bot_echo0001", "echo", { archived: true })] },
    });
    expect(await loadGettingStartedBots(request, ["echo", "writing-bot"])).toEqual({
      statuses: { echo: null, "writing-bot": null },
      agentIds: {},
    });
  });

  it("reports unavailable instead of done when a check fails", async () => {
    const request = gateway({
      "/api/chat-agents": { enabled: true, agents: [agent("bot_brief001", "personal-daily-brief")] },
      "/api/chat-agents/bot_brief001/direct-chat": new Error("down"),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await loadGettingStartedBots(request, ["personal-daily-brief"])).statuses).toEqual({ "personal-daily-brief": "unavailable" });
    const listDown = gateway({ "/api/chat-agents": new Error("down") });
    expect((await loadGettingStartedBots(listDown, ["echo"])).statuses).toEqual({ echo: "unavailable" });
  });

  it("asks nothing when no bots were added", async () => {
    const request = gateway({});
    expect(await loadGettingStartedBots(request, [])).toEqual({ statuses: {}, agentIds: {} });
    expect(request).not.toHaveBeenCalled();
  });

  it("opens the bot's own chat, creating it on first use", async () => {
    const request = vi.fn(async () => ({ chatId: CHAT_ID }));
    expect(await openGettingStartedBotChat(request, "bot_brief001")).toBe(CHAT_ID);
    expect(request).toHaveBeenCalledWith("/api/chat-agents/bot_brief001/direct-chat", "POST", {});
  });
});
