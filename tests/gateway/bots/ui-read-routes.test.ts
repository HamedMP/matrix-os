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
