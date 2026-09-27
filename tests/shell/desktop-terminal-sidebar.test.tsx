// @vitest-environment jsdom

import React from "react";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/projects/ProjectSharing", () => ({
  ProjectSharing: ({ projectId }: { projectId: string }) => <button type="button">Share project {projectId}</button>,
}));

vi.mock("../../shell/src/components/terminal/TerminalThemePicker.js", () => ({
  ThemePickerButton: () => null,
}));

import { DesktopTerminalSidebar } from "../../shell/src/components/terminal/DesktopTerminalSidebar.js";
import type { ShellSessionSummary } from "../../shell/src/components/terminal/terminal-session-state.js";

function shell(name: string, subtitle: string, project?: string): ShellSessionSummary {
  return { name, subtitle, status: "active", ...(project ? { project, projectId: project } : {}) };
}

function renderSidebar(sessions: ShellSessionSummary[]) {
  return render(<DesktopTerminalSidebar sessions={sessions} selectedName={null} creating={false}
    onCreate={vi.fn()} onOpen={vi.fn()} onDelete={vi.fn()} />);
}

describe("DesktopTerminalSidebar project sharing (#1798)", () => {
  it("groups project sessions under a heading that carries the project Share control", () => {
    renderSidebar([
      shell("tws_main:tt_1", "release-notes"),
      shell("tws_launch:tt_2", "api-server", "launch-site"),
      shell("tws_launch:tt_3", "worker", "launch-site"),
    ]);

    const group = screen.getByRole("group", { name: "launch-site" });
    expect(within(group).getByRole("button", { name: "Share project launch-site" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Open tws_launch:tt_2" })).toBeTruthy();
    expect(within(group).getByRole("button", { name: "Open tws_launch:tt_3" })).toBeTruthy();
    const main = screen.getByRole("group", { name: "Main" });
    expect(within(main).getByRole("button", { name: "Open tws_main:tt_1" })).toBeTruthy();
    expect(within(main).queryByRole("button", { name: /^Share project/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Share project/ })).toHaveLength(1);
  });

  it("keeps the flat session list when no session belongs to a project", () => {
    renderSidebar([shell("tws_main:tt_1", "release-notes"), shell("tws_main:tt_2", "notes")]);

    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Share project/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Open tws_main:tt_1" })).toBeTruthy();
  });
});
