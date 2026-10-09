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
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/apps")
    ? new Response(JSON.stringify(["focus", "files"].map(slug => ({ slug, name: slug === "focus" ? "Focus" : "Files", path: `/files/apps/${slug}/index.html` }))))
    : String(url).endsWith("/session")
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
async function requestOpen(frame: HTMLIFrameElement, path: string, app = "app-gallery") {
  await act(async () => { window.dispatchEvent(new MessageEvent("message", {
    source: frame.contentWindow, origin: "null",
    data: { type: "os:open-app", app, payload: { name: "Focus", path } },
  })); });
}

describe("Web Canvas app bridge launches", () => {
  it("opens a Gallery directory launch through the real AppViewer bridge at the canonical launcher path", async () => {
    const frame = await mountedGalleryFrame();
    await requestOpen(frame, "apps/focus");
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
    await requestOpen(frame, "/files/apps/focus");
    expect(useWindowManager.getState().windows).toHaveLength(2);
    expect(useWindowManager.getState().getWindow(focus.id)).toMatchObject({ minimized: false });
    expect(useWindowManager.getState().focusedWindowId).toBe(focus.id);
    expect(useCanvasTransform.getState().panX).not.toBe(0);
  });
  it("keeps the real bridge app-identity validation when launching from Canvas", async () => {
    const frame = await mountedGalleryFrame();
    await requestOpen(frame, "apps/focus", "different-app");
    expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
  });
});

describe("Web Desktop app bridge launches", () => {
  it("opens a Gallery directory launch through the real AppViewer callback at the canonical launcher path", async () => {
    const frame = await mountedGalleryFrame("desktop");
    await requestOpen(frame, "apps/focus");
    const focused = useWindowManager.getState().windows.find(win => win.path === "apps/focus/index.html");
    expect(focused).toMatchObject({ title: "Focus", minimized: false });
    expect(useWindowManager.getState().focusedWindowId).toBe(focused!.id);
    expect(useWindowManager.getState().windows).toHaveLength(2);
  });
  it("restores the canonical app window when Gallery opens its directory, preserving launcher identity", async () => {
    const focus: AppWindow = { ...galleryWindow, id: "focus", title: "Focus", path: "apps/focus/index.html", minimized: true };
    useWindowManager.setState({ windows: [galleryWindow, focus], nextZ: 3 });
    const frame = await mountedGalleryFrame("desktop");
    await requestOpen(frame, "/files/apps/focus");
    expect(useWindowManager.getState().windows).toHaveLength(2);
    expect(useWindowManager.getState().getWindow(focus.id)).toMatchObject({ minimized: false });
    expect(useWindowManager.getState().focusedWindowId).toBe(focus.id);
  });
  it.each(["__file-browser__", "__terminal__:legacy-session", "https://example.invalid/work/"])("preserves existing special launch path %s through the callback", async (path) => {
    const frame = await mountedGalleryFrame("desktop");
    await requestOpen(frame, path);
    expect(useWindowManager.getState().windows.find(win => win.path === path)).toMatchObject({ title: "Focus" });
  });
  it("keeps the real bridge app-identity validation when launching from Web Desktop", async () => {
    const frame = await mountedGalleryFrame("desktop");
    await requestOpen(frame, "apps/focus", "different-app");
    expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
  });
});

