import { describe, expect, it, vi } from "vitest";
import { BotClientError, createBotClient } from "../../packages/ui/src/chat-agents/bots/client.js";
import { createCompanyBrainBot, findCompanyBrainBot } from "../../packages/ui/src/brain/company-brain-bot.js";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";

const PROJECT = "proj_matrix_os";

function record(id: string) {
  return {
    chat: {
      id, ownerScope: { type: "personal" as const, ownerId: "owner_brain" }, title: "Why bots", lifecycle: "active" as const,
      attention: "none" as const, revision: 1, messageCount: 0, createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
    },
  };
}

describe("bot thread client", () => {
  it("creates a thread for one project and lists a project's threads, parsed as Chat records", async () => {
    const request = vi.fn(async (path: string) => path.includes("?") && !path.includes("bot-recipes")
      ? { items: [record("chat_a")], nextCursor: "chatcur_next" }
      : path.includes("bot-recipes") ? { recipes: [] } : record("chat_a"));
    const bots = createBotClient(request);
    expect((await bots.threads.create("bot_0123456789abcdef", {
      clientRequestId: "req_first_chat", projectId: PROJECT, title: "Why bots",
    })).chat.id).toBe("chat_a");
    expect(request).toHaveBeenLastCalledWith("/api/chat-agents/bot_0123456789abcdef/threads", "POST", {
      clientRequestId: "req_first_chat", projectId: PROJECT, title: "Why bots",
    });
    // A title that is not a safe label is left out; the server names the thread.
    await bots.threads.create("bot_0123456789abcdef", { clientRequestId: "req_x", projectId: PROJECT, title: "see /Users/ann/x" });
    expect(request).toHaveBeenLastCalledWith("/api/chat-agents/bot_0123456789abcdef/threads", "POST", {
      clientRequestId: "req_x", projectId: PROJECT,
    });
    const page = await bots.threads.list("bot_0123456789abcdef", { projectId: PROJECT, limit: 50, cursor: "chatcur_prev" });
    expect(page.nextCursor).toBe("chatcur_next");
    expect(request).toHaveBeenLastCalledWith(
      `/api/chat-agents/bot_0123456789abcdef/threads?projectId=${PROJECT}&limit=50&cursor=chatcur_prev`, "GET", undefined,
    );
    await bots.recipes("company-brain");
    expect(request).toHaveBeenLastCalledWith("/api/chat-agents/bot-recipes?recipeId=company-brain", "GET", undefined);
  });

  it("refuses a project that is not a project id before sending, and words failures with fixed text", async () => {
    const request = vi.fn(async () => { throw Object.assign(new Error("postgres://secret"), { status: 409 }); });
    const bots = createBotClient(request);
    await expect(bots.threads.list("bot_0123456789abcdef", { projectId: "matrix-os" })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(bots.threads.create("bot_0123456789abcdef", { clientRequestId: "req_a", projectId: PROJECT }))
      .rejects.toThrow("This changed since you loaded it. Refresh and try again.");
  });
});

/** Like the server, the library lists active Bots only, and the recipe is served by id. */
function client(agents: unknown[], enabled = true) {
  return {
    list: vi.fn(async () => ({ enabled, agents })),
    bots: {
      recipes: vi.fn(async (): Promise<unknown[]> => [{ recipeId: "company-brain", version: "1" }]),
      instantiate: vi.fn(async () => ({ agent: { id: "b1" }, chatId: "chat_direct", operation: "created" })),
    },
  };
}

const bot = (id: string, createdAt: string, recipeId = "company-brain") => ({
  id, createdAt, archived: false, recipeRef: { recipeId, version: "1" },
});
const as = (fake: ReturnType<typeof client>) => fake as unknown as ChatAgentClient;

describe("Company Brain Bot", () => {
  it("finds the oldest active Bot, offers setup only where the recipe is served, and is unavailable when Bots are off", async () => {
    const find = (agents: unknown[], enabled = true) => findCompanyBrainBot(as(client(agents, enabled)));
    expect(await find([bot("b2", "2026-10-02"), bot("b1", "2026-10-01"), bot("x", "2026-09-01", "writing-bot")]))
      .toEqual({ kind: "ready", botId: "b1" });
    expect(await find([bot("x", "2026-09-01", "writing-bot")])).toEqual({ kind: "setup" });
    expect(await find([bot("b1", "2026-10-01")], false)).toEqual({ kind: "unavailable" });
    expect(await findCompanyBrainBot({ list: vi.fn() } as unknown as ChatAgentClient)).toEqual({ kind: "unavailable" });
    const noRecipe = client([]);
    noRecipe.bots.recipes.mockResolvedValue([]);
    expect(await findCompanyBrainBot(as(noRecipe))).toEqual({ kind: "unavailable" });
  });

  it("reads Bots that answer 503 as not running, and passes other failures on", async () => {
    const down = client([]);
    down.bots.recipes.mockRejectedValue(new BotClientError(503, "Bots are temporarily unavailable."));
    expect(await findCompanyBrainBot(as(down))).toEqual({ kind: "unavailable" });
    expect(await createCompanyBrainBot(as(down))).toEqual({ kind: "unavailable" });
    const busy = client([]);
    busy.bots.instantiate.mockRejectedValue(new BotClientError(503, "Bots are temporarily unavailable."));
    expect(await createCompanyBrainBot(as(busy))).toEqual({ kind: "unavailable" });
    const broken = client([]);
    broken.bots.instantiate.mockRejectedValue(new BotClientError(409, "This changed since you loaded it."));
    await expect(createCompanyBrainBot(as(broken))).rejects.toThrow(BotClientError);
  });

  it("is ready only when the Bot Start returned is listed as active; a replayed archived Bot reads as archived", async () => {
    const made = client([]);
    made.list.mockResolvedValueOnce({ enabled: true, agents: [bot("b1", "2026-10-01")] });
    expect(await createCompanyBrainBot(as(made))).toEqual({ kind: "ready", botId: "b1" });
    expect(made.bots.instantiate).toHaveBeenCalledWith({
      recipe: { recipeId: "company-brain", version: "1" }, clientRequestId: expect.stringMatching(/^req_companybrain_/),
    });
    // Every replay returns a Bot archived since; the list leaves it out. Start gives up after 5 in a row.
    const replayed = client([]);
    replayed.bots.instantiate.mockResolvedValue({ agent: { id: "b_archived" }, chatId: "chat_direct", operation: "replayed" });
    expect(await createCompanyBrainBot(as(replayed))).toEqual({ kind: "archived" });
    expect(replayed.bots.instantiate).toHaveBeenCalledTimes(5);
  });

  it("makes a new Bot once when Start replays one the owner archived, keyed on the archived Bot", async () => {
    const requestIds = (fake: ReturnType<typeof client>) =>
      (fake.bots.instantiate.mock.calls as unknown as [{ clientRequestId: string }][]).map(([input]) => input.clientRequestId);
    const first = client([]);
    first.bots.instantiate
      .mockResolvedValueOnce({ agent: { id: "b_archived" }, chatId: "chat_old", operation: "replayed" })
      .mockResolvedValueOnce({ agent: { id: "b2" }, chatId: "chat_direct", operation: "created" });
    first.list.mockResolvedValueOnce({ enabled: true, agents: [] })
      .mockResolvedValue({ enabled: true, agents: [bot("b2", "2026-10-09")] });
    expect(await createCompanyBrainBot(as(first))).toEqual({ kind: "ready", botId: "b2" });
    const ids = requestIds(first);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toMatch(/^req_companybrain_[0-9a-f]{64}$/);
    expect(ids[1]).not.toBe(ids[0]);
    // A second Start (a double click, or another device) asks with the same ids, so it gets the same new Bot.
    const again = client([]);
    again.bots.instantiate
      .mockResolvedValueOnce({ agent: { id: "b_archived" }, chatId: "chat_old", operation: "replayed" })
      .mockResolvedValueOnce({ agent: { id: "b2" }, chatId: "chat_direct", operation: "replayed" });
    again.list.mockResolvedValueOnce({ enabled: true, agents: [] })
      .mockResolvedValue({ enabled: true, agents: [bot("b2", "2026-10-09")] });
    expect(await createCompanyBrainBot(as(again))).toEqual({ kind: "ready", botId: "b2" });
    expect(requestIds(again)).toEqual(ids);
  });

  it("does not create anything when the server has no Company Brain recipe", async () => {
    const fake = client([]);
    fake.bots.recipes.mockResolvedValue([]);
    expect(await createCompanyBrainBot(as(fake))).toEqual({ kind: "unavailable" });
    expect(fake.bots.instantiate).not.toHaveBeenCalled();
  });
});
