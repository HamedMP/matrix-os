// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { MATRIX_BOT_SELECTION, type CanonicalProviderCatalog, type ChatAgent } from "@matrix-os/contracts";
import { createChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { saved } from "../../desktop/chat-agents-fixture.js";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat.js";

afterEach(cleanup);
const planId = "matrix_chatgpt_plan", fundedId = "matrix_pi_default";
const binding = [{ id: "accountId", value: "details-account" }, { id: "grantRevision", value: "3" }];
function catalogFixture(options = binding): CanonicalProviderCatalog {
 const catalog = createCanonicalProviderCatalogFixture(), base = catalog.instances[0]!;
 catalog.drivers.push({ kind: "matrix_pi", displayName: "Matrix AI", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
  { kind: "matrix_bot", displayName: "Matrix Bot", adapterVersion: "1.0.0", capabilityClass: "system_agent" });
 catalog.instances.push({ ...base, id: fundedId, driverKind: "matrix_pi", displayName: "Matrix AI", connectionLabel: "Matrix AI",
  models: [{ ...base.models[0]!, id: "sonnet", displayName: "Sonnet" }], defaultSelection: { instanceId: fundedId, model: "sonnet" } },
  { ...base, id: planId, driverKind: "matrix_bot", displayName: "ChatGPT subscription", supports: { ...base.supports, rootChat: false, permissionModes: ["default"] },
   models: [1, 2].map(n => ({ ...base.models[0]!, id: `owner-model-${n}`, displayName: `Owner model ${n}` })),
   options: options.map(option => ({ id: option.id, label: option.id, kind: "enum", placement: "advanced", values: [{ value: option.value, label: option.value }], defaultValue: option.value })),
   defaultSelection: { instanceId: planId, model: "owner-model-1", options } });
 return catalog;
}
function fixture() {
 let agent: ChatAgent = { ...saved, recipeRef: { recipeId: "writing-bot", version: "1" }, selection: { instanceId: fundedId, model: "sonnet" } };
 let failPatch = false;
 const request = vi.fn(async (_path: string, method: string, body?: unknown) => {
  if (method === "PATCH") {
   if (failPatch) { failPatch = false; throw new Error("Unavailable"); }
   const input = body as { selection: ChatAgent["selection"]; baseRevision: number };
   expect(input.baseRevision).toBe(agent.revision);
   agent = { ...agent, selection: input.selection, revision: agent.revision + 1 };
   return agent;
  }
  return { enabled: true, agents: [agent] };
 });
 const client = createChatAgentClient(request);
 client.bots = { interactions: vi.fn(async () => []), tasks: vi.fn(async () => []), authority: vi.fn(async () => ({ grants: [], connections: [], memory: { items: [] }, routines: [], pendingInteractions: [] })) } as never;
 const update = vi.spyOn(client, "update");
 return { client, request, update, failNextPatch: () => { failPatch = true; }, agent: () => agent, replace: (next: ChatAgent) => { agent = next; } };
}
async function openDetails() {
 await screen.findByText(saved.name);
 fireEvent.click(screen.getByRole("button", { name: "Details" }));
 return await screen.findByRole("combobox", { name: "Bot model" });
}
function savedRouteLabel() {
 return screen.getByRole("heading", { name: "Runs on" }).parentElement!.querySelector("p")!.textContent;
}
function switchConnection(id: string) {
 fireEvent.change(screen.getByRole("combobox", { name: "Connection" }), { target: { value: id } });
}
function chooseModel(id: string, model: string, options?: typeof binding) {
 fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: JSON.stringify(options ? [id, model, options] : [id, model]) } });
}

