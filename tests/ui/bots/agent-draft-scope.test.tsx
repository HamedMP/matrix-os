// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import type { AgentEditor } from "../../../packages/ui/src/chat-agents/AgentEditor.js";
import type { BotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import type { InstantiateBotResponse } from "@matrix-os/contracts";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

type EditorProps = React.ComponentProps<typeof AgentEditor>;
const observed = vi.hoisted(() => ({ latest: null as EditorProps | null }));
vi.mock("../../../packages/ui/src/chat-agents/AgentEditor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../../packages/ui/src/chat-agents/AgentEditor.js")>();
  return { ...actual, AgentEditor: (props: EditorProps) => {
    observed.latest = props;
    return <actual.AgentEditor {...props}/>;
  } };
});
afterEach(async () => { await act(async () => {}); cleanup(); observed.latest = null; });
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
async function openScratch() {
  fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
  const scratch = screen.getByRole("button", { name: "Start from scratch" });
  await waitFor(() => expect(scratch).toBeEnabled()); fireEvent.click(scratch);
  await waitFor(() => expect(observed.latest?.catalogLoading).toBe(false));
}

it("rejects callbacks from a canceled creation session after opening another draft", async () => {
  const client = clientFixture({ matrix: true });
  render(<ChatAgentsPanel client={client} onClose={vi.fn()}/>);
  await openScratch();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Old draft" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Old instructions" } });
  const old = observed.latest!;
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Start from scratch" }));
  await act(async () => { old.change({ name: "Stale change" }); await old.onSave(); });
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  expect(client.create).not.toHaveBeenCalled();
});

it("invalidates old owner callbacks even after switching away and back to the same client", async () => {
  const first = clientFixture({ matrix: true }), second = clientFixture({ matrix: true });
  const view = render(<ChatAgentsPanel client={first} onClose={vi.fn()}/>);
  await openScratch();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Old draft" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Old instructions" } });
  const old = observed.latest!;
  view.rerender(<ChatAgentsPanel client={second} onClose={vi.fn()}/>);
  await screen.findByRole("button", { name: "New Agent" });
  view.rerender(<ChatAgentsPanel client={first} onClose={vi.fn()}/>);
  await openScratch();
  await act(async () => { old.change({ name: "Stale owner" }); await old.onSave(); });
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  expect(first.create).not.toHaveBeenCalled(); expect(second.create).not.toHaveBeenCalled();
});

it("keeps the same full draft and request identity while setup is paused and resumed", async () => {
  const client = clientFixture({ matrix: true }), setup = vi.fn();
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} onSetup={setup}/>);
  await openScratch();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Keep draft" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Keep instructions" } });
  const before = observed.latest!.draft;
  act(() => observed.latest!.onSetup!());
  expect(setup).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Resume agent setup" }));
  await waitFor(() => expect(observed.latest?.catalogLoading).toBe(false));
  expect(observed.latest!.draft).toBe(before);
  expect(client.create).not.toHaveBeenCalled();
});

it("allows the live session to edit and save under React StrictMode", async () => {
  const client = clientFixture({ matrix: true });
  render(<React.StrictMode><ChatAgentsPanel client={client} onClose={vi.fn()}/></React.StrictMode>);
  await openScratch();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Live draft" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Live instructions" } });
  await act(async () => { await observed.latest!.onSave(); });
  expect(client.create).toHaveBeenCalledWith(expect.objectContaining({ name: "Live draft", instructions: "Live instructions" }));
});

it.each(["creation", "readback"] as const)("rejects late managed %s after owner A→B→A without updating the new draft", async stage => {
  const base = clientFixture({ matrix: true });
  const catalog = await base.catalog();
  const source = catalog.instances[0]!;
  const selection = { instanceId: "matrix_chatgpt_plan", model: "owner-model",
    options: [{ id: "accountId", value: "work" }, { id: "grantRevision", value: "3" }] };
  catalog.instances.push({ ...source, id: selection.instanceId, driverKind: "matrix_bot",
    displayName: "ChatGPT subscription", connectionLabel: "ChatGPT subscription", defaultSelection: selection,
    supports: { ...source.supports, permissionModes: ["default"], rootChat: false },
    options: selection.options.map(option => ({ ...option, label: option.id, kind: "enum" as const,
      values: [{ value: option.value, label: option.value }], defaultValue: option.value, placement: "advanced" as const })),
    models: [{ ...source.models[0]!, id: selection.model, displayName: "Owner model" }] });
  const created: InstantiateBotResponse = { agent: { id: saved.id, name: "Old managed draft",
    avatarSeed: "a".repeat(32), revision: 1, status: "active" }, chatId: "chat_old_managed", operation: "created" };
  let finishCreate!: (value: InstantiateBotResponse) => void;
  const createCustom = vi.fn(() => stage === "creation"
    ? new Promise<InstantiateBotResponse>(resolve => { finishCreate = resolve; }) : Promise.resolve(created));
  const first = { ...base, list: vi.fn<ChatAgentClient["list"]>(async () => ({ enabled: true, agents: [] })),
    bots: { recipes: vi.fn(async () => []), createCustom } as unknown as BotClient };
  const second = clientFixture({ matrix: true });
  const view = render(<ChatAgentsPanel client={first} onClose={vi.fn()}/>);
  await openScratch();
  fireEvent.change(screen.getByRole("combobox", { name: "Connection" }), { target: { value: selection.instanceId } });
  fireEvent.change(screen.getByRole("combobox", { name: "Model" }), {
    target: { value: JSON.stringify([selection.instanceId, selection.model, selection.options]) },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Old managed draft" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Instructions" }), { target: { value: "Old instructions" } });
  let finishReadback!: (value: Awaited<ReturnType<typeof first.list>>) => void;
  if (stage === "readback") first.list.mockImplementationOnce(() => new Promise(resolve => { finishReadback = resolve; }));
  let pending!: Promise<void>;
  act(() => { pending = observed.latest!.onSave(); });
  await waitFor(() => expect(createCustom).toHaveBeenCalledTimes(1));
  if (stage === "readback") await waitFor(() => expect(finishReadback).toBeDefined());
  view.rerender(<ChatAgentsPanel client={second} onClose={vi.fn()}/>);
  await screen.findByRole("button", { name: "New Agent" });
  view.rerender(<ChatAgentsPanel client={first} onClose={vi.fn()}/>);
  await openScratch();
  const reads = first.list.mock.calls.length;
  await act(async () => {
    if (stage === "creation") finishCreate(created);
    else finishReadback({ enabled: true, agents: [{ ...saved, selection, recipeRef: { recipeId: "custom-coordinator", version: "1" } }] });
    await pending;
  });
  expect(first.list).toHaveBeenCalledTimes(reads);
  expect(first.update).not.toHaveBeenCalled(); expect(first.create).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("");
  expect(screen.queryByText(/Saved\. Open this bot/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
});
