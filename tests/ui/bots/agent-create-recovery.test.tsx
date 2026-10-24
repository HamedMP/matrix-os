// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import type { BotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";
import { createCanonicalShellChatClient } from "../../../shell/src/lib/canonical-chat-client.js";
import { createCanonicalChatClient } from "../../../desktop/src/renderer/src/lib/canonical-chat-client.js";
import { createApiClient } from "../../../desktop/src/renderer/src/lib/api.js";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function() { this.removeAttribute("open"); };
const selection = { instanceId: "matrix_pi_default", model: "sonnet" };
const agent = { ...saved, name: "My Bot", description: "", instructions: "Prepare a report", selection,
  recipeRef: { recipeId: "custom-coordinator", version: "1" } };
const created = { agent: { id: agent.id, name: agent.name, avatarSeed: "a".repeat(32), revision: 1, status: "active" as const },
  chatId: "chat_created01", operation: "created" as const };
function fixture() {
  const client = clientFixture({ matrix: true });
  const createCustom = vi.fn(async () => { client.list.mockResolvedValue({ enabled: true, agents: [agent] }); return created; });
  const bots = { authority: vi.fn(async () => ({ connections: [], grants: [] })), createCustom, recipes: vi.fn(async () => []), ensureDirectChat: vi.fn(async () => created.chatId) };
  return { client: { ...client, bots: bots as unknown as BotClient }, createCustom, open: vi.fn(), close: vi.fn() };
}
async function draft(x: ReturnType<typeof fixture>) {
  render(<ChatAgentsPanel client={x.client} onClose={x.close} onOpenBotChat={x.open}/>);
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  fireEvent.click(await screen.findByRole("button", { name: "Start from scratch" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: agent.name } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: agent.instructions } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Create Agent" })).toBeEnabled());
}

it("creates a funded scratch Bot through managed admission and opens its saved Chat", async () => {
  const x = fixture(); await draft(x);
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(x.open).toHaveBeenCalledWith(created.chatId));
  expect(x.createCustom).toHaveBeenCalledWith(expect.objectContaining({ selection, name: agent.name }));
  expect(x.client.create).not.toHaveBeenCalled();
  expect(x.close).toHaveBeenCalledTimes(1);
});

it("explains blank recipe output and recomputes after editing or removing the recipe", async () => {
  const x = fixture(); await draft(x);
  fireEvent.click(screen.getByRole("button", { name: "Add recipe" }));
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();
  expect(screen.getByRole("textbox", { name: "Expected output" })).toHaveAttribute("aria-invalid", "true");
  expect(screen.getAllByText("Describe the expected output for this recipe.").length).toBeGreaterThan(0);
  fireEvent.change(screen.getByRole("textbox", { name: "Expected output" }), { target: { value: "   " } });
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Expected output" }), { target: { value: "A verified report" } });
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Remove recipe" }));
  expect(screen.queryByText("Describe the expected output for this recipe.")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(agent.instructions);
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeEnabled();
});

it("serializes same-tick native form submissions", async () => {
  const x = fixture(); await draft(x);
  let resolve!: (value: typeof created) => void;
  x.createCustom.mockImplementation(() => new Promise(value => { resolve = value; }));
  const form = screen.getByRole("button", { name: "Create Agent" }).closest("form")!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(x.createCustom).toHaveBeenCalledTimes(1);
  x.client.list.mockResolvedValue({ enabled: true, agents: [agent] });
  await act(async () => resolve(created));
  expect(x.open).toHaveBeenCalledTimes(1);
});

it("replays the original identity after a lost response then applies draft edits to that Bot", async () => {
  const x = fixture(); await draft(x);
  x.createCustom.mockRejectedValueOnce(new Error("connection lost after commit"));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await screen.findByText(/could not confirm whether your Bot was saved/i);
  const original = x.createCustom.mock.calls[0];
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Revised Bot" } });
  x.client.update.mockResolvedValue({ ...agent, name: "Revised Bot", revision: 2 });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(x.open).toHaveBeenCalledWith(created.chatId));
  expect(x.createCustom.mock.calls[1]).toEqual(original);
  expect(x.client.update).toHaveBeenCalledWith(agent.id, expect.objectContaining({ name: "Revised Bot" }));
  expect(x.client.create).not.toHaveBeenCalled();
});

