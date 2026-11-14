// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";
import { WebDesktopSurface } from "@/components/desktop/WebDesktopSurface";
import { DockMinimizedWindows, DockSharedAppWindows } from "@/components/desktop/DockWindowIcons";
import { WindowsTaskbar } from "@/components/taskbar/WindowsTaskbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { openSharedLauncherApp, sharedLauncherAppEntry } from "@/hooks/useSharedLauncherApps";
import { useWindowManager, type AppEntry } from "@/hooks/useWindowManager";

vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ user: { fullName: "Test User", imageUrl: undefined } }),
  useAuth: () => ({ isLoaded: true, isSignedIn: true, signOut: vi.fn() }),
  useClerk: () => ({ openUserProfile: vi.fn() }),
}));

const artwork = (scopeId: string, digest: string) => `/api/collaboration/shared-apps/${scopeId}/artwork/${digest.repeat(64)}`;

function sharedTarget(overrides: Partial<CollaborativeAppDirectoryItem> & Pick<CollaborativeAppDirectoryItem, "scopeId">): CollaborativeAppDirectoryItem {
  return {
    runtimeId: "vps:20000000-0000-4000-8000-000000000001",
    organizationId: "org_team",
    authorityGeneration: 1,
    appId: "shared-tasks-lab",
    catalogId: "30000000-0000-4000-8000-000000000001",
    readinessId: "40000000-0000-4000-8000-000000000001",
    registrationIncarnation: "a".repeat(64),
    buildId: "b".repeat(64),
    shareRevision: "1",
    owner: { actorId: "user_owner_a", displayName: "Ada" },
    ...overrides,
  };
}

// Two owners share apps with the same slug; a third shared app reuses a system app's name.
const SCOPE_A = "10000000-0000-4000-8000-00000000000a";
const SCOPE_B = "10000000-0000-4000-8000-00000000000b";
const SCOPE_CHAT = "10000000-0000-4000-8000-00000000000c";
const ADA_TASKS = sharedTarget({
  scopeId: SCOPE_A,
  presentation: { name: "Shared Tasks Lab", iconUrl: artwork(SCOPE_A, "c") },
});
const BO_TASKS = sharedTarget({
  scopeId: SCOPE_B,
  owner: { actorId: "user_owner_b", displayName: "Bo" },
  presentation: { name: "Team Tasks", iconUrl: artwork(SCOPE_B, "d") },
});
const SHARED_CHAT = sharedTarget({ scopeId: SCOPE_CHAT, appId: "chat", presentation: { name: "Chat" } });

// The recipient's own catalog: a system app and their own app with the same slug as the shared one.
const CATALOG: AppEntry[] = [
  { name: "Files", path: "__file-browser__", iconUrl: "/icons/files.png" },
  { name: "Chat", path: "__chat__", iconUrl: "/icons/chat.png" },
  { name: "Shared Tasks Lab", path: "apps/shared-tasks-lab/index.html", iconUrl: "/icons/recipient-own-tasks.svg" },
];

function RunningDesktop() {
  const windows = useWindowManager((state) => state.windows);
  const state = useWindowManager.getState();
  return <WebDesktopSurface apps={CATALOG} windows={windows} fullscreenWindowId={null} launcherOpen={false}
    onOpenApp={(path, name) => state.openWindow(name ?? path, path, 0)} onOpenLauncher={vi.fn()} onOpenSettings={vi.fn()}
    onActivateWindow={(id) => useWindowManager.getState().restoreAndFocusWindow(id)}
    onCloseWindow={(id) => useWindowManager.getState().closeWindow(id)}
    onShowDesktop={vi.fn()} onToggleFullscreen={vi.fn()} />;
}

function runningButton(name: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Running apps" })).getByRole("button", { name });
}

function artworkOf(button: HTMLElement): string | null {
  return button.querySelector("img")?.getAttribute("src") ?? null;
}

function windowFor(target: CollaborativeAppDirectoryItem) {
  return useWindowManager.getState().windows.find((windowRecord) => windowRecord.sharedAppTarget?.scopeId === target.scopeId)!;
}

