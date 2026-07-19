// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
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

describe("MenuBar macOS-glass variant", () => {
  beforeEach(() => {
    resetStore();
    document.documentElement.setAttribute("data-theme-style", "macos-glass");
  });

  afterEach(async () => {
    // The attribute removal notifies useThemeStyle's MutationObserver on any
    // still-mounted MenuBar; flush that update inside act.
    await act(async () => {
      document.documentElement.removeAttribute("data-theme-style");
      await Promise.resolve();
    });
  });

  // The useThemeStyle hook mirrors data-theme-style via an effect + a
  // MutationObserver whose callbacks are microtasks; flush both inside act.
  async function renderMenuBar(ui: React.ReactElement) {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(ui);
      await Promise.resolve();
    });
    return result;
  }

  it("renders the Apple menu, mac menus, and status icons", async () => {
    await renderMenuBar(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}} onOpenSettings={() => {}} />,
    );

    // Apple glyph menu, then the bold app menu, then the mac menu set.
    expect(screen.getByRole("button", { name: "Apple menu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Matrix OS" })).toBeTruthy();
    for (const label of ["File", "Edit", "View", "Window", "Help"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
    // Right side: spotlight + Control Center buttons (battery/wifi are decorative).
    expect(screen.getByRole("button", { name: "Spotlight search" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Control Center" })).toBeTruthy();
  });

  it("keeps the flat structure when the design is not macos-glass", async () => {
    document.documentElement.removeAttribute("data-theme-style");
    await renderMenuBar(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}} />,
    );

    expect(screen.queryByRole("button", { name: "Apple menu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Window" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Spotlight search" })).toBeNull();
  });

  it("minimizes the focused window from the Window menu", async () => {
    const onMinimizeWindow = vi.fn();
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);
    const windowId = useWindowManager.getState().windows[0]!.id;

    await renderMenuBar(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}} onMinimizeWindow={onMinimizeWindow} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Window" }));
    fireEvent.click(screen.getByRole("button", { name: /Minimize/ }));
    expect(onMinimizeWindow).toHaveBeenCalledWith(windowId);
  });

  it("opens the command palette from the Help menu", async () => {
    const onOpenCommandPalette = vi.fn();
    await renderMenuBar(
      <MenuBar onOpenCommandPalette={onOpenCommandPalette} onNewWindow={() => {}} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    fireEvent.click(screen.getByRole("button", { name: /Matrix OS Help/ }));
    expect(onOpenCommandPalette).toHaveBeenCalled();
  });

  it("opens system settings from the Apple menu", async () => {
    const onOpenSettings = vi.fn();
    await renderMenuBar(
      <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}} onOpenSettings={onOpenSettings} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Apple menu" }));
    fireEvent.click(screen.getByRole("button", { name: /System Settings/ }));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
