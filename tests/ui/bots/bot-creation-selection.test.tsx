// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MATRIX_BOT_SELECTION, type CanonicalProviderCatalog, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { AgentRecipesPanel } from "../../../packages/ui/src/chat-agents/AgentRecipesPanel.js";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { AgentEditor } from "../../../packages/ui/src/chat-agents/AgentEditor.js";
import { BotRecipeSetup } from "../../../packages/ui/src/chat-agents/bots/BotRecipeSetup.js";
import { deriveCanonicalProviderChoices } from "../../../packages/ui/src/canonical-provider-choice.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
const recipe = { recipeId: "writing-bot", version: "2026-09-27.1", name: "Writing Bot", description: "Writes drafts", output: "A draft" };
const dailyRecipe = { ...recipe, recipeId: "personal-daily-brief", name: "Daily Brief" };
function catalog(ready = true): CanonicalProviderCatalog {
  const value = createCanonicalProviderCatalogFixture();
  const base = value.instances[0]!;
  value.instances = [{ ...base, id: "matrix_pi_default", driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    availability: ready ? "available" : "unavailable", connectionState: ready ? "ready" : "credit_reserved",
    models: [{ ...base.models[0]!, id: "sonnet", displayName: "Sonnet", availability: ready ? "available" : "unavailable" }],
    supports: { ...base.supports, interactionModes: ["default"], permissionModes: ["full_access"] },
    defaultSelection: { instanceId: "matrix_pi_default", model: "sonnet" } }];
  return value;
}
const ready = catalog();
const models = deriveCanonicalProviderChoices(ready);
const selection = { instanceId: "matrix_pi_default", model: "sonnet" };
function submitCreate() {
  const button = screen.getByRole("button", { name: "Create bot" }) as HTMLButtonElement;
  fireEvent.click(button);
  fireEvent.submit(button.closest("form")!);
  return button;
}

it.each([
  { name: "empty catalog", models: [], catalog: { ...ready, instances: [] }, loading: false },
  { name: "null catalog despite retained choices", models, catalog: null, loading: false },
  { name: "unavailable catalog despite retained choices", models, catalog: catalog(false), loading: false },
  { name: "loading catalog", models, catalog: ready, loading: true },
])("blocks missing model intent in recipe creation with $name, including direct form submit", ({ models, catalog, loading }) => {
  const create = vi.fn(), open = vi.fn();
  render(<AgentRecipesPanel botRecipes={[recipe]} matrixModels={models} catalog={catalog} catalogLoading={loading} onInstantiateBot={create} onOpenBotChat={open}/>);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  expect(submitCreate().disabled).toBe(true);
  expect(create).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});

it("requires an actual creation placeholder before deliberate Automatic and sends its explicit sentinel", async () => {
  const create = vi.fn(async () => "chat_created");
  render(<AgentRecipesPanel botRecipes={[recipe]} matrixModels={[]} catalog={null} onInstantiateBot={create} onOpenBotChat={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  const picker = screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement;
  expect(picker.selectedOptions[0]!.textContent).toBe("Choose a bot model");
  expect(submitCreate().disabled).toBe(true);
  fireEvent.change(picker, { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ recipeId: recipe.recipeId, version: recipe.version }, expect.stringMatching(/^req_/), MATRIX_BOT_SELECTION));
});

it("blocks a stale recipe choice after refresh while preserving its exact intent", () => {
  const create = vi.fn(), props = { botRecipes: [recipe], matrixModels: models, onInstantiateBot: create, onOpenBotChat: vi.fn() };
  const view = render(<AgentRecipesPanel {...props} catalog={ready}/>);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  view.rerender(<AgentRecipesPanel {...props} catalog={catalog(false)}/>);
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe(JSON.stringify([selection.instanceId, selection.model]));
  expect(submitCreate().disabled).toBe(true); expect(create).not.toHaveBeenCalled();
});

it("submits the ready concrete model as part of the new recipe payload", async () => {
  const create = vi.fn(async () => "chat_created");
  render(<AgentRecipesPanel botRecipes={[recipe]} matrixModels={models} catalog={ready} onInstantiateBot={create} onOpenBotChat={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ recipeId: recipe.recipeId, version: recipe.version }, expect.stringMatching(/^req_/), selection));
});

