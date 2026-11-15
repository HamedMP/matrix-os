// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteTerminalAttention } from "@desktop/renderer/src/features/terminal/RemoteTerminalAttention";
import { useTerminalAgentEvents } from "@desktop/renderer/src/stores/terminal-agent-events";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";

const workspaceId = `tws_${"0".repeat(32)}`;
const tabId = `tt_${"a".repeat(32)}`;
const key = `${workspaceId}:${tabId}`;
type Word = "working" | "done" | "blocked" | "error";
const tabs = (agentStatus: Word, statusMessage?: string) => ({
  [key]: { ref: { workspaceId, tabId }, name: "review", cwd: "", state: "live" as const, agentStatus, ...(statusMessage ? { statusMessage } : {}) },
});
const publish = (next: ReturnType<typeof tabs>, connected = true) => act(() => { useTerminalAgentEvents.setState({ connected, tabs: next }); });

beforeEach(() => {
  useTerminalAgentEvents.setState({ connected: false, seq: 0, tabs: {} });
  useTabs.setState({ tabs: [], activeTabId: null, terminalSessionRequest: null, terminalSessionRequestSequence: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Electron Desktop remote terminal attention", () => {
  // Fault detected: an agent on the Matrix computer blocks and Electron shows nothing,
  // the first snapshot replays old states as news, or Open lands on the wrong tab.
  it("raises a blocked remote agent once, updates it in place, and Open focuses that tab", () => {
    render(<RemoteTerminalAttention />);
    publish(tabs("blocked", "Allow edit?"));
    expect(screen.queryByTestId("terminal-attention")).toBeNull();
    publish(tabs("working"));
    publish(tabs("blocked", "Allow edit?"));
    expect(screen.getByRole("alert").textContent).toContain("review needs you: Allow edit?");
    publish(tabs("blocked", "Allow write?"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("Allow write?");

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const state = useTabs.getState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    expect(active?.kind).toBe("terminals");
    expect(useDesktopSurfaces.getState().surfaces[active!.id]?.mode).not.toBe("closed");
    expect(state.terminalSessionRequest?.sessionName).toBe(key);
    expect(screen.queryByTestId("terminal-attention")).toBeNull();
  });

  // Fault detected: an error or a finish in a background remote tab is silent, or a
  // finish the person is watching still interrupts them.
  it("uses the shared copy for errors and finishes, and skips a finish in the viewed tab", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<><section data-terminal-session={key} /><RemoteTerminalAttention /></>);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 100 } as DOMRect);
    publish(tabs("working"));
    publish(tabs("done"));
    expect(screen.queryByTestId("terminal-attention")).toBeNull();
    publish(tabs("error"));
    expect(screen.getByRole("alert").textContent).toContain("review reported an error");
    publish(tabs("working"));
    vi.mocked(document.hasFocus).mockReturnValue(false);
    publish(tabs("done"));
    expect(screen.getByRole("status").textContent).toContain("review finished");
  });
});
