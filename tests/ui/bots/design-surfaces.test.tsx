// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
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
    width = 500;
    act(() => resized?.([], {} as ResizeObserver));
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("0px");
    fireEvent.click(screen.getByRole("button", { name: "Close bot details" }));
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(within(host).getByRole("complementary", { name: "Bot details" })).toBeTruthy();
    view.rerender(<BotChatPanel chatId="chat_other" directBotId={null} client={client} detailsContainer={host} />);
    expect(within(host).queryByRole("complementary")).toBeNull();
    expect(host.style.getPropertyValue("--matrix-bot-details-reserve")).toBe("");
    expect(disconnect).toHaveBeenCalled();
  } finally { view.unmount(); host.remove(); vi.unstubAllGlobals(); }
});

it("shows authenticated app access in Agent settings without adding grant or connection actions", async () => {
  const client = clientFixture();
  const bot = { ...saved, recipeRef: { recipeId: "writer", version: "1" } };
  client.list.mockResolvedValue({ enabled: true, agents: [bot] });
  client.bots = { recipes: vi.fn(async () => []), authority: vi.fn(async () => ({ grants: [], connections: [{ service: "gmail", state: "connected_not_granted" }], memory: { items: [] }, routines: [], pendingInteractions: [] })) } as never;
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${bot.name}` }));
  expect(await screen.findByText("Permission required")).toBeTruthy();
  expect(client.bots!.authority).toHaveBeenCalledWith(bot.id);
  expect(screen.queryByRole("button", { name: /^Connect|^Grant/ })).toBeNull();
});
