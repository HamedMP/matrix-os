import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { TerminalMouseModeState } from "../../packages/terminal-runtime/src/mouse-mode-state.js";

const encoder = new TextEncoder();
const write = (term: Terminal, text: string) => new Promise<void>((resolve) => term.write(text, resolve));

async function mouseState(term: Terminal): Promise<string[]> {
  const replies: string[] = [];
  const listener = term.onData((data) => replies.push(data));
  await write(term, [9, 1000, 1002, 1003, 1006, 1016].map((mode) => `\x1b[?${mode}$p`).join(""));
  listener.dispose();
  return replies;
}

describe("bounded terminal mouse mode state", () => {
  it.each([
    "\x1b[?1000;1006h",
    "\x1b[?9h",
    "\x1b[?1002;1016h",
    "\x1b[?1003;1006h\x1b[?1000l\x1b[?1016l",
    "\x1b[?1000h\x1b[?1003h\x1b[?1016h\x1b[?1006h",
    "\x1b[?1002;1006h\x1bc",
    "\x1b[?1002;1006h\x1b[!p",
    "\x1b[?1000h\x1b[?1005;1015h",
    "\u009b?1000;1006h",
  ])("matches real xterm mouse state for %j even with byte fragmentation", async (sequence) => {
    const tracker = new TerminalMouseModeState();
    const source = new Terminal({ allowProposedApi: true });
    const restored = new Terminal({ allowProposedApi: true });
    try {
      await write(source, sequence);
      for (const byte of encoder.encode(sequence)) tracker.observe(Uint8Array.of(byte));
      // A reused renderer may have stale modes, including a different encoding.
      await write(restored, "\x1b[?1003;1016hrestored prompt");
      await write(restored, new TextDecoder().decode(tracker.bootstrap() ?? new Uint8Array()));
      expect(await mouseState(restored)).toEqual(await mouseState(source));
      expect(restored.buffer.active.getLine(0)?.translateToString(true)).toBe("restored prompt");
    } finally {
      source.dispose();
      restored.dispose();
    }
  });

  it("does not invent mouse state when no relevant sequence was observed", () => {
    const tracker = new TerminalMouseModeState();
    tracker.observe(encoder.encode("screen text\x1b[?1049h\x1b[31mred\x1b[?25l"));
    expect(tracker.bootstrap()).toBeNull();
  });

  it.each([
    "\x1b]52;c;\x1b[?1003h\x07",
    "\x1b]52;c;\x1b[?1003h\x1b\\",
    "\x1bPignored\x1b[?1003h\x1b\\",
    "\x1b_ignored\x1b[?1003h\x1b\\",
    "\x1b^ignored\x1b[?1003h\x1b\\",
    "\x1bXignored\x1b[?1003h\x1b\\",
    "\u009dignored\x1b[?1003h\u009c",
  ])("never replays or interprets mouse-looking payload inside control strings: %j", (payload) => {
    const tracker = new TerminalMouseModeState();
    tracker.observe(encoder.encode("\x1b[?1000;1006h"));
    const previous = tracker.bootstrap();
    for (const byte of encoder.encode(payload)) tracker.observe(Uint8Array.of(byte));
    expect(tracker.bootstrap()).toEqual(previous);
    tracker.observe(encoder.encode("\x1b[?1002h"));
    expect(tracker.bootstrap()).not.toEqual(previous);
    expect(new TextDecoder().decode(tracker.bootstrap()!)).not.toContain("ignored");
  });

  it("discards oversized/aborted CSI and recovers without retaining payloads", () => {
    const tracker = new TerminalMouseModeState();
    tracker.observe(encoder.encode("\x1b[?1000;1006h"));
    const previous = tracker.bootstrap();
    tracker.observe(encoder.encode(`\x1b[?${"0".repeat(10_000)}1003h`));
    tracker.observe(encoder.encode("\x1b[?1003\x18h\x1b[?1003\x1ah"));
    expect(tracker.bootstrap()).toEqual(previous);
    tracker.observe(encoder.encode("\x1b]" + "x".repeat(1_000_000)));
    tracker.observe(encoder.encode("\x18\x1b[?1002h"));
    const bootstrap = tracker.bootstrap()!;
    expect(bootstrap.byteLength).toBeLessThan(100);
    expect(new TextDecoder().decode(bootstrap)).toContain("\x1b[?1002h");
  });
});
