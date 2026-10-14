// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import type { BotCreationChatProps } from "../../../packages/ui/src/chat-agents/BotCreationChat.js";
import type { BotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
afterEach(async () => { await act(async () => {}); cleanup(); });
const recipe = { recipeId: "writing-bot", version: "1", name: "Writing Bot", description: "Writes drafts", output: "A draft" };
function fixture() {
  const client = clientFixture({ matrix: true });
  let definition: typeof saved & { recipeRef?: { recipeId: string; version: string } } | undefined;
  client.list.mockImplementation(async () => ({ enabled: true, agents: definition ? [definition] : [] }));
  const bots = { recipes: vi.fn(async () => [recipe]), instantiate: vi.fn(),
    creationSeed: vi.fn(async () => ({ recipe: { recipeId: recipe.recipeId, version: recipe.version }, editable: true,
      draft: { name: recipe.name, description: recipe.description, instructions: "Write drafts using the owner’s instructions", recipe: { skills: ["matrix-integrations"], integrations: [], output: recipe.output } } })),
    createCustom: vi.fn(async (input) => { definition = { ...saved, ...input, recipeRef: { recipeId: "custom-coordinator", version: "1" } }; return {
      agent: { id: saved.id, name: input.name, avatarSeed: "a".repeat(32), revision: 1, status: "active" as const }, chatId: "chat_custom", operation: "created" as const }; }),
    ensureDirectChat: vi.fn(async () => "chat_custom") };
  return { client: { ...client, bots: bots as unknown as BotClient }, bots };
}
let latest: BotCreationChatProps;
const renderer = (props: BotCreationChatProps) => { latest = props; return <div aria-label="Real Chat host slot">{props.draftBar}</div>; };
async function scratch(client: ReturnType<typeof fixture>["client"], open = vi.fn()) {
  const view = render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={open} renderCreationChat={renderer}/>);
  const trigger = await screen.findByRole("button", { name: "Start from scratch" });
  await waitFor(() => expect(trigger).toBeEnabled()); fireEvent.click(trigger);
  expect(screen.getByText("What should your agent do?")).toBeVisible();
  await waitFor(() => expect(latest.pending).toBe(false));
  return view;
}
function configure() {
  act(() => { expect(latest.applyDraftChange(latest.revision, { name: "My agent", description: "My description",
    instructions: "Prepare an actionable daily brief", recipe: { skills: ["matrix-integrations"],
      integrations: [{ service: "gmail", accountLabel: "Work" }], output: "A brief", jevInboxLabeling: false } })).toBe(true); });
}