beforeEach(() => {
  useWindowManager.setState({ windows: [], focusedWindowId: null, fullscreenWindowId: null, closedPaths: new Set(), closedLayouts: new Map() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("running shared app identity in the Web Desktop dock", () => {
  it("shows the owner's artwork for a shared window launched from the launcher, not a generic window glyph", () => {
    render(<RunningDesktop />);
    act(() => { openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS)); });

    const button = runningButton("Focus Shared Tasks Lab shared by Ada");
    expect(artworkOf(button)).toBe(artwork(SCOPE_A, "c"));
    // The only vector inside the button is the shared badge; no generic window glyph remains.
    expect(Array.from(button.querySelectorAll("svg")).filter((svg) => !svg.closest("[aria-label='Shared app']"))).toEqual([]);
    expect(button.parentElement?.querySelector("span[aria-hidden='true'] > span")).toBeTruthy();
    expect(within(button).getByRole("img", { name: "Shared app" })).toBeTruthy();
  });

  it("keeps the same artwork bound to the window through minimize, restore, close, and reopen", () => {
    render(<RunningDesktop />);
    act(() => { openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS)); });
    const opened = windowFor(ADA_TASKS);

    act(() => { useWindowManager.getState().minimizeWindow(opened.id); });
    const minimized = runningButton("Restore Shared Tasks Lab shared by Ada");
    expect(artworkOf(minimized)).toBe(artwork(SCOPE_A, "c"));

    fireEvent.click(minimized);
    expect(windowFor(ADA_TASKS).minimized).toBe(false);
    expect(artworkOf(runningButton("Focus Shared Tasks Lab shared by Ada"))).toBe(artwork(SCOPE_A, "c"));

    act(() => { useWindowManager.getState().closeWindow(opened.id); });
    expect(screen.queryByRole("button", { name: /Shared Tasks Lab shared by Ada/ })).toBeNull();

    act(() => { openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS)); });
    expect(artworkOf(runningButton("Focus Shared Tasks Lab shared by Ada"))).toBe(artwork(SCOPE_A, "c"));
  });

  it("never lends a same-slug app's or a same-named system app's artwork to another window", () => {
    render(<RunningDesktop />);
    act(() => {
      openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS));
      openSharedLauncherApp(sharedLauncherAppEntry(BO_TASKS));
      openSharedLauncherApp(sharedLauncherAppEntry(SHARED_CHAT));
      useWindowManager.getState().openWindow("Shared Tasks Lab", "apps/shared-tasks-lab/index.html", 0);
      useWindowManager.getState().openWindow("Chat", "__chat__", 0);
    });

    expect(artworkOf(runningButton("Focus Shared Tasks Lab shared by Ada"))).toBe(artwork(SCOPE_A, "c"));
    expect(artworkOf(runningButton("Focus Team Tasks shared by Bo"))).toBe(artwork(SCOPE_B, "d"));
    // The recipient's own app and system Chat keep their catalog artwork and carry no shared badge.
    const ownApp = runningButton("Focus Shared Tasks Lab");
    expect(artworkOf(ownApp)).toBe("/icons/recipient-own-tasks.svg");
    expect(within(ownApp).queryByRole("img", { name: "Shared app" })).toBeNull();
    expect(artworkOf(runningButton("Focus Chat"))).toBe("/icons/chat.png");
    // A shared app named "Chat" without artwork gets its own letter tile, not the system Chat icon.
    const sharedChat = runningButton("Focus Chat shared by Ada");
    expect(artworkOf(sharedChat)).toBeNull();
    expect(sharedChat.textContent).toContain("C");
  });

  it("falls back to the owner's name initial when artwork is missing or fails to load", () => {
    render(<RunningDesktop />);
    act(() => { openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS)); });
    const button = runningButton("Focus Shared Tasks Lab shared by Ada");

    fireEvent.error(button.querySelector("img")!);
    const fallback = runningButton("Focus Shared Tasks Lab shared by Ada");
    expect(fallback.querySelector("img")).toBeNull();
    expect(fallback.textContent).toContain("S");
    expect(within(fallback).getByRole("img", { name: "Shared app" })).toBeTruthy();
  });

  it("shows the window's artwork in the header previews as well", () => {
    render(<RunningDesktop />);
    act(() => { openSharedLauncherApp(sharedLauncherAppEntry(BO_TASKS)); });
    fireEvent.click(screen.getByRole("tab", { name: "Open app previews" }));
    const preview = screen.getByRole("button", { name: "Preview Team Tasks shared by Bo" });
    const images = Array.from(preview.querySelectorAll("img"), (image) => image.getAttribute("src"));
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((src) => src === artwork(SCOPE_B, "d"))).toBe(true);
  });

  it("restores the owner's own app windows from the saved layout with catalog artwork and no shared window", () => {
    // Shared windows are deliberately ephemeral: they are never written to the layout.
    act(() => {
      useWindowManager.getState().loadLayout([
        { path: "apps/shared-tasks-lab/index.html", title: "Shared Tasks Lab", x: 10, y: 10, width: 600, height: 400, state: "minimized" },
      ]);
    });
    render(<RunningDesktop />);
    expect(artworkOf(runningButton("Restore Shared Tasks Lab"))).toBe("/icons/recipient-own-tasks.svg");
    expect(screen.queryByRole("button", { name: /shared by/ })).toBeNull();
  });
});

