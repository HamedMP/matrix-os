// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MATRIX_BOT_SELECTION, type ChatAgent } from "@matrix-os/contracts";
import { AgentEditor } from "../../../packages/ui/src/chat-agents/AgentEditor.js";
import { AgentRecipesPanel } from "../../../packages/ui/src/chat-agents/AgentRecipesPanel.js";
import type { CanonicalProviderChoice } from "../../../packages/ui/src/canonical-provider-choice.js";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
const model: CanonicalProviderChoice = { instanceId: "matrix_pi_default", driverKind: "matrix_pi", harnessLabel: "Pi",
  connectionLabel: "Matrix AI", modelId: "cloudflare:@cf/zai-org/glm-5.3-flash", modelLabel: "GLM 5.3 Flash",
  interactionMode: "default", interactionModes: ["default"], permissionMode: "full_access", permissionModes: ["full_access"],
  options: [], selectedOptions: [], supportsFileAttachments: false };
const recipe = { recipeId: "writing-bot", version: "2026-09-27.1", name: "Writing Bot", description: "Writes drafts", output: "A draft" };
const selected = { instanceId: model.instanceId, model: model.modelId };
const bot = { id: "bot_abcdefgh", revision: 1, recipeRef: recipe } as ChatAgent;
function editor(selection = MATRIX_BOT_SELECTION, models = [model]) {
  const change = vi.fn();
  render(<AgentEditor draft={{ name: "Writer", description: "", instructions: "Write drafts", requestId: "req_test", selection }}
    editing={bot} pending={false} models={models} recipeCatalog={null} connections={[]} recipeLoading={false}
    recipeError="" connectionError="" change={change} onSave={vi.fn()} onArchive={vi.fn()} onBack={vi.fn()} onRetryRecipe={vi.fn()} />);
  return change;
}
it("defaults a new recipe to an exact Matrix model without an implicit Automatic route", async () => {
  const create = vi.fn(async () => "chat_abcdefgh");
  render(<AgentRecipesPanel botRecipes={[recipe]} matrixModels={[model]} onInstantiateBot={create} onOpenBotChat={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  const picker = screen.getByRole("combobox", { name: "Bot model" });
  expect((picker as HTMLSelectElement).value).toBe(JSON.stringify([model.instanceId, model.modelId]));
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ recipeId: recipe.recipeId, version: recipe.version }, expect.stringMatching(/^req_/), selected));
});
it("edits recipe model intent without changing its bot identity or grants", () => {
  const change = editor();
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: JSON.stringify([model.instanceId, model.modelId]) } });
  expect(change).toHaveBeenCalledWith({ selection: selected });
});
it("shows an unavailable saved Matrix choice and requires deliberate reselection", () => {
  const change = editor(selected, []);
  const picker = screen.getByRole("combobox", { name: "Model" });
  expect(screen.getByRole("option", { name: /unavailable/ })).toBeTruthy();
  expect((picker as HTMLSelectElement).value).toBe(JSON.stringify([selected.instanceId, selected.model]));
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(picker, { target: { value: "" } });
  expect(change).toHaveBeenCalledWith({ selection: MATRIX_BOT_SELECTION });
});
it("never offers owner models in a recipe bot's managed model field", () => {
  editor(MATRIX_BOT_SELECTION, [{ ...model, instanceId: "pi_owner", connectionLabel: "Personal key" }, model]);
  expect(screen.getAllByRole("option")).toHaveLength(2);
});

it("uses a new idempotency key when the model changes after a failed creation", async () => {
  const create = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValueOnce("chat_abcdefgh");
  render(<AgentRecipesPanel botRecipes={[recipe]} matrixModels={[model]} onInstantiateBot={create} onOpenBotChat={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await screen.findByRole("alert");
  fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create.mock.calls[0]?.[1]).not.toBe(create.mock.calls[1]?.[1]);
});

it("keeps an exact saved Matrix selection in the revisioned edit request and reopened form", async () => {
  const { ChatAgentsPanel } = await import("../../../packages/ui/src/chat-agents/ChatAgentsEntry.js");
  const { clientFixture, saved } = await import("../../desktop/chat-agents-fixture.js");
  const { createCanonicalProviderCatalogFixture } = await import("../../contracts/fixtures/canonical-chat.js");
  const client = clientFixture();
  const savedBot = { ...saved, recipeRef: recipe, selection: MATRIX_BOT_SELECTION };
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.instances.push({ ...base, id: model.instanceId, driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    models: [{ ...base.models[0]!, id: model.modelId, displayName: model.modelLabel }],
    defaultSelection: selected, supports: { ...base.supports, interactionModes: ["default"], permissionModes: ["full_access"] } });
  client.catalog.mockResolvedValue(catalog);
  client.list.mockResolvedValue({ enabled: true, agents: [savedBot] });
  client.update.mockImplementation(async (_id, input) => ({ ...savedBot, ...input, revision: savedBot.revision + 1 }));
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${savedBot.name}` }));
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: JSON.stringify([model.instanceId, model.modelId]) } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(client.update).toHaveBeenCalledWith(savedBot.id, expect.objectContaining({ baseRevision: savedBot.revision, selection: selected })));
  expect(client.update.mock.calls[0]![1]).not.toHaveProperty("recipe");
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${savedBot.name}` }));
  expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe(JSON.stringify([selected.instanceId, selected.model]));
});

