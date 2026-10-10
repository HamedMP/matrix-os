// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { BotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";
import { AgentRecipesPanel } from "../../../packages/ui/src/chat-agents/AgentRecipesPanel.js";
import { ChatAgentsPanel, ChatAgentsRailSection } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { ChatAgentsContent } from "../../../packages/ui/src/chat-agents/ChatAgentsContent.js";
import { ChatAgentsWorkspace } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
const recipe = { recipeId: "writing-bot", version: "1", name: "Writing Bot", description: "Writes drafts", output: "A draft" };
function fixture() {
  const client = clientFixture({ matrix: true });
  const bots = { recipes: vi.fn(async () => [recipe]), instantiate: vi.fn(), createCustom: vi.fn() };
  return { client: { ...client, bots: bots as unknown as BotClient }, bots };
}
const scratch = () => screen.getByRole("button", { name: "Start from scratch" });

it("keeps Agents on management while both creation entries open the same scratch-first chooser", async () => {
  const { client, bots } = fixture(), start = vi.fn();
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={start}/>
    <ChatAgentsContent client={client} scopeKey="main"><textarea aria-label="Chat draft" defaultValue="Keep my draft"/></ChatAgentsContent>
  </ChatAgentsWorkspace>);
  fireEvent.click(await screen.findByRole("button", { name: "Agents", exact: true }));
  expect(await screen.findByRole("heading", { name: "Your AI team" })).toBeVisible();
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  expect(screen.getByRole("heading", { name: "New agent", exact: true })).toBeVisible();
  const card = scratch();
  expect(card.closest(".matrix-chat-agent-recipes__grid")?.firstElementChild).toBe(card);
  expect(screen.getByText("Describe it in your own words")).toBeVisible();
  expect(await screen.findByRole("button", { name: "Use Writing Bot" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Agents", exact: true }));
  expect(await screen.findByRole("heading", { name: "Your AI team" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Add new agent" }));
  expect(scratch()).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close Agents" }));
  expect(screen.getByRole("textbox", { name: "Chat draft" })).toHaveValue("Keep my draft");
  expect(start).not.toHaveBeenCalled(); expect(client.create).not.toHaveBeenCalled();
  expect(bots.instantiate).not.toHaveBeenCalled(); expect(bots.createCustom).not.toHaveBeenCalled();
});

it.each([
  { entry: "management", revoked: false },
  { entry: "sidebar +", revoked: false },
  { entry: "management", revoked: true },
])("keeps Build in Chat available through $entry and checks current authority (revoked=$revoked)", async ({ entry, revoked }) => {
  const { client, bots } = fixture(), start = vi.fn(), intent = vi.fn();
  let authorized = true;
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={start}
    onSelectionIntent={intent} isCurrent={() => authorized}/>
    <ChatAgentsContent client={client} scopeKey="main"><textarea aria-label="Chat draft" defaultValue="Keep my draft"/></ChatAgentsContent>
  </ChatAgentsWorkspace>);
  if (entry === "management") {
    fireEvent.click(await screen.findByRole("button", { name: "Agents", exact: true }));
    expect(await screen.findByRole("heading", { name: "Your AI team" })).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  } else fireEvent.click(await screen.findByRole("button", { name: "Add new agent" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ad Spend Watch" } });
  const build = await screen.findByRole("button", { name: "Use Ad Spend Watch" });
  expect(build).toBeEnabled();
  expect(build).toHaveTextContent("Build in Chat");
  expect(start).not.toHaveBeenCalled(); expect(intent).toHaveBeenCalledTimes(1);
  authorized = !revoked;
  fireEvent.click(build);
  if (revoked) {
    expect(start).not.toHaveBeenCalled(); expect(intent).toHaveBeenCalledTimes(1);
  } else {
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.stringContaining("Ad Spend Watch"));
    expect(intent).toHaveBeenCalledTimes(2);
  }
  expect(screen.queryByRole("region", { name: "Agent recipes" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Chat draft" })).toHaveValue("Keep my draft");
  expect(client.create).not.toHaveBeenCalled(); expect(bots.createCustom).not.toHaveBeenCalled();
  expect(bots.instantiate).not.toHaveBeenCalled();
});

it.each(["Cancel", "Close agent settings", "Escape"])("returns an empty scratch form to the filtered chooser via %s without mutation", async action => {
  const { client, bots } = fixture();
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()}/>);
  await waitFor(() => expect(scratch()).toBeEnabled());
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Writing" } });
  const trigger = scratch(); act(() => trigger.focus()); fireEvent.click(trigger);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue("");
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Discard this" } });
  if (action === "Escape") fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
  else fireEvent.click(screen.getByRole("button", { name: action }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("searchbox")).toHaveValue("Writing");
  expect(scratch()).toHaveFocus();
  expect(client.create).not.toHaveBeenCalled(); expect(bots.createCustom).not.toHaveBeenCalled();
  expect(bots.instantiate).not.toHaveBeenCalled();
  fireEvent.click(scratch());
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
});

it("retains preset setup and its cancel path beside scratch", async () => {
  const { client, bots } = fixture();
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(recipe.name);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(scratch()).toBeVisible(); expect(bots.instantiate).not.toHaveBeenCalled();
});

it("keeps the scratch form open and rejects cancel and duplicate submit while creation is pending", async () => {
  const { client } = fixture();
  let complete!: (value: typeof saved) => void;
  client.create.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()}/>);
  await waitFor(() => expect(scratch()).toBeEnabled());
  fireEvent.click(scratch());
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Pending bot" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Write drafts" } });
  const create = screen.getByRole("button", { name: "Create Agent" });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Close agent settings" })).toBeDisabled();
  fireEvent(screen.getByRole("dialog"), new Event("cancel", { bubbles: false, cancelable: true }));
  fireEvent.submit(screen.getByRole("textbox", { name: "Name" }).closest("form")!);
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(client.create).toHaveBeenCalledTimes(1);
  await act(async () => { complete({ ...saved, name: "Pending bot" }); });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("heading", { name: "Your AI team" })).toBeVisible();
});

it("does not open a stale preset Chat after changing computer", async () => {
  const { client, bots } = fixture(), next = fixture(), open = vi.fn();
  let complete!: (value: { chatId: string }) => void;
  bots.instantiate.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
  const panel = render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={open}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  const create = screen.getByRole("button", { name: "Create bot" });
  await waitFor(() => expect(create).toBeEnabled());
  fireEvent.click(create);
  expect(bots.instantiate).toHaveBeenCalledTimes(1);
  panel.rerender(<ChatAgentsPanel client={next.client} onClose={vi.fn()} onOpenBotChat={open}/>);
  expect(await screen.findByRole("heading", { name: "Your AI team" })).toBeVisible();
  await act(async () => { complete({ chatId: "chat_previous_attempt" }); });
  expect(open).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "Your AI team" })).toBeVisible();
});

