// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { BotComposerControls } from "../../../packages/ui/src/chat-agents/bots/BotComposerControls.js";
import { ChatAgentsWorkspace, useChatAgentsNavigation } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { ChatAgentsContent } from "../../../packages/ui/src/chat-agents/ChatAgentsContent.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
import type { BotTaskSummary } from "@matrix-os/contracts";
afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
function matrixCatalog(available = true) {
  const catalog = createCanonicalProviderCatalogFixture(), base = catalog.instances[0]!;
  catalog.instances.push({ ...base, id: "matrix_pi_default", driverKind: "matrix_pi", connectionLabel: "Matrix AI",
    availability: available ? "available" : "unavailable", unavailabilityReason: available ? undefined : "disabled_in_settings",
    models: [{ ...base.models[0]!, id: "sonnet", displayName: "Sonnet" }],
    defaultSelection: { instanceId: "matrix_pi_default", model: "sonnet" } });
  return catalog;
}
it("creates a new agent with a concrete Matrix AI choice, without coding or Automatic options", async () => {
  const client = clientFixture(); client.catalog.mockResolvedValue(matrixCatalog());
  render(<ChatAgentsPanel client={client} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  const dialog = within(screen.getByRole("dialog", { name: "New Agent" }));
  const picker = dialog.getByRole("combobox", { name: "Model" });
  expect(within(picker).getAllByRole("option").map(option => option.textContent)).toEqual(["Sonnet · Matrix AI"]);
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "Writer" } });
  fireEvent.change(dialog.getByRole("textbox", { name: "Instructions" }), { target: { value: "Write." } });
  fireEvent.click(dialog.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ selection: { instanceId: "matrix_pi_default", model: "sonnet" } })));
});
it("does not fall back to an available coding agent when Matrix AI is disabled", async () => {
  const client = clientFixture(), setup = vi.fn(); client.catalog.mockResolvedValue(matrixCatalog(false));
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} onSetup={setup}/>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  const dialog = within(screen.getByRole("dialog", { name: "New Agent" }));
  const picker = dialog.getByRole("combobox", { name: "Model" });
  expect(picker).toHaveProperty("disabled", true);
  expect(within(picker).queryByRole("option", { name: /undefined/ })).toBeNull();
  expect(dialog.getByText(/Disabled in Settings/)).toBeTruthy();
  fireEvent.change(dialog.getByRole("textbox", { name: "Name" }), { target: { value: "Writer" } });
  fireEvent.change(dialog.getByRole("textbox", { name: "Instructions" }), { target: { value: "Write." } });
  expect(dialog.getByRole("button", { name: "Create Agent" })).toHaveProperty("disabled", true);
  fireEvent.click(dialog.getByRole("button", { name: "Agents & providers" }));
  expect(setup).toHaveBeenCalledOnce(); expect(client.create).not.toHaveBeenCalled();
});
it("uses accurate scoped host titles and removes Back to Chat", async () => {
  const client = clientFixture();
  function Host() {
    const nav = useChatAgentsNavigation()!;
    return <><button onClick={event => nav.open({ client }, event.currentTarget)}>Open team</button><output data-testid="host-title">{nav.opened?.title}</output>
      <ChatAgentsContent client={client} scopeKey="runtime" hostedChrome><p>Chat draft</p></ChatAgentsContent></>;
  }
  render(<ChatAgentsWorkspace><Host/></ChatAgentsWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Open team" }));
  await waitFor(() => expect(screen.getByTestId("host-title").textContent).toBe("Your AI team"));
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  await waitFor(() => expect(screen.getByTestId("host-title").textContent).toBe("New agent"));
  expect(screen.queryByRole("button", { name: "Back to Chat" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.getByTestId("host-title").textContent).toBe("Your AI team"));
});
it("does not duplicate transcript model failures and retains task history in Details", async () => {
  const client = clientFixture(), bot = { ...saved, recipeRef: { recipeId: "writer", version: "1" }, selection: { instanceId: "matrix_bot_default", model: "auto" } };
  const tasks: BotTaskSummary[] = [1, 2, 3].map(n => ({ taskId: `task_${n}`, chatId: "chat_bot", agentId: bot.id, revision: 1, status: "blocked", blockedReason: "model_unavailable", updatedAt: `2026-10-03T00:00:0${n}.000Z` }));
  client.list.mockResolvedValue({ enabled: true, agents: [bot] });
  client.bots = { interactions: vi.fn(async () => []), tasks: vi.fn(async () => tasks), authority: vi.fn(async () => ({ grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })) } as never;
  render(<BotChatPanel chatId="chat_bot" directBotId={bot.id} client={client} catalog={matrixCatalog(false)}/>);
  await screen.findByText(bot.name);
  expect(screen.queryByText("Choose an available model")).toBeNull();
  expect(screen.queryByText("Model unavailable")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  const details = within(screen.getByRole("complementary", { name: "Bot details" }));
  fireEvent.click(details.getByText("Task history"));
  expect(details.getAllByText("Model unavailable")).toHaveLength(3);
  expect(client.update).not.toHaveBeenCalled();
});
it("keeps Automatic truthful while offering safe catalog refresh and settings actions", async () => {
  const client = clientFixture(), setup = vi.fn(), refresh = vi.fn();
  client.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipeRef: { recipeId: "writer", version: "1" }, selection: { instanceId: "matrix_bot_default", model: "auto" } }] });
  render(<BotComposerControls agentId={saved.id} client={client} catalog={matrixCatalog(false)} onSetup={setup} onRefreshCatalog={refresh}/>);
  const trigger = screen.getByRole("button", { name: "Choose bot agent and model" });
  await waitFor(() => expect(trigger.textContent).toContain("Automatic"));
  expect(trigger.textContent).not.toContain("Matrix AI");
  expect(trigger.textContent).not.toContain("managed by this computer");
  fireEvent.click(trigger);
  expect(screen.getByText(/Disabled in Settings/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check availability" })); expect(refresh).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Agents & providers" })); expect(setup).toHaveBeenCalledOnce();
  expect(client.update).not.toHaveBeenCalled();
});

it("rejects stale title reports after reopening or changing clients", () => {
  const client = clientFixture(), nextClient = clientFixture();
  let reportOld!: () => void;
  function Host() {
    const nav = useChatAgentsNavigation()!;
    return <><output data-testid="title">{nav.opened?.title}</output>
      <button onClick={event => { nav.open({ client }, event.currentTarget); const generation = nav.getGeneration(); reportOld = () => nav.setTitle(client, generation, "Edit agent"); }}>Open first</button>
      <button onClick={event => { nav.close(); nav.open({ client }, event.currentTarget); }}>Reopen</button>
      <button onClick={event => nav.open({ client: nextClient, view: "recipes" }, event.currentTarget)}>Open next</button>
      <button onClick={() => reportOld()}>Old reply</button></>;
  }
  render(<ChatAgentsWorkspace><Host/></ChatAgentsWorkspace>);
  fireEvent.click(screen.getByRole("button", { name: "Open first" }));
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  fireEvent.click(screen.getByRole("button", { name: "Old reply" }));
  expect(screen.getByTestId("title").textContent).toBe("Your AI team");
  fireEvent.click(screen.getByRole("button", { name: "Open next" }));
  fireEvent.click(screen.getByRole("button", { name: "Old reply" }));
  expect(screen.getByTestId("title").textContent).toBe("New agent");
});
