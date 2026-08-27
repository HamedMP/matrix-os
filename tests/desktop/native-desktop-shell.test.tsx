// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NativeDesktopShell from "@desktop/renderer/src/features/desktop-shell/NativeDesktopShell";
import NavigationHeader from "@desktop/renderer/src/features/mission-control/NavigationHeader";
import { DESKTOP_Z_INDEX, NATIVE_DESKTOP_LAYOUT } from "@desktop/renderer/src/design/layering";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useApps } from "@desktop/renderer/src/stores/apps";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";

const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

function mockLoadedWallpaperImage(): void {
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    queueMicrotask(() => callback(0));
    return 0;
  });
  vi.stubGlobal("Image", class {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  });
}

function getWindowControl(title: string, action: "Close" | "Minimize" | "Maximize"): HTMLElement {
  return within(screen.getByRole("dialog", { name: `${title} window` }))
    .getByRole("button", { name: action });
}

vi.mock("@desktop/renderer/src/features/mission-control/TabContent", () => ({
  TabPane: ({ tab, layoutRevision }: { tab: { title: string }; layoutRevision?: string }) => (
    <div data-layout-revision={layoutRevision}>{tab.title} content</div>
  ),
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
  useConnection.setState(useConnection.getInitialState(), true);
  useApps.setState(useApps.getInitialState(), true);
  useUi.setState(useUi.getInitialState(), true);
  useNativeDesktopMode.setState(useNativeDesktopMode.getInitialState(), true);
  useNativeDesktopMode.setState({ hydrated: true });
  window.operator = {
    invoke: vi.fn(async (channel: string) => channel === "state:get"
      ? { value: { mode: "desktop" } }
      : { ok: true }),
    on: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (createObjectURLDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectURLDescriptor);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (revokeObjectURLDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectURLDescriptor);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("native desktop shell", () => {
  it("holds mode-specific chrome until persisted desktop mode is hydrated", () => {
    useNativeDesktopMode.setState({ hydrated: false, mode: "desktop" });

    render(<NativeDesktopShell overlayOpen={false} />);

    expect(screen.getByTestId("desktop-background")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Browser" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open apps" })).toBeNull();
  });

  it("uses a dedicated shell-background layer and presents the hosted shell as Browser", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    const browserIcon = screen.getByRole("button", { name: "Browser" });
    expect(browserIcon).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    const browserLabel = browserIcon.querySelector<HTMLElement>("[data-desktop-icon-label]");
    expect(browserLabel?.style.color).toBe("rgb(255, 255, 255)");
    expect(browserLabel?.style.background).toBe("");
    expect(browserLabel?.style.textShadow).toContain("rgba(0, 0, 0");
    const browserGlow = browserIcon.querySelector<HTMLElement>("[data-desktop-app-icon-shine]");
    expect(browserGlow?.style.background).toContain("linear-gradient(180deg");
    expect(browserGlow?.style.height).toBe("50%");
    const browserAppIcon = browserIcon.querySelector<HTMLElement>("[data-desktop-app-icon]");
    expect(browserAppIcon?.style.background).toBe("var(--surface-info-emphasis, #3B85BA)");
    expect(browserAppIcon?.style.color).toBe("white");
    expect(screen.getByRole("button", { name: "Chat" })
      .querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background)
      .toBe("var(--surface-success-emphasis, #288A5B)");
    expect(screen.getByRole("button", { name: "Terminal" })
      .querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background)
      .toBe("var(--surface-warning-emphasis, #E0AA52)");
    expect(screen.getByRole("button", { name: "Files" })
      .querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background)
      .toBe("var(--surface-brand-emphasis, #748E59)");
    expect(screen.getByRole("button", { name: "Projects" })
      .querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background)
      .toBe("var(--surface-error-emphasis, #BA5236)");
    expect(screen.getByRole("button", { name: "Plugins" })
      .querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background)
      .toBe("rgb(124, 109, 180)");
    expect(screen.getByRole("button", { name: "Settings" })
      .querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background)
      .toBe("var(--surface-neutral-emphasis, #6B7280)");
    const filesDockIcon = screen.getByTestId("desktop-taskbar-files")
      .querySelector<HTMLElement>("[data-desktop-app-icon]");
    expect(filesDockIcon?.classList.contains("absolute")).toBe(true);
    expect(filesDockIcon?.classList.contains("relative")).toBe(false);
    const filesDockButton = screen.getByTestId("desktop-taskbar-files");
    expect(filesDockButton.classList.contains("bg-[var(--bg-surface)]")).toBe(false);
    expect(filesDockButton.classList.contains("border")).toBe(false);
    const background = screen.getByTestId("desktop-background");
    expect(background.style.background).toContain("--bg-app");
    expect(background.style.zIndex).toBe(String(DESKTOP_Z_INDEX.nativeDesktopBackground));
  });

  it("opens the background menu from an empty desktop right-click", async () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    fireEvent.contextMenu(screen.getByTestId("native-desktop-workspace"));

    expect(await screen.findByText("Change background…")).toBeTruthy();
  });

  it("loads the configured wallpaper through the authenticated API and revokes it on runtime change", async () => {
    mockLoadedWallpaperImage();
    const createObjectURL = vi.fn(() => "blob:desktop-wallpaper");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const firstApi = {
      get: vi.fn(async () => ({ background: { type: "wallpaper", name: "moraine-lake.jpg" } })),
      getBlob: vi.fn(async () => new Blob(["wallpaper"], { type: "image/jpeg" })),
    };
    useConnection.setState({ api: firstApi as never });
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-background").style.backgroundImage)
        .toBe('url("blob:desktop-wallpaper")');
    });
    expect(firstApi.get).toHaveBeenCalledWith("/api/settings/desktop");
    expect(firstApi.getBlob).toHaveBeenCalledWith(
      `/api/files/blob?path=${encodeURIComponent("system/wallpapers/moraine-lake.jpg")}`,
      { maxBytes: 10 * 1024 * 1024 },
    );

    act(() => {
      useConnection.setState({
        api: {
          get: vi.fn(async () => ({ background: { type: "solid", color: "#123456" } })),
        } as never,
      });
    });
    await waitFor(() => expect(screen.getByTestId("desktop-background").style.backgroundColor).toBe("rgb(18, 52, 86)"));
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:desktop-wallpaper");
  });

  it("refreshes the wallpaper when the desktop regains focus", async () => {
    mockLoadedWallpaperImage();
    const createObjectURL = vi.fn(() => "blob:first-wallpaper");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const api = {
      get: vi.fn()
        .mockResolvedValueOnce({ background: { type: "wallpaper", name: "moraine-lake.jpg" } })
        .mockResolvedValueOnce({ background: { type: "solid", color: "#123456" } }),
      getBlob: vi.fn(async () => new Blob(["wallpaper"], { type: "image/jpeg" })),
    };
    useConnection.setState({ api: api as never });
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);
    await waitFor(() => {
      expect(screen.getByTestId("desktop-background").style.backgroundImage)
        .toBe('url("blob:first-wallpaper")');
    });

    fireEvent.focus(window);

    await waitFor(() => {
      expect(screen.getByTestId("desktop-background").style.backgroundColor).toBe("rgb(18, 52, 86)");
    });
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:first-wallpaper");
  });

  it("refreshes the background after returning from the hosted Browser to Desktop", async () => {
    const api = {
      get: vi.fn()
        .mockResolvedValueOnce({ background: { type: "solid", color: "#111111" } })
        .mockResolvedValueOnce({ background: { type: "solid", color: "#223344" } }),
    };
    useConnection.setState({ api: api as never });
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);
    await waitFor(() => {
      expect(screen.getByTestId("desktop-background").style.backgroundColor).toBe("rgb(17, 17, 17)");
    });

    fireEvent.doubleClick(screen.getByRole("button", { name: "Browser" }));
    fireEvent.click(getWindowControl("Browser", "Maximize"));
    fireEvent.click(screen.getByRole("tab", { name: "Desktop" }));

    await waitFor(() => {
      expect(screen.getByTestId("desktop-background").style.backgroundColor).toBe("rgb(34, 51, 68)");
    });
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["closing", () => fireEvent.click(screen.getByRole("button", { name: "Close Browser" }))],
    ["restoring", () => fireEvent.doubleClick(screen.getByRole("tab", { name: "Browser" }))],
  ])("refreshes the background after %s the maximized Browser", (_action, leaveBrowser) => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Browser" }));
    fireEvent.click(getWindowControl("Browser", "Maximize"));
    const before = useUi.getState().desktopBackgroundRefreshRequest;

    leaveBrowser();

    expect(useUi.getState().desktopBackgroundRefreshRequest).toBe(before + 1);
  });

  it("opens desktop destinations as floating windows", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));

    expect(screen.getByRole("dialog", { name: "Chat window" })).toBeTruthy();
    expect(screen.getByText("Chat content")).toBeTruthy();
    expect(document.querySelector("[data-os-window-chrome-placement]")?.textContent).toBe("");
    expect(useDesktopSurfaces.getState().surfaces[useTabs.getState().activeTabId!]?.mode).toBe("window");
  });

  it("offers Settings as a native app and maximizes it into tabs", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    const settingsIcon = screen.getByRole("button", { name: "Settings" });
    fireEvent.doubleClick(settingsIcon);

    const settingsTab = useTabs.getState().tabs.find((candidate) => candidate.kind === "settings");
    expect(settingsTab).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[settingsTab!.id]?.mode).toBe("window");
    expect(screen.getByRole("dialog", { name: "Settings window" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Settings" })).toBeNull();

    fireEvent.click(getWindowControl("Settings", "Maximize"));

    expect(useDesktopSurfaces.getState().surfaces[settingsTab!.id]?.mode).toBe("tab");
    expect(screen.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe("true");

    fireEvent.click(screen.getByRole("tab", { name: "Desktop" }));
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("opens Terminal as its own window and only adds it to the main tab strip when maximized", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));

    const terminalTab = useTabs.getState().tabs.find((candidate) => candidate.kind === "terminals");
    expect(terminalTab).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[terminalTab!.id]?.mode).toBe("window");
    expect(screen.getByRole("dialog", { name: "Terminal window" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Desktop" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();

    fireEvent.click(getWindowControl("Terminal", "Maximize"));

    expect(useDesktopSurfaces.getState().surfaces[terminalTab!.id]?.mode).toBe("tab");
    expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("navigation", { name: "Running apps" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Desktop" }));
    expect(screen.getByRole("tab", { name: "Desktop" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Browser" })).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[terminalTab!.id]?.mode).toBe("tab");

    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));

    fireEvent.click(screen.getByRole("button", { name: "Close Terminal" }));

    expect(useDesktopSurfaces.getState().surfaces[terminalTab!.id]?.mode).toBe("closed");
    expect(screen.queryByRole("tab", { name: "Terminal" })).toBeNull();
    expect(document.querySelector("[data-native-desktop-shell]")).toBeTruthy();
  });

  it("puts minimize and close controls inside each maximized tab", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(getWindowControl("Terminal", "Maximize"));

    expect(screen.getByRole("button", { name: "Minimize Terminal tab" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close Terminal workspace" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restore Terminal as window" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Minimize Terminal tab" }));
    expect(useDesktopSurfaces.getState().surfaces[useTabs.getState().activeTabId!]?.mode)
      .toBe("minimized");
    expect(screen.getByRole("tab", { name: "Desktop" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens Projects as a floating window and only adds it to the tab strip when maximized", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Projects" }));

    const tab = useTabs.getState().tabs.find((candidate) => candidate.kind === "projects");
    expect(tab).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[tab!.id]?.mode).toBe("window");
    expect(screen.getByRole("dialog", { name: "Projects window" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Desktop" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: "Projects" })).toBeNull();

    fireEvent.click(getWindowControl("Projects", "Maximize"));

    expect(useDesktopSurfaces.getState().surfaces[tab!.id]?.mode).toBe("tab");
    expect(screen.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe("true");
  });

  it("opens Apps as a transient launcher instead of a desktop app surface", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    expect(screen.queryByRole("button", { name: "Apps" })).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Open App Launcher" }).at(-1)!);

    const launcher = screen.getByRole("dialog", { name: "App launcher" });
    expect(launcher.className).toContain("h-full");
    expect(launcher.className).toContain("w-full");
    expect(launcher.className).toContain("max-h-none");
    expect(launcher.className).toContain("max-w-none");
    expect(launcher.className).toContain("m-0");
    expect(launcher.className).toContain("border-0");
    expect(launcher.className).toContain("p-0");
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "apps")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Apps window" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close App Launcher" }));
    expect(screen.queryByRole("dialog", { name: "App launcher" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Open App Launcher" }).at(-1)!);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "App launcher" })).toBeNull();
  });

  it("retains launcher icon elements after closing so reopening does not download them again", () => {
    useConnection.setState({ platformHost: "https://runtime.example.com" });
    useApps.setState({
      apps: [{ slug: "notes", name: "Notes" }],
      loaded: true,
      loading: false,
      error: null,
    });
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    fireEvent.click(screen.getAllByRole("button", { name: "Open App Launcher" }).at(-1)!);
    const firstIcon = screen.getByRole("button", { name: "Notes" }).querySelector("img");
    expect(firstIcon).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close App Launcher" }));
    expect(screen.queryByRole("dialog", { name: "App launcher" })).toBeNull();
    expect(firstIcon?.isConnected).toBe(true);

    fireEvent.click(screen.getAllByRole("button", { name: "Open App Launcher" }).at(-1)!);
    const reopenedIcon = screen.getByRole("button", { name: "Notes" }).querySelector("img");
    expect(reopenedIcon).toBe(firstIcon);
  });

  it("keeps the fixed header sidebar tab inert beside maximized workspace tabs", () => {
    useConnection.setState({ platformHost: "https://runtime.example.com" });
    useApps.setState({
      apps: [{ slug: "notes", name: "Notes" }],
      loaded: true,
      loading: false,
      error: null,
    });
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(getWindowControl("Terminal", "Maximize"));

    fireEvent.click(screen.getByRole("tab", { name: "Sidebar" }));

    const terminalTab = useTabs.getState().tabs.find((candidate) => candidate.kind === "terminals")!;
    expect(useDesktopSurfaces.getState().surfaces[terminalTab.id]?.mode).toBe("tab");
    expect(screen.getByRole("tab", { name: "Terminal" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "App launcher" })).toBeNull();
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "app")).toBe(false);
  });

  it("opens launcher apps as windows after returning from retained tabs to the Desktop", () => {
    useConnection.setState({ platformHost: "https://runtime.example.com" });
    useApps.setState({
      apps: [{ slug: "notes", name: "Notes" }],
      loaded: true,
      loading: false,
      error: null,
    });
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));
    fireEvent.click(getWindowControl("Terminal", "Maximize"));
    fireEvent.click(screen.getByRole("tab", { name: "Desktop" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Open App Launcher" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Notes" }));

    const notesTab = useTabs.getState().tabs.find((candidate) => candidate.kind === "app")!;
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
    expect(useDesktopSurfaces.getState().surfaces[notesTab.id]?.mode).toBe("window");
  });

  it("dismisses the transient launcher when its empty backdrop is clicked", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);
    fireEvent.click(screen.getAllByRole("button", { name: "Open App Launcher" })[0]!);

    fireEvent.pointerDown(screen.getByTestId("app-launcher-backdrop"));

    expect(screen.queryByRole("dialog", { name: "App launcher" })).toBeNull();
  });

  it("minimizes a window to the taskbar and restores it", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));
    const tabId = useTabs.getState().activeTabId!;

    fireEvent.click(getWindowControl("Chat", "Minimize"));
    expect(screen.queryByRole("dialog", { name: "Chat window" })).toBeNull();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("minimized");

    fireEvent.click(screen.getByRole("button", { name: "Restore Chat" }));
    expect(screen.getByRole("dialog", { name: "Chat window" })).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("window");
  });

  it("keeps the running-apps scrollbar hidden inside the taskbar", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));

    const runningApps = screen.getByTestId("desktop-taskbar-running-apps");
    expect(runningApps.className).toContain("[scrollbar-width:none]");
    expect(runningApps.className).toContain("[&::-webkit-scrollbar]:hidden");
    expect(runningApps.className).not.toContain("pb-2");
    const chatButton = screen.getByRole("button", { name: "Focus Chat" });
    expect(chatButton.className).not.toContain("hover:-translate-y-0.5");
    expect(chatButton.querySelector("[data-desktop-app-icon]")?.className)
      .toContain("group-hover:-translate-y-0.5");
    expect(chatButton.parentElement?.className).toContain("flex-col");
    expect(chatButton.parentElement?.className).toContain("gap-0.5");
    expect(chatButton.parentElement?.querySelector("[data-taskbar-running-indicator]"))
      .toBeTruthy();
  });

  it("does not reserve an empty dock slot when no apps are running", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    const dock = screen.getByRole("navigation", { name: "Running apps" });
    expect(dock.style.borderRadius).toBe("16px");
    expect(dock.style.border).toBe("1px solid rgba(255, 255, 255, 0.15)");
    expect(dock.style.background).toBe("rgba(255, 255, 255, 0.3)");
    expect(dock.style.boxShadow).toContain("rgba(0, 0, 0, 0.05)");
    expect(dock.style.backdropFilter).toBe("blur(67.95704650878906px)");
    expect(dock.style.padding).toBe("6px 6px 0px");
    expect(dock.style.gap).toBe("6px");
    const launcher = dock.querySelector<HTMLElement>("[aria-label='Open App Launcher']");
    expect(launcher?.style.background).toBe("");
    const launcherAppIcon = launcher?.querySelector<HTMLElement>("[data-desktop-app-icon]");
    expect(launcherAppIcon?.style.background).toBe("var(--surface-inverse, #0D0C0C)");
    expect(launcherAppIcon?.style.color).toBe("rgb(250, 250, 245)");
    expect(launcherAppIcon?.className).toContain("group-hover:-translate-y-0.5");
    expect(launcher?.querySelector("[data-desktop-app-icon-shine]")).toBeTruthy();
    expect(dock.querySelector("[data-testid='desktop-taskbar-files'] [data-desktop-app-icon-shine]")).toBeTruthy();
    expect(dock.style.minWidth).toBe("");
    expect(dock.querySelector("[data-testid='desktop-taskbar-running-apps']"))
      .toBeNull();
    expect([...dock.querySelectorAll("span")].filter((element) => element.classList.contains("h-[50px]")
      && element.classList.contains("w-px"))).toHaveLength(0);
  });

  it("keeps Files pinned in the static Dock section and marks it when the surface is open", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    const dock = screen.getByRole("navigation", { name: "Running apps" });
    const filesButton = dock.querySelector<HTMLButtonElement>("[data-testid='desktop-taskbar-files']");
    expect(filesButton).toBeTruthy();
    expect(filesButton?.parentElement?.querySelector("[data-taskbar-running-indicator]")).toBeNull();
    expect(dock.querySelector("[data-testid='desktop-taskbar-running-apps']")).toBeNull();

    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));

    expect(filesButton?.parentElement?.querySelector("[data-taskbar-running-indicator]")).toBeTruthy();
    expect(dock.querySelector("[data-testid='desktop-taskbar-running-apps']")).toBeNull();

    fireEvent.click(getWindowControl("Files", "Close"));
    expect(filesButton?.parentElement?.querySelector("[data-taskbar-running-indicator]")).toBeNull();
    expect(filesButton?.isConnected).toBe(true);
  });

  it("does not reopen a closed Files surface after closing a later app", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));
    fireEvent.click(getWindowControl("Files", "Close"));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Plugins" }));
    fireEvent.click(getWindowControl("Plugins", "Close"));

    expect(screen.queryByRole("dialog", { name: "Files window" })).toBeNull();
  });

  it("focuses Dock apps instead of minimizing them, including tabbed apps from Desktop", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));
    const terminalTabId = useTabs.getState().activeTabId!;
    const dock = screen.getByRole("navigation", { name: "Running apps" });
    expect(dock.querySelector("[title='Terminal'] [data-desktop-app-icon-shine]")).toBeTruthy();
    fireEvent.click(dock.querySelector<HTMLButtonElement>("[title='Terminal']")!);
    expect(useDesktopSurfaces.getState().surfaces[terminalTabId]?.mode).toBe("window");
    expect(useTabs.getState().activeTabId).toBe(terminalTabId);

    fireEvent.click(getWindowControl("Terminal", "Maximize"));
    fireEvent.click(screen.getByRole("tab", { name: "Desktop" }));
    fireEvent.click(
      screen.getByRole("navigation", { name: "Running apps" })
        .querySelector<HTMLButtonElement>("[title='Terminal']")!,
    );

    expect(useDesktopSurfaces.getState().workspaceView).toBe("tabs");
    expect(screen.getByRole("tab", { name: "Terminal" }).getAttribute("aria-selected")).toBe("true");
  });

  it("maximizes a window into the tab strip and restores it as a window", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));
    const tabId = useTabs.getState().activeTabId!;

    fireEvent.click(getWindowControl("Files", "Maximize"));
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("tab");
    const surface = document.querySelector<HTMLElement>(`[data-desktop-surface="${tabId}"]`)!;
    expect(surface.style.inset).toBe("0px");

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("dialog", { name: "Files window" })).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("window");
  });

  it("keeps the inert sidebar tab and windowed-dock launcher while moving the profile to the top bar", () => {
    render(<><NavigationHeader nativeDesktop /><NativeDesktopShell overlayOpen={false} /></>);

    const header = screen.getByRole("banner");
    expect(header.querySelector('[aria-label="Sidebar"]')).toBeTruthy();
    const dock = screen.getByRole("navigation", { name: "Running apps" });
    expect(dock.querySelector('[aria-label="Open App Launcher"]')).toBeTruthy();
    expect(header.textContent).toContain("Account");
    expect(dock.textContent).not.toContain("Account");
    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Go forward" })).toBeNull();
  });

  it("keeps the native resize handle clear of floating Browser content", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Browser" }));

    const content = screen.getByTestId("desktop-surface-content-home");
    expect(content.style.paddingRight).toBe(`${NATIVE_DESKTOP_LAYOUT.resizeHandleSize}px`);
    expect(content.style.paddingBottom).toBe(`${NATIVE_DESKTOP_LAYOUT.resizeHandleSize}px`);
  });

  it("unmounts a closed root surface and reopens it from its desktop icon", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Browser" }));
    expect(screen.getByText("Browser content")).toBeTruthy();

    fireEvent.click(getWindowControl("Browser", "Close"));
    expect(screen.queryByText("Browser content")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Browser" }));
    expect(screen.getByText("Browser content")).toBeTruthy();
  });

  it("focuses the topmost visible surface after closing an active closable tab", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Browser" }));
    fireEvent.click(getWindowControl("Browser", "Minimize"));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));
    act(() => {
      useTabs.getState().openTab({ kind: "app", slug: "notes", title: "Notes" });
    });
    const notesId = useTabs.getState().activeTabId!;

    fireEvent.click(getWindowControl("Notes", "Close"));

    expect(useTabs.getState().tabs.some((tab) => tab.id === notesId)).toBe(false);
    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)?.title).toBe("Files");
  });

  it("keeps inactive floating surfaces mounted while only the focused surface is interactive", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));

    expect(screen.getByText("Chat content")).toBeTruthy();
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
    expect(dragHandle.classList.contains("z-20")).toBe(true);
    expect(getWindowControl("Files", "Close").style.background)
      .toBe("var(--surface-primary, #FFFEFC)");
    expect(getWindowControl("Files", "Minimize").style.background)
      .toBe("var(--surface-primary, #FFFEFC)");
    expect(getWindowControl("Files", "Maximize").style.background)
      .toBe("var(--surface-primary, #FFFEFC)");

    fireEvent.pointerDown(dragHandle, { button: 0, clientX: 400, clientY: 180 });
    fireEvent.pointerMove(window, { clientX: 480, clientY: 225 });
    fireEvent.pointerUp(window);

    expect(useDesktopSurfaces.getState().surfaces[tabId]!.bounds).toMatchObject({
      x: before.x + 80,
      y: before.y + 45,
    });
  });

  it("stops an active drag when the surface unmounts", () => {
    const view = render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));
    const tabId = useTabs.getState().activeTabId!;
    const before = useDesktopSurfaces.getState().surfaces[tabId]!.bounds;

    fireEvent.pointerDown(screen.getByTestId("desktop-window-drag-handle"), {
      button: 0,
      clientX: 400,
      clientY: 180,
      pointerId: 1,
    });
    view.unmount();
    fireEvent.pointerMove(window, { clientX: 520, clientY: 280, pointerId: 1 });

    expect(useDesktopSurfaces.getState().surfaces[tabId]!.bounds).toEqual(before);
  });
});