it("reserves one featured slot without counting scratch and keeps it through search/category filters", () => {
  const start = vi.fn();
  const view = render(<AgentRecipesPanel onStartFromScratch={start} onStartChat={vi.fn()}/>);
  const grid = view.container.querySelector(".matrix-chat-agent-recipes__grid")!;
  expect(grid.children).toHaveLength(6);
  expect(grid.firstElementChild).toBe(scratch());
  const count = screen.getByRole("button", { name: /See all .* templates/ }).textContent;
  fireEvent.click(screen.getByRole("button", { name: /See all .* templates/ }));
  expect(grid.children.length).toBeGreaterThan(6);
  expect(Number(count?.match(/\d+/)?.[0])).toBe(grid.children.length - 1);
  fireEvent.click(screen.getByRole("button", { name: "Show featured templates" }));
  expect(screen.getByRole("button", { name: /See all .* templates/ }).textContent).toBe(count);
  fireEvent.click(screen.getByRole("button", { name: "Sales" }));
  expect(scratch()).toBeVisible();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "no-possible-template-match" } });
  expect(scratch()).toBeVisible(); expect(screen.getByText("No recipes match that search.")).toBeVisible();
  expect(grid.children).toHaveLength(1);
});

it.each(["loading", "unavailable"] as const)("keeps custom creation independent of %s recipe catalog", async status => {
  const { client, bots } = fixture();
  if (status === "loading") bots.recipes.mockImplementation(() => new Promise(() => {}));
  else bots.recipes.mockRejectedValue(new Error("offline"));
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()}/>);
  await waitFor(() => expect(scratch()).toBeEnabled());
  fireEvent.click(scratch());
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue("");
});

it.each(["loading", "disabled", "limit", "catalog"])("preserves the custom-entry %s guard", async reason => {
  const { client } = fixture();
  if (reason === "loading") client.list.mockImplementation(() => new Promise(() => {}));
  if (reason === "disabled") client.list.mockResolvedValue({ enabled: false, agents: [] });
  if (reason === "limit") client.list.mockResolvedValue({ enabled: true, agents: Array.from({ length: 100 }, (_, i) => ({ ...saved, id: `bot_${i}` })) });
  if (reason === "catalog") client.catalog.mockRejectedValue(new Error("offline"));
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()}/>);
  await act(async () => {});
  expect(scratch()).toBeDisabled();
  fireEvent.click(scratch()); expect(screen.queryByRole("dialog")).toBeNull();
});

it("discards scratch navigation and draft when the client scope changes", async () => {
  const first = fixture(), second = fixture();
  const view = render(<ChatAgentsPanel client={first.client} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(scratch());
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "First owner draft" } });
  view.rerender(<ChatAgentsPanel client={second.client} onClose={vi.fn()}/>);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(await screen.findByRole("heading", { name: "Your AI team" })).toBeVisible();
  expect(second.client.create).not.toHaveBeenCalled();
});