it("shows a bot's saved Matrix model instead of claiming automatic routing", async () => {
  const { BotChatPanel } = await import("../../../packages/ui/src/chat-agents/bots/BotChatPanel.js");
  const client = { bots: { directBot: vi.fn(async () => bot.id), interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ agentId: bot.id, revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })) },
    list: vi.fn(async () => ({ enabled: true, agents: [{ ...bot, name: "Writer", revision: 1, selection: selected }] })) };
  render(<BotChatPanel chatId="chat_abcdefgh" client={client as never} />);
  await screen.findByText("Writer");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(`Matrix AI · ${selected.model}`)).toBeTruthy();
  expect(screen.queryByText("Model: Model routing: automatic")).toBeNull();
  expect(screen.queryByText(/Runtime: Pi/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Choose bot model" })).toBeNull();
});

it("blocks creation when a previously selected Matrix model disappears", () => {
  const create = vi.fn();
  const props = { botRecipes: [recipe], onInstantiateBot: create, onOpenBotChat: vi.fn() };
  const { rerender } = render(<AgentRecipesPanel {...props} matrixModels={[model]} />);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: JSON.stringify([model.instanceId, model.modelId]) } });
  rerender(<AgentRecipesPanel {...props} matrixModels={[]} />);
  expect((screen.getByRole("button", { name: "Create bot" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe(JSON.stringify([selected.instanceId, selected.model]));
  expect(create).not.toHaveBeenCalled();
});

it("offers an exact managed recipe model through the legacy catalog client without connection labels", async () => {
  const { ChatAgentsPanel } = await import("../../../packages/ui/src/chat-agents/ChatAgentsEntry.js");
  const { createChatAgentClient } = await import("../../../packages/ui/src/chat-agents/client.js");
  const { createChatProviderRoutes } = await import("../../../packages/gateway/src/chat/provider-routes.js");
  const { createCanonicalProviderCatalogFixture } = await import("../../contracts/fixtures/canonical-chat.js");
  const { clientFixture } = await import("../../desktop/chat-agents-fixture.js");
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.drivers = [{ ...catalog.drivers[0]!, kind: "matrix_pi", displayName: "Pi" }];
  catalog.instances = [{ ...base, id: model.instanceId, driverKind: "matrix_pi", connectionLabel: "Matrix AI",
    models: [{ ...base.models[0]!, id: "claude-sonnet-5", displayName: "Claude Sonnet 5" }],
    defaultSelection: { instanceId: model.instanceId, model: "claude-sonnet-5" },
    supports: { ...base.supports, interactionModes: ["default"], permissionModes: ["full_access"] } }];
  const routes = createChatProviderRoutes({ catalog: { getCatalog: async () => catalog, refresh: async () => catalog },
    getPrincipal: () => ({ userId: "fixture_owner", source: "jwt" }) });
  const request = vi.fn(async (path: string) => (await routes.request(path)).json());
  const legacyClient = createChatAgentClient(request);
  const instantiate = vi.fn(async () => ({ chatId: "chat_abcdefgh", operation: "created" as const,
    agent: { id: "bot_abcdefgh", name: "Writing Bot", avatarSeed: "a".repeat(32), revision: 1, status: "active" as const } }));
  const client = { ...clientFixture(), catalog: legacyClient.catalog,
    bots: { ...legacyClient.bots!, recipes: vi.fn(async () => [recipe]), instantiate } };
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  const option = await screen.findByRole("option", { name: "Claude Sonnet 5 · Matrix AI" });
  expect(request).toHaveBeenCalledWith("/api/chat-providers?includeConnectionLabels=true&includeConnectionState=true&includeFundingState=true", "GET");
  fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: (option as HTMLOptionElement).value } });
  fireEvent.click(await screen.findByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(instantiate).toHaveBeenCalledWith(expect.objectContaining({
    selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" },
  })));
});

