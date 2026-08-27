// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebDesktopSurface } from "@/components/desktop/WebDesktopSurface";

const apps = [
  { name: "Terminal", path: "__terminal__", iconUrl: "/icons/terminal.svg" },
  { name: "Files", path: "__file-browser__", iconUrl: "/icons/files.svg" },
  { name: "Hermes", path: "__chat__", iconUrl: "/icons/chat.svg" },
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
  it("renders the native Desktop structure without the deprecated menu bar", () => {
    render(
      <WebDesktopSurface
        apps={apps}
        windows={windows}
        launcherOpen={false}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={vi.fn()}
      >
        <div>window layer</div>
      </WebDesktopSurface>,
    );

    expect(screen.getByRole("navigation", { name: "Desktop apps" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Running apps" })).toBeTruthy();
    expect(screen.queryByRole("banner")).toBeNull();
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
        launcherOpen={false}
        onOpenApp={onOpenApp}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={onActivateWindow}
      />,
    );

    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));
    expect(onOpenApp).toHaveBeenCalledWith("Terminal", "__terminal__");

    fireEvent.click(screen.getByRole("button", { name: "Focus Terminal" }));
    expect(onActivateWindow).toHaveBeenCalledWith("terminal-window");
  });

  it("keeps minimized apps in the taskbar as restore targets", () => {
    const onActivateWindow = vi.fn();
    render(
      <WebDesktopSurface
        apps={apps}
        windows={[{ ...windows[0], minimized: true }]}
        launcherOpen={false}
        onOpenApp={vi.fn()}
        onOpenLauncher={vi.fn()}
        onOpenSettings={vi.fn()}
        onActivateWindow={onActivateWindow}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore Terminal" }));
    expect(onActivateWindow).toHaveBeenCalledWith("terminal-window");
  });
});
