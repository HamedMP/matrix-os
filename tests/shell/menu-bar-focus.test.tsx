// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowManager } from "../../shell/src/hooks/useWindowManager.js";

let MenuBar: typeof import("../../shell/src/components/MenuBar.js").MenuBar;

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useUser: () => ({
    user: {
      fullName: null,
      username: "test-user",
      imageUrl: "",
      primaryEmailAddress: { emailAddress: "test@example.com" },
    },
  }),
  useClerk: () => ({
    signOut: vi.fn(async () => undefined),
    openUserProfile: vi.fn(),
  }),
  UserButton: Object.assign(
    ({ children }: { children?: React.ReactNode }) => <div data-testid="clerk-user-button">{children}</div>,
    {
      MenuItems: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
      Link: ({ href, label }: { href: string; label: string; labelIcon?: React.ReactElement }) => <a href={href}>{label}</a>,
    },
  ),
}));

vi.mock("../../shell/src/components/AppSettingsDialog.js", () => ({
  AppSettingsDialog: () => null,
}));

beforeAll(async () => {
  ({ MenuBar } = await import("../../shell/src/components/MenuBar.js"));
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
  beforeEach(() => {
    resetStore();
  });

  it("shows Matrix OS button and hides focused-app button when no app owns focus", () => {
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);
    useWindowManager.getState().clearFocus();

    render(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}}>
        <button type="button">Fit</button>
      </MenuBar>,
    );

    expect(screen.getByRole("button", { name: "Matrix OS" })).toBeTruthy();
    expect(screen.queryByTestId("menu-focus-indicator")).toBeNull();
    expect(screen.queryByRole("button", { name: "Whiteboard" })).toBeNull();
  });

  it("shows the active app name when a window owns focus", () => {
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);

    render(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}}>
        <button type="button">Fit</button>
      </MenuBar>,
    );

    expect(screen.getByRole("button", { name: "Whiteboard" })).toBeTruthy();
    expect(screen.queryByTestId("menu-focus-indicator")).toBeNull();
    expect(screen.queryByRole("button", { name: "Matrix OS" })).toBeNull();
  });

  it("puts switch-computer under the account menu instead of the top menu", async () => {
    render(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}}>
        <button type="button">Fit</button>
      </MenuBar>,
    );

    expect(screen.queryByRole("button", { name: "Computer" })).toBeNull();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu for test-user" }), {
      button: 0,
      ctrlKey: false,
    });
    expect((await screen.findByRole("menuitem", { name: "Switch computer" })).getAttribute("href")).toBe("/runtime");
  });
});
