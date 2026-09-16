import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  TerminalRuntime,
  type ZellijRuntimeAdapter,
} from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

const flushTerminal = (terminal: Terminal) => new Promise<void>((resolve) => {
  terminal.write("\x1b[0m", resolve);
});

describe("scroll initialization for additional terminal viewers", () => {
  it.each([
    {
      name: "mouse reporting enabled before the second viewer joins",
      chunks: ["\x1b[?1049h\x1b[?1000h\x1b[?1006h"],
      mouseTrackingMode: "vt200",
      buffer: "alternate",
    },
    {
      name: "fragmented mouse-mode changes before the second viewer joins",
      chunks: ["\x1b[?1049h\x1b[?1000h", "\x1b[?1000l\x1b[?10", "02h\x1b[?1006h"],
      mouseTrackingMode: "drag",
      buffer: "alternate",
    },
    {
      name: "disabled mouse reporting is not re-enabled",
      chunks: ["\x1b[?1049h\x1b[?1000h\x1b[?1006h", "\x1b[?1000l\x1b[?1006l"],
      mouseTrackingMode: "none",
      buffer: "alternate",
    },
    {
      name: "a terminal reset clears earlier mouse reporting",
      chunks: ["\x1b[?1049h\x1b[?1000h\x1b[?1006h", "\x1bc"],
      mouseTrackingMode: "none",
      buffer: "normal",
    },
  ])("restores current state: $name", async ({ chunks, mouseTrackingMode, buffer }) => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-viewer-scroll-"));
    const first = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const second = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const clipboardCommand = vi.fn(() => true);
    second.parser.registerOscHandler(52, clipboardCommand);
    let emit: ((data: Uint8Array) => void) | undefined;
    const openAttachment = vi.fn<ZellijRuntimeAdapter["openAttachment"]>(async (_session, input) => {
      emit = input.onData;
      return { write: async () => {}, resize: async () => {}, close: async () => {} };
    });
    const adapter: ZellijRuntimeAdapter = {
      ensureSession: async () => {},
      createTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
      subscribeWorkspace: async () => ({ close: async () => {} }),
      openAttachment,
    };
    const runtime = new TerminalRuntime({
      store: new TerminalWorkspaceStore({ homePath }),
      zellij: adapter,
    });
    try {
      const workspace = await runtime.ensureWorkspace();
      const tab = await runtime.createTab(workspace.id, { name: "shell", cwd: "" });
      const ref = { workspaceId: workspace.id, tabId: tab.id };
      const firstFrames: string[] = [];
      await runtime.attach(ref, {
        viewerId: "web-desktop",
        send: (data) => {
          const text = new TextDecoder().decode(data);
          firstFrames.push(text);
          first.write(text);
        },
      });

      // Emit after the first viewer is registered. This isolates later-viewer
      // initialization from the lost attachment-startup output fixed by #1703.
      for (const chunk of chunks) emit!(new TextEncoder().encode(chunk));
      emit!(new TextEncoder().encode("\x1b]52;c;c3RhbGU=\x07stale screen text"));
      await flushTerminal(first);
      expect(first.modes.mouseTrackingMode).toBe(mouseTrackingMode);
      expect(first.buffer.active.type).toBe(buffer);
      const firstFrameCount = firstFrames.length;

      // A cold/reconnected renderer applies its screen snapshot before joining
      // the existing PTY. A screen dump does not encode Zellij client modes.
      await new Promise<void>((resolve) => second.write("\x1bcrestored prompt", resolve));
      const secondFrames: string[] = [];
      await runtime.attach(ref, {
        viewerId: "electron-desktop",
        send: (data) => {
          const text = new TextDecoder().decode(data);
          secondFrames.push(text);
          second.write(text);
        },
      });
      await flushTerminal(second);

      expect(openAttachment).toHaveBeenCalledOnce();
      expect(firstFrames).toHaveLength(firstFrameCount);
      expect(clipboardCommand).not.toHaveBeenCalled();
      expect(secondFrames.join("")).not.toContain("stale screen text");
      // Entering the alternate screen after the snapshot would erase it.
      // Scroll initialization must preserve the restored presentation.
      expect(second.buffer.active.getLine(0)?.translateToString(true)).toBe("restored prompt");
      expect(second.modes.mouseTrackingMode).toBe(mouseTrackingMode);
    } finally {
      await runtime.shutdown();
      first.dispose();
      second.dispose();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
