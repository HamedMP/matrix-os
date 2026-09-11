import { describe, expect, it, vi } from "vitest";
import { sendTerminalResize } from "../../shell/src/components/terminal/terminal-remote-resize";

describe("sendTerminalResize", () => {
  it("sends current terminal dimensions to an open websocket", () => {
    const send = vi.fn();

    const terminalKey = "tws_0123456789abcdef0123456789abcdef:tt_0123456789abcdef0123456789abcdef";
    const sent = sendTerminalResize({ readyState: 1, send }, { cols: 142, rows: 38 }, true, terminalKey);

    expect(sent).toBe(true);
    expect(send).toHaveBeenCalledWith(JSON.stringify({
      type: "resize",
      terminalRef: {
        workspaceId: "tws_0123456789abcdef0123456789abcdef",
        tabId: "tt_0123456789abcdef0123456789abcdef",
      },
      mode: "soft",
      size: { cols: 142, rows: 38 },
    }));
  });

  it("does not send when remote resize is disabled", () => {
    const send = vi.fn();

    const sent = sendTerminalResize({ readyState: 1, send }, { cols: 142, rows: 38 }, false);

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send invalid terminal dimensions", () => {
    const send = vi.fn();

    const sent = sendTerminalResize({ readyState: 1, send }, { cols: 0, rows: 38 }, true);

    expect(sent).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
