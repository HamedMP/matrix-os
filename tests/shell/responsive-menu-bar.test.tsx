// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  useClerk: () => ({ signOut: vi.fn(async () => undefined), openUserProfile: vi.fn() }),
  UserButton: Object.assign(
    ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    {
      MenuItems: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
      Link: ({ href, label }: { href: string; label: string }) => <a href={href}>{label}</a>,
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
    fullscreenWindowId: null,
  });
}

async function openApplicationActions() {
  const trigger = screen.getByRole("button", { name: "More application actions" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.findByRole("menu", { name: "More application actions" });
}

describe("responsive MenuBar actions", () => {
  beforeEach(() => {
    resetStore();
    document.documentElement.removeAttribute("data-theme-style");
  });

  afterEach(async () => {
    await act(async () => {
      document.documentElement.removeAttribute("data-theme-style");
      await Promise.resolve();
    });
  });

  it("keeps standard File, Edit, and View menus direct at full width", () => {
    render(<MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}} />);

    const fullActions = screen.getByTestId("full-application-actions");
    expect(fullActions.className).toContain("hidden");
    expect(fullActions.className).toContain("lg:flex");
    for (const label of ["File", "Edit", "View"]) {
      expect(within(fullActions).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("exposes and invokes every standard action displaced into the compact Radix menu", async () => {
    const onNewWindow = vi.fn();
    const onOpenCommandPalette = vi.fn();
    const onMinimizeWindow = vi.fn();
    const execCommand = vi.fn(() => true);
    const writeText = vi.fn(async () => undefined);
    const readText = vi.fn(async () => "pasted text");
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText, readText } });
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "selected text" } as Selection);
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);
    const windowId = useWindowManager.getState().windows[0]!.id;
    render(
      <MenuBar
        onOpenCommandPalette={onOpenCommandPalette}
        onNewWindow={onNewWindow}
        onMinimizeWindow={onMinimizeWindow}
      />,
    );

    const compactActions = screen.getByTestId("compact-application-actions");
    expect(compactActions.className).toContain("lg:hidden");
    let menu = await openApplicationActions();
    for (const section of ["File", "Edit", "View"]) {
      expect(within(menu).getByText(section)).toBeTruthy();
    }
    for (const action of [
      "New Window",
      "Close Window",
      "Minimize",
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Select All",
      "Reload App",
      "Enter Full Screen",
      "Command Palette",
    ]) {
      expect(within(menu).getByRole("menuitem", { name: new RegExp(`^${action}`) })).toBeTruthy();
    }

    const choose = async (name: RegExp) => {
      const openMenu = await openApplicationActions();
      fireEvent.click(within(openMenu).getByRole("menuitem", { name }));
    };

    fireEvent.click(within(menu).getByRole("menuitem", { name: /^New Window/ }));
    expect(onNewWindow).toHaveBeenCalledOnce();

    await choose(/^Minimize/);
    expect(onMinimizeWindow).toHaveBeenCalledWith(windowId);

    await choose(/^Undo/);
    await choose(/^Redo/);
    await choose(/^Cut/);
    await choose(/^Copy/);
    await choose(/^Paste/);
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("insertText", false, "pasted text"));
    await choose(/^Select All/);
    expect(execCommand).toHaveBeenCalledWith("undo");
    expect(execCommand).toHaveBeenCalledWith("redo");
    expect(execCommand).toHaveBeenCalledWith("delete");
    expect(execCommand).toHaveBeenCalledWith("selectAll");
    expect(writeText).toHaveBeenCalledWith("selected text");

    const reload = vi.fn();
    const originalQuerySelector = document.querySelector.bind(document);
    vi.spyOn(document, "querySelector").mockImplementation((selector) => {
      if (selector === `[data-window-id="${windowId}"] iframe`) {
        return {
          get src() { return "about:blank"; },
          set src(value: string) { reload(value); },
        } as HTMLIFrameElement;
      }
      return originalQuerySelector(selector);
    });
    await choose(/^Reload App/);
    expect(reload).toHaveBeenCalledWith("about:blank");

    await choose(/^Enter Full Screen/);
    expect(useWindowManager.getState().fullscreenWindowId).toBe(windowId);

    await choose(/^Command Palette/);
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();

    await choose(/^Close Window/);
    expect(useWindowManager.getState().windows).toHaveLength(0);
  });

  it("keeps all macOS-glass application menus direct at full width", async () => {
    document.documentElement.setAttribute("data-theme-style", "macos-glass");
    await act(async () => {
      render(<MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}} />);
      await Promise.resolve();
    });

    const fullActions = screen.getByTestId("full-application-actions");
    for (const label of ["File", "Edit", "View", "Window", "Help"]) {
      expect(within(fullActions).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("includes Window and Help in compact macOS-glass actions and invokes them", async () => {
    const onMinimizeWindow = vi.fn();
    const onOpenCommandPalette = vi.fn();
    useWindowManager.getState().openWindow("Whiteboard", "apps/whiteboard", 80);
    const windowId = useWindowManager.getState().windows[0]!.id;
    document.documentElement.setAttribute("data-theme-style", "macos-glass");
    await act(async () => {
      render(
        <MenuBar
          onOpenCommandPalette={onOpenCommandPalette}
          onNewWindow={() => {}}
          onMinimizeWindow={onMinimizeWindow}
        />,
      );
      await Promise.resolve();
    });

    let menu = await openApplicationActions();
    expect(within(menu).getByText("Window")).toBeTruthy();
    expect(within(menu).getByText("Help")).toBeTruthy();
    const minimizeItems = within(menu).getAllByRole("menuitem", { name: /^Minimize/ });
    fireEvent.click(minimizeItems[minimizeItems.length - 1]!);
    expect(onMinimizeWindow).toHaveBeenCalledWith(windowId);

    menu = await openApplicationActions();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Zoom" }));
    expect(useWindowManager.getState().fullscreenWindowId).toBe(windowId);

    menu = await openApplicationActions();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Matrix OS Help/ }));
    expect(onOpenCommandPalette).toHaveBeenCalledOnce();
  });

  it("truncates long active-app names visually while preserving the full accessible name and tooltip", () => {
    const longName = "A very long active application name that must not resize the menu bar";
    useWindowManager.getState().openWindow(longName, "apps/long-name", 80);
    render(<MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}} />);

    const appButton = screen.getByRole("button", { name: longName });
    expect(appButton.getAttribute("title")).toBe(longName);
    expect(appButton.querySelector("span")?.className).toContain("truncate");
  });
});
