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

it("opens custom Agent creation from the host catalog without waiting on duplicate discovery", async () => {
  const { client } = fixture();
  const catalog = await client.catalog();
  client.catalog.mockClear();
  client.catalog.mockImplementation(() => new Promise(() => {}));
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()}
    providerCatalog={{ catalog, loading: false, error: "", refresh: vi.fn() }} />);
  await waitFor(() => expect(scratch()).toBeEnabled());
  fireEvent.click(scratch());
  expect(screen.getByRole("region", { name: "New Agent" })).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(client.catalog).not.toHaveBeenCalled();
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
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh models" })).toBeEnabled());
  if (action === "Escape") fireEvent.keyDown(screen.getByRole("region", { name: "New Agent" }), { key: "Escape" });
  else fireEvent.click(screen.getByRole("button", { name: action }));
  expect(screen.queryByRole("region", { name: "New Agent" })).toBeNull();
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
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("searchbox")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(recipe.name);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(scratch()).toBeVisible(); expect(bots.instantiate).not.toHaveBeenCalled();
});

it("keeps the scratch form open and rejects cancel and duplicate submit while creation is pending", async () => {
  const { client, bots } = fixture();
  const response = { agent: { id: saved.id, name: "Pending bot", avatarSeed: "a".repeat(32), revision: 1, status: "active" },
    chatId: "chat_pending01", operation: "created" };
  let complete!: (value: typeof response) => void;
  bots.createCustom.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
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
  fireEvent.keyDown(screen.getByRole("region", { name: "New Agent" }), { key: "Escape" });
  fireEvent.submit(screen.getByRole("textbox", { name: "Name" }).closest("form")!);
  expect(screen.getByRole("region", { name: "New Agent" })).toBeVisible();
  expect(bots.createCustom).toHaveBeenCalledTimes(1);
  expect(client.create).not.toHaveBeenCalled();
  client.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, name: "Pending bot", description: "", instructions: "Write drafts",
    selection: { instanceId: "matrix_pi_default", model: "sonnet" }, recipeRef: { recipeId: "custom-coordinator", version: "1" } }] });
  await act(async () => { complete(response); });
  expect(screen.queryByRole("region", { name: "New Agent" })).toBeNull();
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
  if (reason === "catalog") {
    const retry = screen.getByRole("button", { name: "Retry models" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
  } else {
    expect(scratch()).toBeDisabled(); fireEvent.click(scratch());
  }
  expect(screen.queryByRole("region", { name: "New Agent" })).toBeNull();
});

it("discards scratch navigation and draft when the client scope changes", async () => {
  const first = fixture(), second = fixture();
  const view = render(<ChatAgentsPanel client={first.client} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(scratch());
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "First owner draft" } });
  view.rerender(<ChatAgentsPanel client={second.client} onClose={vi.fn()}/>);
  expect(screen.queryByRole("region", { name: "New Agent" })).toBeNull();
  expect(await screen.findByRole("heading", { name: "Your AI team" })).toBeVisible();
  expect(second.client.create).not.toHaveBeenCalled();
});


it.each([false, true])("keeps in-card catalog retry keyboard-focusable and respects host blocking (blocked=%s)", blocked => {
  const start = vi.fn(), refresh = vi.fn();
  render(<AgentRecipesPanel onStartFromScratch={start} onRefreshCatalog={refresh} scratchDisabled
    catalogError="Models unavailable" scratchRetryDisabled={blocked}/>);
  const retry = screen.getByRole("button", { name: "Retry models" });
  expect(retry.tagName).toBe("BUTTON");
  expect(retry.querySelector("button")).toBeNull();
  if (blocked) expect(retry).toBeDisabled(); else expect(retry).toBeEnabled();
  if (!blocked) { retry.focus(); expect(retry).toHaveFocus(); }
  fireEvent.click(retry);
  expect(refresh).toHaveBeenCalledTimes(blocked ? 0 : 1);
  expect(start).not.toHaveBeenCalled();
});

it("keeps custom creation available when a host refresh fails after a trusted catalog loaded", async () => {
  const start = vi.fn();
  const catalog = await clientFixture({ matrix: true }).catalog();
  render(<AgentRecipesPanel onStartFromScratch={start} catalog={catalog}
    catalogError="Models could not be refreshed. Your draft is still here."/>);
  const entry = screen.getByRole("button", { name: "Start from scratch" });
  expect(entry).toBeEnabled();
  fireEvent.click(entry);
  expect(start).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Retry models" })).toBeNull();
});


