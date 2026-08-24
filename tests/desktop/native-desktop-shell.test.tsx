// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NativeDesktopShell from "@desktop/renderer/src/features/desktop-shell/NativeDesktopShell";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

vi.mock("@desktop/renderer/src/features/mission-control/TabContent", () => ({
  TabPane: ({ tab }: { tab: { title: string } }) => <div>{tab.title} content</div>,
  TabErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@desktop/renderer/src/features/runtime/RuntimeComputerMenu", () => ({
  default: () => <div>Computer</div>,
}));
vi.mock("@desktop/renderer/src/features/mission-control/AccountMenu", () => ({
  default: () => <div>Account</div>,
}));
vi.mock("@desktop/renderer/src/features/updates/DesktopUpdateButton", () => ({
  default: () => null,
}));

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => cleanup());

describe("native desktop shell", () => {
  it("uses the shell background and presents the hosted shell as Browser", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    expect(screen.getByRole("button", { name: "Browser" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    const background = document.querySelector<HTMLElement>("[data-native-desktop-shell]")?.style.background ?? "";
    expect(background).toContain("inherit");
    expect(background).not.toContain("--bg-sunken");
  });

  it("opens desktop destinations as floating windows", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));

    expect(screen.getByRole("dialog", { name: "Hermes window" })).toBeTruthy();
    expect(screen.getByText("Hermes content")).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[useTabs.getState().activeTabId!]?.mode).toBe("window");
  });

  it("minimizes a window to the taskbar and restores it", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));
    const tabId = useTabs.getState().activeTabId!;

    fireEvent.click(screen.getByRole("button", { name: "Minimize Terminal" }));
    expect(screen.queryByRole("dialog", { name: "Terminal window" })).toBeNull();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("minimized");

    fireEvent.click(screen.getByRole("button", { name: "Restore Terminal" }));
    expect(screen.getByRole("dialog", { name: "Terminal window" })).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("window");
  });

  it("maximizes a window into the tab strip and restores it as a window", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));
    const tabId = useTabs.getState().activeTabId!;

    fireEvent.click(screen.getByRole("button", { name: "Maximize Files into tabs" }));
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("tab");

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("dialog", { name: "Files window" })).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("window");
  });

  it("keeps inactive floating surfaces mounted while only the focused surface is interactive", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));

    expect(screen.getByText("Hermes content")).toBeTruthy();
    expect(screen.getByText("Terminal content")).toBeTruthy();
    expect(screen.getByTestId("desktop-surface-content-chat").hasAttribute("inert")).toBe(true);
    expect(screen.getByTestId("desktop-surface-content-terminals").hasAttribute("inert")).toBe(false);
  });

  it("uses an in-app drag handle instead of the native Electron titlebar region", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));
    const tabId = useTabs.getState().activeTabId!;
    const before = useDesktopSurfaces.getState().surfaces[tabId]!.bounds;

    const dragHandle = screen.getByTestId("desktop-window-drag-handle");
    expect(dragHandle.classList.contains("titlebar-drag")).toBe(false);
    expect(dragHandle.classList.contains("no-drag")).toBe(true);

    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 400, clientY: 180 });
    fireEvent.pointerMove(window, { clientX: 480, clientY: 225 });
    fireEvent.pointerUp(window);

    expect(useDesktopSurfaces.getState().surfaces[tabId]!.bounds).toMatchObject({
      x: before.x + 80,
      y: before.y + 45,
    });
  });
});
