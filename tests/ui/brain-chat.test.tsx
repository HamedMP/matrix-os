// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainApp } from "../../packages/ui/src/brain/BrainApp.js";
import type { BrainChatHost, BrainChatSlot } from "../../packages/ui/src/brain/BrainChat.js";
import { BotClientError } from "../../packages/ui/src/chat-agents/bots/client.js";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";
import { apiError, fakeBrainApi, PROJECT } from "./brain-fixtures.js";

const PROJECTS = [
  { id: PROJECT, name: "matrix-os", slug: "matrix-os" },
  { id: "proj_second", name: "second", slug: "second" },
];
const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const REMEMBERED = `matrix-os:brain-chat:${PROJECT}`;
const NOT_RUNNING = /Chat with the brain is not running on this computer/;
const BOTS_DOWN = () => new BotClientError(503, "Bots are temporarily unavailable.");

export function thread(id: string, title: string, activityAt = "2026-10-08T10:00:00.000Z") {
  return { chat: { id, title, activityAt, createdAt: activityAt, updatedAt: activityAt, titleVersion: 2 } } as never;
}

export function brainBot(extra: Record<string, unknown> = {}) {
  return {
    id: "agent_brain", archived: false, createdAt: "2026-10-01T00:00:00.000Z",
    recipeRef: { recipeId: "company-brain", version: "2026-10-08.1" }, ...extra,
  };
}

/** A Chat Agents client with a Company Brain Bot unless a test says otherwise. Like the server, it lists active Bots only. */
export function fakeAgents(options: {
  agents?: unknown[]; enabled?: boolean;
  threads?: (agentId: string, input: { projectId: string; cursor?: string }) => Promise<unknown>;
} = {}) {
  const list = vi.fn(async () => ({ enabled: options.enabled ?? true, agents: options.agents ?? [brainBot()] }));
  const threads = {
    list: vi.fn(options.threads ?? (async () => ({ items: [] }))),
    create: vi.fn(async (_agentId: string, _input: { clientRequestId: string }) => thread("chat_new", "New question")),
  };
  const bots = {
    recipes: vi.fn(async () => [{ recipeId: "company-brain", version: "2026-10-08.1", name: "Company Brain", description: "d", output: "o" }]),
    instantiate: vi.fn(async () => ({ agent: { id: "agent_brain" }, chatId: "chat_direct", operation: "created" })),
    threads,
  };
  return { client: { list, bots } as unknown as ChatAgentClient, list, bots, threads };
}

/** A chat host whose view is a stub that records each slot it was given. */
function fakeHost(agents: ChatAgentClient, rows?: BrainChatHost["rows"]) {
  const slots: BrainChatSlot[] = [];
  const openInChat = vi.fn();
  const host: BrainChatHost = {
    agents, openInChat, ...(rows ? { rows } : {}),
    render: (slot) => {
      slots.push(slot);
      return <div data-testid="chat-view">{slot.chatId ?? "draft"} | {slot.prompt} | {slot.promptDetail}</div>;
    },
  };
  return { host, slots, openInChat, last: () => slots[slots.length - 1]! };
}

/** A brain with one connected repository unless a test says otherwise. */
function chatApi(sources: () => Promise<unknown> = async () => ({ items: [{ sourceId: "src_git", kind: "git" }], kinds: [] })) {
  return fakeBrainApi({ sources });
}

