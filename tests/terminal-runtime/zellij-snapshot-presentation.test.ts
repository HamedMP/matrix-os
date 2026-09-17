import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { normalizeTerminalSnapshot } from "../../packages/contracts/src/terminal-snapshot.js";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";
import type { ZellijObserverEvent } from "../../packages/terminal-runtime/src/runtime.js";
import { presentZellijSnapshot } from "../../packages/terminal-runtime/src/zellij-screen-dump.js";

async function capture(ansi: string, viewport: string[], scrollback?: string[]) {
  let emit = (_line: string) => {};
  const ready = Promise.withResolvers<ZellijObserverEvent>();
  const adapter = new ZellijCliRuntimeAdapter({
    homePath: "/home/matrix",
    run: vi.fn(async () => ansi),
    spawnSubscription: (_args, onLine) => {
      emit = onLine;
      return { close: async () => {} };
    },
  });
  const observer = await adapter.subscribeWorkspace("matrix-w-0123456789abcdef0123456789abcdef", {
    paneIds: ["terminal_12"],
    onEvent: ready.resolve,
  });
  emit(JSON.stringify({ event: "pane_update", pane_id: "terminal_12", viewport, scrollback, is_initial: true }));
  const event = await ready.promise;
  await observer.close();
  if (event.type !== "pane-update") throw new Error("Expected snapshot");
  return event;
}

describe("Zellij snapshot presentation", () => {
  it("leaves legacy snapshots and a full viewport unpadded", () => {
    expect(presentZellijSnapshot("legacy\n", 0, 10)).toBe("legacy\n");
    expect(presentZellijSnapshot("full\x1b[m\n", 10, 10)).toBe("full\x1b[m");
    expect(presentZellijSnapshot("larger\n", 12, 10)).toBe("larger\n");
  });

  it("does not push an at-limit snapshot beyond the public frame allowance", () => {
    const ansi = "x".repeat(5 * 1024 * 1024);
    expect(presentZellijSnapshot(ansi, 1, 200)).toBe(ansi);
  });
  it.each([
    ["unknown empty-history framing", "\x1b[m\nprompt\x1b[m\n", 1, [""]],
    ["short viewport after history", "history\n\nprompt\x1b[m\n", 1, ["history", ""]],
    ["intentional first viewport blank", "history\n\nprompt\x1b[m\n", 2, ["history"]],
  ] as const)("restores %s at its viewport row without losing history", async (_name, dump, viewportRows, history) => {
    const terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true });
    try {
      const ansi = presentZellijSnapshot(dump, viewportRows, 10);
      await new Promise<void>((resolve) => terminal.write("\x1bc" + normalizeTerminalSnapshot(ansi), resolve));
      const buffer = terminal.buffer.active;
      expect(buffer.getLine(buffer.baseY + viewportRows - 1)?.translateToString(true)).toBe("prompt");
      expect(buffer.cursorY).toBe(viewportRows - 1);
      expect(buffer.cursorX).toBe(6);
      expect(Array.from({ length: buffer.baseY }, (_, row) => buffer.getLine(row)?.translateToString(true))).toEqual(history);
    } finally { terminal.dispose(); }
  });

  it("keeps a fresh prompt on the same row before and after the native redraw", async () => {
    // Zellij 0.44.3 emits an SGR-only empty history, a separator, then CLI LF.
    const prompt = "\x1b[36mreview\x1b[m:~/projects%";
    const snapshot = await capture(`\x1b[m\n${prompt}\x1b[m\n`, [prompt], []);
    const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) => terminal.write("\x1bc" + normalizeTerminalSnapshot(snapshot.ansi), resolve));
      const before = terminal.buffer.active.getLine(0)?.translateToString(true);
      expect(before).toBe("review:~/projects%");
      expect(terminal.buffer.active.cursorY).toBe(0);
      await new Promise<void>((resolve) => terminal.write(`\x1b[2J\x1b[1;1H${prompt}`, resolve));
      expect(terminal.buffer.active.getLine(0)?.translateToString(true)).toBe(before);
    } finally { terminal.dispose(); }
  });

  it("preserves intentional leading blank viewport rows", async () => {
    const snapshot = await capture("\x1b[m\n\n\x1b[31mprompt\x1b[m\n", ["", "\x1b[31mprompt\x1b[m"], []);
    expect(snapshot.ansi).toBe("\n\x1b[31mprompt\x1b[m");
  });

  it("preserves real blank history and trailing blank viewport rows", async () => {
    const snapshot = await capture("\x1b[m\nprompt\n\n\x1b[m\n", ["prompt", "", ""], [""]);
    expect(snapshot.ansi).toBe("\x1b[m\nprompt\n\n\x1b[m");
  });

  it("does not guess whether a leading blank is history when metadata is absent", async () => {
    const snapshot = await capture("\x1b[m\nprompt\x1b[m\n", ["prompt"]);
    expect(snapshot.ansi).toBe("\x1b[m\nprompt\x1b[m");
  });
});
