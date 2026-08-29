// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  desktopAppearanceForApp,
  WebDesktopSurface,
} from "@/components/desktop/WebDesktopSurface";

const apps = [
  { name: "Terminal", path: "__terminal__", iconUrl: "/icons/terminal.svg" },
  { name: "Files", path: "__file-browser__", iconUrl: "/icons/files.svg" },
  { name: "Hermes", path: "__chat__", iconUrl: "/icons/chat.svg" },
  { name: "Browser", path: "apps/browser/index.html", iconUrl: "/icons/browser.svg" },
  { name: "Notes", path: "apps/notes/index.html", iconUrl: "/icons/notes.svg" },
  { name: "Whiteboard", path: "apps/whiteboard/index.html", iconUrl: "/icons/whiteboard.svg" },
  { name: "Calculator", path: "apps/calculator/index.html", iconUrl: "/icons/calculator.svg" },
];

const windows = [
  {
    id: "terminal-window",
    title: "Terminal",
    path: "__terminal__",
    x: 120,
    y: 80,
    width: 900,
    height: 620,
    minimized: false,
    zIndex: 3,
  },
];

describe("WebDesktopSurface", () => {
  it("renders the native Desktop header without restoring the deprecated app menu", () => {
    render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId={null}
        launcherOpen={false}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={vi.fn()}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={vi.fn()}
      >
        <div>window layer</div>
      </WebDesktopSurface>,
    );

    expect(screen.getByRole("navigation", { name: "Desktop apps" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Running apps" })).toBeTruthy();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("tablist", { name: "Workspace tabs" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Open app previews" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Show desktop" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(screen.queryByText("File")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
    expect(screen.queryByText("View")).toBeNull();
    expect(screen.queryByRole("button", { name: "Calculator" })).toBeNull();
    expect(screen.getByText("window layer")).toBeTruthy();
  });

  it("uses desktop icon activation and taskbar focus behavior", () => {
    const onOpenApp = vi.fn();
    const onActivateWindow = vi.fn();
    render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId={null}
        launcherOpen={false}
        onOpenApp={onOpenApp}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={onActivateWindow}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));
    expect(onOpenApp).toHaveBeenCalledWith("__terminal__", "Terminal");

    fireEvent.click(screen.getByRole("button", { name: "Focus Terminal" }));
    expect(onActivateWindow).toHaveBeenCalledWith("terminal-window");
  });

  it("removes a configured Desktop icon from its context menu", () => {
    const onRemoveDesktopIcon = vi.fn();
    render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId={null}
        launcherOpen={false}
        desktopIcons={[{ path: "__chat__", x: 20, y: 58 }]}
        onMoveDesktopIcon={vi.fn()}
        onRemoveDesktopIcon={onRemoveDesktopIcon}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={vi.fn()}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Chat" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove Chat from Desktop" }));
    expect(onRemoveDesktopIcon).toHaveBeenCalledWith("__chat__");
  });

  it("ships the canonical Desktop destinations in parity order and deep-links Plugins to Services", () => {
    const onOpenSettings = vi.fn();
    const onOpenApp = vi.fn();
    render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId={null}
        launcherOpen={false}
        onOpenApp={onOpenApp}
        onOpenLauncher={vi.fn()}
        onOpenSettings={onOpenSettings}
        onActivateWindow={vi.fn()}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const desktop = screen.getByRole("navigation", { name: "Desktop apps" });
    expect(Array.from(desktop.querySelectorAll("button")).map((button) => button.getAttribute("aria-label")))
      .toEqual(["Chat", "Terminal", "Files", "Editor", "VS Code", "Settings", "Plugins", "Browser", "Notes", "Whiteboard"]);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Plugins" }));
    expect(onOpenSettings).toHaveBeenCalledWith("integrations");
    fireEvent.doubleClick(screen.getByRole("button", { name: "Notes" }));
    expect(onOpenApp).toHaveBeenCalledWith("apps/notes/index.html", "Notes");
  });

  it("renders account, runtime, and support controls in the header action slot", () => {
    render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId={null}
        launcherOpen={false}
        headerActions={<button type="button">Account controls</button>}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={vi.fn()}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    expect(screen.getByRole("banner").contains(screen.getByRole("button", { name: "Account controls" })))
      .toBe(true);
  });

  it("keeps minimized apps in the taskbar as restore targets", () => {
    const onActivateWindow = vi.fn();
    render(
      <WebDesktopSurface
        apps={apps}
        windows={[{ ...windows[0], minimized: true }]}
        fullscreenWindowId={null}
        launcherOpen={false}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={onActivateWindow}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore Terminal" }));
    expect(onActivateWindow).toHaveBeenCalledWith("terminal-window");
  });

  it("renders every canonical taskbar app as a full-size desktop tile", () => {
    render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId={null}
        launcherOpen={false}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={vi.fn()}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={vi.fn()}
      />,
    );

    const filesTile = screen.getByRole("button", { name: "Open Files" })
      .querySelector<HTMLElement>("[data-desktop-app-icon]");
    const terminalTile = screen.getByRole("button", { name: "Focus Terminal" })
      .querySelector<HTMLElement>("[data-desktop-app-icon]");

    for (const tile of [filesTile, terminalTile]) {
      expect(tile).toBeTruthy();
      expect(tile?.className).toContain("size-11");
      expect(tile?.className).toContain("rounded-[13px]");
      expect(tile?.className).not.toContain("absolute");
    }

    expect(desktopAppearanceForApp(apps[0])).toMatchObject({
      color: "var(--surface-warning-emphasis, #E0AA52)",
      iconColor: "white",
    });
    expect(desktopAppearanceForApp(apps[1])).toMatchObject({
      color: "var(--surface-brand-emphasis, #748E59)",
      iconColor: "white",
    });
  });

  it("shows an app in the top bar only while that window is fullscreen", () => {
    const onToggleFullscreen = vi.fn();
    const { rerender } = render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId={null}
        launcherOpen={false}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={vi.fn()}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );

    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(screen.getByRole("button", { name: "Focus Terminal" })).toBeTruthy();

    rerender(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId="terminal-window"
        launcherOpen={false}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={vi.fn()}
        onCloseWindow={vi.fn()}
        onShowDesktop={vi.fn()}
        onToggleFullscreen={onToggleFullscreen}
      />,
    );

    expect(screen.getByRole("tab", { name: "Terminal" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Focus Terminal" })).toBeTruthy();

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Terminal" }));
    expect(onToggleFullscreen).toHaveBeenCalledWith("terminal-window");
  });

  it("shows the desktop and exposes open-window previews from the header", () => {
    const onActivateWindow = vi.fn();
    const onCloseWindow = vi.fn();
    const onShowDesktop = vi.fn();
    render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        fullscreenWindowId={null}
        launcherOpen={false}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={onActivateWindow}
        onCloseWindow={onCloseWindow}
        onShowDesktop={onShowDesktop}
        onToggleFullscreen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Show desktop" }));
    expect(onShowDesktop).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("tab", { name: "Open app previews" }));
    expect(screen.getByRole("dialog", { name: "Open apps" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Preview Terminal" }));
    expect(onActivateWindow).toHaveBeenCalledWith("terminal-window");
    expect(screen.queryByRole("dialog", { name: "Open apps" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Open app previews" }));
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal preview" }));
    expect(onCloseWindow).toHaveBeenCalledWith("terminal-window");
  });
});