function renderChat(host: BrainChatHost, api = chatApi()) {
  return render(<BrainApp api={api} loadProjects={async () => PROJECTS} chat={host} showHeading={false} />);
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  window.localStorage.clear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Brain chat tab", () => {
  it("opens the newest brain chat of the project, remembers it, and lists the others with how long ago", async () => {
    const agents = fakeAgents({ threads: async () => ({ items: [
      thread("chat_a", "Bot chat sidebar", "2026-10-08T10:00:00.000Z"),
      thread("chat_b", "Navigation cache", "2026-10-07T09:00:00.000Z"),
    ] }) });
    const view = fakeHost(agents.client);
    renderChat(view.host);
    expect(await screen.findByTestId("chat-view"))
      .toHaveTextContent("chat_a | Ask about matrix-os | Answers come only from this project's brain, with a link to every source.");
    expect(agents.threads.list).toHaveBeenCalledWith("agent_brain", { projectId: PROJECT, limit: 50 });
    // The first pick is remembered too, so every surface opens the chat the same way after a reload.
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED)).toBe("chat_a"));
    const list = screen.getByRole("list", { name: "Past chats" });
    expect(within(list).getAllByRole("button").map((row) => row.textContent)).toEqual(["Bot chat sidebar2h", "Navigation cache1d"]);
    expect(within(list).getByRole("button", { name: /Bot chat sidebar/ })).toHaveAttribute("aria-current", "true");
    expect(view.last()).toMatchObject({ projectId: PROJECT, agentId: "agent_brain", chatId: "chat_a" });

    fireEvent.click(within(list).getByRole("button", { name: /Navigation cache/ }));
    expect(screen.getByTestId("chat-view")).toHaveTextContent("chat_b");
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED)).toBe("chat_b"));
    fireEvent.click(screen.getByRole("button", { name: "Open in Chat" }));
    expect(view.openInChat).toHaveBeenCalledWith("chat_b");
    cleanup();
    renderChat(fakeHost(agents.client).host);
    expect(await screen.findByTestId("chat-view")).toHaveTextContent("chat_b");
  });

  it("makes one thread on a draft's first send and shows it at once, even when its first turn then fails", async () => {
    const agents = fakeAgents();
    const view = fakeHost(agents.client);
    renderChat(view.host);
    expect(await screen.findByTestId("chat-view")).toHaveTextContent("draft");
    expect(screen.getByText("No brain chats for matrix-os yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in Chat" })).toBeNull();
    expect(agents.threads.create).not.toHaveBeenCalled();

    const slot = view.last();
    agents.threads.list.mockResolvedValue({ items: [thread("chat_new", "What changed this week")] });
    const [first, second] = await act(() => Promise.all([
      slot.createChat({ clientRequestId: "req_one_chat", title: "What changed this week" }),
      slot.createChat({ clientRequestId: "req_two_chat", title: "What changed this week" }),
    ]));
    expect(first).toBe(second);
    expect(agents.threads.create).toHaveBeenCalledTimes(1);
    expect(agents.threads.create).toHaveBeenCalledWith("agent_brain", {
      clientRequestId: "req_one_chat", projectId: PROJECT, title: "What changed this week",
    });
    // No report from the view is needed: the slot knows the thread from createChat and keeps the view mounted.
    expect(await screen.findByRole("button", { name: /What changed this week/ })).toHaveAttribute("aria-current", "true");
    expect(view.last().chatId).toBe("chat_new");
    expect(new Set(view.slots.map((seen) => seen.createChat)).size).toBe(1);
    await waitFor(() => expect(window.localStorage.getItem(REMEMBERED)).toBe("chat_new"));
    expect(screen.getByRole("button", { name: "Open in Chat" })).toBeTruthy();

    // Every admitted turn the view reports reloads the list, so it sorts and dates the chat like the server.
    const before = agents.threads.list.mock.calls.length;
    act(() => view.last().onChatChanged("chat_new", "What changed this week"));
    await waitFor(() => expect(agents.threads.list.mock.calls.length).toBe(before + 1));

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(screen.getByTestId("chat-view")).toHaveTextContent("draft");
    await act(() => view.last().createChat({ clientRequestId: "req_three_chat", title: "Risks" }));
    expect(agents.threads.create).toHaveBeenCalledTimes(2);
  });

  it("keeps the chats Show more loaded, and the open chat's title, when the list reloads", async () => {
    const agents = fakeAgents({ threads: async (_agentId, input) => input.cursor === undefined
      ? { items: [thread("chat_a", "Bot chat sidebar")], nextCursor: "chatcur_2" }
      : { items: [thread("chat_old", "An older question", "2026-09-01T00:00:00.000Z")] } });
    renderChat(fakeHost(agents.client).host);
    await screen.findByTestId("chat-view");
    expect(agents.threads.list).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    fireEvent.click(await screen.findByRole("button", { name: /An older question/ }));
    expect(screen.getByTestId("chat-view")).toHaveTextContent("chat_old");
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(agents.threads.list).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: /An older question/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("An older question", { selector: "p" })).toBeTruthy();
  });

  it("asks once to start the brain chat with a fixed request id and no model, so the server picks Automatic", async () => {
    const agents = fakeAgents({ agents: [] });
    agents.list.mockResolvedValueOnce({ enabled: true, agents: [] })
      .mockResolvedValue({ enabled: true, agents: [brainBot()] });
    agents.bots.instantiate.mockRejectedValueOnce(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    renderChat(fakeHost(agents.client).host);
    expect(await screen.findByRole("heading", { name: "Chat with your Company Brain" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The brain chat could not be started. Try again.");
    expect(warn).toHaveBeenCalledWith("[brain] chat setup failed", "Error");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByTestId("chat-view")).toHaveTextContent("draft");
    expect(agents.bots.recipes).toHaveBeenCalledWith("company-brain");
    const calls = agents.bots.instantiate.mock.calls as unknown as [{ clientRequestId: string }][];
    expect(calls[0]![0]).toEqual({
      recipe: { recipeId: "company-brain", version: "2026-10-08.1" }, clientRequestId: calls[0]![0].clientRequestId,
    });
    expect(calls[0]![0].clientRequestId).toMatch(/^req_companybrain_[0-9a-f]{64}$/);
    expect(calls[1]![0].clientRequestId).toBe(calls[0]![0].clientRequestId);
  });

  it("says when Start returns a Bot that was archived, without promising a way back", async () => {
    const agents = fakeAgents({ agents: [] });
    agents.bots.instantiate.mockResolvedValue({ agent: { id: "agent_archived" }, chatId: "chat_direct", operation: "replayed" });
    renderChat(fakeHost(agents.client).host);
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByText(/The Company Brain chat was archived, so it cannot start here/)).toBeTruthy();
    expect(screen.queryByText(/Restore/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Search" }));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Search");
  });

  it("says chat is not running when Bots are off or answer 503, and retries a failed lookup", async () => {
    renderChat(fakeHost(fakeAgents({ enabled: false }).client).host);
    expect(await screen.findByText(NOT_RUNNING)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Search" }));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Search");
    cleanup();
    // No Bot yet and Bots down: no setup card whose Start could only fail.
    const noBot = fakeAgents({ agents: [] });
    noBot.bots.recipes.mockRejectedValue(BOTS_DOWN());
    renderChat(fakeHost(noBot.client).host);
    expect(await screen.findByText(NOT_RUNNING)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    cleanup();
    // A Bot and Bots down: no draft whose first send could only fail.
    renderChat(fakeHost(fakeAgents({ threads: async () => { throw BOTS_DOWN(); } }).client).host);
    expect(await screen.findByText(NOT_RUNNING)).toBeTruthy();
    expect(screen.queryByTestId("chat-view")).toBeNull();
    cleanup();
    const failing = fakeAgents();
    failing.list.mockRejectedValueOnce(new Error("offline"));
    renderChat(fakeHost(failing.client).host);
    expect(await screen.findByRole("alert")).toHaveTextContent("The brain chat could not be opened.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("chat-view")).toBeTruthy();
  });

  it("asks to connect a source first, or says the brain is off, before any Bot is looked up", async () => {
    const agents = fakeAgents();
    renderChat(fakeHost(agents.client).host, chatApi(async () => ({ items: [], kinds: [] })));
    expect(await screen.findByText("Connect this project's repository in Sources first.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Sources" }));
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Sources");
    cleanup();
    renderChat(fakeHost(agents.client).host, chatApi(async () => { throw apiError("server", "brain_unavailable"); }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The Company Brain is off right now. Try again later.");
    expect(agents.list).not.toHaveBeenCalled();
  });

  it("opens a draft when past chats cannot load, and retries the list", async () => {
    const agents = fakeAgents({ threads: async () => { throw new Error("offline"); } });
    renderChat(fakeHost(agents.client).host);
    expect(await screen.findByTestId("chat-view")).toHaveTextContent("draft");
    expect(screen.getByRole("alert")).toHaveTextContent("Past chats could not be loaded.");
    agents.threads.list.mockResolvedValue({ items: [thread("chat_a", "Bot chat sidebar")] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Past chats" })).toBeTruthy();
    // The draft stays open: a list that arrives late never moves the viewer.
    expect(screen.getByTestId("chat-view")).toHaveTextContent("draft");
  });

  it("renames and deletes a past chat from its menu, then opens the next chat", async () => {
    const agents = fakeAgents({ threads: async () => ({ items: [
      thread("chat_a", "Bot chat sidebar"), thread("chat_b", "Navigation cache", "2026-10-07T09:00:00.000Z"),
    ] }) });
    const rows = { rename: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
    renderChat(fakeHost(agents.client, rows).host);
    await screen.findByTestId("chat-view");
    fireEvent.keyDown(screen.getByRole("button", { name: "More for Bot chat sidebar" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const name = await screen.findByRole("textbox", { name: "Chat name" });
    await waitFor(() => expect(name).toHaveFocus());
    fireEvent.change(name, { target: { value: "Where bot chats show" } });
    fireEvent.submit(name.closest("form")!);
    await waitFor(() => expect(rows.rename).toHaveBeenCalledWith(
      expect.objectContaining({ chat: expect.objectContaining({ id: "chat_a" }) }), "Where bot chats show"));
    const renamed = await screen.findByRole("button", { name: /^Where bot chats show/ });
    await waitFor(() => expect(renamed).toHaveFocus());
    expect(screen.getByText("Where bot chats show", { selector: "p" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("button", { name: "More for Where bot chats show" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    const confirm = within(await screen.findByRole("group", { name: "Delete Where bot chats show" }));
    fireEvent.click(confirm.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rows.remove).toHaveBeenCalledWith("chat_a"));
    // The open chat was deleted: the next one opens, and the deleted row stays gone until the server agrees.
    await waitFor(() => expect(screen.getByTestId("chat-view")).toHaveTextContent("chat_b"));
    expect(screen.queryByRole("button", { name: /Where bot chats show|Bot chat sidebar/ })).toBeNull();
    expect(screen.getByRole("button", { name: "New chat" })).toHaveFocus();
  });

  it("drops a list that answers after a project switch, and folds the list on narrow screens with focus kept", async () => {
    let answerFirst: (value: unknown) => void = () => undefined;
    const agents = fakeAgents({
      threads: (_agentId, input) => input.projectId === PROJECT
        ? new Promise((resolve) => { answerFirst = resolve; })
        : Promise.resolve({ items: [thread("chat_second", "Second project question"), thread("chat_more", "Follow up")] }),
    });
    renderChat(fakeHost(agents.client).host);
    await waitFor(() => expect(agents.threads.list).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: "proj_second" } });
    expect(await screen.findByTestId("chat-view")).toHaveTextContent("chat_second | Ask about second");
    await act(async () => { answerFirst({ items: [thread("chat_old", "From the other project")] }); });
    expect(screen.queryByText("From the other project")).toBeNull();

    const toggle = screen.getByRole("button", { name: "Chats" });
    const list = () => document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(list()).toHaveClass("hidden", "@2xl:grid");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(list()).not.toHaveClass("hidden");
    // Opening moves focus to the open chat; Escape closes the list and returns focus to Chats.
    await waitFor(() => expect(screen.getByRole("button", { name: /Second project question/ })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("button", { name: /Second project question/ }), { key: "Escape" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
    // A pick closes the list and keeps focus on Chats, not on a row that is now hidden.
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /Follow up/ }));
    expect(screen.getByTestId("chat-view")).toHaveTextContent("chat_more");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveFocus();
  });
});