it("returns focus to the heading when closing scratch during discovery without stealing it later", async () => {
  const { client, bots } = fixture();
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()}/>);
  await waitFor(() => expect(scratch()).toBeEnabled());
  let resolve!: (value: Awaited<ReturnType<typeof client.catalog>>) => void;
  client.catalog.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  fireEvent.click(scratch());
  const name = screen.getByRole("textbox", { name: "Name" });
  act(() => name.focus());
  fireEvent.change(name, { target: { value: "Discard this" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  const heading = screen.getByRole("heading", { name: "New agent", exact: true });
  expect(scratch()).toBeDisabled();
  expect(heading).toHaveFocus();
  expect(screen.queryByRole("region", { name: "New Agent" })).toBeNull();
  const catalog = await clientFixture({ matrix: true }).catalog();
  await act(async () => resolve(catalog));
  expect(scratch()).toBeEnabled();
  expect(heading).toHaveFocus();
  expect(client.create).not.toHaveBeenCalled();
  expect(bots.createCustom).not.toHaveBeenCalled();
});

it("opens a gallery inspiration as an unsaved scratch draft without inventing resource bindings", async () => {
  const { client, bots } = fixture(), start = vi.fn();
  const record = { chat: { id: "chat_setup01", ownerScope: { type: "personal", ownerId: "owner" }, revision: 0 } };
  const setupChat = { create: vi.fn(async () => record), admitTurn: vi.fn(() => new Promise(() => {})), detail: vi.fn(async () => ({ record, messages: [], activities: [], runs: [], turns: [] })), cancelRun: vi.fn() };
  render(<ChatAgentsPanel client={{ ...client, setupChat: setupChat as never }} view="recipes" onClose={vi.fn()} onStartChat={start}/>);
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Ad Spend Watch" } });
  const useIdea = await screen.findByRole("button", { name: "Use Ad Spend Watch" });
  await waitFor(() => expect(useIdea).toBeEnabled());
  fireEvent.click(useIdea);
  expect(await screen.findByRole("region", { name: "Agent setup conversation" })).toBeVisible();
  await waitFor(() => expect(setupChat.admitTurn).toHaveBeenCalledOnce());
  expect(setupChat.admitTurn).toHaveBeenCalledWith("chat_setup01", expect.objectContaining({
    botCreation: expect.objectContaining({ seed: { kind: "scratch" }, draft: expect.objectContaining({ name: "Ad Spend Watch", description: expect.any(String) }) }),
  }));
  expect(start).not.toHaveBeenCalled();
  expect(bots.createCustom).not.toHaveBeenCalled();
  expect(bots.instantiate).not.toHaveBeenCalled();
  expect(client.create).not.toHaveBeenCalled();
});

it("uses the selected native recipe version and confirms the reviewed configuration on that same recipe", async () => {
  const { client, bots } = fixture(), open = vi.fn();
  const context = { ...recipe, instructions: "Write with the owner's approved research.", skills: [], capabilities: [],
    integrations: [{ service: "gmail", effects: ["read"], required: true }], mcpServers: [] };
  const recipeSetupContext = vi.fn(async () => context);
  bots.instantiate.mockResolvedValue({ chatId: "chat_writing01" });
  const record = { chat: { id: "chat_drafting1", ownerScope: { type: "personal", ownerId: "owner" }, revision: 0 } };
  const setupChat = { create: vi.fn(async () => record), detail: vi.fn(async () => ({ record, activities: [], runs: [], messages: [], turns: [] })),
    admitTurn: vi.fn(() => new Promise(() => {})), cancelRun: vi.fn() };
  render(<ChatAgentsPanel client={{ ...client, bots: { ...bots, recipeSetupContext } as never, setupChat: setupChat as never }}
    onOpenBotChat={open} onClose={vi.fn()} view="recipes" />);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  const ref = { recipeId: recipe.recipeId, version: recipe.version };
  await waitFor(() => expect(recipeSetupContext).toHaveBeenCalledWith(ref));
  await waitFor(() => expect(setupChat.admitTurn).toHaveBeenCalledOnce());
  expect(setupChat.admitTurn).toHaveBeenCalledWith(record.chat.id, expect.objectContaining({ botCreation: expect.objectContaining({
    seed: { kind: "recipe", ...ref }, draft: expect.objectContaining({ name: recipe.name, instructions: context.instructions }),
  }) }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("region", { name: "Recipe resources" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Included in this recipe" }));
  expect(screen.getByRole("region", { name: "Recipe resources" })).toHaveTextContent("Gmail");
  fireEvent.click(screen.getByRole("button", { name: "Add skills" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Matrix integrations" }));
  fireEvent.click(screen.getByRole("button", { name: "Add to configuration" }));
  fireEvent.click(screen.getByRole("button", { name: "Review configuration" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit configuration" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Draft concise answers." } });
  expect(bots.instantiate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_writing01"));
  expect(bots.instantiate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ recipe: ref, name: recipe.name,
    configuration: { description: recipe.description, instructions: "Draft concise answers.",
      recipe: { skills: ["matrix-integrations"], integrations: [], output: context.output } } }));
  expect(bots.createCustom).not.toHaveBeenCalled();
});

it("keeps a failed recipe context read on that template and starts no model turn", async () => {
  const { client, bots } = fixture();
  const setupChat = { create: vi.fn(), detail: vi.fn(), admitTurn: vi.fn(), cancelRun: vi.fn() };
  render(<ChatAgentsPanel client={{ ...client, bots: { ...bots, recipeSetupContext: vi.fn().mockRejectedValue(new Error("offline")) } as never, setupChat }}
    onOpenBotChat={vi.fn()} onClose={vi.fn()} view="recipes"/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Recipe setup is unavailable");
  expect(screen.queryByRole("region", { name: "Agent setup conversation" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByRole("button", { name: "Start from scratch" })).toBeVisible();
  expect(setupChat.admitTurn).not.toHaveBeenCalled();
  expect(bots.instantiate).not.toHaveBeenCalled();
});