it("starts scratch in Chat and round-trips the same full configuration through the optional form", async () => {
  const { client } = fixture(); await scratch(client); configure();
  const before = latest.draft, session = latest.sessionId, revision = latest.revision;
  expect(screen.getByRole("button", { name: "Create agent", exact: true })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Use a form" }));
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("My agent");
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue(before.instructions);
  fireEvent.change(screen.getByRole("textbox", { name: /Description/ }), { target: { value: "Edited in form" } });
  fireEvent.click(screen.getByRole("button", { name: "Back to Chat" }));
  expect(latest.draft).toEqual({ ...before, description: "Edited in form", requestId: latest.draft.requestId });
  expect(latest.draft.requestId).not.toBe(before.requestId); expect(latest.sessionId).toBe(session);
  expect(latest.revision).toBe(revision + 1);
  fireEvent.click(screen.getByRole("button", { name: "Use a form" }));
  const unchanged = latest.draft;
  fireEvent(screen.getByRole("dialog", { name: "Agent form" }), new Event("cancel", { cancelable: true }));
  expect(latest.draft).toBe(unchanged);
  expect(client.bots.createCustom).not.toHaveBeenCalled();
});

it("creates and opens the current Chat-first draft once under StrictMode effect replay", async () => {
  const { client, bots } = fixture(), open = vi.fn();
  render(<React.StrictMode><ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={open} renderCreationChat={renderer}/></React.StrictMode>);
  const trigger = await screen.findByRole("button", { name: "Start from scratch" });
  await waitFor(() => expect(trigger).toBeEnabled()); fireEvent.click(trigger);
  await waitFor(() => expect(latest.pending).toBe(false)); configure();
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_custom"));
  expect(bots.createCustom).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Close Agents" })).toBeEnabled();
});

it("retains the saved agent and real Chat ID on failed open retries without duplicate creation", async () => {
  const { client, bots } = fixture(), open = vi.fn().mockRejectedValueOnce(new Error("open failed")).mockResolvedValue(undefined);
  await scratch(client, open); configure();
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await screen.findByRole("alert"); expect(bots.createCustom).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(bots.createCustom).toHaveBeenCalledTimes(1);
  expect(bots.ensureDirectChat).not.toHaveBeenCalled();
  expect(open).toHaveBeenLastCalledWith("chat_custom");
});

it("finishes executor-only changes for a retained agent without requiring its coordinator catalog again", async () => {
  const { client, bots } = fixture(), open = vi.fn().mockRejectedValueOnce(new Error("open failed")).mockResolvedValue(undefined);
  const configureExecution = vi.fn(async () => undefined);
  Object.assign(bots, { directBot: vi.fn(async () => saved.id),
    execution: vi.fn(async () => ({ revision: 1, connectionId: null })), configureExecution });
  await scratch(client, open); configure();
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await screen.findByRole("alert");
  act(() => expect(latest.applyDraftChange(latest.revision, { taskExecutor: { connectionId: "claude_code_tasks", model: "task_model" } })).toBe(true));
  const current = await client.catalog();
  client.catalog.mockResolvedValue({ ...current, instances: [] });
  fireEvent.click(screen.getByRole("button", { name: "Details", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
  await waitFor(() => expect(latest.pending).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Back to draft" }));
  const retry = screen.getByRole("button", { name: "Retry setup" });
  expect(retry).toBeEnabled(); fireEvent.click(retry);
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(configureExecution).toHaveBeenCalledWith(saved.id, { baseRevision: 1, connectionId: "claude_code_tasks", model: "task_model" });
  expect(bots.createCustom).toHaveBeenCalledTimes(1); expect(client.update).not.toHaveBeenCalled();
});

it("keeps the outer Agents close control disabled while explicit creation is pending", async () => {
  const { client, bots } = fixture();
  let finish!: (value: Awaited<ReturnType<typeof bots.createCustom>>) => void;
  bots.createCustom.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await scratch(client); configure();
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await waitFor(() => expect(bots.createCustom).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Close Agents" })).toBeDisabled();
  await act(async () => { finish({ agent: { id: saved.id, name: "My agent", avatarSeed: "a".repeat(32), revision: 1, status: "active" },
    chatId: "chat_custom", operation: "created" }); });
});

it("reuses the uncertain definition request when only executor intent changes before retry", async () => {
  const { client, bots } = fixture(), open = vi.fn();
  bots.createCustom.mockRejectedValueOnce(new Error("Unconfirmed transport result"));
  Object.assign(bots, { directBot: vi.fn(async () => saved.id), execution: vi.fn(async () => ({ revision: 1, connectionId: null })),
    configureExecution: vi.fn(async () => undefined) });
  await scratch(client, open); configure();
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await screen.findByRole("alert");
  const request = bots.createCustom.mock.calls[0]![0];
  act(() => expect(latest.applyDraftChange(latest.revision, { taskExecutor: { connectionId: "claude_code_tasks", model: "task_model" } })).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_custom"));
  expect(bots.createCustom).toHaveBeenCalledTimes(2);
  expect(bots.createCustom).toHaveBeenLastCalledWith(request);
});

it.each([undefined, "true"])("does not enable a template with malformed editable eligibility %s", async editable => {
  const { client, bots } = fixture();
  const result = await bots.creationSeed();
  bots.creationSeed.mockResolvedValue({ ...result, editable } as never);
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={vi.fn()} renderCreationChat={renderer}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Template configuration is unavailable");
  expect(screen.getByRole("button", { name: "Create agent", exact: true })).toBeDisabled();
  expect(bots.createCustom).not.toHaveBeenCalled();
});

it("preserves an incomplete coordinator source proposal instead of creating with the previous connection", async () => {
  const { client, bots } = fixture(); await scratch(client); configure();
  const previous = latest.draft.selection!;
  act(() => expect(latest.applyDraftChange(latest.revision, { coordinatorInstanceId: "matrix_anthropic_api" })).toBe(true));
  expect(latest.draft.coordinatorInstanceId).toBe("matrix_anthropic_api");
  expect(latest.draft.selection).toBeNull();
  expect(screen.getByRole("button", { name: "Create agent", exact: true })).toBeDisabled();
  act(() => expect(latest.applyDraftChange(latest.revision, { selection: previous })).toBe(true));
  expect(latest.draft.coordinatorInstanceId).toBe(previous.instanceId);
  expect(screen.getByRole("button", { name: "Create agent", exact: true })).toBeEnabled();
  const current = latest.draft;
  act(() => expect(latest.applyDraftChange(latest.revision, { coordinatorInstanceId: "matrix_anthropic_api", selection: previous })).toBe(false));
  expect(latest.draft).toBe(current);
  expect(bots.createCustom).not.toHaveBeenCalled();
});

it("rejects outdated revisions and callbacks after client A→B→A even though the client is reused", async () => {
  const first = fixture(), second = fixture(); const view = await scratch(first.client); const old = latest;
  configure();
  act(() => expect(old.applyDraftChange(old.revision, { name: "Old revision" })).toBe(false));
  expect(latest.draft.name).toBe("My agent");
  view.rerender(<ChatAgentsPanel client={second.client} view="recipes" onClose={vi.fn()} renderCreationChat={renderer}/>);
  view.rerender(<ChatAgentsPanel client={first.client} view="recipes" onClose={vi.fn()} renderCreationChat={renderer}/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start from scratch" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Start from scratch" }));
  await waitFor(() => expect(latest.pending).toBe(false));
  act(() => expect(old.applyDraftChange(old.revision, { name: "Old owner" })).toBe(false));
  expect(latest.draft.name).toBe(""); expect(first.client.create).not.toHaveBeenCalled();
});

it("loads the authoritative template seed and persists every edited field in a managed custom clone", async () => {
  const { client, bots } = fixture(), open = vi.fn();
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={open} renderCreationChat={renderer}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  await waitFor(() => expect(latest.pending).toBe(false));
  expect(latest.seed.kind).toBe("recipe");
  expect(latest.draft.instructions).toBe("Write drafts using the owner’s instructions");
  expect(bots.creationSeed).toHaveBeenCalledWith({ recipeId: recipe.recipeId, version: recipe.version });
  act(() => expect(latest.applyDraftChange(latest.revision, { instructions: "My customized template instructions", description: "Customized description",
    recipe: { skills: ["matrix-integrations"], integrations: [{ service: "gmail", accountLabel: "Work" }], output: "Customized output" } })).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await waitFor(() => expect(bots.createCustom).toHaveBeenCalledTimes(1));
  expect(bots.createCustom).toHaveBeenCalledWith(expect.objectContaining({ seedRecipe: { recipeId: recipe.recipeId, version: recipe.version },
    instructions: "My customized template instructions", description: "Customized description", recipe: expect.objectContaining({ output: "Customized output" }) }));
  expect(bots.instantiate).not.toHaveBeenCalled();
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_custom"));
});

it("preserves an incomplete task executor through Details and Form without choosing a task model", async () => {
  const { client, bots } = fixture();
  Object.assign(bots, { connections: vi.fn(async () => ({ connections: [{ id: "claude_code_tasks", providerId: "anthropic",
    executionKind: "native_task", availability: "available", models: [{ id: "task_model", displayName: "Observed task model" }],
    authorization: { revision: 2, enabled: true, background: false }, coordinatorFunding: "separate" }] })) });
  await scratch(client); configure();
  fireEvent.click(screen.getByRole("button", { name: "Details", exact: true }));
  const executor = await screen.findByRole("combobox", { name: "Task executor" });
  await waitFor(() => expect(executor).toBeEnabled());
  fireEvent.change(executor, { target: { value: "claude_code_tasks" } });
  expect(latest.draft.taskExecutor).toEqual({ connectionId: "claude_code_tasks", model: null });
  const identity = latest.draft.requestId;
  fireEvent.click(screen.getByRole("button", { name: "Back to draft" }));
  expect(screen.getByRole("button", { name: "Create agent", exact: true })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Use a form" }));
  expect(screen.getByRole("button", { name: "Create Agent", exact: true })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Back to Chat" }));
  fireEvent.click(screen.getByRole("button", { name: "Details", exact: true }));
  expect(screen.getByRole("combobox", { name: "Task executor" })).toHaveValue("claude_code_tasks");
  expect(screen.getByRole("combobox", { name: "Task model" })).toHaveValue("");
  expect(latest.draft.requestId).toBe(identity);
  expect(latest.snapshot.draft.taskExecutor).toEqual(latest.draft.taskExecutor);
  expect(latest.snapshot.draft).not.toHaveProperty("requestId");
  expect(client.bots.createCustom).not.toHaveBeenCalled();
});

it("does not open or apply a saved Chat result after changing away and back to the original owner", async () => {
  const first = fixture(), second = fixture(), open = vi.fn();
  let finish!: (value: Awaited<ReturnType<typeof first.bots.createCustom>>) => void;
  const saveResult = { agent: { id: saved.id, name: "My agent", avatarSeed: "a".repeat(32), revision: 1, status: "active" as const }, chatId: "chat_old_owner", operation: "created" as const };
  first.bots.createCustom.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = await scratch(first.client, open); configure();
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await waitFor(() => expect(first.bots.createCustom).toHaveBeenCalledTimes(1));
  view.rerender(<ChatAgentsPanel client={second.client} view="recipes" onClose={vi.fn()} onOpenBotChat={open} renderCreationChat={renderer}/>);
  view.rerender(<ChatAgentsPanel client={first.client} view="recipes" onClose={vi.fn()} onOpenBotChat={open} renderCreationChat={renderer}/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start from scratch" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Start from scratch" }));
  await act(async () => { finish(saveResult); });
  expect(open).not.toHaveBeenCalled(); expect(latest.draft.name).toBe("");
  expect(screen.queryByText("Your agent and Chat are ready.")).not.toBeInTheDocument();
});

it("preserves the existing instantiate policy for templates whose required apps make cloning unavailable", async () => {
  const { client, bots } = fixture(), open = vi.fn();
  bots.creationSeed.mockResolvedValue({ recipe: { recipeId: recipe.recipeId, version: recipe.version }, editable: false,
    draft: { name: recipe.name, description: recipe.description, instructions: "Required template instructions",
      recipe: { skills: ["matrix-integrations"], integrations: [], output: recipe.output } } });
  bots.instantiate.mockResolvedValue({ agent: { id: saved.id, name: recipe.name, avatarSeed: "a".repeat(32), revision: 1, status: "active" },
    chatId: "chat_fixed_template", operation: "created" });
  render(<ChatAgentsPanel client={client} view="recipes" onClose={vi.fn()} onOpenBotChat={open} renderCreationChat={renderer}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Use Writing Bot" }));
  await waitFor(() => expect(latest.pending).toBe(false));
  act(() => expect(latest.applyDraftChange(latest.revision, { instructions: "Changed policy" })).toBe(false));
  expect(screen.getByRole("alert")).toHaveTextContent("required apps");
  fireEvent.click(screen.getByRole("button", { name: "Create agent", exact: true }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_fixed_template"));
  expect(bots.instantiate).toHaveBeenCalledWith(expect.objectContaining({ recipe: { recipeId: recipe.recipeId, version: recipe.version } }));
  expect(bots.createCustom).not.toHaveBeenCalled();
});
