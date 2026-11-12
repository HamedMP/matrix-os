import { describe, expect, it, vi } from "vitest";
import { ProjectIdSchema } from "../../packages/contracts/src/index.js";
import {
  createTerminalEventsClient,
  EMPTY_TERMINAL_EVENTS_STATE,
  orderTerminalAgents,
  reduceTerminalEvents,
  rollUpTerminalStatus,
  terminalAttentionChanges,
  terminalVisualStatus,
  type TerminalEventsSocket,
  type TerminalTabFacts,
} from "../../packages/ui/src/terminal-agents/index.js";

const workspaceId = `tws_${"0".repeat(32)}`;
const tabA = `tt_${"a".repeat(32)}`;
const tabB = `tt_${"b".repeat(32)}`;
const fact = (tabId: string, overrides: Partial<TerminalTabFacts> = {}): TerminalTabFacts => ({
  ref: { workspaceId, tabId }, name: tabId === tabA ? "review" : "build", cwd: "", state: "live", ...overrides,
});
const map = (...facts: TerminalTabFacts[]) => new Map(facts.map((tab) => [`${tab.ref.workspaceId}:${tab.ref.tabId}`, tab]));

// Fault detected: a project shows "working" while one of its agents is waiting for
// the person, or the person is pinged about work they are already watching.
describe("terminal agent attention", () => {
  it("rolls up the most urgent status the way Herdr does", () => {
    expect(rollUpTerminalStatus(["idle", "working", "done"])).toBe("done");
    expect(rollUpTerminalStatus(["done", "blocked", "working"])).toBe("blocked");
    expect(rollUpTerminalStatus(["error", "done"])).toBe("error");
    expect(rollUpTerminalStatus([undefined, undefined])).toBeUndefined();
  });

  it("maps status words to the sidebar's visual states", () => {
    expect(["working", "blocked", "error", "done", "idle", undefined].map((word) => terminalVisualStatus(word as never)))
      .toEqual(["running", "waiting", "waiting", "finished", "idle", undefined]);
  });

  it("raises blocked and errors always, and done only for tabs nobody is looking at", () => {
    const before = map(fact(tabA, { agentStatus: "working" }), fact(tabB, { agentStatus: "working" }));
    const after = map(fact(tabA, { agentStatus: "done" }), fact(tabB, { agentStatus: "blocked", statusMessage: "Allow edit?" }));
    expect(terminalAttentionChanges(before, after, new Set([`${workspaceId}:${tabA}`]))).toEqual([
      { key: `${workspaceId}:${tabB}`, kind: "blocked", ref: { workspaceId, tabId: tabB }, name: "build", message: "Allow edit?" },
    ]);
    expect(terminalAttentionChanges(before, after, new Set()).map((change) => change.kind)).toEqual(["done", "blocked"]);
    expect(terminalAttentionChanges(after, after, new Set())).toEqual([]);
  });

  // Fault detected (fourth review of #3299): a tab created already blocked raised nothing.
  it("raises a tab that appears already blocked or errored", () => {
    const next = map(fact(tabA, { agentStatus: "blocked" }), fact(tabB, { agentStatus: "done" }));
    expect(terminalAttentionChanges(new Map(), next, new Set()).map((change) => [change.name, change.kind])).toEqual([["review", "blocked"]]);
  });

  it("orders agents needs-you first, then done, working, idle", () => {
    expect(orderTerminalAgents([
      fact(tabA, { agentStatus: "idle" }), fact(tabB, { agentStatus: "blocked" }),
      fact(`tt_${"c".repeat(32)}`, { agentStatus: "working", name: "c" }), fact(`tt_${"d".repeat(32)}`, { name: "plain" }),
    ]).map((tab) => tab.agentStatus)).toEqual(["blocked", "working", "idle"]);
  });
});

describe("terminal events state", () => {
  it("applies a snapshot then events and drops malformed input", () => {
    let state = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, {
      type: "snapshot", seq: 1,
      tabs: [fact(tabA), { ref: { workspaceId: "../x", tabId: tabB }, name: "bad", state: "live" }],
    });
    expect(Object.keys(state.tabs)).toEqual([`${workspaceId}:${tabA}`]);
    state = reduceTerminalEvents(state, { type: "event", seq: 2, event: { kind: "status", ref: { workspaceId, tabId: tabA }, status: "blocked", message: "Allow?" } });
    expect(state.tabs[`${workspaceId}:${tabA}`]).toMatchObject({ agentStatus: "blocked", statusMessage: "Allow?" });
    state = reduceTerminalEvents(state, { type: "event", seq: 3, event: { kind: "status", ref: { workspaceId, tabId: tabA }, status: null } });
    expect(state.tabs[`${workspaceId}:${tabA}`]?.agentStatus).toBeUndefined();
    state = reduceTerminalEvents(state, { type: "event", seq: 4, event: { kind: "finished", ref: { workspaceId, tabId: tabA }, exitCode: 2 } });
    expect(state.tabs[`${workspaceId}:${tabA}`]).toMatchObject({ state: "finished", exitCode: 2 });
    state = reduceTerminalEvents(state, { type: "event", seq: 5, event: { kind: "removed", ref: { workspaceId, tabId: tabA } } });
    expect(state.tabs).toEqual({});
    expect(reduceTerminalEvents(state, { type: "event", event: { kind: "status", ref: { workspaceId, tabId: tabB }, status: "dancing" } })).toBe(state);
  });
});

class FakeSocket implements TerminalEventsSocket {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
}