it("keeps the full Details connection switch local, then uses the real client to persist complete model selections at each revision", async () => {
 const x = fixture(); render(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={catalogFixture()}/>);
 await openDetails(); const savedRoute = savedRouteLabel(); switchConnection(planId);
 expect(savedRouteLabel()).toBe(savedRoute);
 expect(x.update).not.toHaveBeenCalled(); expect(x.request.mock.calls.filter(call => call[1] === "PATCH")).toHaveLength(0);
 expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(planId);
 expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue("unselected");
 expect(screen.queryByRole("alert")).toBeNull();
 chooseModel(planId, "owner-model-1", binding);
 await waitFor(() => expect(x.update).toHaveBeenCalledExactlyOnceWith(saved.id, { selection: { instanceId: planId, model: "owner-model-1", options: binding }, baseRevision: 1 }));
 await waitFor(() => expect(screen.getByRole("combobox", { name: "Connection" })).toBeEnabled());
 chooseModel(planId, "owner-model-2", binding);
 await waitFor(() => expect(x.agent().revision).toBe(3));
 expect(x.update).toHaveBeenLastCalledWith(saved.id, { selection: { instanceId: planId, model: "owner-model-2", options: binding }, baseRevision: 2 });
 await waitFor(() => expect(screen.getByRole("combobox", { name: "Connection" })).toBeEnabled());
 switchConnection(fundedId); expect(x.update).toHaveBeenCalledTimes(2);
 expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue("unselected");
 chooseModel(fundedId, "sonnet"); await waitFor(() => expect(x.agent().revision).toBe(4));
 expect(x.update).toHaveBeenLastCalledWith(saved.id, { selection: { instanceId: fundedId, model: "sonnet" }, baseRevision: 3 });
});

it.each(["catalog", "account", "grant", "unavailable"] as const)("retains an unfinished source during %s refresh and saves only an explicit current qualified model", async boundary => {
 const x = fixture(), initial = catalogFixture();
 const view = render(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={initial} refreshKey={0}/>);
 await openDetails(); switchConnection(planId);
 const currentOptions = binding.map(option => boundary === "account" && option.id === "accountId" ? { ...option, value: "current-account" }
  : boundary === "grant" && option.id === "grantRevision" ? { ...option, value: "4" } : option);
 const refreshed = catalogFixture(currentOptions); refreshed.revision = "fresh_catalog";
 if (boundary === "unavailable") { refreshed.instances[2]!.availability = "unavailable"; refreshed.instances[2]!.defaultSelection = undefined; }
 view.rerender(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={refreshed} catalogLoading refreshKey={1}/>);
 expect(screen.getByRole("combobox", { name: "Bot model" })).toBeDisabled();
 expect(x.update).not.toHaveBeenCalled();
 await act(async () => { await Promise.resolve(); });
 view.rerender(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={refreshed} refreshKey={1}/>);
 expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(planId);
 expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue("unselected");
 expect(x.update).not.toHaveBeenCalled();
 if (boundary === "unavailable") {
  expect(within(screen.getByRole("combobox", { name: "Bot model" })).queryByRole("option", { name: /Owner model/ })).toBeNull();
 } else {
  chooseModel(planId, "owner-model-2", currentOptions);
  await waitFor(() => expect(x.update).toHaveBeenCalledExactlyOnceWith(saved.id, { selection: { instanceId: planId, model: "owner-model-2", options: currentOptions }, baseRevision: 1 }));
 }
});

