// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { MATRIX_BOT_SELECTION } from "@matrix-os/contracts";
import { AgentRecipesPanel } from "../../../packages/ui/src/chat-agents/AgentRecipesPanel.js";
import { createBotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };

const recipe = { recipeId: "writing-bot", version: "2026-09-27.1", name: "Writing Bot",
  description: "Writes drafts", output: "A draft" };

describe("launch recipe creation", () => {
  it("opens the direct chat returned by the server", async () => {
    const create = vi.fn(async () => "chat_0123456789abcdef");
    const open = vi.fn();
    render(<AgentRecipesPanel botRecipes={[recipe]} onInstantiateBot={create} onOpenBotChat={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("chat_0123456789abcdef"));
    expect(create).toHaveBeenCalledWith({ recipeId: recipe.recipeId, version: recipe.version }, expect.stringMatching(/^req_/), MATRIX_BOT_SELECTION);
  });

  it("keeps the panel open and reuses the request id after a failed attempt", async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error("provider token at /home/matrix"))
      .mockResolvedValueOnce("chat_0123456789abcdef");
    const open = vi.fn();
    render(<AgentRecipesPanel botRecipes={[recipe]} onInstantiateBot={create} onOpenBotChat={open} />);
    fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).not.toMatch(/provider|token|\/home/);
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(create.mock.calls[0]?.[1]).toBe(create.mock.calls[1]?.[1]);
  });

  it("does not fall back to a prompt when launch catalog metadata is unavailable", () => {
    const start = vi.fn();
    render(<AgentRecipesPanel onStartChat={start} botRecipes={[]} onInstantiateBot={vi.fn()} onOpenBotChat={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Use Writing Bot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use Jev Inbox Triage" })).toBeNull();
  });
});

const created = {
  agent: { id: "bot_0123456789abcdef", name: "Writing Bot", avatarSeed: "a".repeat(32), revision: 1, status: "active" },
  chatId: "chat_0123456789abcdef", operation: "created",
};

describe("bot browser client", () => {
  it("validates launch recipes and instantiates with the stable request id", async () => {
    const request = vi.fn(async (path: string) => path.endsWith("bot-recipes")
      ? { recipes: [{ recipeId: "writing-bot", version: "2026-09-27.1", name: "Writing Bot", description: "Writes drafts", output: "A draft" }] }
      : created);
    const client = createBotClient(request);
    expect((await client.recipes())[0]?.name).toBe("Writing Bot");
    const input = { clientRequestId: "req_create_123", recipe: { recipeId: "writing-bot", version: "2026-09-27.1" } };
    expect(await client.instantiate(input)).toMatchObject({ chatId: created.chatId });
    expect(request).toHaveBeenLastCalledWith("/api/chat-agents/instantiate", "POST", input);
  });

  it("returns fixed error copy without exposing server or transport text", async () => {
    const client = createBotClient(async () => { throw Object.assign(new Error("postgres at /home/matrix failed"), { status: 503 }); });
    await expect(client.recipes()).rejects.toThrow("Bots are temporarily unavailable.");
    await expect(client.recipes()).rejects.not.toThrow(/postgres|\/home/);
  });

  it("rejects invalid server payloads with the same generic error", async () => {
    const client = createBotClient(async () => ({ recipes: [{ ...created, instructions: "hidden" }] }));
    await expect(client.recipes()).rejects.toThrow("Bots are temporarily unavailable.");
  });

  it("finds a direct bot for the active Chat", async () => {
    const request = vi.fn(async () => ({ agentId: "bot_0123456789abcdef" }));
    expect(await createBotClient(request).directBot("chat_0123456789abcdef")).toBe("bot_0123456789abcdef");
    expect(request).toHaveBeenCalledWith("/api/chats/chat_0123456789abcdef/bot", "GET", undefined);
  });
});

it("resolves a bot's owner-bound chat with validated transport responses", async () => {
  const request = vi.fn(async () => ({ chatId: "chat_0123456789abcdef" }));
  const client = createBotClient(request);
  expect(await client.directChat("bot_0123456789abcdef")).toBe("chat_0123456789abcdef");
  expect(request).toHaveBeenCalledWith("/api/chat-agents/bot_0123456789abcdef/direct-chat", "GET", undefined);
  await expect(createBotClient(async () => ({ chatId: "invalid!" })).directChat("bot_0123456789abcdef"))
    .rejects.toThrow("Bots are temporarily unavailable.");
});
it('keeps the same creation request when opening the created Chat fails',async()=>{
 const create=vi.fn(async()=> 'chat_bot');const open=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
 render(<AgentRecipesPanel botRecipes={[recipe]} onInstantiateBot={create} onOpenBotChat={open}/>);
 fireEvent.click(screen.getByRole('button',{name:'Use Writing Bot'}));fireEvent.change(screen.getByRole('combobox',{name:'Bot model'}),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Create bot'}));
 await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Create bot'}));
 await waitFor(()=>expect(open).toHaveBeenCalledTimes(2));expect(create.mock.calls[0]?.[1]).toBe(create.mock.calls[1]?.[1]);
});
it('does not navigate after a recipe panel has been left',async()=>{
 let finish!:(id:string)=>void;const create=vi.fn(()=>new Promise<string>(resolve=>{finish=resolve;}));const open=vi.fn();
 const view=render(<AgentRecipesPanel botRecipes={[recipe]} onInstantiateBot={create} onOpenBotChat={open}/>);
 fireEvent.click(screen.getByRole('button',{name:'Use Writing Bot'}));fireEvent.change(screen.getByRole('combobox',{name:'Bot model'}),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'Create bot'}));
 await waitFor(()=>expect(create).toHaveBeenCalledOnce());view.unmount();finish('chat_bot');await Promise.resolve();await Promise.resolve();expect(open).not.toHaveBeenCalled();
});

it("negotiates Bot run IDs and accepts older task summaries", async () => {
  const request = vi.fn(async () => ({ tasks: [{ taskId: "task_abcdefgh", agentId: "bot_research1", chatId: "chat_research",
    status: "waiting_person", revision: 2, updatedAt: "2026-09-28T12:00:00.000Z" }] }));
  const result = await createBotClient(request).tasks("chat_research");
  expect(request).toHaveBeenCalledWith("/api/chats/chat_research/bot-tasks?includeRunIds=true", "GET", undefined);
  expect(result[0]?.runId).toBeUndefined();
});
