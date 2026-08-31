// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabPane, TabErrorBoundary } from "@desktop/renderer/src/features/mission-control/TabContent";
import DesktopSurfaceFrame from "@desktop/renderer/src/features/desktop-shell/DesktopSurfaceFrame";
import type { Tab } from "@desktop/renderer/src/stores/tabs";

const workTabMock = vi.hoisted(() => vi.fn(() => <div>Work</div>));
const taskWorkspaceMock = vi.hoisted(() => vi.fn(() => <div>Task</div>));
const terminalsTabMock = vi.hoisted(() => vi.fn(() => <div>Terminal</div>));
const homeMock = vi.hoisted(() => vi.fn(() => <div>Browser</div>));
const browserMock = vi.hoisted(() => vi.fn(() => <div>Web Browser</div>));
const editorMock = vi.hoisted(() => vi.fn(() => <div>Editor</div>));
const notesMock = vi.hoisted(() => vi.fn(() => <div>Notes</div>));

vi.mock("@desktop/renderer/src/features/work/WorkTab", () => ({ default: workTabMock }));
vi.mock("@desktop/renderer/src/features/workspace/TaskWorkspace", () => ({ default: taskWorkspaceMock }));
vi.mock("@desktop/renderer/src/features/terminal/TerminalsTab", () => ({ default: terminalsTabMock }));
vi.mock("@desktop/renderer/src/features/mission-control/HomeTab", () => ({ default: homeMock }));
vi.mock("@desktop/renderer/src/features/browser/BrowserTab", () => ({ default: browserMock }));
vi.mock("@desktop/renderer/src/features/editor/DesktopEditorWorkspace", () => ({ default: editorMock }));
vi.mock("@desktop/renderer/src/features/notes/NotesWorkspace", () => ({ default: notesMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  workTabMock.mockImplementation(() => <div>Work</div>);
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

  it("mounts hosted Chat navigation in the OS window sidebar safe area", () => {
    const tab: Tab = { id: "chat", kind: "work", title: "Chat", closable: false, workRoute: "chat" };
    const commonProps = {
      tab,
      active: true,
      presentation: "desktop" as const,
      onFocus: vi.fn(),
      onClose: vi.fn(),
      onMinimize: vi.fn(),
      onMaximize: vi.fn(),
      onBoundsChange: vi.fn(),
    };
    const windowSurface = { tabId: tab.id, mode: "window" as const, bounds: { x: 0, y: 0, width: 1_200, height: 800 }, zIndex: 1 };

    const view = render(<DesktopSurfaceFrame {...commonProps} surface={windowSurface} tabWorkspaceActive={false} />);

    const sidebar = view.container.querySelector("[data-os-window-sidebar]") as HTMLElement;
    expect(sidebar).toBeTruthy();
    expect(sidebar.style.width).toBe("240px");
    expect(sidebar.querySelector<HTMLElement>('[data-os-window-safe-view="sidebar"]')?.style.paddingTop).toBe("48px");
    expect(sidebar.querySelector('[aria-label="Chat navigation"]')).toBeTruthy();
    expect(view.container.querySelector('[data-os-window-main] [aria-label="Chat navigation"]')).toBeNull();

    view.rerender(<DesktopSurfaceFrame
      {...commonProps}
      surface={{ ...windowSurface, mode: "tab" }}
      tabWorkspaceActive
    />);

    const tabSidebar = view.container.querySelector("[data-os-window-sidebar]") as HTMLElement;
    expect(tabSidebar.querySelector<HTMLElement>('[data-os-window-safe-view="sidebar"]')?.style.paddingTop).toBe("");
    expect(view.container.querySelector("[data-os-window-top-bar-overlay]")).toBeNull();
  });

  it("collapses and restores an active Chat sidebar through OSWindow", () => {
    const tab: Tab = {
      id: "chat-active",
      kind: "work",
      title: "Chat",
      closable: false,
      workRoute: "chat",
      chatId: "chat-global",
      chatTitle: "Global chat",
      chatView: "conversation",
    };
    const view = render(<DesktopSurfaceFrame
      tab={tab}
      surface={{ tabId: tab.id, mode: "window", bounds: { x: 0, y: 0, width: 1_200, height: 800 }, zIndex: 1 }}
      active
      tabWorkspaceActive={false}
      overlayOpen={false}
      presentation="desktop"
      onFocus={vi.fn()}
      onClose={vi.fn()}
      onMinimize={vi.fn()}
      onMaximize={vi.fn()}
      onBoundsChange={vi.fn()}
    />);

    const osWindow = view.container.querySelector("[data-os-window]") as HTMLElement;
    const sidebar = view.container.querySelector("[data-os-window-sidebar]") as HTMLElement;
    const trigger = screen.getByRole("button", { name: "Toggle Chat sidebar" });
    expect(trigger.parentElement?.textContent).toContain("Global chat");
    expect(osWindow.getAttribute("data-sidebar-shown")).toBe("true");

    fireEvent.click(trigger);
    expect(osWindow.getAttribute("data-sidebar-shown")).toBe("false");
    expect(sidebar.hidden).toBe(true);

    fireEvent.click(trigger);
    expect(osWindow.getAttribute("data-sidebar-shown")).toBe("true");
    expect(sidebar.hidden).toBe(false);

    view.rerender(<DesktopSurfaceFrame
      tab={tab}
      surface={{ tabId: tab.id, mode: "tab", bounds: { x: 0, y: 0, width: 1_200, height: 800 }, zIndex: 1 }}
      active
      tabWorkspaceActive
      overlayOpen={false}
      presentation="desktop"
      onFocus={vi.fn()}
      onClose={vi.fn()}
      onMinimize={vi.fn()}
      onMaximize={vi.fn()}
      onBoundsChange={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "Toggle Chat sidebar" })).toBeTruthy();
    expect(view.container.querySelector("[data-os-window-top-bar-overlay]")).toBeTruthy();
    expect(view.container.querySelector<HTMLElement>('[data-os-window-safe-view="sidebar"]')?.style.paddingTop).toBe("");
  });

  it("renders apps through the current AppLauncher", () => {
    render(<TabPane tab={{ id: "apps", kind: "apps", title: "Apps", closable: true }} active />);
    expect(screen.getByRole("heading", { name: /^(Apps|Loading apps)$/ })).toBeTruthy();
  });

  it.each([
    ["browser", browserMock],
    ["editor", editorMock],
    ["notes", notesMock],
  ] as const)("renders the current %s workspace", (kind, workspaceMock) => {
    render(<TabPane tab={{ id: kind, kind, title: kind, closable: true }} active />);
    expect(workspaceMock).toHaveBeenCalled();
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
