import { describe, expect, it, vi } from "vitest";
import {
  createTerminalEventsClient,
  EMPTY_TERMINAL_EVENTS_STATE,
  reduceTerminalEvents,
  type TerminalEventsSocket,
} from "../../packages/ui/src/terminal-agents/index.js";
import {
  computerSidebarRows,
  localSidebarRows,
  terminalStatusSections,
  type TerminalSidebarMachine,
} from "../../packages/ui/src/terminal-status-sidebar/index.js";

// Spec 2706 layer 4: the sidebar's rows come from live status, local and per
// computer, and "Done" means finished since the person last opened it.

const workspaceId = `tws_${"0".repeat(32)}`;
const tabA = `tt_${"a".repeat(32)}`;
const tabB = `tt_${"b".repeat(32)}`;
const keyA = `${workspaceId}:${tabA}`;
const keyB = `${workspaceId}:${tabB}`;
const computer: TerminalSidebarMachine = { id: "computer:primary", name: "Main computer", remote: true };
const mac: TerminalSidebarMachine = { id: "local", name: "This Mac", remote: false };

class FakeSocket implements TerminalEventsSocket {
  readyState = 1;
  sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
}

function snapshot(seq = 1) {
  return {
    type: "snapshot", seq,
    tabs: [
      { ref: { workspaceId, tabId: tabA }, name: "build", cwd: "", state: "finished", exitCode: 4 },
      { ref: { workspaceId, tabId: tabB }, name: "review", cwd: "", state: "live", agentStatus: "done", statusAt: "2026-11-11T10:03:00.000Z" },
    ],
  };
}
const attention = (seenA: boolean, seq = 2) => ({
  type: "attention", seq,
  tabs: {
    [keyA]: { doneAt: "2026-11-11T10:04:00.000Z", seen: seenA },
    [keyB]: { doneAt: "2026-11-11T10:03:00.000Z", seen: false },
  },
});

describe("attention frames", () => {
  it("keeps which done tabs were opened, and ignores malformed attention", () => {
    let state = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, snapshot());
    expect(state.attention).toBeUndefined();
    state = reduceTerminalEvents(state, attention(true));
    expect(state.attention?.[keyA]).toEqual({ doneAt: "2026-11-11T10:04:00.000Z", seen: true });
    const before = state;
    expect(reduceTerminalEvents(state, { type: "attention", seq: 3, tabs: { [keyA]: { doneAt: "x".repeat(65), seen: true } } })).toBe(before);
    expect(reduceTerminalEvents(state, { type: "attention", seq: 3, tabs: { "../etc": { doneAt: "now", seen: true } } })).toBe(before);
  });
});

describe("marking a computer tab seen", () => {
  async function connected() {
    const sockets: FakeSocket[] = [];
    const client = createTerminalEventsClient({
      url: () => "wss://example.test/ws/terminal/events",
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
      onState: () => undefined,
      setTimer: () => 0, clearTimer: vi.fn(), setRepeat: () => 0, clearRepeat: vi.fn(),
    });
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    sockets[0]!.onopen?.({});
    sockets[0]!.onmessage?.({ data: JSON.stringify(snapshot()) });
    return { client, socket: sockets[0]! };
  }

  // Fault detected: an older gateway closes the socket on any client frame but a ping.
  it("never sends a seen frame to a gateway that sent no attention frame", async () => {
    const { client, socket } = await connected();
    expect(client.markSeen({ workspaceId, tabId: tabA })).toBe(false);
    expect(socket.sent).toEqual([]);
  });

  it("sends the mark and shows the tab as seen at once", async () => {
    const { client, socket } = await connected();
    socket.onmessage?.({ data: JSON.stringify(attention(false)) });
    expect(client.markSeen({ workspaceId, tabId: tabA })).toBe(true);
    expect(socket.sent).toEqual([JSON.stringify({ type: "seen", ref: { workspaceId, tabId: tabA } })]);
    expect(client.getState().attention?.[keyA]?.seen).toBe(true);
    // Already seen: nothing more is sent.
    expect(client.markSeen({ workspaceId, tabId: tabA })).toBe(true);
    expect(socket.sent).toHaveLength(1);
  });
});

describe("sidebar rows", () => {
  it("files a finished computer tab under Done until it is opened", () => {
    let state = reduceTerminalEvents(EMPTY_TERMINAL_EVENTS_STATE, snapshot());
    state = reduceTerminalEvents(state, attention(false));
    const rows = computerSidebarRows(state, computer);
    expect(rows.find((row) => row.name === "build")).toMatchObject({
      key: `computer:primary|${keyA}`, status: "done", seen: false, statusAt: "2026-11-11T10:04:00.000Z", machine: computer,
    });
    expect(terminalStatusSections(rows).map((section) => [section.id, section.rows.map((row) => row.name)]))
      .toEqual([["done", ["build", "review"]]]);

    state = reduceTerminalEvents(state, attention(true, 3));
    const after = terminalStatusSections(computerSidebarRows(state, computer));
    expect(after.map((section) => [section.id, section.rows.map((row) => row.name)])).toEqual([["done", ["review"]], ["idle", ["build"]]]);
  });

  it("maps local terminals: status, Herdr's seen label, sub-agents and agent icons", () => {
    const rows = localSidebarRows([
      { id: "t1", title: "claude", status: "done", statusAt: 1_000, turn: 3, seenTurn: 3, finished: false, agent: "claude" },
      { id: "t2", title: "helper", status: "working", statusAt: 2_000, turn: 1, seenTurn: null, finished: false, parent: "t1" },
      { id: "t3", title: "tests", status: null, statusAt: 3_000, turn: 0, seenTurn: null, finished: true, finishedSeen: false },
    ], mac);
    expect(rows).toEqual([
      expect.objectContaining({ key: "local|t1", name: "claude", status: "done", seen: true, agent: "claude", statusAt: new Date(1_000).toISOString() }),
      expect.objectContaining({ key: "local|t2", status: "working", parentKey: "local|t1" }),
      expect.objectContaining({ key: "local|t3", status: "done", seen: false }),
    ]);
    // The seen claude terminal reads idle, but takes its working sub-agent's status.
    expect(terminalStatusSections(rows).map((section) => [section.id, section.rows.map((row) => row.name)]))
      .toEqual([["done", ["tests"]], ["working", ["claude"]]]);
  });
});
