// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasWindow } from "../../shell/src/components/canvas/CanvasWindow";
import { DesktopWindow } from "../../shell/src/components/desktop/DesktopWindow";
import { resetWindowManagerLayoutPersistenceForTests, useWindowManager, type AppWindow } from "../../shell/src/hooks/useWindowManager";
import { resetCanvasTransformAnimation, useCanvasTransform } from "../../shell/src/hooks/useCanvasTransform";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode";
import { getCodeEditorUrl } from "../../shell/src/lib/feature-flags";
import { OS_VIEW_DESTINATION_PATHS } from "@matrix-os/contracts";

const socket = vi.hoisted(() => ({ send: vi.fn(), subscribe: vi.fn(() => () => undefined) }));
vi.mock("../../shell/src/hooks/useSocket", () => ({ useSocket: () => socket }));
vi.mock("../../shell/src/components/file-browser/FileResourceSharing", () => ({ FileResourceSharing: () => null }));
vi.mock("../../shell/src/components/terminal/TerminalApp", () => ({ TerminalApp: () => null }));
vi.mock("../../shell/src/components/file-browser/FileBrowser", () => ({ FileBrowser: () => null }));
vi.mock("../../shell/src/components/preview-window/PreviewWindow", () => ({ PreviewWindow: () => null }));
vi.mock("../../shell/src/components/ChatApp", () => ({ ChatApp: () => null }));
vi.mock("../../shell/src/lib/posthog-client", () => ({ capturePostHogEvent: vi.fn() }));

const galleryWindow: AppWindow = {
  id: "gallery", title: "App Gallery", path: "apps/app-gallery", x: 20, y: 30,
  width: 800, height: 600, minimized: false, zIndex: 1,
};
beforeEach(() => {
  resetWindowManagerLayoutPersistenceForTests();
  resetCanvasTransformAnimation();
  useDesktopMode.setState({ mode: "canvas" });
  useCanvasTransform.setState({ zoom: 1, panX: 0, panY: 0, isAnimating: false, isScrolling: false, containerRect: { left: 0, top: 0, width: 1200, height: 800 } });
  useWindowManager.setState({ windows: [galleryWindow], nextZ: 2, closedPaths: new Set(), closedLayouts: new Map(), focusedWindowId: galleryWindow.id, fullscreenWindowId: null, appLaunchTimes: {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/session")
    ? new Response(JSON.stringify({ expiresAt: Date.now() + 60_000 }), { headers: { "Content-Type": "application/json" } })
    : new Response('<!doctype html><html><head><title>App Gallery</title></head><body></body></html>')));
});
afterEach(() => {
  cleanup();
  resetWindowManagerLayoutPersistenceForTests();
  resetCanvasTransformAnimation();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountedGalleryFrame(surface: "canvas" | "desktop" = "canvas"): Promise<HTMLIFrameElement> {
  if (surface === "canvas") {
    render(<CanvasWindow win={galleryWindow} />);
  } else {
    useDesktopMode.setState({ mode: "desktop" });
    const noop = () => undefined;
    render(<DesktopWindow win={galleryWindow} dockPosition="bottom" fullscreenWindowId={null}
      interacting={false} minimizingIds={new Set()} onAnimateMinimize={noop} onCloseWindow={noop}
      onDragEnd={noop} onDragMove={noop} onDragStart={noop} onFocusWindow={noop}
      onOpenWindow={(name, path) => useWindowManager.getState().openWindow(name, path, 0)}
      onResizeInteractionChange={noop} onToggleFullscreen={noop} topInset={38} />);
  }
  const frame = screen.getByTitle(galleryWindow.path) as HTMLIFrameElement;
  await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("window.MatrixOS"));
  return frame;
}
function requestOpen(frame: HTMLIFrameElement, path: string, app = "app-gallery") {
  act(() => window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow, origin: "null",
    data: { type: "os:open-app", app, payload: { name: "Focus", path } },
  })));
}

describe("Web Canvas app bridge launches", () => {
  it("opens a Gallery directory launch through the real AppViewer bridge at the canonical launcher path", async () => {
    const frame = await mountedGalleryFrame();
    requestOpen(frame, "apps/focus");
    const focused = useWindowManager.getState().windows.find(win => win.path === "apps/focus/index.html");
    expect(focused).toMatchObject({ title: "Focus", minimized: false });
    expect(useWindowManager.getState().focusedWindowId).toBe(focused!.id);
    expect(useWindowManager.getState().windows).toHaveLength(2);
    expect(useCanvasTransform.getState().panX).not.toBe(0);
  });
  it("restores and focuses the already-open canonical app window instead of opening a duplicate directory window", async () => {
    const focus: AppWindow = { ...galleryWindow, id: "focus", title: "Focus", path: "apps/focus/index.html", x: 1000, minimized: true };
    useWindowManager.setState({ windows: [galleryWindow, focus], nextZ: 3 });
    const frame = await mountedGalleryFrame();
    requestOpen(frame, "/files/apps/focus");
    expect(useWindowManager.getState().windows).toHaveLength(2);
    expect(useWindowManager.getState().getWindow(focus.id)).toMatchObject({ minimized: false });
    expect(useWindowManager.getState().focusedWindowId).toBe(focus.id);
    expect(useCanvasTransform.getState().panX).not.toBe(0);
  });
  it("keeps the real bridge app-identity validation when launching from Canvas", async () => {
    const frame = await mountedGalleryFrame();
    requestOpen(frame, "apps/focus", "different-app");
    expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
  });
});

