// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOpenTerminalSession } from "../../shell/src/components/terminal/useOpenTerminalSession.js";
import { openTerminalSession } from "../../shell/src/lib/terminal-session-open.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";
import * as handoff from "../../shell/src/lib/provider-terminal-session.js";

const sessionId = `tws_${"0".repeat(32)}:tt_${"a".repeat(32)}`;

function Host() {
  useOpenTerminalSession(20);
  return null;
}

beforeEach(() => {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 0; });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Fault detected (third review of #3299): Open handed the tab to an ephemeral Terminal
// window, and closing that window deleted the session, stopping the agent.
describe("opening an existing terminal tab", () => {
  it("shows it in the durable Terminal window and never opens an ephemeral one", () => {
    const enqueue = vi.spyOn(handoff, "enqueueExistingTerminalRef").mockReturnValue(true);
    const openWindow = vi.fn((name: string, path: string, offset: number, options?: { terminalPersistence?: string }) => {
      useWindowManager.setState({ windows: [{ id: "w-durable", path, title: name, terminalPersistence: options?.terminalPersistence ?? "durable" } as never] });
      void offset;
    });
    useWindowManager.setState({
      windows: [{ id: "w-setup", path: "__terminal__", title: "Terminal", terminalPersistence: "ephemeral" } as never],
      openWindow: openWindow as never,
    });
    render(<Host />);
    openTerminalSession(sessionId);
    expect(openWindow).toHaveBeenCalledWith("Terminal", "__terminal__", 20);
    expect(openWindow.mock.calls[0]?.[3]).toBeUndefined();
    expect(enqueue).toHaveBeenCalledWith(sessionId, "w-durable");
  });

  it("reuses an open durable Terminal window", () => {
    const enqueue = vi.spyOn(handoff, "enqueueExistingTerminalRef").mockReturnValue(true);
    const restore = vi.fn();
    const openWindow = vi.fn();
    useWindowManager.setState({
      windows: [{ id: "w-main", path: "__terminal__", title: "Terminal", terminalPersistence: "durable" } as never],
      restoreAndFocusWindow: restore as never,
      openWindow: openWindow as never,
    });
    render(<Host />);
    openTerminalSession(sessionId);
    expect(restore).toHaveBeenCalledWith("w-main");
    expect(openWindow).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(sessionId, "w-main");
  });

  it("ignores malformed session ids", () => {
    const enqueue = vi.spyOn(handoff, "enqueueExistingTerminalRef");
    render(<Host />);
    openTerminalSession("../../etc");
    window.dispatchEvent(new CustomEvent("matrix:open-terminal-session", { detail: { sessionId: 7 } }));
    expect(enqueue).not.toHaveBeenCalled();
  });
});
