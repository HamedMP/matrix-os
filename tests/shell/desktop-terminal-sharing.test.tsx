// @vitest-environment jsdom

import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PaneNode } from "../../shell/src/stores/terminal-store";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state";

// The real controls resolve a runtime and talk to the platform; these tests only
// care that Web Desktop mounts them, and for which project or terminal.
vi.mock("@/components/projects/ProjectSharing", () => ({
  ProjectSharing: ({ projectId }: { projectId: string }) => <span data-testid="project-share">{projectId}</span>,
}));
vi.mock("../../shell/src/components/terminal/TerminalSharing", () => ({
  TerminalSharing: ({ terminalId }: { terminalId: string }) => <span data-testid="terminal-share">{terminalId}</span>,
}));
vi.mock("../../shell/src/components/terminal/TerminalThemePicker", () => ({
  ThemePickerButton: () => null,
}));

import { DesktopTerminalSidebar } from "../../shell/src/components/terminal/DesktopTerminalSidebar";
import { DesktopTerminalSessionHeader } from "../../shell/src/components/terminal/DesktopTerminalWorkspace";
import { getFocusedSessionId } from "../../shell/src/components/terminal/terminal-layout";

function session(name: string, project?: string): ShellSessionSummary {
  return { name, workspaceId: project ?? "main", tabId: name, revision: 1, workspaceRevision: 1, ...(project ? { project } : {}) };
}

function renderSidebar(sessions: ShellSessionSummary[]) {
  return render(
    <DesktopTerminalSidebar
      sessions={sessions}
      selectedName={null}
      creating={false}
      onCreate={vi.fn()}
      onOpen={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe("Web Desktop terminal sidebar project sharing (#1798)", () => {
  it("offers the project share control on each named project, which Web Desktop could not reach", () => {
    renderSidebar([session("api", "billing"), session("web", "billing"), session("scratch")]);

    const billing = screen.getByRole("list", { name: "billing sessions" });
    expect(within(billing).getByRole("button", { name: "Open api" })).toBeTruthy();
    expect(within(billing).getByRole("button", { name: "Open web" })).toBeTruthy();
    expect(screen.getAllByTestId("project-share").map((node) => node.textContent)).toEqual(["billing"]);
  });

  it("never offers a share control for the unscoped main workspace", () => {
    renderSidebar([session("api", "billing"), session("scratch")]);

    expect(screen.getByRole("list", { name: "Main sessions" })).toBeTruthy();
    expect(screen.getAllByTestId("project-share")).toHaveLength(1);
  });

  it("keeps the flat list unchanged for a member who only uses main", () => {
    renderSidebar([session("scratch"), session("notes")]);

    expect(screen.queryByRole("list", { name: "Main sessions" })).toBeNull();
    expect(screen.queryByTestId("project-share")).toBeNull();
    expect(screen.getByRole("button", { name: "Open scratch" })).toBeTruthy();
  });
});

describe("Web Desktop terminal session header sharing (#1798)", () => {
  it("offers the terminal share control for the focused terminal", () => {
    render(<DesktopTerminalSessionHeader title="api" terminalId="session-api" />);

    expect(screen.getByTestId("terminal-share").textContent).toBe("session-api");
  });

  it("offers no terminal share control before a session is attached", () => {
    render(<DesktopTerminalSessionHeader title="api" terminalId={null} />);

    expect(screen.queryByTestId("terminal-share")).toBeNull();
  });
});

describe("getFocusedSessionId", () => {
  const tree: PaneNode = {
    type: "split",
    direction: "horizontal",
    ratio: 0.5,
    children: [
      { type: "pane", id: "left", cwd: "/", sessionId: "s-left" },
      { type: "pane", id: "right", cwd: "/", sessionId: "s-right" },
    ],
  };

  it("returns the session of the focused pane", () => {
    expect(getFocusedSessionId(tree, "right")).toBe("s-right");
  });

  it("falls back to the first pane when nothing is focused", () => {
    expect(getFocusedSessionId(tree, null)).toBe("s-left");
  });

  it("returns null for a pane that has no session yet", () => {
    const unattached: PaneNode = { type: "pane", id: "only", cwd: "/" };
    expect(getFocusedSessionId(unattached, null)).toBeNull();
  });
});
