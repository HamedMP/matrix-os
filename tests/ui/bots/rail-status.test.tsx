// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotInteraction, BotTaskSummary, ChatAgent } from "@matrix-os/contracts";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import { IsoTimestampSchema } from "@matrix-os/contracts";
import { botRailStatus, latestBotTask } from "../../../packages/ui/src/chat-agents/bots/bot-rail-status.js";
import { useBotRailStatuses } from "../../../packages/ui/src/chat-agents/bots/use-bot-rail-statuses.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const agent: ChatAgent = { ...saved, recipeRef: { recipeId: "writer", version: "1" } };
const task = (status: BotTaskSummary["status"], updatedAt = "2026-10-06T12:00:00.000Z"): BotTaskSummary => ({
  taskId: `task_${status}`, agentId: agent.id, chatId: "chat_bot", revision: 1, status, updatedAt,
});
const interaction = (expiresAt = "2099-01-01T00:00:00.000Z"): BotInteraction => ({
  interactionId: "interaction_one", agentId: agent.id, chatId: "chat_bot", kind: "approval", status: "pending", expiresAt,
}) as BotInteraction;
function fixture() {
  return { ...clientFixture(), bots: {
    directChat: vi.fn(async () => "chat_bot"), tasks: vi.fn(async () => [task("running")]), interactions: vi.fn(async () => []),
    instantiate: vi.fn(),
  } } as unknown as ChatAgentClient;
}
describe("Agent rail status", () => {
  it("orders accepted mixed timestamp precision by instant, including equivalent-instant task ID ties", () => {
    const whole = IsoTimestampSchema.parse("2026-10-06T12:00:00Z");
    const half = IsoTimestampSchema.parse("2026-10-06T12:00:00.500Z");
    expect(IsoTimestampSchema.safeParse("2026-10-06T13:00:00+01:00").success).toBe(false);
    expect(botRailStatus([task("completed", whole), task("running", half)], [], whole))
      .toEqual({ state: "working", label: "Working" });
    expect(latestBotTask([{ ...task("completed", whole), taskId: "task_a" },
      { ...task("running", "2026-10-06T12:00:00.000Z"), taskId: "task_z" }])?.taskId).toBe("task_z");
  });
  it("keeps an interaction pending until its actual expiry across mixed timestamp precision", () => {
    const pending = interaction("2026-10-06T12:00:00.500Z");
    expect(botRailStatus([], [pending], "2026-10-06T12:00:00Z"))
      .toEqual({ state: "attention", label: "Approval requested" });
    expect(botRailStatus([], [pending], "2026-10-06T12:00:00.500Z")).toEqual({ state: "idle", label: "No open tasks" });
  });
  it.each([
    ["running", "working", "Working"], ["queued", "idle", "Queued"],
    ["waiting_person", "attention", "Waiting for your answer"], ["waiting_capacity", "idle", "Waiting for capacity"],
    ["blocked", "attention", "Needs attention"], ["completed", "completed", "Completed"],
    ["failed", "attention", "Could not finish"], ["cancelled", "idle", "Cancelled"],
  ] as const)("maps verified %s without treating every definition as ready", (status, state, label) => {
    expect(botRailStatus([task(status)], [], "2026-10-06T12:01:00.000Z")).toEqual({ state, label });
  });
  it("uses existing blocked copy and ignores old tasks in favor of the latest attempt", () => {
    expect(botRailStatus([task("completed"), { ...task("blocked", "2026-10-06T12:02:00.000Z"), blockedReason: "model_unavailable" }], [], "2026-10-06T12:03:00.000Z"))
      .toEqual({ state: "attention", label: "Model unavailable" });
  });
  it("requires a nonexpired pending interaction and leaves an empty open-task snapshot neutral", () => {
    expect(botRailStatus([], [interaction()], "2026-10-06T12:00:00.000Z")).toEqual({ state: "attention", label: "Approval requested" });
    expect(botRailStatus([], [interaction("2026-10-06T11:00:00.000Z")], "2026-10-06T12:00:00.000Z")).toEqual({ state: "idle", label: "No open tasks" });
    expect(botRailStatus([], [], "2026-10-06T12:00:00.000Z")).toEqual({ state: "idle", label: "No open tasks" });
  });
  it("reads existing bound Chat only and clears runtime status before the next client resolves", async () => {
    const first = fixture(), next = fixture(); let finish!: (tasks: BotTaskSummary[]) => void;
    vi.mocked(next.bots!.tasks).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({client}) => useBotRailStatuses(client, [agent], "chat_one"), {initialProps:{client:first}});
    await waitFor(() => expect(result.current[agent.id]?.state).toBe("working"));
    rerender({client:next}); expect(result.current[agent.id]?.state).toBe("loading");
    await waitFor(() => expect(next.bots!.tasks).toHaveBeenCalled());
    await act(async () => finish([task("completed")]));
    await waitFor(() => expect(result.current[agent.id]?.state).toBe("completed"));
    expect(first.bots!.instantiate).not.toHaveBeenCalled(); expect(next.bots!.instantiate).not.toHaveBeenCalled();
  });
  it("keeps custom Bot task status neutral without recipe reads and refreshes when recipe applicability changes", async () => {
    const client = fixture();
    const custom = { ...saved, recipeRef: undefined };
    const { result, rerender } = renderHook(({ currentAgent }) => useBotRailStatuses(client, [currentAgent], "chat_one"),
      { initialProps: { currentAgent: custom as ChatAgent } });
    await waitFor(() => expect(result.current[custom.id]).toEqual({ state: "unavailable", label: "Status unavailable" }));
    expect(client.bots!.directChat).not.toHaveBeenCalled();
    expect(client.bots!.tasks).not.toHaveBeenCalled();
    expect(client.bots!.interactions).not.toHaveBeenCalled();
    rerender({ currentAgent: agent });
    expect(result.current[agent.id]?.state).toBe("loading");
    await waitFor(() => expect(result.current[agent.id]?.state).toBe("working"));
    rerender({ currentAgent: custom });
    expect(result.current[custom.id]?.state).toBe("loading");
    await waitFor(() => expect(result.current[custom.id]?.state).toBe("unavailable"));
  });
  it("does not show successful task evidence when status reads fail", async () => {
    const client = fixture(); vi.mocked(client.bots!.interactions).mockRejectedValue(new Error("private runtime failure"));
    const { result } = renderHook(() => useBotRailStatuses(client, [agent], "chat_one"));
    await waitFor(() => expect(result.current[agent.id]?.state).toBe("unavailable"));
    expect(result.current[agent.id]?.label).toBe("Status unavailable");
  });
  it("does not create an unbound direct Chat and keeps custom unbound agents neutral", async () => {
    const client = fixture(); vi.mocked(client.bots!.directChat).mockResolvedValue(null);
    const { result } = renderHook(() => useBotRailStatuses(client, [agent], "chat_one"));
    await waitFor(() => expect(result.current[agent.id]?.state).toBe("idle"));
    expect(client.bots!.tasks).not.toHaveBeenCalled(); expect(client.bots!.instantiate).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
  });
  it("fences stale active Chat status completion", async () => {
    const client = fixture(); let finish!: (tasks: BotTaskSummary[]) => void;
    vi.mocked(client.bots!.tasks).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({chat}) => useBotRailStatuses(client, [agent], chat), {initialProps:{chat:"chat_one"}});
    await waitFor(() => expect(client.bots!.tasks).toHaveBeenCalled());
    rerender({chat:"chat_two"}); expect(result.current[agent.id]?.state).toBe("loading");
    vi.mocked(client.bots!.tasks).mockResolvedValue([task("cancelled")]);
    await act(async () => finish([task("completed")]));
    await waitFor(() => expect(result.current[agent.id]?.label).toBe("Cancelled"));
  });
  it("caps the discovered list at its 100-agent contract and coalesces at four reads", async () => {
    const client = fixture(); let running = 0, peak = 0;
    vi.mocked(client.bots!.directChat).mockImplementation(async id => {
      running++; peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 1)); running--;
      return `chat_${id}`;
    });
    vi.mocked(client.bots!.tasks).mockResolvedValue([]);
    const agents = Array.from({length: 103}, (_,index) => ({...agent,id:`bot_${index}`}));
    const {result} = renderHook(() => useBotRailStatuses(client, agents, "chat_one"));
    await waitFor(() => expect(result.current.bot_99?.state).toBe("idle"));
    expect(client.bots!.directChat).toHaveBeenCalledTimes(100);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.current.bot_100?.state).toBe("unavailable");
  });
  it("ignores task and interaction evidence belonging to another bot or Chat", async () => {
    const client = fixture();
    vi.mocked(client.bots!.tasks).mockResolvedValue([{...task("running"),agentId:"other_bot"}]);
    vi.mocked(client.bots!.interactions).mockResolvedValue([{...interaction(),chatId:"other_chat"}]);
    const {result} = renderHook(() => useBotRailStatuses(client, [agent], "chat_one"));
    await waitFor(() => expect(result.current[agent.id]?.label).toBe("No open tasks"));
  });
  it("ignores completion of the previous runtime after switching clients", async () => {
    const first = fixture(), next = fixture(); let finish!: (tasks: BotTaskSummary[]) => void;
    vi.mocked(first.bots!.tasks).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(next.bots!.tasks).mockResolvedValue([task("cancelled")]);
    const {result,rerender} = renderHook(({client}) => useBotRailStatuses(client, [agent], "chat_one"), {initialProps:{client:first}});
    await waitFor(() => expect(first.bots!.tasks).toHaveBeenCalled());
    rerender({client:next});
    await waitFor(() => expect(result.current[agent.id]?.label).toBe("Cancelled"));
    await act(async () => finish([task("completed")]));
    expect(result.current[agent.id]?.label).toBe("Cancelled");
  });
});
