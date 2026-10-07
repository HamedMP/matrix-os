// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { BotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
const recipe = { recipeId: "writing-bot", version: "2026-09-27.1", name: "Writing Bot", description: "Writes drafts", output: "A draft" };
const options = [{ id: "accountId", value: "account-selected" }, { id: "grantRevision", value: "3" }];
const planSelection = { instanceId: "matrix_chatgpt_plan", model: "owner-model-2", options };
const created = { agent: { id: "bot_writing01", name: "Writing Bot", avatarSeed: "a".repeat(32), revision: 1, status: "active" as const }, chatId: "chat_writing01", operation: "created" as const };
function fixture() {
  const catalog = createCanonicalProviderCatalogFixture(); const base = catalog.instances[0]!;
  catalog.instances.push({ ...base, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
    supports: { ...base.supports, permissionModes: ["supervised", "full_access"] },
    models: [{ ...base.models[0]!, id: "sonnet", displayName: "Sonnet" }], defaultSelection: { instanceId: "matrix_pi_default", model: "sonnet" } },
  { ...base, id: "matrix_chatgpt_plan", driverKind: "matrix_bot", displayName: "ChatGPT subscription", connectionLabel: "ChatGPT subscription",
    supports: { ...base.supports, permissionModes: ["default"], rootChat: false }, defaultSelection: planSelection,
    options: options.map(option => ({ id: option.id, label: option.id, kind: "enum" as const, values: [{ value: option.value, label: option.value }], defaultValue: option.value, placement: "advanced" as const })),
    models: [1, 2, 3, 4].map(n => ({ ...base.models[0]!, id: `owner-model-${n}`, displayName: `Owner model ${n}` })) });
  const client = clientFixture(); client.catalog.mockResolvedValue(catalog);
  const bots = { recipes: vi.fn(async () => [recipe]), instantiate: vi.fn(async () => created),
    authority: vi.fn(async () => ({ grants: [], connections: [], memory: { items: [] }, routines: [], pendingInteractions: [] })) };
  return { catalog, bots, client: { ...client, bots: bots as unknown as BotClient } };
}

it("routes the full Writing Bot panel through default-permission subscription models with exact account and revision", async () => {
  const x = fixture(), open = vi.fn();
  render(<ChatAgentsPanel client={x.client} view="recipes" onClose={vi.fn()} onOpenBotChat={open}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  const connection = await screen.findByRole("combobox", { name: "Connection" });
  await waitFor(() => expect(connection).toBeEnabled());
  fireEvent.change(connection, { target: { value: planSelection.instanceId } });
  const models = screen.getByRole("combobox", { name: "Bot model" });
  expect(within(models).getAllByRole("option", { name: /Owner model/ })).toHaveLength(4);
  expect(screen.queryByText(/No ChatGPT subscription models available/)).toBeNull();
  fireEvent.change(models, { target: { value: JSON.stringify([planSelection.instanceId, planSelection.model, options]) } });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith(created.chatId));
  expect(x.bots.instantiate).toHaveBeenCalledWith(expect.objectContaining({ recipe: { recipeId: recipe.recipeId, version: recipe.version }, selection: planSelection }));
});

it("retains managed Matrix AI coordinator choices with default permission without granting generic Agents access", async () => {
  const x = fixture(), open = vi.fn();
  x.catalog.instances.find(instance => instance.id === "matrix_pi_default")!.supports.permissionModes = ["default"];
  render(<ChatAgentsPanel client={x.client} view="recipes" onClose={vi.fn()} onOpenBotChat={open}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  const models = await screen.findByRole("combobox", { name: "Bot model" });
  await screen.findByRole("option", { name: "Sonnet · Matrix AI" });
  fireEvent.change(models, { target: { value: JSON.stringify(["matrix_pi_default", "sonnet"]) } });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith(created.chatId));
  expect(x.bots.instantiate).toHaveBeenCalledWith(expect.objectContaining({ selection: { instanceId: "matrix_pi_default", model: "sonnet" } }));
});

