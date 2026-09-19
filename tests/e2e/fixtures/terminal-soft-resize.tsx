import React from "react";
import { createRoot } from "react-dom/client";
import { TerminalPane } from "../../../shell/src/components/terminal/TerminalPane";
import TerminalView from "../../../desktop/src/renderer/src/features/terminal/TerminalView";
import { useConnection } from "../../../desktop/src/renderer/src/stores/connection";
import "../../../desktop/src/renderer/src/design/tokens.css";
import "@xterm/xterm/css/xterm.css";

const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
const canonicalSize = { cols: 120, rows: 36 };
const fitViewport = new URLSearchParams(window.location.search).get("sizing") === "viewport";
const proposals: unknown[] = [];
const inputs: string[] = [];
let latestSocket: FixtureSocket | undefined;
let outputSequence = 1;
class FixtureSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    latestSocket = this;
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event("open"));
      this.receive({
        type: "attached",
        canonicalSize,
        nextSeq: 0,
        capabilities: ["binary-input-v1"],
        ownership: fitViewport ? "writer" : "observer",
        leaseEpoch: 1,
      });
      this.receive({ type: "replay-start", fromSeq: 0 });
      const data = "\x1b[?1000h\x1b[?1006h\x1b[2J\x1b[H" + Array.from({ length: 35 }, (_, index) =>
        `row ${String(index + 1).padStart(2, "0")}  synthetic terminal output\r\n`).join("") + "LAST-ROW-VISIBLE$ ";
      this.receive({ type: "output", seq: 0, data });
      this.receive({ type: "replay-end", nextSeq: 1, toSeq: 0 });
    }, 10);
  }
  receive(frame: Record<string, unknown>) {
    const identity = frame.type === "lease-revoked"
      ? { terminalRef: ref }
      : { terminalRef: ref, revision: 1 };
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ ...identity, ...frame }) }));
  }
  send(raw: string) {
    const frame = JSON.parse(raw);
    if (frame.type === "resize") {
      if (proposals.length < 100) proposals.push(frame);
      // Match runtime semantics: only a hard resize changes the canonical grid.
      if (fitViewport && frame.mode === "hard") Object.assign(canonicalSize, frame.size);
      this.receive({ type: "canonical-size", canonicalSize });
      if (fitViewport && frame.mode === "hard") {
        const { cols, rows } = canonicalSize;
        this.receive({ type: "output", seq: outputSequence++, data:
          `\x1b[2J\x1b[HGrid: ${cols} columns x ${rows} rows\r\n` +
          "Synthetic terminal resize verification" +
          `\x1b[${rows};1HFINAL ROW${" ".repeat(Math.max(0, cols - 20))}RIGHT EDGE` });
      }
    }
    if (frame.type === "ping") this.receive({ type: "pong" });
    if ((frame.type === "input" || frame.type === "binary") && inputs.length < 100) {
      inputs.push(frame.type === "binary" ? atob(frame.dataBase64) : frame.data);
    }
  }
  close() { this.readyState = 3; }
}
Object.defineProperty(window, "WebSocket", { value: FixtureSocket });
Object.defineProperty(window, "fixtureProposals", { value: proposals });
Object.defineProperty(window, "fixtureGrid", { value: canonicalSize });
Object.defineProperty(window, "fixtureInputs", { value: inputs });
Object.defineProperty(window, "fixtureOutput", { value: (data: string) => latestSocket?.receive({ type: "output", seq: outputSequence++, data }) });
Object.defineProperty(window, "fixtureObserve", { value: () => latestSocket?.receive({ type: "lease-revoked", epoch: 1 }) });
window.operator = { invoke: async () => ({}), on: () => () => undefined };
useConnection.setState({ platformHost: window.location.origin, runtimeSlot: "primary", api: null });
const params = new URLSearchParams(window.location.search);
const electron = params.get("surface") === "electron";
const mobile = params.get("surface") === "web-mobile";
const zoom = Number(params.get("zoom") ?? "1");
const theme = {
  name: "fixture", mode: "dark" as const, colors: {
    background: "#141614", foreground: "#e5e7eb", primary: "#434e3f",
  }, fonts: { mono: "monospace" }, radius: "8px",
};
createRoot(document.getElementById("root")!).render(
  <main>
    <h1>{electron ? "Electron Desktop" : mobile ? "Web Mobile" : zoom === 1 ? "Web Desktop" : "Web Canvas"} — Terminal resize verification</h1>
    <section id="terminal-window" style={{ width: mobile ? 360 : 1100, height: 850, transform: `scale(${zoom})`, transformOrigin: "top left", display: "flex", flexDirection: "column", background: theme.colors.background }}>
      {electron ? <TerminalView sessionName={`${ref.workspaceId}:${ref.tabId}`} active visualScale={zoom} />
        : <TerminalPane paneId="browser-sizing" cwd="" theme={theme} isFocused canvasZoom={zoom} suppressNativeKeyboard={mobile}
            sessionId={`${ref.workspaceId}:${ref.tabId}`} shouldCacheOnUnmount={() => false} shouldDestroyOnUnmount={() => false} />}
    </section>
  </main>,
);
