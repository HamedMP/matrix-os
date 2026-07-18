// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEntry, AppWindow } from "../../shell/src/hooks/useWindowManager.js";
import { DEFAULT_THEME } from "../../shell/src/hooks/useTheme.js";
import { saveShellSnapshot } from "../../shell/src/lib/shell-snapshot-cache.js";
import { WindowsTaskbar } from "../../shell/src/components/taskbar/WindowsTaskbar.js";
import { MenuBar } from "../../shell/src/components/MenuBar.js";
import { OsBootScreen } from "../../shell/src/components/os-session/OsBootScreen.js";
import { OsSessionHost } from "../../shell/src/components/os-session/OsSessionHost.js";
import {
  resetOsSession,
  useOsSessionStore,
} from "../../shell/src/components/os-session/os-session-store.js";
import {
  BOOT_BEAT_MS,
  isBootDesign,
  readPersistedThemeStyle,
} from "../../shell/src/components/os-session/os-session-utils.js";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
  useUser: () => ({
    user: {
      fullName: "Test User",
      username: "test-user",
      imageUrl: undefined,
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

const defaultApps: AppEntry[] = [
  { name: "Notes", path: "apps/notes/index.html", iconUrl: "/icons/notes.png" },
  { name: "Chess", path: "apps/games/chess/index.html", iconUrl: "/icons/chess.png" },
];

function setDesign(style: string) {
  document.documentElement.setAttribute("data-theme-style", style);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const taskbarHandlers = () => ({
  onOpenApp: vi.fn(),
  onFocusWindow: vi.fn(),
  onMinimizeWindow: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenCommandPalette: vi.fn(),
});

async function renderWindowsShell(style: "winxp" | "win11", windows: AppWindow[] = []) {
  setDesign(style);
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <>
        <WindowsTaskbar apps={defaultApps} windows={windows} {...taskbarHandlers()} />
        <OsSessionHost />
      </>,
    );
    await Promise.resolve();
  });
  return result;
}

describe("OsBootScreen", () => {
  it("renders the XP boot screen with the flag wordmark and sliding blocks", () => {
    const { container } = render(<OsBootScreen design="winxp" />);
    expect(screen.getByRole("status", { name: "Windows XP boot screen" })).toBeTruthy();
    expect(container.querySelector("[data-os-boot='winxp']")).toBeTruthy();
    expect(container.querySelector("[data-xp-boot-blocks]")).toBeTruthy();
    expect(screen.getByText("Windows")).toBeTruthy();
    expect(screen.getByText("XP")).toBeTruthy();
  });

  it("renders the macOS boot screen with the Apple logo and a progress bar", () => {
    const { container } = render(<OsBootScreen design="macos-glass" />);
    expect(screen.getByRole("status", { name: "macOS boot screen" })).toBeTruthy();
    expect(container.querySelector("[data-os-boot='macos-glass']")).toBeTruthy();
    expect(container.querySelector("[data-macos-boot-bar]")).toBeTruthy();
  });

  it("renders the Win11 boot screen with the logo and a spinning-dots ring", () => {
    const { container } = render(<OsBootScreen design="win11" />);
    expect(screen.getByRole("status", { name: "Windows 11 boot screen" })).toBeTruthy();
    expect(container.querySelector("[data-os-boot='win11']")).toBeTruthy();
    expect(container.querySelector("[data-win11-boot-spinner]")).toBeTruthy();
  });

  it("renders nothing for the flat and neumorphic designs", () => {
    for (const design of ["flat", "neumorphic"]) {
      const { container, unmount } = render(<OsBootScreen design={design} />);
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });
});

describe("design-switch boot beat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("shows the new design's boot screen briefly on a data-theme-style switch, then auto-dismisses", async () => {
    setDesign("winxp");
    render(<OsSessionHost />);
    await flush();
    // Baseline: the design already applied at mount is not a "switch".
    expect(screen.queryByRole("status", { name: /boot screen/ })).toBeNull();

    act(() => setDesign("win11"));
    await flush();
    expect(screen.getByRole("status", { name: "Windows 11 boot screen" })).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(BOOT_BEAT_MS);
    });
    expect(screen.queryByRole("status", { name: /boot screen/ })).toBeNull();
  });

  it("does not boot-beat when switching to flat or neumorphic, and beats again on the next OS design", async () => {
    setDesign("win11");
    render(<OsSessionHost />);
    await flush();

    act(() => setDesign("flat"));
    await flush();
    expect(screen.queryByRole("status", { name: /boot screen/ })).toBeNull();

    act(() => setDesign("neumorphic"));
    await flush();
    expect(screen.queryByRole("status", { name: /boot screen/ })).toBeNull();

    act(() => setDesign("macos-glass"));
    await flush();
    expect(screen.getByRole("status", { name: "macOS boot screen" })).toBeTruthy();
  });

  it("locks body scroll while the boot screen is up and restores it after", async () => {
    setDesign("winxp");
    render(<OsSessionHost />);
    await flush();
    expect(document.body.style.overflow).toBe("");

    act(() => setDesign("winxp") /* same value: no beat */);
    await flush();
    expect(document.body.style.overflow).toBe("");

    act(() => setDesign("win11"));
    await flush();
    expect(document.body.style.overflow).toBe("hidden");

    act(() => {
      vi.advanceTimersByTime(BOOT_BEAT_MS);
    });
    expect(document.body.style.overflow).toBe("");
  });
});