it.each([
  ["available", "Matrix AI · GLM 5.3 Flash"],
  ["credit_reserved", "Matrix AI · GLM 5.3 Flash · credit reserved"],
  ["unavailable", "Matrix AI · GLM 5.3 Flash · unavailable"],
] as const)("preserves the saved Matrix bot model and %s state without harness details", async (state, label) => {
  const { BotChatPanel } = await import("../../../packages/ui/src/chat-agents/bots/BotChatPanel.js");
  const { clientFixture } = await import("../../desktop/chat-agents-fixture.js");
  const { createCanonicalProviderCatalogFixture } = await import("../../contracts/fixtures/canonical-chat.js");
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.instances = [{ ...base, id: model.instanceId, driverKind: "matrix_pi", displayName: "Pi", connectionLabel: "Matrix AI",
    availability: state === "available" ? "available" : "unavailable", connectionState: state === "available" ? "ready" : state,
    models: [{ ...base.models[0]!, id: selected.model, displayName: "GLM 5.3 Flash", availability: state === "available" ? "available" : "unavailable" }] }];
  const fixture = clientFixture();
  const client = { ...fixture, bots: { interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ agentId: bot.id, revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })) } };
  client.list.mockResolvedValue({ enabled: true, agents: [{ ...bot, name: "Writer", selection: selected }] });
  render(<BotChatPanel chatId="chat_abcdefgh" directBotId={bot.id} client={client as never} catalog={catalog} />);
  await screen.findByText("Writer");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText(/Runtime: Pi/)).toBeNull();
  expect(client.update).not.toHaveBeenCalled();
});
it("keeps checking and automatic bot model states distinct while the saved bot loads", async () => {
  const { BotChatPanel } = await import("../../../packages/ui/src/chat-agents/bots/BotChatPanel.js");
  const { clientFixture } = await import("../../desktop/chat-agents-fixture.js");
  const fixture = clientFixture();
  const client = { ...fixture, bots: { interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ agentId: bot.id, revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })) } };
  let resolve!: (value: { enabled: boolean; agents: ChatAgent[] }) => void;
  client.list.mockReturnValue(new Promise(yes => { resolve = yes; }));
  render(<BotChatPanel chatId="chat_abcdefgh" directBotId={bot.id} client={client as never} />);
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText("Checking bot model…")).toBeTruthy();
  resolve({ enabled: true, agents: [{ ...bot, name: "Writer", selection: MATRIX_BOT_SELECTION }] });
  expect(await screen.findByText("Model routing: automatic")).toBeTruthy();
  expect(screen.queryByText(/Runtime: Pi/)).toBeNull();
});


it("does not label an unsupported saved route as Automatic", async () => {
  const { MatrixBotModelField } = await import("../../../packages/ui/src/chat-agents/bots/MatrixBotModelField.js");
  const change = vi.fn();
  const legacy = { instanceId: "codex_default", model: "gpt-old" };
  render(<MatrixBotModelField label="Bot model" selection={legacy} models={[model]} pending={false} onChange={change}/>);
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe(JSON.stringify([legacy.instanceId, legacy.model]));
  expect(screen.getByRole("option", { name: "gpt-old · unavailable" })).toBeTruthy();
  expect(change).not.toHaveBeenCalled();
});

it("keeps a legacy custom Agent route visible and switches explicitly to Matrix AI, persisting on reopen", async () => {
  const { ChatAgentsPanel } = await import("../../../packages/ui/src/chat-agents/ChatAgentsEntry.js");
  const { clientFixture, saved } = await import("../../desktop/chat-agents-fixture.js");
  const client = clientFixture({ matrix: true });
  client.list.mockResolvedValue({ enabled: true, agents: [saved] });
  render(<ChatAgentsPanel client={client} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${saved.name}` }));
  const picker = screen.getByRole("combobox", { name: "Model" });
  expect((picker as HTMLSelectElement).value).toBe(JSON.stringify([saved.selection.instanceId, saved.selection.model]));
  expect(screen.getByRole("option", { name: /Saved route/ }).textContent).toContain("Hermes");
  expect(screen.queryByRole("option", { name: /Codex/ })).toBeNull();
  expect(screen.queryByRole("option", { name: /Automatic/ })).toBeNull();
  fireEvent.change(picker, { target: { value: JSON.stringify(["matrix_pi_default", "sonnet"]) } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(client.update).toHaveBeenCalledWith(saved.id, expect.objectContaining({ selection: { instanceId: "matrix_pi_default", model: "sonnet" }, baseRevision: saved.revision })));
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${saved.name}` }));
  expect((screen.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value).toBe(JSON.stringify(["matrix_pi_default", "sonnet"]));
  expect(screen.queryByRole("option", { name: /Saved route/ })).toBeNull();
});