for (const surface of ["canvas", "desktop"] as const) {
  describe(`Web ${surface === "canvas" ? "Canvas" : "Desktop"} shell-owned bridge destinations`, () => {
    it.each(["__browser__", "apps/browser", "apps/browser/dist/index.html"])("opens Browser through its existing external destination for %s", async (path) => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      const frame = await mountedGalleryFrame(surface);
      await requestOpen(frame, path);
      expect(open).toHaveBeenCalledWith("https://www.google.com", "_blank", "noopener,noreferrer");
      expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
    });
    it("opens Editor as the existing Files surface with its canonical title", async () => {
      const frame = await mountedGalleryFrame(surface);
      await requestOpen(frame, "__editor__");
      const files = useWindowManager.getState().windows.find(win => win.path === "__file-browser__");
      expect(files).toMatchObject({ title: "Files", minimized: false });
      expect(useWindowManager.getState().focusedWindowId).toBe(files!.id);
      expect(useWindowManager.getState().windows.some(win => win.path === "__editor__")).toBe(false);
    });
    it("opens VS Code at its configured editor URL without creating an empty app window", async () => {
      const open = vi.spyOn(window, "open").mockImplementation(() => null);
      const frame = await mountedGalleryFrame(surface);
      await requestOpen(frame, "__vscode__");
      expect(open).toHaveBeenCalledWith(getCodeEditorUrl(), "_blank", "noopener,noreferrer");
      expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
    });
    it.each(["canvas", "desktop"] as const)("switches the remembered presentation to %s without opening a synthetic app window", async (mode) => {
      const frame = await mountedGalleryFrame(surface);
      await requestOpen(frame, OS_VIEW_DESTINATION_PATHS[mode]);
      expect(useDesktopMode.getState().mode).toBe(mode);
      expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
    });
  });
}

for (const surface of ["canvas", "desktop"] as const) {
  it.each(["apps/files", "/files/apps/files/index.html"])(`opens the installed Files app on ${surface} rather than the built-in file browser for %s`, async (path) => {
    const frame = await mountedGalleryFrame(surface);
    await requestOpen(frame, path);
    expect(useWindowManager.getState().windows.find(win => win.path === "apps/files/index.html")).toMatchObject({ minimized: false });
    expect(useWindowManager.getState().windows.some(win => win.path === "__file-browser__")).toBe(false);
  });
}


for (const surface of ["canvas", "desktop"] as const) {
  it.each(["apps/renamed-ledger", "apps/finance/renamed-ledger", "apps/My Finance/Owner Ledger"])(`launches moved owner folder %s with its manifest runtime and bridge on Web ${surface}`, async (path) => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/apps")) return new Response(JSON.stringify([{ slug: "folio", name: "Owner Ledger", path: `/files/${path}/index.html`, launchUrl: "/apps/folio/" }]));
      return String(url).endsWith("/session") ? new Response(JSON.stringify({ expiresAt: Date.now() + 60_000 }))
        : new Response('<html><head></head><body>Ledger</body></html>');
    });
    vi.stubGlobal("fetch", fetchFn);
    const frame = await mountedGalleryFrame(surface);
    await requestOpen(frame, path);
    await waitFor(() => expect(useWindowManager.getState().windows.find(win => win.path === "apps/folio/index.html")).toMatchObject({ title: "Owner Ledger" }));
    const win = useWindowManager.getState().windows.find(win => win.path === "apps/folio/index.html")!;
    render(<CanvasWindow win={win} />);
    await waitFor(() => expect(screen.getByTitle(win.path).getAttribute("srcdoc")).toContain("window.MatrixOS"));
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/api/apps/folio/session"))).toBe(true);
    expect(fetchFn.mock.calls.some(([url]) => String(url).endsWith("/apps/folio/"))).toBe(true);
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes("/files/apps/"))).toBe(false);
  });
}


it.each(["dispose", "close"])("does not launch after a pending catalog lookup outlives app %s", async (change) => {
  let finish!: (response: Response) => void;
  const fetchFn = vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith("/api/apps")) return new Promise<Response>(resolve => { finish = resolve; });
    return String(url).endsWith("/session") ? new Response(JSON.stringify({ expiresAt: Date.now() + 60_000 })) : new Response('<html><head></head><body></body></html>');
  });
  vi.stubGlobal("fetch", fetchFn);
  const frame = await mountedGalleryFrame();
  await requestOpen(frame, "apps/finance/renamed-ledger");
  if (change === "close") cleanup();
  else act(() => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, origin: "null", data: { type: "os:bridge-dispose", app: "app-gallery" } })));
  await act(async () => finish(new Response(JSON.stringify([{ slug: "folio", name: "Ledger", path: "/files/apps/finance/renamed-ledger/index.html" }]))));
  expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
});

