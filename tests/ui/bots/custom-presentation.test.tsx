// @vitest-environment jsdom
import React from "react";
import { render, cleanup, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { botExecutionPresentation } from "../../../packages/contracts/src/bots/execution-presentation.js";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { saved, clientFixture } from "../../desktop/chat-agents-fixture.js";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
afterEach(cleanup);
it("derives custom selection without coercing its executor or escalating permissions", () => {
 const agent = { ...saved, recipeRef: undefined, selection: { instanceId: "hermes_default", model: "retained" } };
 const catalog = { instances: [{ id: "hermes_default", availability: "available", displayName: "Hermes", driverKind: "hermes", models: [{ id: "retained", displayName: "Retained", availability: "available" }], supports: { permissionModes: ["full_access"], interactionModes: ["default"] } }] } as never;
 const presentation = botExecutionPresentation(agent, catalog);
 expect(presentation).toMatchObject({ kind: "custom", selection: agent.selection, permissionMode: "default", requiresFullAccess: true, available: true });
 expect(botExecutionPresentation(agent, { instances: [] } as never)).toMatchObject({ kind: "custom", available: false });
 expect(botExecutionPresentation({ ...saved, recipeRef: { recipeId: "writing-bot", version: "1" } }, catalog)).toMatchObject({ kind: "recipe", selection: { instanceId: "matrix_bot_default", model: "auto" }, requiresFullAccess: false });
});
it("loads custom Bot identity before reading recipe-only tasks or grants", async () => {
 const base = clientFixture(); base.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipeRef: undefined }] });
 const bots = { directBot: vi.fn(async()=>saved.id), interactions: vi.fn(), tasks: vi.fn(), authority: vi.fn() };
 render(<BotChatPanel chatId="chat_custom" client={{ ...base, bots } as unknown as ChatAgentClient} directBotId={saved.id}/>);
 expect(await screen.findByText(saved.name)).toBeTruthy();
 await waitFor(()=>expect(base.list).toHaveBeenCalled());
 expect(bots.interactions).not.toHaveBeenCalled(); expect(bots.tasks).not.toHaveBeenCalled();expect(bots.authority).not.toHaveBeenCalled();
 expect(screen.queryByRole("alert")).toBeNull();
});

it("preserves legacy recipe and unavailable saved selection when editing only identity text", async () => {
 const { BotEditDialog } = await import("../../../packages/ui/src/chat-agents/bots/BotEditDialog.js");
 HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
 HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
 const agent = { ...saved, recipe: { skills: ["matrix-personal-daily-brief", "matrix-integrations"], integrations: [{ service: "gmail" }], output: "Owner's original output" } };
 const client = clientFixture(), onSaved = vi.fn();
 client.update.mockResolvedValue({ ...agent, name: "Edited name", revision: 2 });
 render(<BotEditDialog agent={agent} client={client} onSaved={onSaved} onClose={vi.fn()}/>);
 expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain(agent.selection.model);
 fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Edited name" } });
 fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
 await waitFor(()=>expect(client.update).toHaveBeenCalledWith(agent.id, { name: "Edited name", description: agent.description, instructions: agent.instructions, baseRevision: 1 }));
 expect(screen.queryByText("Loading access and memory…")).toBeNull();
});

it("keeps a custom saved model visible when its executor catalog has no models", async () => {
 const {BotComposerControls}=await import("../../../packages/ui/src/chat-agents/bots/BotComposerControls.js");
 const agent={...saved,selection:{instanceId:"hermes_default",model:"openai-codex:gpt-5.6-sol"}};
 const client=clientFixture(); const catalog=await client.catalog();
 catalog.instances.find(instance=>instance.id==="hermes_default")!.models=[];
 client.catalog.mockResolvedValue(catalog);
 client.list.mockResolvedValue({enabled:true,agents:[agent]});
 render(<BotComposerControls client={client} agentId={agent.id} catalog={catalog}/>);
 expect(await screen.findByText(/openai-codex:gpt-5.6-sol.*unavailable/)).toBeTruthy();
 expect(client.update).not.toHaveBeenCalled();
});

it.each(["composer", "details", "editor"])("does not mount recipe-only task execution in a custom Bot %s", async (surface) => {
 const {BotComposerControls}=await import("../../../packages/ui/src/chat-agents/bots/BotComposerControls.js");
 const {BotDetailsPanel}=await import("../../../packages/ui/src/chat-agents/bots/BotDetailsPanel.js");
 const {BotEditDialog}=await import("../../../packages/ui/src/chat-agents/bots/BotEditDialog.js");
 HTMLDialogElement.prototype.showModal=function(){this.setAttribute("open", "");};
 HTMLDialogElement.prototype.close=function(){this.removeAttribute("open");};
 const agent={...saved,recipeRef:undefined};
 const client=clientFixture();const catalog=await client.catalog();
 client.list.mockResolvedValue({enabled:true,agents:[agent]});
 const bots={connections:vi.fn(async()=>({connections:[]})),execution:vi.fn(async()=>({revision:0,connectionId:null,model:null,grantRevision:null}))};
 const scoped={...client,bots} as unknown as ChatAgentClient;
 if(surface==="composer"){
  render(<BotComposerControls client={scoped} agentId={agent.id} catalog={catalog}/>);
  await waitFor(()=>expect(screen.getByRole("button",{name:"Choose bot agent and model"}).textContent).toContain(agent.name));
  fireEvent.click(screen.getByRole("button",{name:"Choose bot agent and model"}));
 }else if(surface==="details"){
  render(<BotDetailsPanel agent={agent} agentId={agent.id} authority={null} bots={bots as never} catalog={catalog} pending={false} onModelChange={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} onEdit={vi.fn()}/>);
 }else{
  render(<BotEditDialog agent={agent} client={scoped} catalog={catalog} onSaved={vi.fn()} onClose={vi.fn()}/>);
 }
 expect(screen.queryByRole("combobox",{name:"Task executor"})).toBeNull();
 expect(bots.execution).not.toHaveBeenCalled();
 expect(bots.connections).not.toHaveBeenCalled();
});
