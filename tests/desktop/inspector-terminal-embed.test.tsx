// @vitest-environment jsdom

import React from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSummary, TerminalSessionSummary } from "@matrix-os/contracts";
import { AgentConversationInspector } from "../../desktop/src/renderer/src/features/coding-agents/AgentConversationInspector";
import { InspectorTerminalPanel } from "../../desktop/src/renderer/src/features/panels/InspectorTerminalPanel";

// The panel must reuse the shared xterm TerminalView; stub it here so the
// test asserts the wiring (session name, active gating, list/embed switch)
// without a live socket or canvas.
const terminalViewMock = vi.hoisted(() => ({
  lastProps: undefined as { sessionName: string; active?: boolean } | undefined,
}));

vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: (props: { sessionName: string; active?: boolean }) => {
    terminalViewMock.lastProps = props;
    return (
      <div
        data-testid="embedded-terminal"
        data-session={props.sessionName}
        data-active={String(props.active ?? true)}
      />
    );
  },
}));

afterEach(cleanup);

const NOW = "2026-07-12T12:00:00.000Z";

function session(partial: Partial<TerminalSessionSummary> & { id: string; name: string }): TerminalSessionSummary {
  return {
    status: "running",
    attachable: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function summaryWith(sessions: TerminalSessionSummary[]): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items: sessions, hasMore: false, limit: 20 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

describe("InspectorTerminalPanel", () => {
  function renderPanel(ui: React.ReactElement) {
    return render(<Tooltip.Provider>{ui}</Tooltip.Provider>);
  }

  it("opens with the session list and only offers embed for attachable sessions", () => {
    renderPanel(
      <InspectorTerminalPanel
        summary={summaryWith([
          session({ id: "ts_1", name: "build-shell" }),
          session({ id: "ts_2", name: "old-shell", attachable: false, status: "exited" }),
        ])}
        active
      />,
    );

    expect(screen.getByText("build-shell")).toBeTruthy();
    expect(screen.getByText("old-shell")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open terminal build-shell" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open terminal old-shell" })).toBeNull();
    expect(screen.queryByTestId("embedded-terminal")).toBeNull();
  });

  it("shows a graceful empty state when there are no sessions", () => {
    renderPanel(<InspectorTerminalPanel summary={summaryWith([])} active />);
    expect(screen.getByText(/No terminal sessions/)).toBeTruthy();
  });

  it("embeds a live terminal for the picked session and returns to the list", () => {
    renderPanel(
      <InspectorTerminalPanel
        summary={summaryWith([
          session({ id: "ts_1", name: "build-shell" }),
          session({ id: "ts_2", name: "deploy-shell" }),
        ])}
        active
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open terminal deploy-shell" }));

    const embedded = screen.getByTestId("embedded-terminal");
    expect(embedded.getAttribute("data-session")).toBe("deploy-shell");
    expect(embedded.getAttribute("data-active")).toBe("true");
    expect(terminalViewMock.lastProps?.sessionName).toBe("deploy-shell");
    // Exactly one session embeds at a time; the list is replaced, not stacked.
    expect(screen.queryByRole("button", { name: "Open terminal build-shell" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to terminal sessions" }));

    expect(screen.queryByTestId("embedded-terminal")).toBeNull();
    expect(screen.getByRole("button", { name: "Open terminal build-shell" })).toBeTruthy();
  });

  it("releases the live attachment while the inspector surface is hidden", () => {
    renderPanel(
      <InspectorTerminalPanel
        summary={summaryWith([session({ id: "ts_1", name: "build-shell" })])}
        active={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open terminal build-shell" }));

    expect(screen.getByTestId("embedded-terminal").getAttribute("data-active")).toBe("false");
  });

  it("falls back to the list when the embedded session disappears or detaches", () => {
    const view = renderPanel(
      <InspectorTerminalPanel
        summary={summaryWith([session({ id: "ts_1", name: "build-shell" })])}
        active
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open terminal build-shell" }));
    expect(screen.getByTestId("embedded-terminal")).toBeTruthy();

    view.rerender(
      <Tooltip.Provider>
        <InspectorTerminalPanel
          summary={summaryWith([session({ id: "ts_1", name: "build-shell", attachable: false, status: "exited" })])}
          active
        />
      </Tooltip.Provider>,
    );

    expect(screen.queryByTestId("embedded-terminal")).toBeNull();
    expect(screen.getByText("build-shell")).toBeTruthy();
  });
});

describe("AgentConversationInspector controlled tabs", () => {
  function renderControlled(selectedTab: "changes" | "terminal", onTabChange = vi.fn()) {
    return render(
      <AgentConversationInspector
        defaultTab="changes"
        selectedTab={selectedTab}
        onTabChange={onTabChange}
        counts={{ changes: 1, terminal: 1, preview: 0, activity: 0 }}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>No previews</div>}
        activity={<div>No activity</div>}
      />,
    );
  }

  it("follows the controlled selection and reports tab picks", () => {
    const onTabChange = vi.fn();
    const view = renderControlled("terminal", onTabChange);

    expect(screen.getByRole("tab", { name: /^Terminal\b/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Matrix shell")).toBeTruthy();

    // Clicking a tab notifies the owner; the selection itself stays
    // controlled until the owner rerenders.
    fireEvent.click(screen.getByRole("tab", { name: /^Changes\b/ }));
    expect(onTabChange).toHaveBeenCalledWith("changes");
    expect(screen.getByRole("tab", { name: /^Terminal\b/ }).getAttribute("aria-selected")).toBe("true");

    view.rerender(
      <AgentConversationInspector
        defaultTab="changes"
        selectedTab="changes"
        onTabChange={onTabChange}
        counts={{ changes: 1, terminal: 1, preview: 0, activity: 0 }}
        toolbar={<div>Tools</div>}
        changes={<div>Changed files</div>}
        terminal={<div>Matrix shell</div>}
        preview={<div>No previews</div>}
        activity={<div>No activity</div>}
      />,
    );
    expect(screen.getByRole("tab", { name: /^Changes\b/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Changed files")).toBeTruthy();
  });
});
