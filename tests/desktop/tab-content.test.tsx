// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TabContent from "../../desktop/src/renderer/src/features/mission-control/TabContent";
import { useTabs } from "../../desktop/src/renderer/src/stores/tabs";

const taskWorkspaceMock = vi.hoisted(() =>
  vi.fn(({ taskId, projectSlug }: { taskId: string; projectSlug?: string }) => (
    <button type="button">
      Task {taskId} {projectSlug}
    </button>
  )),
);

vi.mock("../../desktop/src/renderer/src/features/mission-control/HomeTab", () => ({
  default: () => <button type="button">Home body</button>,
}));
vi.mock("../../desktop/src/renderer/src/features/board/Board", () => ({
  default: ({ projectSlug }: { projectSlug: string }) => (
    <button type="button">Board {projectSlug}</button>
  ),
}));
vi.mock("../../desktop/src/renderer/src/features/workspace/TaskWorkspace", () => ({
  default: taskWorkspaceMock,
}));
vi.mock("../../desktop/src/renderer/src/features/terminal/TerminalView", () => ({
  default: () => <button type="button">Terminal body</button>,
}));
vi.mock("../../desktop/src/renderer/src/features/threads/ThreadView", () => ({
  default: () => <button type="button">Thread body</button>,
}));
vi.mock("../../desktop/src/renderer/src/features/settings/SettingsView", () => ({
  default: () => <button type="button">Settings body</button>,
}));
vi.mock("../../desktop/src/renderer/src/features/threads/AgentsTab", () => ({
  default: () => <button type="button">Agents body</button>,
}));

describe("TabContent", () => {
  beforeEach(() => {
    useTabs.setState({ tabs: [], activeTabId: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps inactive tab panes inert while they remain mounted", () => {
    const boardId = useTabs.getState().openTab({ kind: "board", projectSlug: "alpha", title: "Alpha" });
    useTabs.getState().openTab({ kind: "terminal", sessionName: "dev", title: "dev" });
    useTabs.getState().focusTab(boardId);

    const { getByRole, getByText } = render(<TabContent />);

    const activePane = getByRole("button", { name: "Board alpha" }).parentElement;
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
});