it.each(["close", "edit", "agent", "client", "authoritative"] as const)("discards unfinished Details intent after %s changes", async boundary => {
 const x = fixture(), catalog = catalogFixture();
 const view = render(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={catalog} refreshKey={0}/>);
 await openDetails(); switchConnection(planId); expect(x.update).not.toHaveBeenCalled();
 if (boundary === "close") { fireEvent.click(screen.getByRole("button", { name: "Close bot details" })); fireEvent.click(screen.getByRole("button", { name: "Details" })); }
 if (boundary === "edit") {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  fireEvent.click(screen.getByRole("button", { name: "Edit bot" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
 }
 if (boundary === "authoritative") {
  x.replace({ ...x.agent(), revision: 2, selection: { instanceId: fundedId, model: "sonnet" } });
  view.rerender(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={catalog} refreshKey={1}/>);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(fundedId));
 }
 if (boundary === "agent" || boundary === "client") {
  const next = boundary === "client" ? fixture() : x;
  const id = boundary === "agent" ? "bot_other001" : saved.id;
  next.replace({ ...next.agent(), id });
  view.rerender(<BotChatPanel chatId="chat_next" directBotId={id} client={next.client} catalog={catalog} refreshKey={1}/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Details" })).toHaveAttribute("aria-expanded", "false"));
  await openDetails();
 }
 expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(fundedId);
 expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue(JSON.stringify([fundedId, "sonnet"]));
 expect(x.update).not.toHaveBeenCalled();
});

it("keeps custom Bot ordinary models separate from recipe-only subscription choices", async () => {
 const x = fixture(); x.replace({ ...saved });
 render(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={catalogFixture()}/>);
 await screen.findByText(saved.name); fireEvent.click(screen.getByRole("button", { name: "Details" }));
 const models = screen.getByRole("combobox", { name: "Model" });
 expect(screen.queryByRole("combobox", { name: "Connection" })).toBeNull();
 expect(within(models).queryByRole("option", { name: /ChatGPT subscription|Owner model/ })).toBeNull();
 expect(x.update).not.toHaveBeenCalled();
});

it("persists Automatic only as a complete explicit route and keeps blank connection intent unselected", async () => {
 const x = fixture(); render(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={catalogFixture()}/>);
 await openDetails(); switchConnection(planId);
 expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue("unselected");
 expect(x.update).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole("combobox", { name: "Bot model" }), { target: { value: "" } });
 await waitFor(() => expect(x.update).toHaveBeenCalledExactlyOnceWith(saved.id, { selection: MATRIX_BOT_SELECTION, baseRevision: 1 }));
 await waitFor(() => expect(screen.getByRole("combobox", { name: "Connection" })).toBeEnabled());
 expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue("computer");
 expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue("");
 const automaticRoute = savedRouteLabel(); switchConnection(fundedId);
 expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue("unselected");
 expect(savedRouteLabel()).toBe(automaticRoute); expect(x.update).toHaveBeenCalledTimes(1);
});

it("retains a failed complete draft and safe error without claiming the saved execution route changed, then permits explicit retry", async () => {
 const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
 try {
  const x = fixture(); render(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={catalogFixture()}/>);
  await openDetails(); const savedRoute = savedRouteLabel(); switchConnection(planId);
  x.failNextPatch(); chooseModel(planId, "owner-model-1", binding);
  await screen.findByText("Could not change the bot model. Refresh and try again.");
  expect(x.agent().selection).toEqual({ instanceId: fundedId, model: "sonnet" });
  expect(savedRouteLabel()).toBe(savedRoute);
  expect(screen.getByRole("combobox", { name: "Connection" })).toHaveValue(planId);
  expect(screen.getByRole("combobox", { name: "Bot model" })).toHaveValue(JSON.stringify([planId, "owner-model-1", binding]));
  chooseModel(planId, "owner-model-2", binding);
  await waitFor(() => expect(x.agent().revision).toBe(2));
  expect(x.update).toHaveBeenLastCalledWith(saved.id, { selection: { instanceId: planId, model: "owner-model-2", options: binding }, baseRevision: 1 });
  await waitFor(() => expect(screen.queryByText("Could not change the bot model. Refresh and try again.")).toBeNull());
  expect(savedRouteLabel()).not.toBe(savedRoute);
 } finally { warning.mockRestore(); }
});

it("does not silently rebind an already saved subscription model after account or grant refresh", async () => {
 const x = fixture(); x.replace({ ...x.agent(), selection: { instanceId: planId, model: "owner-model-1", options: binding } });
 const currentOptions = [{ id: "accountId", value: "current-account" }, { id: "grantRevision", value: "4" }];
 const view = render(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={catalogFixture()}/>);
 await openDetails();
 view.rerender(<BotChatPanel chatId="chat_details" directBotId={saved.id} client={x.client} catalog={catalogFixture(currentOptions)}/>);
 expect(x.update).not.toHaveBeenCalled();
 expect(x.agent().selection.options).toEqual(binding);
 expect(within(screen.getByRole("combobox", { name: "Bot model" })).getByRole("option", { name: /owner-model-1 · unavailable/ })).toBeDisabled();
 chooseModel(planId, "owner-model-1", currentOptions);
 await waitFor(() => expect(x.update).toHaveBeenCalledExactlyOnceWith(saved.id, { selection: { instanceId: planId, model: "owner-model-1", options: currentOptions }, baseRevision: 1 }));
});