it("allows an existing recipe Bot to switch coordinator with account and grant binding preserved", async () => {
  const x = fixture();
  x.client.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipeRef: { recipeId: recipe.recipeId, version: recipe.version }, selection: { instanceId: "matrix_pi_default", model: "sonnet" } }] });
  render(<ChatAgentsPanel client={x.client} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${saved.name}` }));
  fireEvent.change(screen.getByRole("combobox", { name: "Connection" }), { target: { value: planSelection.instanceId } });
  const models = screen.getByRole("combobox", { name: "Model" });
  fireEvent.change(models, { target: { value: JSON.stringify([planSelection.instanceId, planSelection.model, options]) } });
  const save = screen.getByRole("button", { name: "Save changes" }); expect(save).toBeEnabled(); fireEvent.click(save);
  await waitFor(() => expect(x.client.update).toHaveBeenCalledWith(saved.id, expect.objectContaining({ selection: planSelection, baseRevision: saved.revision })));
});

it("keeps subscription models out of generic Agents even if a future descriptor advertises Full access", async () => {
  const x = fixture(); x.catalog.instances.find(instance => instance.id === planSelection.instanceId)!.supports.permissionModes = ["full_access"]; x.client.list.mockResolvedValue({ enabled: true, agents: [saved] });
  render(<ChatAgentsPanel client={x.client} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  expect(screen.queryByRole("option", { name: /ChatGPT subscription/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /Owner model/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: `Edit ${saved.name}` }));
  expect(screen.queryByRole("option", { name: /ChatGPT subscription/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /Owner model/ })).toBeNull();
});

it.each(["wrong driver", "missing account binding", "unavailable catalog"])("refuses recipe creation with %s despite retained subscription model rows", async reason => {
  const x = fixture(); const plan = x.catalog.instances.find(instance => instance.id === planSelection.instanceId)!;
  if (reason === "wrong driver") plan.driverKind = "codex";
  if (reason === "missing account binding") { plan.options = []; delete plan.defaultSelection; }
  if (reason === "unavailable catalog") { plan.availability = "unavailable"; delete plan.defaultSelection; }
  render(<ChatAgentsPanel client={x.client} view="recipes" onClose={vi.fn()} onOpenBotChat={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  const connection = await screen.findByRole("combobox", { name: "Connection" });
  await waitFor(() => expect(connection).toBeEnabled());
  fireEvent.change(connection, { target: { value: planSelection.instanceId } });
  expect(within(screen.getByRole("combobox", { name: "Bot model" })).queryByRole("option", { name: /Owner model/ })).toBeNull();
  const create = screen.getByRole("button", { name: "Create bot" }); expect(create).toBeDisabled();
  fireEvent.click(create); expect(x.bots.instantiate).not.toHaveBeenCalled();
});

it("uses subscription models in the library Daily Brief creation path", async () => {
  const x = fixture(), open = vi.fn();
  const daily = { ...recipe, recipeId: "personal-daily-brief", name: "Daily Brief" };
  x.bots.recipes.mockResolvedValue([daily]);
  render(<ChatAgentsPanel client={x.client} onClose={vi.fn()} onOpenBotChat={open}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  const dialog = await screen.findByRole("dialog", { name: "Set up Personal Daily Brief" });
  fireEvent.change(within(dialog).getByRole("combobox", { name: "Connection" }), { target: { value: planSelection.instanceId } });
  const models = within(dialog).getByRole("combobox", { name: "Bot model" });
  expect(within(models).getAllByRole("option", { name: /Owner model/ })).toHaveLength(4);
  fireEvent.change(models, { target: { value: JSON.stringify([planSelection.instanceId, planSelection.model, options]) } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith(created.chatId));
  expect(x.bots.instantiate).toHaveBeenCalledWith(expect.objectContaining({ recipe: { recipeId: daily.recipeId, version: daily.version }, selection: planSelection }));
});

it("does not reuse a saved stale account/grant binding when selecting a current recipe coordinator", async () => {
  const x = fixture(); const stale = { ...planSelection, options: [{ id: "accountId", value: "previous-account" }, { id: "grantRevision", value: "2" }] };
  x.client.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipeRef: { recipeId: recipe.recipeId, version: recipe.version }, selection: stale }] });
  render(<ChatAgentsPanel client={x.client} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${saved.name}` }));
  const models = screen.getByRole("combobox", { name: "Model" });
  expect(within(models).getByRole("option", { name: "owner-model-2 · unavailable" })).toBeDisabled();
  expect(models).toHaveValue(JSON.stringify([planSelection.instanceId, planSelection.model, stale.options]));
  fireEvent.change(models, { target: { value: JSON.stringify([planSelection.instanceId, planSelection.model, options]) } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(x.client.update).toHaveBeenCalledWith(saved.id, expect.objectContaining({ selection: planSelection, baseRevision: saved.revision })));
});