describe("terminal events client", () => {
  it("pings while open, reconnects with backoff after a drop, and stops cleanly", async () => {
    const sockets: FakeSocket[] = [];
    const timers: Array<{ callback: () => void; ms: number }> = [];
    const repeats: Array<() => void> = [];
    const states: unknown[] = [];
    const client = createTerminalEventsClient({
      url: () => "wss://example.test/ws/terminal/events",
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      onState: (state) => states.push(state),
      setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
      clearTimer: vi.fn(),
      setRepeat: (callback) => { repeats.push(callback); return repeats.length; },
      clearRepeat: vi.fn(),
    });
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    client.start();
    await flush();
    sockets[0]!.onopen?.({});
    repeats[0]!();
    expect(sockets[0]!.sent).toEqual([JSON.stringify({ type: "ping" })]);
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "snapshot", seq: 1, tabs: [fact(tabA)] }) });
    expect(client.getState().connected).toBe(true);

    sockets[0]!.onclose?.({});
    expect(client.getState().connected).toBe(false);
    expect(timers.map((timer) => timer.ms)).toEqual([1_000]);
    timers[0]!.callback();
    await flush();
    expect(sockets).toHaveLength(2);
    sockets[1]!.onclose?.({});
    expect(timers.map((timer) => timer.ms)).toEqual([1_000, 2_000]);

    timers[1]!.callback();
    await flush();
    client.stop();
    expect(sockets[2]!.closed).toBe(true);
    // A stopped client never reconnects.
    sockets[2]!.onclose?.({});
    expect(timers).toHaveLength(2);
    expect(states.length).toBeGreaterThan(0);
  });

  // Fault detected (review of #3299): a socket closed by stop() republishes the old
  // tabs after the store has cleared itself.
  it("ignores close and messages from a socket it stopped", async () => {
    const sockets: FakeSocket[] = [];
    const states: Array<{ tabs: Record<string, unknown> }> = [];
    const client = createTerminalEventsClient({
      url: () => "wss://example.test/ws/terminal/events",
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      onState: (state) => states.push(state),
      setTimer: () => 1, clearTimer: () => undefined, setRepeat: () => 1, clearRepeat: () => undefined,
    });
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "snapshot", seq: 1, tabs: [fact(tabA)] }) });
    const published = states.length;
    client.stop();
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "snapshot", seq: 2, tabs: [fact(tabB)] }) });
    sockets[0]!.onclose?.({});
    expect(states).toHaveLength(published);
  });

  // Fault detected (fourth review of #3299): a snapshot above the client's cap was
  // rejected whole, dropping every live badge.
  it("keeps live tabs from a snapshot larger than its cap", () => {
    const finished = Array.from({ length: 10_300 }, (_, i) => fact(`tt_${i.toString(16).padStart(32, "0")}`, { state: "finished", exitCode: 0 }));
    const state = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, { type: "snapshot", seq: 1, tabs: [...finished, fact(tabA, { agentStatus: "blocked" })] });
    expect(Object.keys(state.tabs).length).toBeLessThanOrEqual(10_240);
    expect(state.tabs[`${workspaceId}:${tabA}`]).toMatchObject({ agentStatus: "blocked" });
  });

  // Fault detected (fifth review of #3299): at the cap a new live tab was dropped,
  // although the gateway was about to remove a finished one.
  it("makes room for a new live tab by dropping finished history", () => {
    const finished = Array.from({ length: 10_240 }, (_, i) => fact(`tt_${i.toString(16).padStart(32, "0")}`, { state: "finished", exitCode: 0 }));
    let state = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, { type: "snapshot", seq: 1, tabs: finished });
    expect(Object.keys(state.tabs)).toHaveLength(10_240);
    state = reduceTerminalEvents(state, { type: "event", seq: 2, event: { kind: "created", ref: { workspaceId, tabId: tabA }, tab: fact(tabA, { agentStatus: "blocked" }) } });
    expect(state.tabs[`${workspaceId}:${tabA}`]).toMatchObject({ agentStatus: "blocked" });
    expect(Object.keys(state.tabs)).toHaveLength(10_240);
  });

  // Fault detected (eighth review of #3299): the client checked project IDs with its own
  // rule instead of the gateway's, so the two could disagree and drop live status.
  it("accepts every project ID the gateway accepts, using the same schema", () => {
    const projectId = `proj_${"a".repeat(123)}`;
    expect(ProjectIdSchema.safeParse(projectId).success).toBe(true);
    const state = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, { type: "snapshot", seq: 1, tabs: [fact(tabA, { projectId, agentStatus: "working" })] });
    expect(state.tabs[`${workspaceId}:${tabA}`]).toMatchObject({ projectId, agentStatus: "working" });
  });

  it("rejects frames with unknown fields or oversized values", () => {
    const snapshot = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, { type: "snapshot", seq: 1, tabs: [fact(tabA)] });
    for (const frame of [
      { type: "event", seq: 2, event: { kind: "status", ref: { workspaceId, tabId: tabA }, status: "working", extra: 1 } },
      { type: "event", seq: 2, event: { kind: "title", ref: { workspaceId, tabId: tabA }, name: "x".repeat(500) } },
    ]) {
      expect(reduceTerminalEvents(snapshot, frame)).toBe(snapshot);
    }
    // A snapshot drops only the tab that does not match.
    const next = reduceTerminalEvents(snapshot, { type: "snapshot", seq: 3, tabs: [{ ...fact(tabA), injected: "<script>" }, fact(tabB)] });
    expect(Object.keys(next.tabs)).toEqual([`${workspaceId}:${tabB}`]);
  });
});