describe("Web Desktop app bridge launches", () => {
  it("opens a Gallery directory launch through the real AppViewer callback at the canonical launcher path", async () => {
    const frame = await mountedGalleryFrame("desktop");
    requestOpen(frame, "apps/focus");
    const focused = useWindowManager.getState().windows.find(win => win.path === "apps/focus/index.html");
    expect(focused).toMatchObject({ title: "Focus", minimized: false });
    expect(useWindowManager.getState().focusedWindowId).toBe(focused!.id);
    expect(useWindowManager.getState().windows).toHaveLength(2);
  });
  it("restores the canonical app window when Gallery opens its directory, preserving launcher identity", async () => {
    const focus: AppWindow = { ...galleryWindow, id: "focus", title: "Focus", path: "apps/focus/index.html", minimized: true };
    useWindowManager.setState({ windows: [galleryWindow, focus], nextZ: 3 });
    const frame = await mountedGalleryFrame("desktop");
    requestOpen(frame, "/files/apps/focus");
    expect(useWindowManager.getState().windows).toHaveLength(2);
    expect(useWindowManager.getState().getWindow(focus.id)).toMatchObject({ minimized: false });
    expect(useWindowManager.getState().focusedWindowId).toBe(focus.id);
  });
  it.each(["__file-browser__", "__terminal__:legacy-session", "https://example.invalid/work/"])("preserves existing special launch path %s through the callback", async (path) => {
    const frame = await mountedGalleryFrame("desktop");
    requestOpen(frame, path);
    expect(useWindowManager.getState().windows.find(win => win.path === path)).toMatchObject({ title: "Focus" });
  });
  it("keeps the real bridge app-identity validation when launching from Web Desktop", async () => {
    const frame = await mountedGalleryFrame("desktop");
    requestOpen(frame, "apps/focus", "different-app");
    expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
  });
});

for (const surface of ["canvas", "desktop"] as const) {
  describe(`Web ${surface === "canvas" ? "Canvas" : "Desktop"} shell-owned bridge destinations`, () => {
    it.each(["__browser__", "apps/browser", "apps/browser/dist/index.html"])("opens Browser through its existing external destination for %s", async (path) => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      const frame = await mountedGalleryFrame(surface);
      requestOpen(frame, path);
      expect(open).toHaveBeenCalledWith("https://www.google.com", "_blank", "noopener,noreferrer");
      expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
    });
    it("opens Editor as the existing Files surface with its canonical title", async () => {
      const frame = await mountedGalleryFrame(surface);
      requestOpen(frame, "__editor__");
      const files = useWindowManager.getState().windows.find(win => win.path === "__file-browser__");
      expect(files).toMatchObject({ title: "Files", minimized: false });
      expect(useWindowManager.getState().focusedWindowId).toBe(files!.id);
      expect(useWindowManager.getState().windows.some(win => win.path === "__editor__")).toBe(false);
    });
    it("opens VS Code at its configured editor URL without creating an empty app window", async () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      const frame = await mountedGalleryFrame(surface);
      requestOpen(frame, "__vscode__");
      expect(open).toHaveBeenCalledWith(getCodeEditorUrl(), "_blank", "noopener,noreferrer");
      expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
    });
    it.each(["canvas", "desktop"] as const)("switches the remembered presentation to %s without opening a synthetic app window", async (mode) => {
      const frame = await mountedGalleryFrame(surface);
      requestOpen(frame, OS_VIEW_DESTINATION_PATHS[mode]);
      expect(useDesktopMode.getState().mode).toBe(mode);
      expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
    });
  });
}

for (const surface of ["canvas", "desktop"] as const) {
  it.each(["apps/files", "/files/apps/files/index.html"])(`opens the installed Files app on ${surface} rather than the built-in file browser for %s`, async (path) => {
    const frame = await mountedGalleryFrame(surface);
    requestOpen(frame, path);
    expect(useWindowManager.getState().windows.find(win => win.path === "apps/files/index.html")).toMatchObject({ minimized: false });
    expect(useWindowManager.getState().windows.some(win => win.path === "__file-browser__")).toBe(false);
  });
}
