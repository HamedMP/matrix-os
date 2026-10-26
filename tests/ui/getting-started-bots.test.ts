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
  const created = (agentId: string) => ({ status: "created", agentId });

  it("ticks a bot once its chat has messages and leaves the rest to do", async () => {
    const request = gateway({
      "/api/chat-agents": { enabled: true, agents: [agent("bot_brief001", "personal-daily-brief"), agent("bot_write001", "writing-bot")] },
      "/api/settings/get-started/bots": { bots: { "personal-daily-brief": created("bot_brief001"), "writing-bot": created("bot_write001") } },
      "/api/chat-agents/bot_brief001/direct-chat": { chatId: CHAT_ID },
      [`/api/chats/${CHAT_ID}?limit=1`]: { record: { chat: { id: CHAT_ID, messageCount: 2 } }, messages: [] },
      "/api/chat-agents/bot_write001/direct-chat": { chatId: null },
    });
    const result = await loadGettingStartedBots(request, ["personal-daily-brief", "writing-bot"]);
    expect(result).toEqual({
      statuses: { "personal-daily-brief": "complete", "writing-bot": "incomplete" },
      agentIds: { "personal-daily-brief": "bot_brief001", "writing-bot": "bot_write001" },
    });
  });

  it("drops a bot the owner removed, and offers to create one whose creation never finished", async () => {
    // The bot list leaves removed bots out; the gateway says which bot each saved choice made.
    const request = gateway({
      "/api/chat-agents": { enabled: true, agents: [] },
      "/api/settings/get-started/bots": { bots: { echo: created("bot_echo0001"), "writing-bot": { status: "pending" } } },
    });
    expect(await loadGettingStartedBots(request, ["echo", "writing-bot"])).toEqual({
      statuses: { echo: null, "writing-bot": "missing" },
      agentIds: {},
    });
  });

  it("offers Create while a creation is unfinished, even when its bot file exists", async () => {
    const request = gateway({
      "/api/chat-agents": { enabled: true, agents: [agent("bot_write001", "writing-bot")] },
      "/api/settings/get-started/bots": { bots: { "writing-bot": { status: "pending" } } },
    });
    expect(await loadGettingStartedBots(request, ["writing-bot"])).toEqual({ statuses: { "writing-bot": "missing" }, agentIds: {} });
  });

  it("uses the bot Get started made, never another copy of the same recipe", async () => {
    const copy = agent("bot_copy0001", "writing-bot", { createdAt: "2026-10-01T09:00:00.000Z" });
    const request = gateway({
      "/api/chat-agents": { enabled: true, agents: [copy, agent("bot_write001", "writing-bot")] },
      "/api/settings/get-started/bots": { bots: { "writing-bot": created("bot_write001") } },
      "/api/chat-agents/bot_write001/direct-chat": { chatId: null },
    });
    expect(await loadGettingStartedBots(request, ["writing-bot"])).toEqual({ statuses: { "writing-bot": "incomplete" }, agentIds: { "writing-bot": "bot_write001" } });
    // Once the owner removes it, the row goes, even though another copy remains.
    const removed = gateway({
      "/api/chat-agents": { enabled: true, agents: [copy] },
      "/api/settings/get-started/bots": { bots: { "writing-bot": created("bot_write001") } },
    });
    expect(await loadGettingStartedBots(removed, ["writing-bot"])).toEqual({ statuses: { "writing-bot": null }, agentIds: {} });
  });

  it("reports unavailable instead of done when a check fails", async () => {
    const request = gateway({
      "/api/chat-agents": { enabled: true, agents: [agent("bot_brief001", "personal-daily-brief")] },
      "/api/settings/get-started/bots": { bots: { "personal-daily-brief": created("bot_brief001") } },
      "/api/chat-agents/bot_brief001/direct-chat": new Error("down"),
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await loadGettingStartedBots(request, ["personal-daily-brief"])).statuses).toEqual({ "personal-daily-brief": "unavailable" });
    const listDown = gateway({ "/api/chat-agents": new Error("down"), "/api/settings/get-started/bots": { bots: {} } });
    expect((await loadGettingStartedBots(listDown, ["echo"])).statuses).toEqual({ echo: "unavailable" });
    // Without the saved creations it can't tell which bot is the one Get started made.
    const statusDown = gateway({ "/api/chat-agents": { enabled: true, agents: [] }, "/api/settings/get-started/bots": new Error("down") });
    expect(await loadGettingStartedBots(statusDown, ["echo"])).toEqual({ statuses: { echo: "unavailable" }, agentIds: {} });
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
