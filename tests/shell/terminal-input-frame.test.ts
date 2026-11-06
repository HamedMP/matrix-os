import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalTabClientFrameSchema } from "@matrix-os/contracts";
import { sendTerminalInputFrame } from "../../shell/src/components/terminal/terminal-input-frame.js";

const TERMINAL_KEY = `tws_${"a".repeat(32)}:tt_${"b".repeat(32)}`;
const TERMINAL_REF = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sendTerminalInputFrame", () => {
  it("sends an input frame the terminal tab socket accepts", () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const ws = { readyState: 1, send: vi.fn() };

    expect(sendTerminalInputFrame(ws, TERMINAL_KEY, "\x1b[200~hello\x1b[201~")).toBe(true);

    expect(ws.send).toHaveBeenCalledOnce();
    const frame = JSON.parse(ws.send.mock.calls[0]![0]);
    expect(TerminalTabClientFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame).toEqual({ type: "input", terminalRef: TERMINAL_REF, data: "\x1b[200~hello\x1b[201~" });
  });

  it("does not send frames the terminal tab socket would reject", () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const ws = { readyState: 1, send: vi.fn() };

    expect(sendTerminalInputFrame(ws, null, "a")).toBe(false);
    expect(sendTerminalInputFrame(ws, "legacy-session", "a")).toBe(false);
    expect(sendTerminalInputFrame(ws, TERMINAL_KEY, "")).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("does not send when the socket is missing or not open", () => {
    vi.stubGlobal("WebSocket", { OPEN: 1 });
    const closed = { readyState: 3, send: vi.fn() };

    expect(sendTerminalInputFrame(null, TERMINAL_KEY, "a")).toBe(false);
    expect(sendTerminalInputFrame(closed, TERMINAL_KEY, "a")).toBe(false);
    expect(closed.send).not.toHaveBeenCalled();
  });
});
