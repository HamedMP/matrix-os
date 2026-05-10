// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MenuBarType = typeof import("../../shell/src/components/MenuBar.js").MenuBar;
type UseWindowManagerType = typeof import("../../shell/src/hooks/useWindowManager.js").useWindowManager;

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  UserButton: () => null,
}));

vi.mock("../../shell/src/components/AppSettingsDialog.js", () => ({
  AppSettingsDialog: () => null,
}));

let MenuBar: MenuBarType;
let useWindowManager: UseWindowManagerType;

beforeEach(async () => {
  vi.resetModules();
  ({ useWindowManager } = await import("../../shell/src/hooks/useWindowManager.js"));
  ({ MenuBar } = await import("../../shell/src/components/MenuBar.js"));
  resetStore();
});

function resetStore() {
  useWindowManager.setState({
    windows: [],
    nextZ: 1,
    closedPaths: new Set(),
    closedLayouts: new Map(),
    apps: [],
    focusedWindowId: null,
    appLaunchTimes: {},
  });
}

describe("MenuBar focus display", () => {
  it("shows Matrix OS when no app owns focus", () => {
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);
    useWindowManager.getState().clearFocus();

    render(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}}>
        <button type="button">Fit</button>
      </MenuBar>,
    );

    expect(screen.getByRole("button", { name: "Matrix OS" })).toBeTruthy();
  });

  it("shows the active app name when a window owns focus", () => {
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);

    render(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}}>
        <button type="button">Fit</button>
      </MenuBar>,
    );

    expect(screen.getByRole("button", { name: "Whiteboard" })).toBeTruthy();
  });
});
