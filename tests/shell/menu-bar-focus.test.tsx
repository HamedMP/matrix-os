// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MenuBar } from "../../shell/src/components/MenuBar.js";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false }),
  UserButton: () => null,
}));

vi.mock("../../shell/src/components/AppSettingsDialog.js", () => ({
  AppSettingsDialog: () => null,
}));

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
  beforeEach(() => {
    resetStore();
  });

  it("shows Matrix OS and Canvas when no app owns focus", () => {
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);
    useWindowManager.getState().clearFocus();

    render(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}}>
        <button type="button">Fit</button>
      </MenuBar>,
    );

    expect(screen.getByRole("button", { name: "Matrix OS" })).toBeTruthy();
    expect(screen.getByTestId("menu-focus-indicator").textContent).toBe("Canvas");
  });

  it("shows the active app name when a window owns focus", () => {
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);

    render(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}}>
        <button type="button">Fit</button>
      </MenuBar>,
    );

    expect(screen.getByRole("button", { name: "Whiteboard" })).toBeTruthy();
    expect(screen.getByTestId("menu-focus-indicator").textContent).toBe("Whiteboard");
  });
});