describe("os-session utils", () => {
  it("isBootDesign only accepts the three OS designs", () => {
    expect(isBootDesign("winxp")).toBe(true);
    expect(isBootDesign("win11")).toBe(true);
    expect(isBootDesign("macos-glass")).toBe(true);
    expect(isBootDesign("flat")).toBe(false);
    expect(isBootDesign("neumorphic")).toBe(false);
    expect(isBootDesign(null)).toBe(false);
    expect(isBootDesign(undefined)).toBe(false);
  });

  it("readPersistedThemeStyle reads the cached design before first paint", () => {
    const scope = { userId: "u1", runtimeScope: "test", storageKey: "matrix:test:os-session-style" };
    window.localStorage.removeItem(scope.storageKey);
    expect(readPersistedThemeStyle(scope)).toBeNull();
    expect(readPersistedThemeStyle(null)).toBeNull();

    saveShellSnapshot(scope, { theme: { ...DEFAULT_THEME, style: "winxp" } });
    expect(readPersistedThemeStyle(scope)).toBe("winxp");
    window.localStorage.removeItem(scope.storageKey);
  });
});

describe("Windows XP session flows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("Log Off opens the Log Off Windows dialog; Log Off shows the Welcome screen; the user tile returns to the desktop", async () => {
    const { container } = await renderWindowsShell("winxp");

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Log Off" }));

    // Start menu closed, the classic dialog is up.
    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Log Off Windows" });
    expect(within(dialog).getByRole("button", { name: "Switch User" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Log Off" }));

    // Welcome screen: wordmark, caption, one tile per user.
    expect(screen.getByText("To begin, click your user name")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Windows XP Welcome screen" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Test User" }));
    expect(screen.queryByText("To begin, click your user name")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Switch User also leads to the Welcome screen, and Escape returns from it", async () => {
    await renderWindowsShell("winxp");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Log Off" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch User" }));
    expect(screen.getByText("To begin, click your user name")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("To begin, click your user name")).toBeNull();
  });

  it("Cancel and Escape dismiss the Log Off dialog back to the desktop", async () => {
    await renderWindowsShell("winxp");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Log Off" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Log Off Windows" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Log Off" }));
    expect(screen.getByRole("dialog", { name: "Log Off Windows" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Log Off Windows" })).toBeNull();
  });

  it("Turn Off Computer opens the shutdown dialog; Turn Off fades to the safe-off screen that wakes on click", async () => {
    const { container } = await renderWindowsShell("winxp");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn Off Computer" }));

    expect(container.querySelector("[data-xp-start-menu]")).toBeNull();
    const dialog = screen.getByRole("dialog", { name: "Turn off computer" });
    expect(within(dialog).getByRole("button", { name: "Stand By" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Restart" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Turn Off" }));
    const safeOff = screen.getByRole("button", { name: /safe to turn off your computer/i });
    expect(safeOff).toBeTruthy();

    fireEvent.click(safeOff);
    expect(screen.queryByRole("button", { name: /safe to turn off/i })).toBeNull();
  });

  it("Restart and Stand By replay the XP boot screen, then return to the desktop", async () => {
    await renderWindowsShell("winxp");
    for (const label of ["Restart", "Stand By"]) {
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      fireEvent.click(screen.getByRole("button", { name: "Turn Off Computer" }));
      fireEvent.click(screen.getByRole("button", { name: label }));

      expect(screen.getByRole("status", { name: "Windows XP boot screen" })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(BOOT_BEAT_MS);
      });
      expect(screen.queryByRole("status", { name: /boot screen/ })).toBeNull();
      expect(useOsSessionStore.getState().view).toBe("none");
    }
  });
});