function dailyClient(value: CanonicalProviderCatalog | null) {
  const client = clientFixture();
  if (value) client.catalog.mockResolvedValue(value); else client.catalog.mockRejectedValue(new Error("offline"));
  const calls = { recipes: vi.fn(async () => [dailyRecipe]), instantiate: vi.fn(async () => ({ chatId: "chat_daily", agent: { ...saved, recipeRef: dailyRecipe } })) };
  return { ...client, bots: calls, calls };
}
it.each(["empty", "unavailable", "failed"] as const)("blocks missing Daily Brief selection with %s catalog", async state => {
  const client = dailyClient(state === "failed" ? null : state === "empty" ? { ...ready, instances: [] } : catalog(false));
  const open = vi.fn();
  render(<ChatAgentsPanel client={client as never} onClose={vi.fn()} onOpenBotChat={open}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  expect(submitCreate().disabled).toBe(true);
  expect(client.calls.instantiate).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
it("Daily Brief sends deliberate Automatic explicitly, and retains the ready concrete default", async () => {
  const client = dailyClient({ ...ready, instances: [] }), open = vi.fn();
  render(<ChatAgentsPanel client={client as never} onClose={vi.fn()} onOpenBotChat={open}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(client.calls.instantiate).toHaveBeenCalledWith({ recipe: { recipeId: dailyRecipe.recipeId, version: dailyRecipe.version }, name: "Personal Daily Brief", clientRequestId: expect.stringMatching(/^req_/), selection: MATRIX_BOT_SELECTION }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_daily"));
});
it("Daily Brief creation includes its ready concrete model", async () => {
  const client = dailyClient(ready);
  render(<ChatAgentsPanel client={client as never} onClose={vi.fn()} onOpenBotChat={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(client.calls.instantiate).toHaveBeenCalledWith(expect.objectContaining({ selection })));
});

it("shared setup rejects a forced submit when disabled, pending, or missing intent", () => {
  const create = vi.fn(), props = { recipe, models, catalog: ready, error: "", onSelectionChange: vi.fn(), onCreate: create, onClose: vi.fn() };
  const view = render(<BotRecipeSetup {...props} selection={selection} pending={false} createDisabled/>);
  submitCreate();
  view.rerender(<BotRecipeSetup {...props} selection={selection} pending/>); fireEvent.submit(screen.getByRole("textbox", { name: "Name" }).closest("form")!);
  view.rerender(<BotRecipeSetup {...props} selection={null} pending={false}/>); submitCreate();
  expect(create).not.toHaveBeenCalled();
});

it("does not describe an unselected creation placeholder as an unavailable saved model", () => {
  const props = { recipe, models, catalog: ready, error: "", pending: false, onSelectionChange: vi.fn(), onCreate: vi.fn(), onClose: vi.fn() };
  const view = render(<BotRecipeSetup {...props} selection={null}/>);
  expect(screen.getByRole("option", { name: "Choose a bot model" })).toBeTruthy();
  expect(screen.queryByText("This saved bot model is unavailable. Choose another model or check Agents & providers.")).toBeNull();
  view.rerender(<BotRecipeSetup {...props} selection={{ ...selection, model: "removed-model" }}/>);
  expect(screen.getByText("This saved bot model is unavailable. Choose another model or check Agents & providers.")).toBeTruthy();
});

it.each([
  { name: "null", selection: null, catalog: ready, loading: false },
  { name: "Automatic", selection: MATRIX_BOT_SELECTION, catalog: ready, loading: false },
  { name: "loading", selection, catalog: ready, loading: true },
  { name: "null catalog", selection, catalog: null, loading: false },
  { name: "stale", selection, catalog: catalog(false), loading: false },
])("keeps custom-new-agent creation fail closed for $name", ({ selection, catalog, loading }) => {
  const save = vi.fn();
  render(<AgentEditor editing="new" draft={{ name: "New", description: "", instructions: "Write", selection: selection as CanonicalChatModelSelection | null, requestId: "req_test" }} pending={false} models={models} catalog={catalog} catalogLoading={loading} recipeCatalog={null} connections={[]} recipeLoading={false} recipeError="" connectionError="" change={vi.fn()} onSave={save} onArchive={vi.fn()} onBack={vi.fn()} onRetryRecipe={vi.fn()}/>);
  const button = screen.getByRole("button", { name: "Create Agent" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true); fireEvent.submit(button.closest("form")!); expect(save).not.toHaveBeenCalled();
});
