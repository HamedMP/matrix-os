// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { BotEditorApps } from "../../../packages/ui/src/chat-agents/bots/BotEditorApps.js";
import { AgentRecipesPanel } from "../../../packages/ui/src/chat-agents/AgentRecipesPanel.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };

it("keeps the saved Agents list behind a dismissible settings dialog and preserves edits after a failed save", async () => {
  const client = clientFixture();
  client.list.mockResolvedValue({ enabled: true, agents: [saved] });
  client.update.mockRejectedValue(new Error("private failure"));
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${saved.name}` }));
  const dialog = screen.getByRole("dialog", { name: "Edit Agent" });
  const fields = within(dialog);
  fireEvent.change(fields.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep these changes" } });
  fireEvent.click(fields.getByRole("button", { name: "Save changes" }));
  expect((await fields.findByRole("alert")).textContent).toContain("Agent could not be saved");
  expect((fields.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe("Keep these changes");
  fireEvent.click(fields.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: `Edit ${saved.name}` })).toBeTruthy();
  expect(screen.queryByText("Build your team")).toBeNull();
});

it("uses the Bot's saved description in its compact identity header and leaves model selection in the composer/details", async () => {
  const bot = { ...saved, recipeRef: { recipeId: "writer", version: "1" } };
  const client = clientFixture();
  client.list.mockResolvedValue({ enabled: true, agents: [bot] });
  client.bots = { directBot: vi.fn(async () => bot.id), interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ grants: [], connections: [], memory: { items: [] }, routines: [], pendingInteractions: [] })) } as never;
  render(<BotChatPanel chatId="chat_bot" client={client} />);
  await screen.findByText(bot.name);
  expect(screen.getByText(bot.description)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Choose bot model" })).toBeNull();
  expect(screen.queryByText("Persistent history")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByRole("complementary", { name: "Bot details" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close bot details" }));
  expect(screen.queryByRole("complementary", { name: "Bot details" })).toBeNull();
});

it("places Bot identity and Details in the host toolbar without a second identity row", async () => {
  const host = document.createElement("header");
  const nextHost = document.createElement("header");
  const detailsHost = document.createElement("section");
  const nextDetailsHost = document.createElement("section");
  document.body.append(host, nextHost, detailsHost, nextDetailsHost);
  const bot = { ...saved, recipeRef: { recipeId: "writer", version: "1" } };
  const client = clientFixture();
  client.list.mockResolvedValue({ enabled: true, agents: [bot] });
  client.bots = { interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ grants: [], connections: [], memory: { items: [] }, routines: [], pendingInteractions: [] })) } as never;
  const view = render(<BotChatPanel chatId="chat_bot" directBotId={bot.id} client={client} headerContainer={host} detailsContainer={detailsHost}
    headerLeading={<button>Toggle Chat sidebar</button>} headerActions={<button>Share</button>} />);
  try {
    await within(host).findByText(bot.name);
    expect(view.container.querySelector(".matrix-bot-identity-bar")).toBeNull();
    expect(within(host).getByRole("button", { name: "Toggle Chat sidebar" })).toBeTruthy();
    expect(within(host).getByRole("button", { name: "Share" })).toBeTruthy();
    fireEvent.click(within(host).getByRole("button", { name: "Details" }));
    expect(await within(detailsHost).findByRole("complementary", { name: "Bot details" })).toBeTruthy();
    view.rerender(<BotChatPanel chatId="chat_bot" directBotId={bot.id} client={client} headerContainer={nextHost} detailsContainer={nextDetailsHost} />);
    expect(host.querySelector(".matrix-bot-identity-bar")).toBeNull();
    expect(within(nextHost).getByText(bot.name)).toBeTruthy();
    expect(within(nextHost).getByRole("button", { name: "Details" }).getAttribute("aria-expanded")).toBe("true");
    expect(within(detailsHost).queryByRole("complementary")).toBeNull();
    expect(detailsHost.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("");
    expect(detailsHost.hasAttribute("data-bot-details-reserved")).toBe(false);
    expect(within(nextDetailsHost).getByRole("complementary", { name: "Bot details" })).toBeTruthy();
    view.rerender(<BotChatPanel chatId="chat_other" directBotId={null} client={client} headerContainer={nextHost} detailsContainer={nextDetailsHost} />);
    expect(nextHost.querySelector(".matrix-bot-identity-bar")).toBeNull();
    expect(within(nextDetailsHost).queryByRole("complementary")).toBeNull();
    expect(nextDetailsHost.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("");
    expect(nextDetailsHost.hasAttribute("data-bot-details-reserved")).toBe(false);
  } finally { view.unmount(); host.remove(); nextHost.remove(); detailsHost.remove(); nextDetailsHost.remove(); }
});

it("keeps template search and setup accessible while showing a compact featured set and expandable full catalog", () => {
  render(<AgentRecipesPanel onStartChat={vi.fn()} />);
  expect(screen.getAllByRole("button", { name: /^Use / }).length).toBeLessThanOrEqual(6);
  fireEvent.click(screen.getByRole("button", { name: /See all .* templates/ }));
  expect(screen.getAllByRole("button", { name: /^Use / }).length).toBeGreaterThan(6);
  fireEvent.change(screen.getByRole("searchbox", { name: "Search recipes" }), { target: { value: "Account Research Desk" } });
  expect(screen.getAllByRole("button", { name: /^Use / })).toHaveLength(1);
});

it("anchors Details to the supplied Chat surface, responds to its width and releases the old owner on scope change", async () => {
  const { act } = await import("@testing-library/react");
  let resized: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: ResizeObserverCallback) { resized = callback; }
    observe() {} disconnect() { disconnect(); }
  });
  const host = document.createElement("section");
  host.className = "matrix-bot-chat-layout";
  host.setAttribute("data-bot-details-reserved", "original");
  let width = 1000;
  vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => ({ width } as DOMRect));
  document.body.append(host);
  const client = clientFixture();
  const bot = { ...saved, recipeRef: { recipeId: "writer", version: "1" } };
  client.list.mockResolvedValue({ enabled: true, agents: [bot] });
  client.bots = { interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ grants: [], connections: [], memory: { items: [] }, routines: [], pendingInteractions: [] })) } as never;
  const view = render(<BotChatPanel chatId="chat_bot" directBotId={bot.id} client={client} detailsContainer={host} />);
  try {
    await screen.findByText(bot.name);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(within(host).getByRole("complementary", { name: "Bot details" }).parentElement).toBe(host);
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("360px");
    expect(host.getAttribute("data-bot-details-reserved")).toBe("true");
    width = 500;
    act(() => resized?.([], {} as ResizeObserver));
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("0px");
    expect(host.getAttribute("data-bot-details-reserved")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Close bot details" }));
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("");
    expect(host.getAttribute("data-bot-details-reserved")).toBe("original");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(within(host).getByRole("complementary", { name: "Bot details" })).toBeTruthy();
    view.rerender(<BotChatPanel chatId="chat_other" directBotId={null} client={client} detailsContainer={host} />);
    expect(within(host).queryByRole("complementary")).toBeNull();
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("");
    expect(host.getAttribute("data-bot-details-reserved")).toBe("original");
    expect(disconnect).toHaveBeenCalled();
  } finally { view.unmount(); host.remove(); vi.unstubAllGlobals(); }
});

it("shows branded connected accounts and clear Chat consent guidance in Agent settings", async () => {
  const client = clientFixture();
  const bot = { ...saved, recipeRef: { recipeId: "writer", version: "1" } };
  client.list.mockResolvedValue({ enabled: true, agents: [bot] });
  client.bots = { recipes: vi.fn(async () => []), authority: vi.fn(async () => ({ grants: [], connections: [{
    service: "gmail", serviceName: "Gmail", logoUrl: "https://pipedream.com/s.v0/gmail/logo/48", state: "connected_not_granted",
    accounts: [
      { displayKey: `acct_${"a".repeat(24)}`, label: "Work", email: "work@example.test", state: "connected_not_granted" },
      { displayKey: `acct_${"b".repeat(24)}`, label: "Personal", email: "personal@example.test", state: "connected_not_granted" },
    ],
  }], memory: { items: [] }, routines: [], pendingInteractions: [] })) } as never;
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${bot.name}` }));
  expect(await screen.findByRole("img", { name: "Gmail" })).toBeTruthy();
  expect(screen.getByText("Gmail")).toBeTruthy();
  expect(screen.getByText("Work")).toBeTruthy();
  expect(screen.getByText("work@example.test")).toBeTruthy();
  expect(screen.getByText("Personal")).toBeTruthy();
  expect(screen.getByText("personal@example.test")).toBeTruthy();
  expect(screen.getAllByText("Permission required")).toHaveLength(2);
  expect(screen.getByText(/Ask this bot to use Gmail in Chat/)).toBeTruthy();
  expect(client.bots!.authority).toHaveBeenCalledWith(bot.id);
  expect(screen.queryByRole("button", { name: /^Connect|^Grant/ })).toBeNull();
});

