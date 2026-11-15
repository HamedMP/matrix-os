// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "sonner";
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
// sonner renders a toast on the next macrotask.
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const publish = async (next: ReturnType<typeof tabs>, connected = true) => {
  act(() => { useTerminalAgentEvents.setState({ connected, tabs: next }); });
  await flush();
};

beforeEach(() => {
  useTerminalAgentEvents.setState({ connected: false, seq: 0, tabs: {} });
  useTabs.setState({ tabs: [], activeTabId: null, terminalSessionRequest: null, terminalSessionRequestSequence: 0 });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Electron Desktop remote terminal attention", () => {
  // Fault detected: an agent on the Matrix computer blocks and Electron shows nothing,
  // the first snapshot replays old states as news, or Open lands on the wrong tab.
  it("raises a blocked remote agent once, updates it in place, and Open focuses that tab", async () => {
    render(<><Toaster /><RemoteTerminalAttention /></>);
    await publish(tabs("blocked", "Allow edit?"));
    expect(screen.queryByTestId("terminal-attention")).toBeNull();
    await publish(tabs("working"));
    await publish(tabs("blocked", "Allow edit?"));
    expect(screen.getByRole("alert").textContent).toContain("review needs you: Allow edit?");
    // Fault detected (review of #3300): the cards had their own fixed stack instead of
    // the window's one toast host, so they could overlap other notices.
    expect(screen.getByRole("alert").closest("[data-sonner-toaster]")).not.toBeNull();
    await publish(tabs("blocked", "Allow write?"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toContain("Allow write?");

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await flush();
    const state = useTabs.getState();
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    expect(active?.kind).toBe("terminals");
    expect(useDesktopSurfaces.getState().surfaces[active!.id]?.mode).not.toBe("closed");
    expect(state.terminalSessionRequest?.sessionName).toBe(key);
    // A dismissed toast animates out before it leaves the host.
    await waitFor(() => expect(screen.queryByTestId("terminal-attention")).toBeNull());
  });

  // Fault detected: an error or a finish in a background remote tab is silent, or a
  // finish the person is watching still interrupts them.
  it("uses the shared copy for errors and finishes, and skips a finish in the viewed tab", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<><Toaster /><section data-terminal-session={key} /><RemoteTerminalAttention /></>);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 } as DOMRect);
    await publish(tabs("working"));
    await publish(tabs("done"));
    expect(screen.queryByTestId("terminal-attention")).toBeNull();
    await publish(tabs("error"));
    expect(screen.getByRole("alert").textContent).toContain("review reported an error");
    await publish(tabs("working"));
    vi.mocked(document.hasFocus).mockReturnValue(false);
    await publish(tabs("done"));
    expect(screen.getByRole("status").textContent).toContain("review finished");
  });
});