it("retries opening a committed Bot without another creation", async () => {
  const x = fixture(); await draft(x); x.open.mockRejectedValueOnce(new Error("host unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await screen.findByText(/Bot was created, but setup could not finish/);
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(agent.name);
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(x.open).toHaveBeenCalledTimes(2));
  expect(x.createCustom).toHaveBeenCalledTimes(1);
});

it("preserves selected recipe data through failed refresh and retry", async () => {
  const x = fixture(); await draft(x);
  fireEvent.click(screen.getByRole("button", { name: "Add recipe" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Personal Daily Brief" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Expected output" }), { target: { value: "A verified report" } });
  x.client.recipeCatalog.mockRejectedValueOnce(new Error("private discovery error"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh skills" }));
  await screen.findByText("Recipe options are unavailable. Saved selections are preserved.");
  expect(screen.getByRole("checkbox", { name: "Personal Daily Brief" })).toBeChecked();
  expect(screen.getByRole("textbox", { name: "Expected output" })).toHaveValue("A verified report");
  expect(screen.queryByText("private discovery error")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry recipe options" }));
  await waitFor(() => expect(screen.queryByText("Recipe options are unavailable. Saved selections are preserved.")).toBeNull());
  expect(screen.getByRole("checkbox", { name: "Personal Daily Brief" })).toBeChecked();
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeEnabled();
});

it("keeps model discovery inside the scratch card and restores its ready icon", async () => {
  const x = fixture();
  let resolve!: (value: Awaited<ReturnType<typeof x.client.catalog>>) => void;
  x.client.catalog.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  render(<ChatAgentsPanel client={x.client} view="recipes" onClose={x.close}/>);
  const card = screen.getByRole("button", { name: "Start from scratch" });
  expect(card).toHaveAttribute("aria-busy", "true");
  expect(within(card).getByRole("status")).toHaveTextContent("Loading models…");
  expect(card.querySelector(".matrix-ap-loading-spinner")).not.toBeNull();
  expect(card.querySelector(".lucide-plus")).toBeNull();
  expect(document.querySelector(".matrix-chat-agent-catalog-status")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry models" })).toBeNull();
  expect(card).toBeDisabled();
  const catalog = await clientFixture({ matrix: true }).catalog();
  await act(async () => resolve(catalog));
  await waitFor(() => expect(screen.queryByText("Loading models…")).toBeNull());
  expect(screen.getByRole("button", { name: "Start from scratch" })).toBe(card);
  expect(card).toBeEnabled();
  expect(card).toHaveAttribute("aria-busy", "false");
  expect(card.querySelector(".matrix-ap-loading-spinner")).toBeNull();
  expect(card.querySelector(".lucide-plus")).not.toBeNull();
});

it("offers model retry from a failed chooser and coalesces its pending requests", async () => {
  const x = fixture(); x.client.catalog.mockRejectedValueOnce(new Error("private discovery failure"));
  render(<ChatAgentsPanel client={x.client} view="recipes" onClose={x.close}/>);
  await screen.findByText("Models unavailable. Retry models.");
  const retry = await screen.findByRole("button", { name: "Retry models" });
  expect(within(retry).getByRole("alert")).toHaveTextContent("Models unavailable. Retry models.");
  expect(within(retry).getByText("Start from scratch")).toBeVisible();
  expect(within(retry).getByText("Describe it in your own words")).toBeVisible();
  expect(retry.querySelector("button")).toBeNull();
  expect(document.querySelector(".matrix-chat-agent-catalog-status")).toBeNull();
  expect(retry).toBeEnabled();
  retry.focus(); expect(retry).toHaveFocus();
  let resolve!: (value: Awaited<ReturnType<typeof x.client.catalog>>) => void;
  const catalog = await clientFixture({ matrix: true }).catalog();
  x.client.catalog.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  fireEvent.click(retry); fireEvent.click(retry);
  expect(screen.queryByRole("button", { name: "Retry models" })).toBeNull();
  const loadingCard = screen.getByRole("button", { name: "Start from scratch" });
  expect(loadingCard).toBeDisabled();
  expect(loadingCard).toHaveAttribute("aria-busy", "true");
  expect(within(loadingCard).getByRole("status")).toHaveTextContent("Loading models…");
  expect(x.client.catalog).toHaveBeenCalledTimes(2);
  await act(async () => resolve(catalog));
  await waitFor(() => expect(screen.getByRole("button", { name: "Start from scratch" })).toBeEnabled());
  expect(screen.queryByText("private discovery failure")).toBeNull();
});

it("retries failed model discovery without losing a draft or reusing stale model authority", async () => {
  const x = fixture(); await draft(x);
  const dialog = screen.getByRole("dialog", { name: "New Agent" });
  expect(dialog).toHaveAttribute("open");
  const editor = within(dialog);
  fireEvent.click(editor.getByRole("button", { name: "Add recipe" }));
  fireEvent.click(editor.getByRole("checkbox", { name: "Personal Daily Brief" }));
  fireEvent.change(editor.getByRole("textbox", { name: "Expected output" }), { target: { value: "A verified report" } });
  const model = (editor.getByRole("combobox", { name: "Model" }) as HTMLSelectElement).value;
  x.client.catalog.mockRejectedValueOnce(new Error("private discovery failure"));
  const retry = editor.getByRole("button", { name: "Refresh models" });
  expect(retry).toBeVisible();
  fireEvent.click(retry);
  await screen.findByText("Models could not be refreshed. Your draft is still here.");
  // Native modal editors make the chooser's outer Retry models button inert.
  expect(editor.queryByRole("button", { name: "Retry models" })).toBeNull();
  expect(dialog).toContainElement(retry);
  expect(retry).toBeEnabled();
  expect(editor.getByRole("button", { name: "Create Agent" })).toBeDisabled();
  let resolve!: (value: Awaited<ReturnType<typeof x.client.catalog>>) => void;
  x.client.catalog.mockReturnValueOnce(new Promise(value => { resolve = value; }));
  fireEvent.click(retry);
  expect(retry).toBeDisabled(); expect(editor.getByRole("button", { name: "Create Agent" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Retry models" })).toBeNull();
  const catalog = await clientFixture({ matrix: true }).catalog();
  await act(async () => resolve(catalog));
  await waitFor(() => expect(editor.getByRole("button", { name: "Create Agent" })).toBeEnabled());
  expect(editor.getByRole("textbox", { name: "Name" })).toHaveValue(agent.name);
  expect(editor.getByRole("textbox", { name: "Instructions" })).toHaveValue(agent.instructions);
  expect(editor.getByRole("textbox", { name: "Expected output" })).toHaveValue("A verified report");
  expect(editor.getByRole("checkbox", { name: "Personal Daily Brief" })).toBeChecked();
  expect(editor.getByRole("combobox", { name: "Model" })).toHaveValue(model);
  expect(x.createCustom).not.toHaveBeenCalled();
});

it("submits a valid recipe with optional Ask when run integration", async () => {
  const x = fixture(); await draft(x);
  fireEvent.click(screen.getByRole("button", { name: "Add recipe" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Add integration" }), { target: { value: "gmail" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Expected output" }), { target: { value: "A verified report" } });
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await waitFor(() => expect(x.createCustom).toHaveBeenCalledTimes(1));
  expect(x.createCustom).toHaveBeenCalledWith(expect.objectContaining({ recipe: expect.objectContaining({ skills: [], integrations: [{ service: "gmail" }], output: "A verified report" }) }));
});

it("recovers only the saved funded Bot after explicit action and retains identity after failed opening", async () => {
  const x = fixture(), legacy = { ...agent, recipeRef: undefined };
  x.client.list.mockResolvedValue({ enabled: true, agents: [legacy] });
  const recoverManagedCustom = vi.fn(async () => { x.client.list.mockResolvedValue({ enabled: true, agents: [agent] }); return created; });
  Object.assign(x.client.bots!, { recoverManagedCustom });
  render(<ChatAgentsPanel client={x.client} onClose={x.close} onOpenBotChat={x.open}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${agent.name}` }));
  expect(recoverManagedCustom).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Unsaved" } });
  expect(screen.getByRole("button", { name: "Recover Bot" })).toBeDisabled();
  expect(screen.getByText(/Save your changes or reopen this Bot before recovering/)).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: agent.name } });
  x.open.mockRejectedValueOnce(new Error("host unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Recover Bot" }));
  await screen.findByText(/Bot was recovered, but its Chat could not open/);
  expect(recoverManagedCustom).toHaveBeenCalledExactlyOnceWith(agent.id, { baseRevision: agent.revision });
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(agent.instructions);
  fireEvent.click(screen.getByRole("button", { name: "Recover Bot" }));
  await waitFor(() => expect(x.open).toHaveBeenCalledTimes(2));
  expect(recoverManagedCustom).toHaveBeenCalledTimes(1);
  expect(x.client.create).not.toHaveBeenCalled(); expect(x.createCustom).not.toHaveBeenCalled();
});

it("preserves existing Bot input on recovery conflict and never creates a replacement", async () => {
  const x = fixture(); x.client.list.mockResolvedValue({ enabled: true, agents: [{ ...agent, recipeRef: undefined }] });
  const recoverManagedCustom = vi.fn().mockRejectedValue({ status: 409 });
  Object.assign(x.client.bots!, { recoverManagedCustom });
  render(<ChatAgentsPanel client={x.client} onClose={x.close} onOpenBotChat={x.open}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${agent.name}` }));
  fireEvent.click(screen.getByRole("button", { name: "Recover Bot" }));
  await screen.findByText(/Bot changed since you opened it. Reopen it before recovering/);
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(agent.instructions);
  expect(x.open).not.toHaveBeenCalled(); expect(x.client.create).not.toHaveBeenCalled(); expect(x.createCustom).not.toHaveBeenCalled();
});

it("opens a recovered Bot without overwriting a concurrent definition edit during readback", async () => {
  const x = fixture();
  x.client.list.mockResolvedValue({ enabled: true, agents: [{ ...agent, recipeRef: undefined }] });
  Object.assign(x.client.bots!, { recoverManagedCustom: vi.fn(async () => {
    x.client.list.mockResolvedValue({ enabled: true, agents: [{ ...agent, revision: 3,
      name: "Owner's newer name", instructions: "Owner's newer instructions" }] });
    return created;
  }) });
  render(<ChatAgentsPanel client={x.client} onClose={x.close} onOpenBotChat={x.open}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${agent.name}` }));
  fireEvent.click(screen.getByRole("button", { name: "Recover Bot" }));
  await waitFor(() => expect(x.open).toHaveBeenCalledWith(created.chatId));
  expect(x.client.update).not.toHaveBeenCalled();
  expect(x.client.create).not.toHaveBeenCalled();
  expect(x.createCustom).not.toHaveBeenCalled();
});

it.each([
  ["Web", "prompt_too_large", "Shorten the instructions or remove recipe skills, then try again."],
  ["Electron", "prompt_too_large", "Shorten the instructions or remove recipe skills, then try again."],
  ["Web", "unsupported_skill", "Remove the unavailable skill before creating this Bot."],
  ["Electron", "unsupported_skill", "Remove the unavailable skill before creating this Bot."],
  ["Web", "private/provider/path", "Agent could not be saved. Your changes are still here. Try again or reopen the Agent to refresh."],
  ["Electron", "private/provider/path", "Agent could not be saved. Your changes are still here. Try again or reopen the Agent to refresh."],
] as const)("shows safe %s creation feedback for %s from the actual wire transport", async (surface, reason, message) => {
  const x = fixture();
  const fetchFn = vi.fn(async () => new Response(JSON.stringify({ code: "invalid_request", reason, message: "private/raw provider diagnostic" }),
    { status: 400, headers: { "content-type": "application/json" } }));
  const wire = surface === "Web" ? createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn })
    : createCanonicalChatClient(createApiClient({ baseUrl: "https://matrix.test", getRuntimeSlot: () => "primary", fetchFn }));
  x.client.bots!.createCustom = wire.agents!.bots!.createCustom;
  await draft(x);
  fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
  await screen.findByText(message);
  expect(screen.queryByText("private/raw provider diagnostic")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(agent.instructions);
  expect(screen.getByRole("button", { name: "Create Agent" })).toBeEnabled();
});


it("reopens a file-promoted unfinished recovery and resumes its server-projected original revision", async () => {
  const x = fixture(), promoted = { ...agent, revision: 2 };
  x.client.list.mockResolvedValue(Object.assign({ enabled: true, agents: [promoted] }, {
    managedCustomRecoveries: [{ agentId: agent.id, baseRevision: 1 }],
  }));
  const recoverManagedCustom = vi.fn(async () => {
    x.client.list.mockResolvedValue({ enabled: true, agents: [promoted] });
    return { ...created, agent: { ...created.agent, revision: 2 } };
  });
  Object.assign(x.client.bots!, { recoverManagedCustom });
  const first = render(<ChatAgentsPanel client={x.client} onClose={x.close} onOpenBotChat={x.open}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${agent.name}` }));
  expect(screen.getByRole("button", { name: "Recover Bot" })).toBeEnabled();
  first.unmount();
  render(<ChatAgentsPanel client={x.client} onClose={x.close} onOpenBotChat={x.open}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${agent.name}` }));
  fireEvent.click(screen.getByRole("button", { name: "Recover Bot" }));
  await waitFor(() => expect(x.open).toHaveBeenCalledWith(created.chatId));
  expect(recoverManagedCustom).toHaveBeenCalledExactlyOnceWith(agent.id, { baseRevision: 1 });
  expect(x.client.update).not.toHaveBeenCalled(); expect(x.createCustom).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${agent.name}` }));
  expect(screen.queryByRole("button", { name: "Recover Bot" })).toBeNull();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await screen.findByText("No app access recorded.");
});

it("hides recovery for an active promoted Bot without an unfinished server projection", async () => {
  const x = fixture();
  x.client.list.mockResolvedValue({ enabled: true, agents: [agent] });
  Object.assign(x.client.bots!, { recoverManagedCustom: vi.fn() });
  render(<ChatAgentsPanel client={x.client} onClose={x.close} onOpenBotChat={x.open}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${agent.name}` }));
  await screen.findByText("No app access recorded.");
  expect(screen.queryByRole("button", { name: "Recover Bot" })).toBeNull();
});

it("requires finishing projected recovery before Save can advance the promoted definition", async () => {
  const x = fixture(), promoted = { ...agent, revision: 2 };
  x.client.list.mockResolvedValue(Object.assign({ enabled: true, agents: [promoted] }, {
    managedCustomRecoveries: [{ agentId: agent.id, baseRevision: 1 }],
  }));
  Object.assign(x.client.bots!, { recoverManagedCustom: vi.fn() });
  render(<ChatAgentsPanel client={x.client} onClose={x.close} onOpenBotChat={x.open}/>);
  fireEvent.click(await screen.findByRole("button", { name: `Edit ${agent.name}` }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Uncommitted owner edit" } });
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Recover Bot" })).toBeDisabled();
  expect(screen.getByText(/Finish recovery before saving changes to this Bot/)).toBeTruthy();
  expect(screen.getByText(/Reopen this Bot to discard unsaved changes before recovering/)).toBeTruthy();
  fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);
  expect(x.client.update).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Uncommitted owner edit");
  expect(screen.getByRole("button", { name: "Archive Agent" })).toBeEnabled();
  await screen.findByText("No app access recorded.");
});

it.each(["Web", "Electron"] as const)("opts in to recovery projection through the actual %s list transport", async surface => {
  const wireLibrary = { enabled: true, agents: [agent], managedCustomRecoveries: [{ agentId: agent.id, baseRevision: 1 }] };
  const fetchFn = vi.fn<(input: unknown) => Promise<Response>>(async () => new Response(JSON.stringify(wireLibrary), { status: 200, headers: { "content-type": "application/json" } }));
  const wire = surface === "Web" ? createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn })
    : createCanonicalChatClient(createApiClient({ baseUrl: "https://matrix.test", getRuntimeSlot: () => "primary", fetchFn }));
  expect(await wire.agents!.list()).toMatchObject(wireLibrary);
  expect(String(fetchFn.mock.calls[0]![0])).toContain("/api/chat-agents?includeManagedCustomRecoveries=true");
});
