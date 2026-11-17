// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebDesktopControls } from "@/components/desktop/WebDesktopControls";
import { OPEN_TERMINAL_SESSION_EVENT } from "@/lib/terminal-session-open";
import { useTerminalAgentEvents } from "@/stores/terminal-agent-events";

vi.mock("@/components/UserButton", () => ({ UserButton: () => <button>Account</button> }));
vi.mock("@/components/onboarding/GettingStartedPopover", () => ({ GettingStartedPopover: () => null }));

const WS = "tws_00000000000000000000000000000001";
const TAB = "tt_00000000000000000000000000000001";
const OTHER_TAB = "tt_00000000000000000000000000000002";
const summary = {
  runtime: { id: "rt_primary", label: "Main", status: "available" }, capabilities: [], providers: [],
  projects: { items: [], hasMore: false, limit: 20 },
  activeThreads: { items: [{ id: "thread_tab", providerId: "codex", title: "Coding agent run", status: "running", attention: "none", terminalRef: { workspaceId: WS, tabId: OTHER_TAB }, createdAt: "2026-07-06T00:00:00.000Z", updatedAt: "2026-07-06T00:01:00.000Z" },
    { id: "thread_chat", providerId: "codex", title: "Chat only run", status: "running", attention: "none", createdAt: "2026-07-06T00:00:00.000Z", updatedAt: "2026-07-06T00:01:00.000Z" }], hasMore: false, limit: 20 },
  recentActivity: { items: [], hasMore: false, limit: 20 },
  limits: { maxPromptBytes: 16384, maxAttachmentCount: 8, maxTerminalInputBytes: 8192, maxListItems: 20 }, serverTime: "2026-07-06T00:03:00.000Z",
};
const retain = vi.fn(() => () => undefined);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("/api/coding-agents/summary") ? summary : url.includes("/api/system/info") ? { runtime: { runtimeSlot: "primary" } } : { items: [], hasMore: false, limit: 20, selectedSlot: "primary" } })));
  useTerminalAgentEvents.setState({
    connected: true, seq: 1, retain,
    tabs: {
      [`${WS}:${TAB}`]: { ref: { workspaceId: WS, tabId: TAB }, name: "Herdr parity", cwd: "", state: "live", agentStatus: "blocked", statusMessage: "Allow git push?" },
      [`${WS}:${OTHER_TAB}`]: { ref: { workspaceId: WS, tabId: OTHER_TAB }, name: "release-notes", cwd: "", state: "live", agentStatus: "working" },
    },
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Web Desktop agent inbox", () => {
  it("lists live terminal agents and opens the exact tab in the durable Terminal", async () => {
    const opened: string[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent<{ sessionId: string }>).detail.sessionId);
    window.addEventListener(OPEN_TERMINAL_SESSION_EVENT, listener);
    try {
      render(<WebDesktopControls onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} onOpenSupport={vi.fn()} onOpenFirstWork={vi.fn()} />);
      expect(retain).toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/coding-agents/summary?include=recentThreads"), expect.anything());
      fireEvent.click(await screen.findByRole("button", { name: "Inbox, 1 agent needs you" }));
      fireEvent.click(await screen.findByRole("button", { name: /Herdr parity/ }));
      expect(opened).toEqual([`${WS}:${TAB}`]);
      // A coding-agent thread opens its own terminal tab; one without a tab is not a dead button.
      fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
      fireEvent.click(await screen.findByRole("button", { name: /release-notes/ }));
      expect(opened).toEqual([`${WS}:${TAB}`, `${WS}:${OTHER_TAB}`]);
      fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
      await screen.findByText("Chat only run");
      expect(screen.queryByRole("button", { name: /Chat only run/ })).toBeNull();
    } finally {
      window.removeEventListener(OPEN_TERMINAL_SESSION_EVENT, listener);
    }
  });
});