it("keeps an unavailable moved app closed rather than launching its legacy file iframe", async () => {
  const frame = await mountedGalleryFrame();
  await requestOpen(frame, "apps/My Finance/Owner Ledger");
  expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
});


it.each(["apps/legacy/index.html", "apps/legacy.html"])("preserves catalog-backed legacy app %s without inventing a runtime identity", async (path) => {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/apps")
    ? new Response(JSON.stringify([{ name: "Legacy", path: `/files/${path}` }]))
    : String(url).endsWith("/session") ? new Response(JSON.stringify({ expiresAt: Date.now() + 60_000 })) : new Response('<html><head></head><body></body></html>')));
  const frame = await mountedGalleryFrame();
  await requestOpen(frame, path);
  expect(useWindowManager.getState().windows.find(win => win.path === path)).toMatchObject({ title: "Legacy" });
});


for (const surface of ["canvas", "desktop"] as const) {
  it(`resolves a stable Gallery identity after another owner folder move on Web ${surface}`, async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/apps")
      ? new Response(JSON.stringify([{ slug: "folio", name: "Owner Ledger", path: "/files/apps/New Folder/Latest Ledger/index.html" }]))
      : String(url).endsWith("/session") ? new Response(JSON.stringify({ expiresAt: Date.now() + 60_000 })) : new Response('<html><head></head><body></body></html>')));
    const frame = await mountedGalleryFrame(surface);
    await requestOpen(frame, "apps/folio");
    expect(useWindowManager.getState().windows.find(win => win.path === "apps/folio/index.html")).toMatchObject({ title: "Owner Ledger" });
  });
}


for (const surface of ["canvas", "desktop"] as const) {
  it(`distinguishes explicit Gallery identities from occupied old folders on Web ${surface}`, async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/apps")
      ? new Response(JSON.stringify([
        { slug: "folio", name: "Folio", path: "/files/apps/ledger/index.html" },
        { slug: "ledger", name: "Ledger", path: "/files/apps/folio/index.html" },
      ]))
      : String(url).endsWith("/session") ? new Response(JSON.stringify({ expiresAt: Date.now() + 60_000 })) : new Response('<html><head></head><body></body></html>')));
    const frame = await mountedGalleryFrame(surface);
    await requestOpen(frame, "matrix-app:folio");
    expect(useWindowManager.getState().windows.find(win => win.path === "apps/folio/index.html")).toMatchObject({ title: "Folio" });
    await requestOpen(frame, "apps/folio");
    expect(useWindowManager.getState().windows.find(win => win.path === "apps/ledger/index.html")).toMatchObject({ title: "Ledger" });
  });
  it.each(["matrix-app:missing", "matrix-app:../folio", "matrix-app:folio?x", "matrix-app:folio/other", "matrix-app://folio"])(`keeps invalid or unavailable explicit identity %s closed on Web ${surface}`, async path => {
    const frame = await mountedGalleryFrame(surface);
    await requestOpen(frame, path);
    expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
  });
  it(`rejects ambiguous explicit identities on Web ${surface}`, async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => String(url).endsWith("/api/apps")
      ? new Response(JSON.stringify([
        { slug: "folio", name: "First", path: "/files/apps/first/index.html" },
        { slug: "folio", name: "Second", path: "/files/apps/second/index.html" },
      ]))
      : String(url).endsWith("/session") ? new Response(JSON.stringify({ expiresAt: Date.now() + 60_000 })) : new Response('<html><head></head><body></body></html>')));
    const frame = await mountedGalleryFrame(surface);
    await requestOpen(frame, "matrix-app:folio");
    expect(useWindowManager.getState().windows).toEqual([galleryWindow]);
  });
}