it("blocks custom Agent model changes during catalog refresh while retaining unchanged text edits", () => {
  const legacy = { id: "bot_legacy", selection: { instanceId: "codex_default", model: "gpt-old" } } as ChatAgent;
  const props = { editing: legacy, pending: false, models: [model], catalogLoading: true, recipeCatalog: null, connections: [], recipeLoading: false,
    recipeError: "", connectionError: "", change: vi.fn(), onSave: vi.fn(), onArchive: vi.fn(), onBack: vi.fn(), onRetryRecipe: vi.fn() };
  const draft = { name: "Legacy", description: "", instructions: "Write", requestId: "req_test", selection: legacy.selection };
  const view = render(<AgentEditor {...props} draft={draft}/>);
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<AgentEditor {...props} draft={{ ...draft, selection: selected }}/>);
  expect((screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);
  expect(props.onSave).not.toHaveBeenCalled();
});

it("does not default or create from retained choices after fresh catalog funding blocks them", async () => {
  const { createCanonicalProviderCatalogFixture } = await import("../../contracts/fixtures/canonical-chat.js");
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.instances = [{ ...base, id: model.instanceId, driverKind: "matrix_pi", availability: "unavailable", connectionState: "credit_reserved",
    models: [{ ...base.models[0]!, id: model.modelId, displayName: model.modelLabel, availability: "unavailable" }] }];
  const create = vi.fn();
  render(<AgentRecipesPanel botRecipes={[recipe]} matrixModels={[model]} catalog={catalog} onInstantiateBot={create} onOpenBotChat={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe("unselected");
  expect((screen.getByRole("option", { name: /Credit reserved/ }) as HTMLOptionElement).disabled).toBe(true);
  fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: JSON.stringify([model.instanceId, model.modelId]) } });
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe("unselected");
  expect(create).not.toHaveBeenCalled();
});

it("defaults when models finish loading without replacing an explicitly chosen Automatic route", () => {
  const props = { botRecipes: [recipe], onInstantiateBot: vi.fn(), onOpenBotChat: vi.fn() };
  const view = render(<AgentRecipesPanel {...props} matrixModels={[]} catalogLoading/>);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  view.rerender(<AgentRecipesPanel {...props} matrixModels={[model]} catalogLoading={false}/>);
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe(JSON.stringify([model.instanceId, model.modelId]));
  fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: "" } });
  view.rerender(<AgentRecipesPanel {...props} matrixModels={[{ ...model, modelId: "other", modelLabel: "Other" }]}/>);
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe("");
});

it("preserves an initialized new recipe model if catalog refresh removes it instead of falling back to Automatic", () => {
  const props = { botRecipes: [recipe], onInstantiateBot: vi.fn(), onOpenBotChat: vi.fn() };
  const view = render(<AgentRecipesPanel {...props} matrixModels={[model]}/>);
  fireEvent.click(screen.getByRole("button", { name: "Use Writing Bot" }));
  view.rerender(<AgentRecipesPanel {...props} matrixModels={[]}/>);
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe(JSON.stringify([model.instanceId, model.modelId]));
  expect((screen.getByRole("button", { name: "Create bot" }) as HTMLButtonElement).disabled).toBe(true);
});

it("shows the same saved legacy route and unavailable state in Bot details and its model field", async () => {
  const { BotDetailsPanel } = await import("../../../packages/ui/src/chat-agents/bots/BotDetailsPanel.js");
  const { createCanonicalProviderCatalogFixture } = await import("../../contracts/fixtures/canonical-chat.js");
  const catalog = createCanonicalProviderCatalogFixture();
  const base = catalog.instances[0]!;
  catalog.instances = [{ ...base, id: "codex_default", driverKind: "codex", displayName: "Codex", connectionLabel: undefined,
    models: [{ ...base.models[0]!, id: "gpt-old", displayName: "GPT Old" }] }];
  render(<BotDetailsPanel agent={{ ...bot, name: "Legacy", selection: { instanceId: "codex_default", model: "gpt-old" } }}
    agentId={bot.id} authority={null} bots={{} as never} catalog={catalog} pending={false} onModelChange={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} onEdit={vi.fn()}/>);
  expect(screen.getByText("GPT Old · Codex · unavailable")).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "Bot model" }) as HTMLSelectElement).value).toBe(JSON.stringify(["codex_default", "gpt-old"]));
  expect(screen.queryByText("Model routing: automatic")).toBeNull();
});
