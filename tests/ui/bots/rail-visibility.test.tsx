// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BotTaskSummary } from "@matrix-os/contracts";
import { ChatAgentsRailSection } from "../../../packages/ui/src/chat-agents/ChatAgentsRailSection.js";
import { ChatAgentsWorkspace } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { useBotRailStatuses } from "../../../packages/ui/src/chat-agents/bots/use-bot-rail-statuses.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const agent = { ...saved, recipeRef: { recipeId: "writer", version: "1" } };
const task = (status: BotTaskSummary["status"]): BotTaskSummary => ({
  taskId: "task_one", agentId: agent.id, chatId: "chat_bot", revision: 1, status, updatedAt: "2026-10-07T00:00:00.000Z",
});
function fixture() {
  const client = clientFixture();
  client.list.mockResolvedValue({ enabled: true, agents: [agent] });
  return { ...client, bots: { directChat: vi.fn(async () => "chat_bot"),
    tasks: vi.fn(async () => [task("running")]), interactions: vi.fn(async () => []) } };
}
async function flush(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function rail(client: ReturnType<typeof fixture>, visible: boolean) {
  return <ChatAgentsWorkspace><ChatAgentsRailSection client={client as never} visible={visible} /></ChatAgentsWorkspace>;
}

it("pauses mounted hidden rail discovery and status reads, resumes immediately, and cleans up on unmount", async () => {
  vi.useFakeTimers();
  const client = fixture();
  const { rerender, unmount } = render(rail(client, false));
  await flush(30_000); act(() => { window.dispatchEvent(new Event("focus")); }); await flush();
  expect(client.list).not.toHaveBeenCalled(); expect(client.bots.tasks).not.toHaveBeenCalled();
  rerender(rail(client, true)); await flush();
  expect(client.list).toHaveBeenCalledTimes(1); expect(client.bots.tasks).toHaveBeenCalledTimes(1);
  rerender(rail(client, false)); await flush(30_000);
  act(() => { window.dispatchEvent(new Event("focus")); }); await flush();
  expect(client.list).toHaveBeenCalledTimes(1); expect(client.bots.tasks).toHaveBeenCalledTimes(1);
  rerender(rail(client, true)); await flush();
  expect(client.list).toHaveBeenCalledTimes(2); expect(client.bots.tasks).toHaveBeenCalledTimes(2);
  unmount(); await flush(30_000); act(() => { window.dispatchEvent(new Event("focus")); }); await flush();
  expect(client.list).toHaveBeenCalledTimes(2); expect(client.bots.tasks).toHaveBeenCalledTimes(2);
});

it("ignores a discovery result from before a hide after the visible rail has loaded fresh data", async () => {
  vi.useFakeTimers();
  const client = fixture(); let finish!: (value: Awaited<ReturnType<typeof client.list>>) => void;
  client.list.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { rerender } = render(rail(client, true)); await flush();
  rerender(rail(client, false));
  client.list.mockResolvedValue({ enabled: true, agents: [{ ...agent, name: "Fresh definition" }] });
  rerender(rail(client, true)); await flush();
  expect(screen.getByRole("button", { name: "Chat with Fresh definition" })).toBeTruthy();
  await act(async () => { finish({ enabled: true, agents: [{ ...agent, name: "Stale definition" }] }); });
  expect(screen.queryByRole("button", { name: "Chat with Stale definition" })).toBeNull();
  expect(screen.getByRole("button", { name: "Chat with Fresh definition" })).toBeTruthy();
});

it("pauses on document hiding even when the host remains visible, then refreshes on document visibility", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const client = fixture(); render(rail(client, true));
  act(() => { window.dispatchEvent(new Event("focus")); }); await flush(30_000);
  expect(client.list).not.toHaveBeenCalled(); expect(client.bots.tasks).not.toHaveBeenCalled();
  visibility.mockReturnValue("visible"); act(() => { document.dispatchEvent(new Event("visibilitychange")); }); await flush();
  expect(client.list).toHaveBeenCalledTimes(1); expect(client.bots.tasks).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("hidden"); act(() => { document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); }); await flush(30_000);
  expect(client.list).toHaveBeenCalledTimes(1); expect(client.bots.tasks).toHaveBeenCalledTimes(1);
  visibility.mockReturnValue("visible"); act(() => { document.dispatchEvent(new Event("visibilitychange")); }); await flush();
  expect(client.list).toHaveBeenCalledTimes(2); expect(client.bots.tasks).toHaveBeenCalledTimes(2);
});

it("fences pending status reads across hidden host periods and obtains fresh evidence on resume", async () => {
  vi.useFakeTimers();
  const client = fixture(); let finish!: (value: BotTaskSummary[]) => void;
  client.bots.tasks.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ visible }) => useBotRailStatuses(client as never, [agent], "chat_one", visible),
    { initialProps: { visible: true } }); await flush();
  expect(client.bots.tasks).toHaveBeenCalledTimes(1);
  rerender({ visible: false }); await act(async () => { finish([task("completed")]); });
  expect(result.current[agent.id]?.state).toBe("unavailable");
  client.bots.tasks.mockResolvedValue([task("cancelled")]);
  rerender({ visible: true }); await flush();
  expect(client.bots.tasks).toHaveBeenCalledTimes(2);
  expect(result.current[agent.id]).toEqual({ state: "idle", label: "Cancelled" });
});

it("fences a pending status read when the document hides and resumes without waiting for a polling interval", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const client = fixture(); let finish!: (value: BotTaskSummary[]) => void;
  client.bots.tasks.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useBotRailStatuses(client as never, [agent], "chat_one")); await flush();
  visibility.mockReturnValue("hidden"); act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  await act(async () => { finish([task("completed")]); });
  await flush(30_000);
  expect(client.bots.tasks).toHaveBeenCalledTimes(1);
  expect(result.current[agent.id]?.state).toBe("unavailable");
  client.bots.tasks.mockResolvedValue([task("cancelled")]);
  visibility.mockReturnValue("visible"); act(() => { document.dispatchEvent(new Event("visibilitychange")); }); await flush();
  expect(client.bots.tasks).toHaveBeenCalledTimes(2);
  expect(result.current[agent.id]).toEqual({ state: "idle", label: "Cancelled" });
});
