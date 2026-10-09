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
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled());
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
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Model" })).toBeEnabled());
  const models = screen.getByRole("combobox", { name: "Model" });
  expect(within(models).getByRole("option", { name: "owner-model-2 · unavailable" })).toBeDisabled();
  expect(models).toHaveValue(JSON.stringify([planSelection.instanceId, planSelection.model, stale.options]));
  fireEvent.change(models, { target: { value: JSON.stringify([planSelection.instanceId, planSelection.model, options]) } });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(x.client.update).toHaveBeenCalledWith(saved.id, expect.objectContaining({ selection: planSelection, baseRevision: saved.revision })));
});

 it("saves a new subscription Bot through managed creation and recovers readback without a second logical creation", async () => {
 const x = fixture(); const createCustom = vi.fn(async (_input: unknown) => created);
 (x.bots as unknown as {createCustom: ReturnType<typeof vi.fn>}).createCustom = createCustom;
 x.client.list.mockResolvedValue({ enabled: true, agents: [saved] });
 render(<ChatAgentsPanel client={x.client} onClose={vi.fn()} onOpenBotChat={vi.fn()}/>);
 fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
 const connection = screen.getByRole("combobox", { name: "Connection" });
 await waitFor(() => expect(connection).toBeEnabled());
 fireEvent.change(connection, {target: {value: planSelection.instanceId}});
 expect(within(screen.getByRole("combobox", {name: "Model"})).getAllByRole("option", {name: /Owner model/})).toHaveLength(4);
 fireEvent.change(screen.getByRole("combobox", {name:"Model"}), {target:{value:JSON.stringify([planSelection.instanceId,planSelection.model,options])}});
 fireEvent.change(screen.getByRole("textbox", {name:"Name"}), {target:{value:"My coordinator"}});
 fireEvent.change(screen.getByRole("textbox", {name:"Instructions"}), {target:{value:"Only confirmed actions"}});
 x.client.list.mockRejectedValueOnce(new Error("secret private path"));
 fireEvent.click(screen.getByRole("button", {name:"Create Agent"}));
 await screen.findByRole("alert");
 expect(screen.getByRole("textbox", {name:"Instructions"})).toHaveValue("Only confirmed actions");
 const request=createCustom.mock.calls[0]![0];
 expect(request).toMatchObject({name:"My coordinator",instructions:"Only confirmed actions",selection:planSelection});
 expect(request).not.toHaveProperty("recipeRef");
 x.client.list.mockResolvedValue({enabled:true,agents:[{...saved,id:created.agent.id,name:"My coordinator",selection:planSelection,recipeRef:{recipeId:"custom-coordinator",version:"1"}}]});
 fireEvent.click(screen.getByRole("button", {name:"Create Agent"}));
 await screen.findByText("Saved. Open this bot’s Chat from the sidebar to send a request.");
 expect(createCustom).toHaveBeenLastCalledWith(request);
 expect(x.client.create).not.toHaveBeenCalled();
 });
 it("requires an explicit subscription choice when Matrix AI has no available models", async () => {
 const x=fixture(); (x.bots as unknown as {createCustom:ReturnType<typeof vi.fn>}).createCustom=vi.fn(async()=>created);
 x.catalog.instances=x.catalog.instances.filter(instance=>instance.id===planSelection.instanceId);
 render(<ChatAgentsPanel client={x.client} onClose={vi.fn()}/>);
 fireEvent.click(await screen.findByRole("button", {name:"New Agent"}));
 await waitFor(()=>expect(screen.getByRole("combobox", {name:"Connection"})).toBeEnabled());
 expect(screen.getByRole("combobox", {name:"Connection"})).toHaveValue("matrix_pi_default");
 expect(screen.getByRole("combobox", {name:"Model"})).toHaveValue("unselected");
 });
 it("refreshes recovered models without changing the editor draft", async () => {
 const x=fixture(); render(<ChatAgentsPanel client={x.client} onClose={vi.fn()}/>);
 fireEvent.click(await screen.findByRole("button", {name: "New Agent"}));
 fireEvent.change(screen.getByRole("textbox", {name: "Name"}), {target:{value:"Keep my name"}});
 fireEvent.change(screen.getByRole("textbox", {name:"Instructions"}), {target:{value:"Keep my instructions"}});
 await waitFor(() => expect(screen.getByRole("button", {name:"Refresh models"})).toBeEnabled());
 const next = structuredClone(x.catalog); const pi=next.instances.find(i=>i.id==="matrix_pi_default")!;
 pi.models.push({...pi.models[0]!, id:"glm",displayName:"GLM"}); x.client.catalog.mockResolvedValue(next);
 fireEvent.click(screen.getByRole("button", {name:"Refresh models"}));
 await screen.findByRole("option", {name:"GLM · Matrix AI"});
 expect(screen.getByRole("textbox", {name:"Name"})).toHaveValue("Keep my name");
 expect(screen.getByRole("textbox", {name:"Instructions"})).toHaveValue("Keep my instructions");
 expect(screen.getByRole("combobox", {name:"Model"})).toHaveValue(JSON.stringify(["matrix_pi_default","sonnet"]));
 });

