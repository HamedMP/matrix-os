// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TabContent, { TabErrorBoundary } from "@desktop/renderer/src/features/mission-control/TabContent";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

const taskWorkspaceMock = vi.hoisted(() =>
  vi.fn(({ taskId, projectSlug }: { taskId: string; projectSlug?: string }) => (
    <button type="button">
      Task {taskId} {projectSlug}
    </button>
  )),
);

vi.mock("@desktop/renderer/src/features/project/ProjectTab", () => ({
  default: ({ projectSlug }: { projectSlug: string }) => (
    <button type="button">Project {projectSlug}</button>
  ),
}));
vi.mock("@desktop/renderer/src/features/workspace/TaskWorkspace", () => ({
  default: taskWorkspaceMock,
}));
vi.mock("@desktop/renderer/src/features/terminal/TerminalView", () => ({
  default: () => <button type="button">Terminal body</button>,
}));

describe("TabContent", () => {
  beforeEach(() => {
    useConnection.setState({
      status: "signed-in",
      handle: "operator",
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
      api: null,
    });
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps inactive tab panes inert while they remain mounted", () => {
    const projectId = useTabs.getState().openTab({ kind: "project", projectSlug: "alpha", title: "Alpha" });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "dev", title: "dev" });
    useTabs.getState().focusTab(projectId);

    const { getByRole, getByText } = render(<TabContent />);

    const activePane = getByRole("button", { name: "Project alpha" }).parentElement;
    const hiddenPane = getByText("Terminal body").parentElement;

    expect(activePane?.hasAttribute("inert")).toBe(false);
    expect(hiddenPane?.hasAttribute("inert")).toBe(true);
    expect(hiddenPane?.getAttribute("aria-hidden")).toBe("true");
  });

  it("forwards task project slugs into the task workspace", () => {
    useTabs.getState().openTab({
      kind: "task",
      taskId: "task_a",
      projectSlug: "alpha",
      title: "Task A",
    });

    const { getByRole } = render(<TabContent />);

    expect(getByRole("button", { name: "Task task_a alpha" })).toBeTruthy();
    expect(taskWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_a", projectSlug: "alpha", active: true }),
      undefined,
    );
  });

  it("renders the apps tab through the tracked AppLauncher module", () => {
    useTabs.setState({
      activeTabId: "apps",
      tabs: [{ id: "apps", kind: "apps", title: "Apps", closable: true }],
    });

    render(<TabContent />);

    expect(screen.getByRole("heading", { name: /^(Apps|Loading apps)$/ })).toBeTruthy();
  });

  it("contains a task panel exception without blanking the desktop renderer", () => {
    function BrokenPanel(): React.ReactNode {
      throw new Error("private terminal failure");
    }

    render(
      <TabErrorBoundary tabTitle="Task A" onClose={vi.fn()}>
        <BrokenPanel />
      </TabErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "Task A couldn't open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
    expect(screen.queryByText(/private terminal failure/i)).toBeNull();
  });
});
