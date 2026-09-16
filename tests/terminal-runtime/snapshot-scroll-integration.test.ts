import { Terminal } from "@xterm/xterm";
import { expect, it, vi } from "vitest";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import type { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

it("keeps startup redraw and mode changes ordered while initializing a viewer", async () => {
  const ref = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
  const store = { getRuntimeWorkspace: async () => ({
    id: ref.workspaceId, zellijSessionName: "test", canonicalSize: { cols: 80, rows: 24 },
    tabs: { [ref.tabId]: { zellijPaneId: "terminal_1" } },
  }) } as unknown as TerminalWorkspaceStore;
  let emit!: (data: Uint8Array) => void;
  const encode = (text: string) => new TextEncoder().encode(text);
  const openAttachment = vi.fn(async (_name: string, input: { onData: typeof emit }) => {
    emit = input.onData;
    emit(encode("\x1b[?1000;1006hinitial prompt"));
    return { write: async () => {}, resize: async () => {}, close: async () => {} };
  });
  const runtime = new TerminalRuntime({ store, zellij: { openAttachment } as unknown as ZellijRuntimeAdapter });
  const terminal = new Terminal({ allowProposedApi: true });
  const later = new Terminal({ allowProposedApi: true });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const sending = new Promise<void>((resolve) => { started = resolve; });
  const output: string[] = [];
  let first = true;
  try {
    const attaching = runtime.attach(ref, { viewerId: "first", send: async (data) => {
      if (first) { first = false; started(); await pending; }
      output.push(new TextDecoder().decode(data));
      await new Promise<void>((resolve) => terminal.write(data, resolve));
    } });
    await sending;
    emit(encode("\x1b[?1000l\r\nlatest prompt"));
    expect(output).toEqual([]);
    release();
    await attaching;
    await vi.waitFor(() => expect(output).toHaveLength(3));
    await new Promise<void>((resolve) => terminal.write("", resolve));
    expect(output[0]).toContain("\x1b[?1000h");
    expect(output[0]).not.toContain("initial prompt");
    expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe("initial prompt");
    expect(terminal.buffer.active.getLine(1)?.translateToString(true)).toBe("latest prompt");
    expect(terminal.modes.mouseTrackingMode).toBe("none");
    await runtime.attach(ref, { viewerId: "later", send: (data) => new Promise<void>((resolve) => later.write(data, resolve)) });
    expect(later.modes.mouseTrackingMode).toBe("none");
    expect(openAttachment).toHaveBeenCalledOnce();
  } finally {
    release();
    await runtime.shutdown();
    terminal.dispose();
    later.dispose();
  }
});