it('recovers the created Bot after a readback failure even if the owner edits the retained draft', async () => {
 const x=fixture(); const createCustom=vi.fn(async()=>created);
 (x.bots as unknown as {createCustom:ReturnType<typeof vi.fn>}).createCustom=createCustom;
 render(<ChatAgentsPanel client={x.client} onClose={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:'New Agent'}));
 await waitFor(()=>expect(screen.getByRole('combobox',{name:'Connection'})).toBeEnabled());
 fireEvent.change(screen.getByRole('combobox',{name:'Connection'}),{target:{value:planSelection.instanceId}});
 fireEvent.change(screen.getByRole('combobox',{name:'Model'}),{target:{value:JSON.stringify([planSelection.instanceId,planSelection.model,options])}});
 fireEvent.change(screen.getByRole('textbox',{name:'Name'}),{target:{value:'Created once'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Instructions'}),{target:{value:'Only confirmed actions'}});
 x.client.list.mockRejectedValueOnce(new Error('readback unavailable'));
 fireEvent.click(screen.getByRole('button',{name:'Create Agent'}));
 await screen.findByRole('alert');
 fireEvent.change(screen.getByRole('textbox',{name:'Name'}),{target:{value:'Recovered name'}});
 const recovered={...saved,id:created.agent.id,name:'Created once',instructions:'Only confirmed actions',description:'',selection:planSelection,recipeRef:{recipeId:'custom-coordinator',version:'1'}};
 x.client.list.mockResolvedValue({enabled:true,agents:[recovered]});
 x.client.update.mockResolvedValue({...recovered,name:'Recovered name'});
 fireEvent.click(screen.getByRole('button',{name:'Create Agent'}));
 await screen.findByText('Saved. Open this bot’s Chat from the sidebar to send a request.');
 expect(createCustom).toHaveBeenCalledTimes(1);
 expect(x.client.update).toHaveBeenCalledWith(created.agent.id,expect.objectContaining({name:'Recovered name',baseRevision:recovered.revision}));
 expect(x.client.create).not.toHaveBeenCalled();
});

it('preserves the supported Hermes executor when a new draft selects the legacy Jev skill', async () => {
 const x=fixture(); (x.bots as unknown as {createCustom:ReturnType<typeof vi.fn>}).createCustom=vi.fn(async()=>created);
 const base=x.catalog.instances[0]!;
 x.catalog.instances.push({...base,id:'hermes_default',driverKind:'hermes',displayName:'Hermes',defaultSelection:{instanceId:'hermes_default',model:'openai-api:gpt-5.6-sol'},models:[{...base.models[0]!,id:'openai-api:gpt-5.6-sol',displayName:'Hermes owner model'}]});
 const recipes=await x.client.recipeCatalog();
 x.client.recipeCatalog.mockResolvedValue({...recipes,skills:[...recipes.skills,{id:'matrix-jev-email-triage',name:'Jev Inbox Triage',description:'Legacy Hermes workflow'}]});
 render(<ChatAgentsPanel client={x.client} onClose={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:'New Agent'}));
 fireEvent.click(await screen.findByRole('button',{name:'Add recipe'}));
 fireEvent.click(await screen.findByRole('checkbox',{name:'Jev Inbox Triage'}));
 await screen.findByRole('option',{name:'Hermes owner model · Hermes'});
 expect(screen.queryByRole('option',{name:/Owner model 2/})).toBeNull();
});

it('removes the committed recipe during retained new-Bot recovery and retries a failed update without another creation', async () => {
 const x=fixture(); const createCustom=vi.fn(async ()=>created);
 (x.bots as unknown as {createCustom:ReturnType<typeof vi.fn>}).createCustom=createCustom;
 render(<ChatAgentsPanel client={x.client} onClose={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:'New Agent'}));
 await waitFor(()=>expect(screen.getByRole('combobox',{name:'Connection'})).toBeEnabled());
 fireEvent.change(screen.getByRole('combobox',{name:'Connection'}),{target:{value:planSelection.instanceId}});
 fireEvent.change(screen.getByRole('combobox',{name:'Model'}),{target:{value:JSON.stringify([planSelection.instanceId,planSelection.model,options])}});
 fireEvent.change(screen.getByRole('textbox',{name:'Name'}),{target:{value:'Created once'}});
 fireEvent.change(screen.getByRole('textbox',{name:/Description/}),{target:{value:'Keep this description'}});
 fireEvent.change(screen.getByRole('textbox',{name:'Instructions'}),{target:{value:'Only confirmed actions'}});
 fireEvent.click(await screen.findByRole('button',{name:'Add recipe'}));
 fireEvent.click(screen.getByRole('checkbox',{name:'Personal Daily Brief'}));
 fireEvent.change(screen.getByRole('textbox',{name:'Expected output'}),{target:{value:'A verified brief'}});
 x.client.list.mockRejectedValueOnce(new Error('readback unavailable'));
 fireEvent.click(screen.getByRole('button',{name:'Create Agent'}));
 await screen.findByRole('alert');
 const committedRecipe={skills:['matrix-personal-daily-brief'],integrations:[],output:'A verified brief'};
 expect(createCustom).toHaveBeenCalledWith(expect.objectContaining({recipe:committedRecipe,selection:planSelection}));
 const recovered={...saved,id:created.agent.id,name:'Created once',description:'Keep this description',
   instructions:'Only confirmed actions',selection:planSelection,recipeRef:{recipeId:'custom-coordinator',version:'1'},recipe:committedRecipe};
 x.client.list.mockResolvedValue({enabled:true,agents:[recovered]});
 x.client.update.mockRejectedValueOnce(new Error('update unavailable'));
 fireEvent.click(screen.getByRole('button',{name:'Remove recipe'}));
 fireEvent.click(screen.getByRole('button',{name:'Create Agent'}));
 await waitFor(()=>expect(x.client.update).toHaveBeenCalledWith(created.agent.id,{
   name:recovered.name,description:recovered.description,instructions:recovered.instructions,
   baseRevision:recovered.revision,recipe:null}));
 await screen.findByRole('alert');
 expect(screen.getByRole('textbox',{name:'Instructions'})).toHaveValue(recovered.instructions);
 expect(screen.getByRole('combobox',{name:'Model'})).toHaveValue(JSON.stringify([planSelection.instanceId,planSelection.model,options]));
 expect(screen.queryByRole('textbox',{name:'Expected output'})).toBeNull();
 x.client.update.mockResolvedValue({...saved,id:created.agent.id,name:recovered.name,description:recovered.description,
   instructions:recovered.instructions,selection:planSelection,recipeRef:recovered.recipeRef,revision:2});
 fireEvent.click(screen.getByRole('button',{name:'Create Agent'}));
 await screen.findByText('Saved. Open this bot’s Chat from the sidebar to send a request.');
 expect(createCustom).toHaveBeenCalledTimes(1);
 expect(x.client.update).toHaveBeenCalledTimes(2);
 expect(x.client.create).not.toHaveBeenCalled();
});
