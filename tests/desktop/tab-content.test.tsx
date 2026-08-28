// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabPane, TabErrorBoundary } from "@desktop/renderer/src/features/mission-control/TabContent";
import DesktopSurfaceFrame from "@desktop/renderer/src/features/desktop-shell/DesktopSurfaceFrame";
import type { Tab } from "@desktop/renderer/src/stores/tabs";

const workTabMock = vi.hoisted(() => vi.fn(() => <div>Work</div>));
const taskWorkspaceMock = vi.hoisted(() => vi.fn(() => <div>Task</div>));
const terminalsTabMock = vi.hoisted(() => vi.fn(() => <div>Terminal</div>));
const homeMock = vi.hoisted(() => vi.fn(() => <div>Browser</div>));

vi.mock("@desktop/renderer/src/features/work/WorkTab", () => ({ default: workTabMock }));
vi.mock("@desktop/renderer/src/features/workspace/TaskWorkspace", () => ({ default: taskWorkspaceMock }));
vi.mock("@desktop/renderer/src/features/terminal/TerminalsTab", () => ({ default: terminalsTabMock }));
vi.mock("@desktop/renderer/src/features/mission-control/HomeTab", () => ({ default: homeMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("current desktop tab panes", () => {
  it.each([
    ["chat", "chat"],
    ["projects", "projects"],
    ["project", "project"],
    ["work", "project"],
  ] as const)("keeps persisted %s tabs on the current Work renderer", (kind, route) => {
    const tab: Tab = {
      id: "work", kind, workRoute: route, projectSlug: "alpha",
      title: "Alpha", closable: true, chatId: "chat-a", chatTitle: "Chat A",
    };
    render(<TabPane tab={tab} active />);
    expect(workTabMock).toHaveBeenCalledWith(expect.objectContaining({ route, active: true }), undefined);
    if (route === "project") {
      expect(workTabMock).toHaveBeenCalledWith(expect.objectContaining({
        projectSlug: "alpha", initialChatId: "chat-a", initialChatTitle: "Chat A",
      }), undefined);
    }
  });

  it("forwards task project identity to the live task workspace", () => {
    render(<TabPane tab={{
      id: "task", kind: "task", taskId: "task_a", projectSlug: "alpha", title: "Task A", closable: true,
    }} active />);
    expect(taskWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_a", projectSlug: "alpha", active: true }), undefined,
    );
  });

  it("keeps terminal visibility separate from keyboard ownership", () => {
    const tab: Tab = { id: "terminal", kind: "terminals", title: "Terminal", closable: true };
    const view = render(<TabPane tab={tab} active visible />);
    expect(terminalsTabMock).toHaveBeenLastCalledWith({ active: true, visible: true }, undefined);
    view.rerender(<TabPane tab={tab} active={false} visible />);
    expect(terminalsTabMock).toHaveBeenLastCalledWith({ active: false, visible: true }, undefined);
    view.rerender(<TabPane tab={tab} active={false} visible={false} />);
    expect(terminalsTabMock).toHaveBeenLastCalledWith({ active: false, visible: false }, undefined);
  });

  it.each(["desktop", "canvas"] as const)("detaches native embeds under overlays in %s", (presentation) => {
    const tab: Tab = { id: "browser", kind: "home", title: "Browser", closable: false };
    const props = {
      tab,
      surface: { tabId: tab.id, mode: "window" as const, bounds: { x: 0, y: 0, width: 800, height: 600 }, zIndex: 1 },
      active: true, tabWorkspaceActive: false, presentation,
      onFocus: vi.fn(), onClose: vi.fn(), onMinimize: vi.fn(), onMaximize: vi.fn(), onBoundsChange: vi.fn(),
    };
    const view = render(<DesktopSurfaceFrame {...props} overlayOpen={false} />);
    expect(homeMock).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }), undefined);
    view.rerender(<DesktopSurfaceFrame {...props} overlayOpen />);
    expect(homeMock).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }), undefined);
    view.rerender(<DesktopSurfaceFrame {...props} overlayOpen={false} />);
    expect(homeMock).toHaveBeenLastCalledWith(expect.objectContaining({ active: true }), undefined);
  });

  it("renders apps through the current AppLauncher", () => {
    render(<TabPane tab={{ id: "apps", kind: "apps", title: "Apps", closable: true }} active />);
    expect(screen.getByRole("heading", { name: /^(Apps|Loading apps)$/ })).toBeTruthy();
  });

  it("contains a task panel exception without exposing private errors", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    function BrokenPanel(): React.ReactNode {
      throw new Error("private terminal failure");
    }
    render(<TabErrorBoundary tabTitle="Task A" onClose={vi.fn()}><BrokenPanel /></TabErrorBoundary>);
    expect(screen.getByRole("heading", { name: "Task A couldn't open" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close tab" })).toBeTruthy();
    expect(screen.queryByText(/private terminal failure/i)).toBeNull();
    vi.restoreAllMocks();
  });
});
