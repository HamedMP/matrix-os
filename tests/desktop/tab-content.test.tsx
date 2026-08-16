// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
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
const terminalsTabMock = vi.hoisted(() =>
  vi.fn(({ active }: { active: boolean }) => (
    <button type="button" data-active={String(active)}>Terminal workspace</button>
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
vi.mock("@desktop/renderer/src/features/terminal/TerminalsTab", () => ({
  default: terminalsTabMock,
}));
vi.mock("@desktop/renderer/src/features/mission-control/HomeTab", () => ({
  default: () => <button type="button">Home workspace</button>,
}));
vi.mock("@desktop/renderer/src/features/chat/ChatTab", () => ({
  default: () => <button type="button">Chat workspace</button>,
}));
vi.mock("@desktop/renderer/src/features/files/FilesWorkspace", () => ({
  default: () => <button type="button">Files workspace</button>,
}));
vi.mock("@desktop/renderer/src/features/plugins/PluginsHub", () => ({
  default: () => <button type="button">Plugins workspace</button>,
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
    expect(activePane?.style.display).toBe("flex");
    expect(activePane?.style.visibility).toBe("visible");
    expect(activePane?.style.pointerEvents).toBe("auto");
    expect(activePane?.style.background).toBe("var(--bg-app)");
    expect(hiddenPane?.hasAttribute("inert")).toBe(true);
    expect(hiddenPane?.getAttribute("aria-hidden")).toBe("true");
    expect(hiddenPane?.style.display).toBe("none");
    expect(hiddenPane?.style.visibility).toBe("hidden");
    expect(hiddenPane?.style.pointerEvents).toBe("none");
  });

  it.each([
    ["apps", { kind: "apps" as const, title: "Apps" }],
    ["plugins", { kind: "plugins" as const, title: "Plugins" }],
    ["chat", { kind: "chat" as const, title: "Chat" }],
    ["files", { kind: "files" as const, title: "Files" }],
    ["home", { kind: "home" as const, title: "Home" }],
    ["project", { kind: "project" as const, projectSlug: "alpha", title: "Alpha" }],
  ])("fully contains the retained Terminal workspace beneath the %s route", (_route, target) => {
    const terminalId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
    const targetId = useTabs.getState().openTab(target);
    useTabs.getState().focusTab(targetId);

    const { container } = render(<TabContent />);
    const terminalPane = container.querySelector<HTMLElement>(`[data-tab-id="${terminalId}"]`);
    const activePane = container.querySelector<HTMLElement>(`[data-tab-id="${targetId}"]`);

    expect(terminalPane).toBeTruthy();
    expect(terminalPane?.dataset.tabKind).toBe("terminals");
    expect(terminalPane?.style.display).toBe("none");
    expect(terminalPane?.style.visibility).toBe("hidden");
    expect(terminalPane?.style.pointerEvents).toBe("none");
    expect(terminalPane?.getAttribute("aria-hidden")).toBe("true");
    expect(terminalPane?.hasAttribute("inert")).toBe(true);

    expect(activePane).toBeTruthy();
    expect(activePane?.style.display).toBe("flex");
    expect(activePane?.style.visibility).toBe("visible");
    expect(activePane?.style.pointerEvents).toBe("auto");
    expect(activePane?.style.background).toBe("var(--bg-app)");
    expect(activePane?.getAttribute("aria-hidden")).toBe("false");
    expect(activePane?.hasAttribute("inert")).toBe(false);
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

  it("propagates active ownership to the mounted Terminal workspace across native focus changes", () => {
    const workspaceId = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
    const nativeId = useTabs.getState().openTab({ kind: "terminal", sessionName: "dev", title: "dev" });
    useTabs.getState().focusTab(workspaceId);
    render(<TabContent />);

    const workspace = screen.getByRole("button", { name: "Terminal workspace" });
    expect(workspace.getAttribute("data-active")).toBe("true");

    act(() => useTabs.getState().focusTab(nativeId));
    expect(workspace.getAttribute("data-active")).toBe("false");

    act(() => useTabs.getState().focusTab(workspaceId));
    expect(workspace.getAttribute("data-active")).toBe("true");
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
