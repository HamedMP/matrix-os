import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellSocket, type WebSocketLike } from "../../desktop/src/renderer/src/lib/shell-socket";

const terminalRef = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
function setup() {
  vi.useFakeTimers();
  const peers: Array<WebSocketLike & { frames: Record<string, unknown>[] }> = [];
  const client = new ShellSocket({
    baseUrl: "https://app.matrix-os.com", runtimeSlot: "primary",
    sessionName: `${terminalRef.workspaceId}:${terminalRef.tabId}`,
    events: { onState() {}, onOutput() {}, onGap() {}, onExit() {} },
    random: () => 0,
    createWebSocket: () => {
      const frames: Record<string, unknown>[] = [];
      const peer = { frames, send: (data: string) => frames.push(JSON.parse(data)), close() {},
        onopen: null, onmessage: null, onclose: null, onerror: null } as WebSocketLike & { frames: Record<string, unknown>[] };
      peers.push(peer);
      return peer;
    },
  });
  const attach = (ownership: "writer" | "observer") => {
    const peer = peers.at(-1)!;
    peer.onopen?.();
    peer.onmessage?.({ data: JSON.stringify({ type: "attached", terminalRef, revision: 1,
      canonicalSize: { cols: 120, rows: 36 }, nextSeq: 0, ownership, leaseEpoch: 1, capabilities: [] }) });
    return peer;
  };
  client.resize(180, 60);
  client.connect();
  return { client, peers, attach };
}
afterEach(() => vi.useRealTimers());

describe("desktop viewport resize authority", () => {
  it("requests real grid expansion after attach and resends it after reconnect", () => {
    const { client, peers, attach } = setup();
    let peer = attach("writer");
    vi.advanceTimersByTime(1000);
    expect(peer.frames).toContainEqual({ type: "resize", terminalRef, mode: "hard", size: { cols: 180, rows: 60 } });
    peer.onclose?.();
    vi.advanceTimersByTime(1000);
    expect(peers).toHaveLength(2);
    peer = attach("writer");
    vi.advanceTimersByTime(1000);
    expect(peer.frames).toContainEqual({ type: "resize", terminalRef, mode: "hard", size: { cols: 180, rows: 60 } });
    client.dispose();
  });
  it("cannot hard-resize once ownership is revoked, including a queued resize", () => {
    const { client, attach } = setup();
    const peer = attach("writer");
    client.resize(200, 70);
    peer.onmessage?.({ data: JSON.stringify({ type: "lease-revoked", terminalRef, epoch: 2 }) });
    vi.advanceTimersByTime(1000);
    expect(peer.frames.filter((frame) => frame.type === "resize").every((frame) => frame.mode === "soft")).toBe(true);
    client.dispose();
  });
});
