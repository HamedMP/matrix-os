// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import { BotChatPanel } from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import { createChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import { saved } from "../../desktop/chat-agents-fixture.js";
afterEach(cleanup);
it("actual shared Bot details offers explicit current-Chat routine destination without granting permission", async () => {
  const agent = { ...saved, recipeRef: { recipeId: "report", version: "1" } };
  const request = vi.fn(async (path: string, _method?: string) => path.endsWith("/destination") ? { preference: { revision: 0, target: null, updatedAt: null }, availability: "unset" }
    : path.includes("interactions") ? { interactions: [] } : path.includes("bot-tasks") ? { tasks: [] }
    : path.includes("authority") ? { agentId: agent.id, revision: 1, grants: [], connections: [], memory: { items: [] }, routines: [], pendingInteractions: [] }
    : { enabled: true, agents: [agent] });
  const client = createChatAgentClient(request);
  render(<BotChatPanel chatId="chat_destination" directBotId={agent.id} client={client}/>);
  await screen.findByText(agent.name); fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(await screen.findByRole("heading", { name: "Routine destination" })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Use this Chat" })).toBeEnabled();
  expect(screen.getByText(/does not authorize routine operations/)).toBeInTheDocument();
  expect(request.mock.calls.every(([, method]) => method !== "POST")).toBe(true);
});

const EMPTY = { preference: { revision: 0, target: null, updatedAt: null }, availability: "unset" } as const;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
it("same-render retained destination callback admits only one pending explicit mutation", async () => {
  const { useRoutineDestination } = await import("../../../packages/ui/src/routine-destination/use-routine-destination.js");
  const { renderHook, act, waitFor } = await import("@testing-library/react");
  const gate = deferred<typeof EMPTY>(), client = { get: vi.fn(async () => EMPTY), remember: vi.fn(() => gate.promise), reset: vi.fn(async () => EMPTY) };
  const hook = renderHook(() => useRoutineDestination({ client, botId: saved.id, chatId: "chat_destination", eligible: true }));
  await waitFor(() => expect(hook.result.current.fresh).toBe(true)); const remember = hook.result.current.remember;
  act(() => { void remember(); void remember(); });
  try { expect(client.remember).toHaveBeenCalledTimes(1); } finally { await act(async () => gate.resolve(EMPTY)); }
});
it("switching Chat aborts outstanding save and its later response cannot overwrite new scope", async () => {
  const { useRoutineDestination } = await import("../../../packages/ui/src/routine-destination/use-routine-destination.js");
  const { renderHook, act, waitFor } = await import("@testing-library/react");
  const gate = deferred<typeof EMPTY>(), client = { get: vi.fn(async () => EMPTY), remember: vi.fn((_input, _signal?: AbortSignal) => gate.promise), reset: vi.fn(async () => EMPTY) };
  const hook = renderHook(({ chatId }) => useRoutineDestination({ client, botId: saved.id, chatId, eligible: true }), { initialProps: { chatId: "chat_destination" } });
  await waitFor(() => expect(hook.result.current.fresh).toBe(true)); act(() => { void hook.result.current.remember(); });
  const signal = client.remember.mock.calls[0]![1]!; hook.rerender({ chatId: "chat_another" });
  try { expect(signal.aborted).toBe(true); } finally { await act(async () => gate.resolve(EMPTY)); }
  await waitFor(() => expect(hook.result.current.pending).toBe(false)); expect(hook.result.current.view).toEqual(EMPTY);
});

async function panelFixture() {
  const { createBotClient } = await import("../../../packages/ui/src/chat-agents/bots/client.js");
  const { RoutineDestinationSection } = await import("../../../packages/ui/src/chat-agents/bots/RoutineDestinationSection.js");
  let value: import("@matrix-os/contracts/routine-destination").RoutineDestinationView = EMPTY, fault: number | null = null;
  const selected = (chatId: string, revision: number) => ({ preference: { revision, target: { botId: saved.id, chatId, bindingCreatedAt: "2026-09-27T12:00:00.000Z" }, updatedAt: "2026-09-27T12:00:00.000Z" }, availability: "available" } as const);
  const request = vi.fn(async (_path: string, method: string, body?: unknown) => {
    if (method === "GET") return value;
    if (fault) { const status = fault; fault = null; throw { status, message: "/private/provider/database" }; }
    const input = body as { baseRevision: number; chatId?: string };
    expect(input.baseRevision).toBe(value.preference.revision);
    value = input.chatId ? selected(input.chatId, input.baseRevision + 1) : { preference: { revision: input.baseRevision + 1, target: null, updatedAt: "2026-09-27T12:00:00.000Z" }, availability: "unset" };
    return value;
  });
  const client = createBotClient(request).routineDestination!;
  return { client, request, Section: RoutineDestinationSection, selected, set: (next: typeof value) => { value = next; }, fail: (status: number) => { fault = status; } };
}
it("explicit current-Chat selection survives reload and irrelevant harness changes with no repeated save or picker", async () => {
  const { waitFor } = await import("@testing-library/react"), x = await panelFixture();
  const panel = render(<div data-harness="claude"><x.Section client={x.client} botId={saved.id} chatId="chat_destination" eligible/></div>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this Chat" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Use this Chat" }));
  expect(await screen.findByText("This Chat is the routine destination on this Computer.")).toBeInTheDocument();
  expect(x.request.mock.calls.filter(call => call[1] === "POST")).toEqual([["/api/routine-cli/destination", "POST", { botId: saved.id, chatId: "chat_destination", baseRevision: 0 }, expect.anything()]]);
  for (const harness of ["claude", "codex", "hermes", "opencode", "pi"]) panel.rerender(<div data-harness={harness}><x.Section client={x.client} botId={saved.id} chatId="chat_destination" eligible/></div>);
  expect(screen.queryByRole("button", { name: "Use this Chat" })).toBeNull();
  panel.unmount(); render(<x.Section client={x.client} botId={saved.id} chatId="chat_destination" eligible/>);
  expect(await screen.findByText("This Chat is the routine destination on this Computer.")).toBeInTheDocument();
  expect(x.request.mock.calls.filter(call => call[1] === "POST")).toHaveLength(1);
});
it("recoverable invalid selection stays visible and only an explicit owner reselection/reset changes it", async () => {
  const { waitFor } = await import("@testing-library/react"), x = await panelFixture(); x.set({ ...x.selected("chat_destination", 7), availability: "unavailable" });
  render(<x.Section client={x.client} botId={saved.id} chatId="chat_destination" eligible/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this Chat again" })).toBeEnabled());
  expect(screen.getByText(/saved routine destination is unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Use this Chat again" })); await screen.findByText("This Chat is the routine destination on this Computer.");
  fireEvent.click(screen.getByRole("button", { name: "Clear destination" })); await screen.findByText("No routine destination selected.");
  expect(x.request.mock.calls.filter(call => call[1] === "POST").map(call => call[2])).toEqual([{ botId: saved.id, chatId: "chat_destination", baseRevision: 7 }, { baseRevision: 8 }]);
});
it("failed save retains current selection safely; stale CAS refreshes metadata without replaying intent", async () => {
  const { waitFor } = await import("@testing-library/react"), x = await panelFixture(); x.set(x.selected("chat_original", 3));
  render(<x.Section client={x.client} botId={saved.id} chatId="chat_destination" eligible/>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this Chat" })).toBeEnabled()); x.fail(503);
  fireEvent.click(screen.getByRole("button", { name: "Use this Chat" })); await screen.findByRole("alert");
  expect(screen.getByText("Another Bot Chat is the routine destination on this Computer.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use this Chat" })).toBeDisabled(); expect(document.body.textContent).not.toContain("/private/provider");
  x.set(x.selected("chat_concurrent", 4)); fireEvent.click(screen.getByRole("button", { name: "Refresh destination" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Use this Chat" })).toBeEnabled());
  x.set(x.selected("chat_newer", 5)); x.fail(409); fireEvent.click(screen.getByRole("button", { name: "Use this Chat" }));
  await screen.findByText(/destination changed elsewhere/); expect(x.request.mock.calls.filter(call => call[1] === "POST")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Use this Chat" })); await screen.findByText("This Chat is the routine destination on this Computer.");
  expect(x.request.mock.calls.filter(call => call[1] === "POST")[2]![2]).toEqual({ botId: saved.id, chatId: "chat_destination", baseRevision: 5 });
});
it("late owner/client A -> B -> A loads and retained callbacks cannot overwrite or mutate current destination", async () => {
  const { useRoutineDestination } = await import("../../../packages/ui/src/routine-destination/use-routine-destination.js"), { renderHook, act, waitFor } = await import("@testing-library/react");
  const old = deferred<typeof EMPTY>(), a = { get: vi.fn(() => old.promise), remember: vi.fn(async () => EMPTY), reset: vi.fn(async () => EMPTY) }, b = { ...a, get: vi.fn(async () => EMPTY) };
  const hook = renderHook(({ client }) => useRoutineDestination({ client, botId: saved.id, chatId: "chat_destination", eligible: true }), { initialProps: { client: a } });
  const retained = hook.result.current.remember; hook.rerender({ client: b }); await waitFor(() => expect(hook.result.current.fresh).toBe(true));
  hook.rerender({ client: a }); await act(async () => old.resolve(EMPTY)); await waitFor(() => expect(hook.result.current.fresh).toBe(true));
  await act(async () => retained()); expect(a.remember).not.toHaveBeenCalled(); expect(hook.result.current.view).toEqual(EMPTY);
});

it("failed initial read never claims no destination was selected", async () => {
  const { RoutineDestinationSection } = await import("../../../packages/ui/src/chat-agents/bots/RoutineDestinationSection.js");
  const client = { get: vi.fn(async () => { throw new Error("private-provider-path"); }), remember: vi.fn(async () => EMPTY), reset: vi.fn(async () => EMPTY) };
  render(<RoutineDestinationSection client={client} botId={saved.id} chatId="chat_destination" eligible/>);
  await screen.findByRole("alert"); expect(screen.queryByText("No routine destination selected.")).toBeNull(); expect(document.body.textContent).not.toContain("private-provider-path");
});

it("retained destination callbacks cannot load or save after their component unmounts", async () => {
  const { useRoutineDestination } = await import("../../../packages/ui/src/routine-destination/use-routine-destination.js");
  const { renderHook, act, waitFor } = await import("@testing-library/react");
  const client = { get: vi.fn(async () => EMPTY), remember: vi.fn(async () => EMPTY), reset: vi.fn(async () => EMPTY) };
  const hook = renderHook(() => useRoutineDestination({ client, botId: saved.id, chatId: "chat_destination", eligible: true }));
  await waitFor(() => expect(hook.result.current.fresh).toBe(true));
  const retained = hook.result.current; hook.unmount();
  await act(async () => { retained.refresh(); await retained.remember(); await retained.reset(); });
  expect(client.get).toHaveBeenCalledTimes(1); expect(client.remember).not.toHaveBeenCalled(); expect(client.reset).not.toHaveBeenCalled();
});