describe("Windows 11 session flows", () => {
  it("the Power flyout offers Lock and Sign out; Lock shows the lock screen; keypress then the user tile returns", async () => {
    const { container } = await renderWindowsShell("win11");

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Power" }));
    const flyout = screen.getByRole("menu", { name: "Power options" });
    expect(within(flyout).getByRole("menuitem", { name: "Lock" })).toBeTruthy();
    expect(within(flyout).getByRole("menuitem", { name: "Sign out" })).toBeTruthy();

    fireEvent.click(within(flyout).getByRole("menuitem", { name: "Lock" }));
    expect(container.querySelector("[data-win11-start-menu]")).toBeNull();

    // Lock screen: blurred clock + date, dismiss hint.
    const lock = screen.getByRole("dialog", { name: "Windows 11 lock screen" });
    expect(within(lock).getByText(/press any key to sign in/i)).toBeTruthy();
    expect(within(lock).getByText(/\d{1,2}:\d{2}/)).toBeTruthy();

    // Any key raises the sign-in pane; the tile returns to the desktop.
    fireEvent.keyDown(document, { key: "Enter" });
    const tile = screen.getByRole("button", { name: "Test User" });
    fireEvent.click(tile);
    expect(screen.queryByRole("dialog", { name: "Windows 11 lock screen" })).toBeNull();
  });

  it("Sign out also lands on the lock screen, and a click raises the sign-in pane", async () => {
    await renderWindowsShell("win11");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Power" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));

    expect(screen.getByRole("dialog", { name: "Windows 11 lock screen" })).toBeTruthy();
    fireEvent.click(screen.getByRole("dialog", { name: "Windows 11 lock screen" }));
    expect(screen.getByRole("button", { name: "Test User" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test User" }));
    expect(screen.queryByRole("dialog", { name: "Windows 11 lock screen" })).toBeNull();
  });

  it("locks body scroll while the lock screen is up", async () => {
    await renderWindowsShell("win11");
    expect(document.body.style.overflow).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(screen.getByRole("button", { name: "Power" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Lock" }));
    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Test User" }));
    expect(document.body.style.overflow).toBe("");
  });
});

describe("macOS session flows", () => {
  async function renderMacShell() {
    setDesign("macos-glass");
    await act(async () => {
      render(
        <>
          <MenuBar onOpenCommandPalette={() => {}} onNewWindow={() => {}} onOpenSettings={() => {}} />
          <OsSessionHost />
        </>,
      );
      await Promise.resolve();
    });
  }

  it("the Apple menu lists Lock Screen and Log Out…, and Lock Screen opens the macOS lock screen; Enter returns", async () => {
    await renderMacShell();

    fireEvent.click(screen.getByRole("button", { name: "Apple menu" }));
    expect(screen.getByRole("button", { name: "Lock Screen" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Log Out/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Lock Screen" }));
    const lock = screen.getByRole("dialog", { name: "macOS lock screen" });
    expect(lock).toBeTruthy();
    expect(within(lock).getByText("Test User")).toBeTruthy();

    const password = screen.getByLabelText("Password");
    fireEvent.change(password, { target: { value: "anything" } });
    fireEvent.keyDown(password, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "macOS lock screen" })).toBeNull();
  });

  it("Log Out… opens the same lock screen", async () => {
    await renderMacShell();
    fireEvent.click(screen.getByRole("button", { name: "Apple menu" }));
    fireEvent.click(screen.getByRole("button", { name: /Log Out/ }));
    expect(screen.getByRole("dialog", { name: "macOS lock screen" })).toBeTruthy();
    // The simulation never calls a real sign-out.
    expect(useOsSessionStore.getState().view).toBe("macos-lock");
  });
});

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme-style");
  document.body.style.overflow = "";
  resetOsSession();
});

afterEach(() => {
  vi.useRealTimers();
});