function CanvasDock() {
  const windows = useWindowManager((state) => state.windows);
  const activate = (id: string) => useWindowManager.getState().restoreAndFocusWindow(id);
  return <TooltipProvider><aside data-dock>
    <DockSharedAppWindows windows={windows} apps={CATALOG} iconSize={44} tooltipSide="top" isHorizontal
      onActivate={activate} onClose={(id) => useWindowManager.getState().closeWindow(id)} />
    <DockMinimizedWindows windows={windows} apps={CATALOG} iconSize={44} tooltipSide="top" isHorizontal onActivate={activate} />
  </aside></TooltipProvider>;
}

function dockButton(name: string, section: "shared" | "minimized"): HTMLElement {
  const container = document.querySelector(`[data-dock-section='${section}']`) as HTMLElement;
  return within(container).getByRole("button", { name });
}

describe("running shared app identity in the Web Canvas dock", () => {
  it("adds a visible shared window with the owner's artwork and badge, then keeps it while minimized and restored", () => {
    render(<CanvasDock />);
    act(() => {
      openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS));
      openSharedLauncherApp(sharedLauncherAppEntry(BO_TASKS));
    });
    const ada = dockButton("Shared Tasks Lab shared by Ada", "shared");
    expect(artworkOf(ada)).toBe(artwork(SCOPE_A, "c"));
    expect(within(ada).getByRole("img", { name: "Shared app" })).toBeTruthy();
    expect(artworkOf(dockButton("Team Tasks shared by Bo", "shared"))).toBe(artwork(SCOPE_B, "d"));

    act(() => { useWindowManager.getState().minimizeWindow(windowFor(ADA_TASKS).id); });
    expect(within(document.querySelector("[data-dock-section='shared']") as HTMLElement)
      .queryByRole("button", { name: "Shared Tasks Lab shared by Ada" })).toBeNull();
    const minimized = dockButton("Shared Tasks Lab shared by Ada", "minimized");
    expect(artworkOf(minimized)).toBe(artwork(SCOPE_A, "c"));

    fireEvent.click(minimized);
    expect(windowFor(ADA_TASKS).minimized).toBe(false);
    expect(artworkOf(dockButton("Shared Tasks Lab shared by Ada", "shared"))).toBe(artwork(SCOPE_A, "c"));
    expect(document.querySelector("[data-dock-section='minimized']")).toBeNull();
  });

  it("keeps catalog artwork for the recipient's own minimized app with the same slug", () => {
    render(<CanvasDock />);
    act(() => {
      useWindowManager.getState().openWindow("Shared Tasks Lab", "apps/shared-tasks-lab/index.html", 0);
      openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS));
    });
    act(() => {
      for (const windowRecord of useWindowManager.getState().windows) useWindowManager.getState().minimizeWindow(windowRecord.id);
    });
    const own = dockButton("Shared Tasks Lab", "minimized");
    expect(artworkOf(own)).toBe("/icons/recipient-own-tasks.svg");
    expect(within(own).queryByRole("img", { name: "Shared app" })).toBeNull();
    expect(artworkOf(dockButton("Shared Tasks Lab shared by Ada", "minimized"))).toBe(artwork(SCOPE_A, "c"));
  });
});

describe("running shared app identity in the Windows taskbars", () => {
  it.each(["winxp", "win11"])("shows each shared window with its owner's artwork in %s", async (style) => {
    act(() => {
      openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS));
      openSharedLauncherApp(sharedLauncherAppEntry(BO_TASKS));
    });
    await act(async () => {
      render(<WindowsTaskbar themeStyle={style} apps={CATALOG} windows={useWindowManager.getState().windows}
        onOpenApp={vi.fn()} onFocusWindow={vi.fn()} onMinimizeWindow={vi.fn()} onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} />);
      await Promise.resolve();
    });
    const images = Array.from(document.querySelectorAll("img"), (image) => image.getAttribute("src"));
    expect(images).toEqual(expect.arrayContaining([artwork(SCOPE_A, "c"), artwork(SCOPE_B, "d")]));
    expect(images).not.toContain("/icons/recipient-own-tasks.svg");
  });

  it("focuses the matching shared window from its Win11 icon", async () => {
    act(() => {
      openSharedLauncherApp(sharedLauncherAppEntry(ADA_TASKS));
      openSharedLauncherApp(sharedLauncherAppEntry(BO_TASKS));
    });
    const onFocusWindow = vi.fn();
    await act(async () => {
      render(<WindowsTaskbar themeStyle="win11" apps={CATALOG} windows={useWindowManager.getState().windows}
        onOpenApp={vi.fn()} onFocusWindow={onFocusWindow} onMinimizeWindow={vi.fn()} onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} />);
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Shared Tasks Lab shared by Ada" }));
    // Bo's window is focused (opened last), so Ada's icon focuses Ada's window rather than minimizing Bo's.
    expect(onFocusWindow).toHaveBeenCalledWith(windowFor(ADA_TASKS).id);
  });
});
