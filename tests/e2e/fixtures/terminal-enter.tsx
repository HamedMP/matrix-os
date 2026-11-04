import React from "react";
import { createRoot } from "react-dom/client";
import { TerminalPane } from "../../../shell/src/components/terminal/TerminalPane";
import "@xterm/xterm/css/xterm.css";

// Only transport/auth are simulated. DOM, focus, keyboard policy, onData and
// writer guards are the production TerminalPane and the locked real xterm.
export const refs = [
  { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` },
  { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"c".repeat(32)}` },
];
const frames: unknown[] = [];
const sockets: FixtureSocket[] = [];
let ready = 0;
class FixtureSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  readonly ref: typeof refs[number];
  constructor(url: string) {
    const query = new URL(url).searchParams;
    this.ref = refs.find(ref => ref.tabId === query.get("tabId"))!;
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.receive({ type: "attached", canonicalSize: { cols: 80, rows: 18 },
        nextSeq: 0, ownership: new URLSearchParams(location.search).has("observer") ? "observer" : "writer", leaseEpoch: 1 });
      this.receive({ type: "replay-start", fromSeq: 0 });
      this.receive({ type: "output", seq: 0, data: "ready$ " });
      this.receive({ type: "replay-end", nextSeq: 1, toSeq: 0 });
      ready += 1;
    }, 10);
  }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ terminalRef: this.ref, ...(frame.type === "lease-revoked" ? {} : { revision: 1 }), ...frame }) }));
  }
  send(raw: string) {
    const frame = JSON.parse(raw);
    if (frame.type === "ping") this.receive({ type: "pong" });
    if (frame.type === "input" && frames.length < 100) frames.push(frame);
  }
  close() { this.readyState = 3; }
}
Object.defineProperty(window, "WebSocket", { value: FixtureSocket });
Object.defineProperty(window, "enterFixture", { value: {
  frames,
  get ready() { return ready; },
  revoke: (tabId: string) => sockets.filter(socket => socket.ref.tabId === tabId)
    .forEach(socket => socket.receive({ type: "lease-revoked", epoch: 1 })),
} });
const theme = { name: "fixture", mode: "dark" as const,
  colors: { background: "#141614", foreground: "#e5e7eb", primary: "#434e3f" },
  fonts: { mono: "monospace" }, radius: "8px" };
createRoot(document.getElementById("root")!).render(<main>
  <button id="outside">Outside terminal</button>
  {refs.map((ref, index) => <section key={ref.tabId} id={`pane-${index}`} style={{ width: 760, height: 360 }}>
    <TerminalPane paneId={`enter-${index}`} cwd="" theme={theme} isFocused
      sessionId={`${ref.workspaceId}:${ref.tabId}`} shouldCacheOnUnmount={() => false}
      shouldDestroyOnUnmount={() => false} />
  </section>)}
</main>);