it("keeps duplicate-label account rows attached to their identity across reorder and removal", () => {
  const accounts = [
    { displayKey: "acct_aaaaaaaaaaaaaaaaaaaaaaaa", label: "Gmail", email: "first@example.test", state: "connected_not_granted" as const },
    { displayKey: "acct_bbbbbbbbbbbbbbbbbbbbbbbb", label: "Gmail", email: "second@example.test", state: "granted" as const },
  ];
  const authority = (rows: typeof accounts) => ({ agentId: "bot_research1", revision: 1, grants: [],
    connections: [{ service: "gmail", state: "granted" as const, accounts: rows }],
    routines: [], pendingInteractions: [], memory: { items: [] } });
  const view = render(<BotEditorApps agentId="bot_research1" authority={authority(accounts)} />);
  const firstRow = screen.getByText("first@example.test").parentElement?.parentElement;
  const secondRow = screen.getByText("second@example.test").parentElement?.parentElement;
  view.rerender(<BotEditorApps agentId="bot_research1" authority={authority([...accounts].reverse())} />);
  expect(screen.getByText("first@example.test").parentElement?.parentElement).toBe(firstRow);
  expect(screen.getByText("second@example.test").parentElement?.parentElement).toBe(secondRow);
  view.rerender(<BotEditorApps agentId="bot_research1" authority={authority([accounts[1]!])} />);
  expect(screen.getByText("second@example.test").parentElement?.parentElement).toBe(secondRow);
});
