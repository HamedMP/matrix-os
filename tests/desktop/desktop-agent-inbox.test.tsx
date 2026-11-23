// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopModeControls from "@desktop/renderer/src/features/desktop-shell/DesktopModeControls";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTerminalAgentEvents } from "@desktop/renderer/src/stores/terminal-agent-events";

const navigation = vi.hoisted(() => ({ openTerminalSession: vi.fn(), openCodingAgentThread: vi.fn(async () => undefined) }));
vi.mock("@desktop/renderer/src/features/mission-control/navigation-roots", () => ({ openTerminalSession: navigation.openTerminalSession }));
vi.mock("@desktop/renderer/src/lib/project-chat", () => ({ openCodingAgentThread: navigation.openCodingAgentThread }));
vi.mock("@desktop/renderer/src/features/runtime/RuntimeComputerMenu", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/onboarding/GettingStartedPopover", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/mission-control/AccountMenu", () => ({ default: () => null }));
vi.mock("@desktop/renderer/src/features/updates/DesktopUpdateButton", () => ({ default: () => null }));

const WS = "tws_00000000000000000000000000000001";
const TAB = "tt_00000000000000000000000000000001";
const summary = {
  runtime: { id: "rt_primary", label: "Main", status: "available" }, capabilities: [], providers: [],
  projects: { items: [], hasMore: false, limit: 20 }, activeThreads: { items: [], hasMore: false, limit: 20 },
  attentionThreads: { items: [{ id: "thread_approval", providerId: "codex", title: "Approve deploy", status: "waiting_for_approval", attention: "approval_required", terminalRef: { workspaceId: WS, tabId: "tt_00000000000000000000000000000009" }, createdAt: "2026-07-06T00:00:00.000Z", updatedAt: "2026-07-06T00:01:00.000Z" }], hasMore: false, limit: 20 },
  recentActivity: { items: [], hasMore: false, limit: 20 },
  limits: { maxPromptBytes: 16384, maxAttachmentCount: 8, maxTerminalInputBytes: 8192, maxListItems: 20 }, serverTime: "2026-07-06T00:03:00.000Z",
};

beforeEach(() => {
  useConnection.setState(useConnection.getInitialState(), true);
  useConnection.setState({ status: "signed-in", runtimeSlot: "primary" });
  useTerminalAgentEvents.setState({ connected: true, seq: 1, tabs: {
    [`${WS}:${TAB}`]: { ref: { workspaceId: WS, tabId: TAB }, name: "Herdr parity", cwd: "", state: "live", agentStatus: "done" },
  } });
  window.operator = {
    invoke: vi.fn(async (channel: string) => (channel === "runtime:get-summary" ? summary : { ok: true })),
    on: vi.fn(() => () => undefined),
  } as never;
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("Electron Desktop agent inbox", () => {
  it("opens a coding-agent thread's own chat and a terminal agent's exact tab", async () => {
    render(<DesktopModeControls />);
    fireEvent.click(await screen.findByRole("button", { name: "Inbox, 1 agent needs you" }));
    fireEvent.click(await screen.findByRole("button", { name: /Approve deploy/ }));
    expect(navigation.openCodingAgentThread).toHaveBeenCalledWith("thread_approval");
    expect(navigation.openTerminalSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Inbox/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Herdr parity/ }));
    expect(navigation.openTerminalSession).toHaveBeenCalledWith(`${WS}:${TAB}`);
  });
});
