// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAttentionNotifier } from "../../shell/src/components/terminal/TerminalAttentionNotifier.js";
import { mergeShellAgentStatus } from "../../shell/src/components/terminal/useShellsWithAgentStatus.js";
import { useTerminalAgentEvents } from "../../shell/src/stores/terminal-agent-events.js";
import { OPEN_PROVIDER_TERMINAL_EVENT } from "../../shell/src/lib/canonical-provider-setup.js";

const workspaceId = `tws_${"0".repeat(32)}`;
const tabId = `tt_${"a".repeat(32)}`;
const key = `${workspaceId}:${tabId}`;

function facts(agentStatus?: "idle" | "working" | "done" | "blocked" | "error", statusMessage?: string) {
  return {
    [key]: {
      ref: { workspaceId, tabId }, name: "review", cwd: "", state: "live" as const,
      ...(agentStatus ? { agentStatus } : {}), ...(statusMessage ? { statusMessage } : {}),
    },
  };
}

beforeEach(() => {
  useTerminalAgentEvents.setState({ connected: true, seq: 0, tabs: {}, retain: () => () => undefined });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Fault detected: an agent waiting on the person goes unnoticed in a background
// terminal, or the toast opens the wrong terminal.
describe("terminal attention notifier", () => {
  it("raises a blocked agent with its message and opens exactly that tab", () => {
    render(<TerminalAttentionNotifier />);
    act(() => { useTerminalAgentEvents.setState({ tabs: facts("working") }); });
    expect(screen.queryByTestId("terminal-attention")).toBeNull();

    act(() => { useTerminalAgentEvents.setState({ tabs: facts("blocked", "Allow edit?") }); });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("review needs you: Allow edit?");

    const opened = vi.fn();
    window.addEventListener(OPEN_PROVIDER_TERMINAL_EVENT, (event) => opened((event as CustomEvent).detail));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(opened).toHaveBeenCalledWith({ sessionId: key });
    expect(screen.queryByTestId("terminal-attention")).toBeNull();
  });

  it("does not treat the first snapshot as news", () => {
    useTerminalAgentEvents.setState({ tabs: facts("blocked") });
    render(<TerminalAttentionNotifier />);
    expect(screen.queryByTestId("terminal-attention")).toBeNull();
  });

  it("raises done only when the person is not looking, and clears an alert once it is resolved", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<TerminalAttentionNotifier />);
    act(() => { useTerminalAgentEvents.setState({ tabs: facts("working") }); });
    act(() => { useTerminalAgentEvents.setState({ tabs: facts("done") }); });
    expect(screen.queryByTestId("terminal-attention")).toBeNull();

    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    act(() => { useTerminalAgentEvents.setState({ tabs: facts("working") }); });
    act(() => { useTerminalAgentEvents.setState({ tabs: facts("done") }); });
    expect(screen.getByRole("status").textContent).toContain("review finished");

    act(() => { useTerminalAgentEvents.setState({ tabs: facts("working") }); });
    expect(screen.queryByTestId("terminal-attention")).toBeNull();
  });
});

describe("sidebar agent status overlay", () => {
  it("shows live agent status on the matching shell only", () => {
    const shells = [
      { name: key, workspaceId, tabId, revision: 1, workspaceRevision: 1 },
      { name: `${workspaceId}:tt_${"b".repeat(32)}`, workspaceId, tabId: `tt_${"b".repeat(32)}`, revision: 1, workspaceRevision: 1 },
    ];
    const merged = mergeShellAgentStatus(shells, facts("blocked", "Allow edit?"));
    expect(merged[0]).toMatchObject({ visualStatus: "waiting", subtitle: "Allow edit?" });
    expect(merged[1]).toBe(shells[1]);
    expect(mergeShellAgentStatus(shells, {})).toBe(shells);
  });
});
