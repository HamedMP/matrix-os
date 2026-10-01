import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { MissingRequestPrincipalError } from "../../../packages/gateway/src/request-principal.js";

describe("bot UI read routes", () => {
  it("returns bounded public recipe metadata without instructions and requires a principal", async () => {
    const app = (authenticated = true) => {
      const server = new Hono();
      server.route("/", createBotRoutes({
        recipes: { list: () => [{ recipeId: "writing-bot", version: "2026-09-27.1", name: "Writing Bot",
          description: "Write drafts", output: "A draft", instructions: "private recipe instructions", capabilities: [], integrations: [] }] } as never,
        getPrincipal: () => {
          if (!authenticated) throw new MissingRequestPrincipalError();
          return { userId: "user_owner_1", source: "jwt" } as never;
        },
      }));
      return server;
    };
    const response = await app().request("/api/chat-agents/bot-recipes");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ recipes: [{ recipeId: "writing-bot", version: "2026-09-27.1",
      name: "Writing Bot", description: "Write drafts", output: "A draft" }] });
    expect((await app(false).request("/api/chat-agents/bot-recipes")).status).toBe(401);
  });

  it("resolves only the principal's direct bot and validates the chat id first", async () => {
    const directBot = vi.fn(async () => "bot_research1");
    const server = new Hono();
    server.route("/", createBotRoutes({ botChats: { directBot }, getPrincipal: () => ({ userId: "owner_1", source: "jwt" }) as never }));
    const response = await server.request("/api/chats/chat_research/bot");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agentId: "bot_research1" });
    expect(directBot).toHaveBeenCalledWith({ type: "personal", ownerId: "owner_1" }, "chat_research");
    expect((await server.request("/api/chats/invalid!/bot")).status).toBe(400);
    expect(directBot).toHaveBeenCalledTimes(1);
  });

  it("resolves a bot's direct Chat for the authenticated owner and validates IDs", async () => {
    const directChat = vi.fn(async (owner) => owner.ownerId === "owner_1" ? "chat_research" : null);
    const server = (ownerId: string | null) => {
      const app = new Hono();
      app.route("/", createBotRoutes({ botChats: { directBot: async () => null, directChat }, getPrincipal: () => {
        if (!ownerId) throw new MissingRequestPrincipalError();
        return { userId: ownerId, source: "jwt" } as never;
      } }));
      return app;
    };
    const response = await server("owner_1").request("/api/chat-agents/bot_research1/direct-chat");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ chatId: "chat_research" });
    expect(directChat).toHaveBeenCalledWith({ type: "personal", ownerId: "owner_1" }, "bot_research1");
    expect(await (await server("other_owner").request("/api/chat-agents/bot_research1/direct-chat")).json()).toEqual({ chatId: null });
    expect((await server(null).request("/api/chat-agents/bot_research1/direct-chat")).status).toBe(401);
    const calls = directChat.mock.calls.length;
    expect((await server("owner_1").request("/api/chat-agents/invalid!/direct-chat")).status).toBe(400);
    expect(directChat).toHaveBeenCalledTimes(calls);
    const bare = new Hono();
    bare.route("/", createBotRoutes({ getPrincipal: () => ({ userId: "owner_1" }) as never }));
    expect((await bare.request("/api/chat-agents/bot_research1/direct-chat")).status).toBe(503);
  });

  it("reads only the principal's Chat and returns allowlisted task fields", async () => {
    const tasks = vi.fn(async () => [{ taskId: "task_abcdefgh", agentId: "bot_research1", chatId: "chat_research",
      status: "waiting_person", revision: 2, updatedAt: "2026-09-28T12:00:00.000Z" }]);
    const server = new Hono();
    server.route("/", createBotRoutes({ tasks, getPrincipal: () => ({ userId: "owner_1", source: "jwt" }) as never }));
    const response = await server.request("/api/chats/chat_research/bot-tasks");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tasks: await tasks.mock.results[0]!.value });
    expect(tasks).toHaveBeenCalledWith("owner_1", "chat_research");
    expect((await server.request("/api/chats/invalid!/bot-tasks")).status).toBe(400);
    expect(tasks).toHaveBeenCalledTimes(1);
  });
});
