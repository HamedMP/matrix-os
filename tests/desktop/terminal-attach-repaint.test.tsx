// @vitest-environment jsdom
// A herdr-core attach repaints the whole terminal (screen and history). The
// view must show that paint once: reopening a terminal must not stack the
// core's history on top of a copy the window kept from the last visit.
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terminal as XTerminal } from "@xterm/xterm";
import { corePaint } from "./fixtures/fake-herdr-core";

const { terminals } = vi.hoisted(() => ({ terminals: [] as XTerminal[] }));
// The real xterm parser and buffer; only the instances are recorded.
vi.mock("@xterm/xterm", async (importActual) => {
  const actual = await importActual<typeof import("@xterm/xterm")>();
  return {
    ...actual,
    Terminal: class RecordedTerminal extends actual.Terminal {
      constructor(options?: ConstructorParameters<typeof actual.Terminal>[0]) {
        super(options);
        terminals.push(this);
      }
    },
  };
});
// jsdom has no WebGL.
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class { dispose() {} } }));

import TerminalView from "@desktop/renderer/src/features/terminal/TerminalView";
import { resetAttachManager, setAlternateTerminalSockets } from "@desktop/renderer/src/features/terminal/terminal-runtime";
import { LOCAL_TERMINAL_SOCKETS } from "@desktop/renderer/src/features/terminal-window/local-terminal-socket";
import { useConnection } from "@desktop/renderer/src/stores/connection";

type Listener = (payload: unknown) => void;
function installOperator(options: { attachReply?: Promise<void> } = {}) {
  const listeners = new Map<string, Listener[]>();
  let nextAttach = 1;
  const invoke = vi.fn(async (channel: string) => {
    if (channel === "local-terminal:attach") {
      const attachId = nextAttach++;
      await options.attachReply;
      return { ok: true, attachId };
    }
    if (channel.startsWith("local-terminal:")) return { ok: true };
    if (channel === "state:get") return { value: null };
    throw new Error(`unexpected channel ${channel}`);
  });
  window.operator = {
    invoke,
    on: (channel, callback) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), callback]);
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== callback));
    },
  } as typeof window.operator;
  return {
    invoke,
    emit: (channel: string, payload: unknown) => { for (const listener of [...(listeners.get(channel) ?? [])]) listener(payload); },
    lastAttachId: () => nextAttach - 1,
  };
}

function bufferLines(terminal: XTerminal): string[] {
  const buffer = terminal.buffer.active;
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row += 1) lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  return lines;
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const drawn = (terminal: XTerminal) => act(() => new Promise<void>((resolve) => terminal.write("", resolve)));

describe("herdr-core attach repaint", () => {
  beforeEach(() => {
    terminals.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    useConnection.setState({ status: "signed-out", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary", api: null } as never);
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    setAlternateTerminalSockets(LOCAL_TERMINAL_SOCKETS);
  });
  afterEach(() => {
    cleanup();
    setAlternateTerminalSockets(null);
    resetAttachManager();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the core's history once when a terminal is reopened", async () => {
    const operator = installOperator();
    const history = Array.from({ length: 40 }, (_, index) => `history line ${index}`);
    const paint = (rows: number) => corePaint({ history, screen: ["$ ls", "README.md", "$ "], rows });

    const first = render(<TerminalView sessionName="local:t1" active />);
    await flush();
    const firstTerminal = terminals.at(-1)!;
    operator.emit("local-terminal:output", { attachId: operator.lastAttachId(), data: paint(firstTerminal.rows) });
    await drawn(firstTerminal);
    expect(bufferLines(firstTerminal).filter((line) => line === "history line 7")).toHaveLength(1);
    first.unmount();

    // Reopened: the core paints the same terminal again.
    render(<TerminalView sessionName="local:t1" active />);
    await flush();
    const reopened = terminals.at(-1)!;
    expect(reopened).not.toBe(firstTerminal);
    // Nothing of the last visit is drawn under the core's paint.
    await drawn(reopened);
    expect(bufferLines(reopened).some((line) => line.startsWith("history line"))).toBe(false);
    operator.emit("local-terminal:output", { attachId: operator.lastAttachId(), data: paint(reopened.rows) });
    await drawn(reopened);

    const lines = bufferLines(reopened);
    expect(lines.filter((line) => line === "history line 7")).toHaveLength(1);
    expect(lines.filter((line) => line === "README.md")).toHaveLength(1);
  });

  it("keeps a first paint that reached the window before the attach reply", async () => {
    let reply!: () => void;
    const operator = installOperator({ attachReply: new Promise<void>((resolve) => { reply = resolve; }) });
    render(<TerminalView sessionName="local:t2" active />);
    await flush();
    const terminal = terminals.at(-1)!;
    // The core's paint can share a read with its answer to the attach.
    operator.emit("local-terminal:output", { attachId: 1, data: corePaint({ history: ["early history"], screen: ["$ "], rows: terminal.rows }) });
    await act(async () => { reply(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await drawn(terminal);
    expect(bufferLines(terminal).filter((line) => line === "early history")).toHaveLength(1);
  });
});
