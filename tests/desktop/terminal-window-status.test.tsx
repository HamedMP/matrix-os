// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixComputer } from "@matrix-os/contracts";
import type { TerminalEventsSocket } from "@matrix-os/ui/terminal-agents";
import {
  terminalRowTarget,
  useTerminalStatus,
} from "@desktop/renderer/src/features/terminal-window/use-terminal-status";

// Spec 2706 layer 4: the Terminal window's sidebar rows come from pushed local
// facts and one events stream per available computer, and opening a terminal
// marks it seen where everyone sees it.

type Listener = (payload: unknown) => void;
function installOperator(handlers: Record<string, (payload: never) => unknown>) {
  const listeners = new Map<string, Listener[]>();
  const invoke = vi.fn(async (channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) throw new Error(`unexpected channel ${channel}`);
    return handler(payload as never);
  });
  window.operator = {
    invoke,
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  };
  return { invoke, emit: (channel: string, payload: unknown) => { for (const listener of listeners.get(channel) ?? []) listener(payload); } };
}

class FakeSocket implements TerminalEventsSocket {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; }
  deliver(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const workspaceId = `tws_${"0".repeat(32)}`;
const tabId = `tt_${"a".repeat(32)}`;
const computer = (slot: string, availability: MatrixComputer["availability"] = "available") =>
  ({ runtimeSlot: slot, label: slot === "primary" ? "Main" : slot, handle: "neo", availability }) as MatrixComputer;
const localFact = { id: "t1", title: "claude", status: "done", statusAt: 1_000, turn: 2, seenTurn: null, finished: false };

describe("Terminal window status", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("shows local rows from watch, then pushed changes, without listing on a timer", async () => {
    const operator = installOperator({ "local-terminal:watch": () => ({ status: "ready", terminals: [localFact] }) });
    const { result } = renderHook(() => useTerminalStatus({ platformHost: null, sessionKey: "", computers: [] }));
    await waitFor(() => expect(result.current.rows).toEqual([expect.objectContaining({ key: "local|t1", status: "done", seen: false })]));
    act(() => operator.emit("local-terminal:facts", { terminals: [{ ...localFact, seenTurn: 2 }] }));
    expect(result.current.rows[0]).toMatchObject({ seen: true });
    expect(operator.invoke.mock.calls.map(([channel]) => channel)).toEqual(["local-terminal:watch"]);
  });

  it("subscribes once per available computer and closes a stream when its computer goes away", async () => {
    installOperator({ "local-terminal:watch": () => ({ status: "unavailable" }) });
    const sockets: FakeSocket[] = [];
    const createSocket = (url: string) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; };
    const { result, rerender } = renderHook((props: { computers: MatrixComputer[] }) => useTerminalStatus({
      platformHost: "https://app.matrix-os.com", sessionKey: "s1", computers: props.computers, createSocket,
    }), { initialProps: { computers: [computer("primary"), computer("lab"), computer("cold", "starting")] } });
    await waitFor(() => expect(sockets).toHaveLength(2));
    expect(sockets.map((socket) => socket.url).sort()).toEqual([
      "wss://app.matrix-os.com/ws/terminal/events",
      "wss://app.matrix-os.com/ws/terminal/events?runtime=lab",
    ]);
    const lab = sockets.find((socket) => socket.url.endsWith("runtime=lab"))!;
    act(() => {
      lab.onopen?.({});
      lab.deliver({ type: "snapshot", seq: 1, tabs: [{ ref: { workspaceId, tabId }, name: "build", cwd: "", state: "finished", exitCode: 4 }] });
      lab.deliver({ type: "attention", seq: 2, tabs: { [`${workspaceId}:${tabId}`]: { doneAt: "2026-11-11T10:04:00.000Z", seen: false } } });
    });
    const key = `computer:lab|${workspaceId}:${tabId}`;
    expect(result.current.rows).toEqual([expect.objectContaining({ key, name: "build", status: "done", seen: false, machine: expect.objectContaining({ name: "lab", remote: true }) })]);

    act(() => result.current.markSeen(key));
    expect(lab.sent).toEqual([JSON.stringify({ type: "seen", ref: { workspaceId, tabId } })]);
    expect(result.current.rows[0]).toMatchObject({ seen: true });

    rerender({ computers: [computer("primary")] });
    expect(lab.closed).toBe(true);
    expect(result.current.rows).toEqual([]);
    expect(sockets).toHaveLength(2);
  });

  it("marks a local terminal seen through the trusted core", async () => {
    const seen = vi.fn(() => ({ ok: true }));
    installOperator({ "local-terminal:watch": () => ({ status: "ready", terminals: [localFact] }), "local-terminal:seen": seen });
    const { result } = renderHook(() => useTerminalStatus({ platformHost: null, sessionKey: "", computers: [] }));
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    act(() => result.current.markSeen("local|t1"));
    await waitFor(() => expect(seen).toHaveBeenCalledWith({ id: "t1" }));
  });

  it("reads where a row's terminal lives and refuses anything else", () => {
    expect(terminalRowTarget("local|vps/t4")).toEqual({ kind: "local", id: "vps/t4" });
    expect(terminalRowTarget(`computer:lab|${workspaceId}:${tabId}`)).toEqual({ kind: "computer", slot: "lab", ref: { workspaceId, tabId } });
    expect(terminalRowTarget("computer:lab|../etc")).toBeNull();
    expect(terminalRowTarget("nowhere")).toBeNull();
  });
});
