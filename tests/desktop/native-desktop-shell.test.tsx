// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NativeDesktopShell from "@desktop/renderer/src/features/desktop-shell/NativeDesktopShell";
import { DESKTOP_Z_INDEX, NATIVE_DESKTOP_LAYOUT } from "@desktop/renderer/src/design/layering";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";

const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

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
  useUi.setState(useUi.getInitialState(), true);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (createObjectURLDescriptor) Object.defineProperty(URL, "createObjectURL", createObjectURLDescriptor);
  else Reflect.deleteProperty(URL, "createObjectURL");
  if (revokeObjectURLDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeObjectURLDescriptor);
  else Reflect.deleteProperty(URL, "revokeObjectURL");
});

describe("native desktop shell", () => {
  it("uses a dedicated shell-background layer and presents the hosted shell as Browser", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    const browserIcon = screen.getByRole("button", { name: "Browser" });
    expect(browserIcon).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
    const browserLabel = browserIcon.querySelector<HTMLElement>("[data-desktop-icon-label]");
    expect(browserLabel?.style.color).toBe("rgb(255, 255, 255)");
    expect(browserLabel?.style.background).toContain("rgba(0, 0, 0");
    expect(browserLabel?.style.textShadow).toContain("rgba(0, 0, 0");
    const background = screen.getByTestId("desktop-background");
    expect(background.style.background).toContain("--bg-app");
    expect(background.style.zIndex).toBe(String(DESKTOP_Z_INDEX.nativeDesktopBackground));
  });

  it("loads the configured wallpaper through the authenticated API and revokes it on runtime change", async () => {
    const createObjectURL = vi.fn(() => "blob:desktop-wallpaper");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const firstApi = {
      get: vi.fn(async () => ({ background: { type: "wallpaper", name: "moraine-lake.jpg" } })),
      getBlob: vi.fn(async () => new Blob(["wallpaper"], { type: "image/jpeg" })),
    };
    useConnection.setState({ api: firstApi as never });
    render(<NativeDesktopShell overlayOpen={false} />);

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
    render(<NativeDesktopShell overlayOpen={false} />);
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

  it("opens desktop destinations as floating windows", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));

    expect(screen.getByRole("dialog", { name: "Hermes window" })).toBeTruthy();
    expect(screen.getByText("Hermes content")).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[useTabs.getState().activeTabId!]?.mode).toBe("window");
  });

  it.each([
    ["Terminal", "terminals"],
    ["Projects", "projects"],
  ] as const)("opens %s directly as a tab workspace", (label, kind) => {
    render(<NativeDesktopShell overlayOpen={false} />);

    fireEvent.doubleClick(screen.getByRole("button", { name: label }));

    expect(screen.getByRole("tab", { name: label }).getAttribute("aria-selected")).toBe("true");
    const tab = useTabs.getState().tabs.find((candidate) => candidate.kind === kind);
    expect(tab).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[tab!.id]?.mode).toBe("tab");
    expect(screen.queryByRole("dialog", { name: `${label} window` })).toBeNull();
  });

  it("opens Apps as a transient launcher instead of a desktop app surface", () => {
    render(<NativeDesktopShell overlayOpen={false} />);

    expect(screen.queryByRole("button", { name: "Apps" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open App Launcher" }));

    expect(screen.getByRole("dialog", { name: "App launcher" })).toBeTruthy();
    expect(useTabs.getState().tabs.some((tab) => tab.kind === "apps")).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Apps window" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close App Launcher" }));
    expect(screen.queryByRole("dialog", { name: "App launcher" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open App Launcher" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "App launcher" })).toBeNull();
  });

  it("dismisses the transient launcher when its empty backdrop is clicked", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Open App Launcher" }));

    fireEvent.pointerDown(screen.getByTestId("app-launcher-backdrop"));

    expect(screen.queryByRole("dialog", { name: "App launcher" })).toBeNull();
  });

  it("minimizes a window to the taskbar and restores it", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));
    const tabId = useTabs.getState().activeTabId!;

    fireEvent.click(screen.getByRole("button", { name: "Minimize Hermes" }));
    expect(screen.queryByRole("dialog", { name: "Hermes window" })).toBeNull();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("minimized");

    fireEvent.click(screen.getByRole("button", { name: "Restore Hermes" }));
    expect(screen.getByRole("dialog", { name: "Hermes window" })).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("window");
  });

  it("maximizes a window into the tab strip and restores it as a window", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));
    const tabId = useTabs.getState().activeTabId!;

    fireEvent.click(screen.getByRole("button", { name: "Maximize Files into tabs" }));
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("tab");
    const surface = document.querySelector<HTMLElement>(`[data-desktop-surface="${tabId}"]`)!;
    expect(surface.style.inset).toBe(`${NATIVE_DESKTOP_LAYOUT.tabStripHeight}px 0 ${NATIVE_DESKTOP_LAYOUT.taskbarReservedHeight}px`);

    fireEvent.doubleClick(screen.getByRole("tab", { name: "Files" }));
    expect(screen.getByRole("dialog", { name: "Files window" })).toBeTruthy();
    expect(useDesktopSurfaces.getState().surfaces[tabId]?.mode).toBe("window");
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

    fireEvent.click(screen.getByRole("button", { name: "Close Browser" }));
    expect(screen.queryByText("Browser content")).toBeNull();
    fireEvent.doubleClick(screen.getByRole("button", { name: "Browser" }));
    expect(screen.getByText("Browser content")).toBeTruthy();
  });

  it("focuses the topmost visible surface after closing an active closable tab", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Browser" }));
    fireEvent.click(screen.getByRole("button", { name: "Minimize Browser" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Files" }));
    act(() => {
      useTabs.getState().openTab({ kind: "app", slug: "notes", title: "Notes" });
    });
    const notesId = useTabs.getState().activeTabId!;

    fireEvent.click(screen.getByRole("button", { name: "Close Notes" }));

    expect(useTabs.getState().tabs.some((tab) => tab.id === notesId)).toBe(false);
    expect(useTabs.getState().tabs.find((tab) => tab.id === useTabs.getState().activeTabId)?.title).toBe("Files");
  });

  it("keeps inactive floating surfaces mounted while only the focused surface is interactive", () => {
    render(<NativeDesktopShell overlayOpen={false} />);
    fireEvent.doubleClick(screen.getByRole("button", { name: "Chat" }));
    fireEvent.doubleClick(screen.getByRole("button", { name: "Terminal" }));

    expect(screen.getByText("Hermes content")).toBeTruthy();
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
    expect(dragHandle.classList.contains("no-drag")).toBe(true);

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
