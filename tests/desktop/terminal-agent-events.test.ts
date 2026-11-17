import { afterEach, describe, expect, it } from "vitest";
import type { TerminalEventsSocket } from "@matrix-os/ui/terminal-agents";
import {
  buildTerminalEventsWsUrl,
  useTerminalAgentEvents,
  wireTerminalAgentEvents,
} from "@desktop/renderer/src/stores/terminal-agent-events";

const workspaceId = `tws_${"0".repeat(32)}`;
const tabId = `tt_${"a".repeat(32)}`;

class FakeSocket implements TerminalEventsSocket {
  readyState = 0;
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void { this.closed = true; this.readyState = 3; this.onclose?.({}); }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
let dispose: (() => void) | null = null;
afterEach(() => { dispose?.(); dispose = null; });

describe("desktop terminal events connection", () => {
  // Fault detected: Electron connects to the wrong computer's events stream, or drops the
  // runtime slot so a secondary computer's agents never report.
  it("builds the events URL for the selected computer like the kernel socket", () => {
    expect(buildTerminalEventsWsUrl("https://app.matrix-os.com/", "primary")).toBe("wss://app.matrix-os.com/ws/terminal/events");
    expect(buildTerminalEventsWsUrl("http://localhost:4000", "vm 2")).toBe("ws://localhost:4000/ws/terminal/events?runtime=vm%202");
  });

  // Fault detected: remote tab status never reaches the Electron store, or a computer
  // switch keeps the old computer's tabs and socket alive.
  it("publishes snapshots and replaces the connection when the computer changes", async () => {
    const sockets: FakeSocket[] = [];
    const createSocket = (url: string) => { const socket = new FakeSocket(url); sockets.push(socket); return socket; };
    dispose = wireTerminalAgentEvents({ baseUrl: "https://app.matrix-os.com", runtimeSlot: "primary", createSocket });
    await flush();
    expect(sockets.map((socket) => socket.url)).toEqual(["wss://app.matrix-os.com/ws/terminal/events"]);
    sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "snapshot", seq: 1, tabs: [
      { ref: { workspaceId, tabId }, name: "review", cwd: "", state: "live", agentStatus: "blocked" },
    ] }) });
    expect(useTerminalAgentEvents.getState().connected).toBe(true);
    expect(useTerminalAgentEvents.getState().tabs[`${workspaceId}:${tabId}`]?.agentStatus).toBe("blocked");

    dispose = wireTerminalAgentEvents({ baseUrl: "https://app.matrix-os.com", runtimeSlot: "second", createSocket });
    expect(sockets[0]!.closed).toBe(true);
    expect(useTerminalAgentEvents.getState()).toMatchObject({ connected: false, tabs: {} });
    await flush();
    expect(sockets[1]!.url).toBe("wss://app.matrix-os.com/ws/terminal/events?runtime=second");

    dispose();
    dispose = null;
    expect(sockets[1]!.closed).toBe(true);
    // A frame from a stopped connection must not restore old tabs.
    sockets[1]!.onmessage?.({ data: JSON.stringify({ type: "snapshot", seq: 2, tabs: [] }) });
    expect(useTerminalAgentEvents.getState().connected).toBe(false);
  });
});
