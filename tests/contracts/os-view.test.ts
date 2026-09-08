import { describe, expect, it } from "vitest";
import {
  DEFAULT_OS_VIEW_DESKTOP_APP_PATHS,
  LegacyDesktopImportSchema,
  PatchOsViewStateRequestSchema,
  createDefaultOsViewDesktopIcons,
  createDefaultOsViewDocument,
  OS_VIEW_CREATE_APP_APPEARANCE,
  OS_VIEW_DESTINATION_PATHS,
  OS_VIEW_FIXED_APP_APPEARANCES,
  OS_VIEW_LABELS,
  isOsViewDestinationPath,
  canonicalOsViewCatalogPath,
  findOpenOsViewDesktopSlot,
  fitOsViewDesktopIconsToViewport,
  legacyDesktopImportFromConfig,
  mergeOsViewStatePatch,
  normalizeOsViewMode,
  osViewFixedAppAppearanceForPath,
  normalizeOsViewDesktopAppPath,
  normalizeOsViewDesktopIcons,
  otherOsViewMode,
  rebaseOsViewStatePatch,
} from "@matrix-os/contracts";

describe("shared OS-view contract", () => {
  it("normalizes current and legacy launcher records into canonical app paths", () => {
    expect(canonicalOsViewCatalogPath({ path: "/files/apps/sushi-counter/index.html" }))
      .toBe("apps/sushi-counter/index.html");
    expect(canonicalOsViewCatalogPath({ file: "sushi-counter/index.html" }))
      .toBe("apps/sushi-counter/index.html");
    expect(canonicalOsViewCatalogPath({ file: "games/2048/index.html" }))
      .toBe("apps/games/2048/index.html");
    expect(canonicalOsViewCatalogPath({ file: "calculator.html" }))
      .toBe("apps/calculator.html");
    expect(canonicalOsViewCatalogPath({ path: "/files/apps/notes/dist/index.html" }))
      .toBe("apps/notes/index.html");
    expect(canonicalOsViewCatalogPath({ path: "/files/../system/desktop.json" })).toBeNull();
    expect(canonicalOsViewCatalogPath({ file: "https://example.test/app.html" })).toBeNull();
  });

  it("places icons down usable rows before advancing columns", () => {
    const icons = [
      { path: "apps/one/index.html", x: 20, y: 20 },
      { path: "apps/two/index.html", x: 20, y: 112 },
      { path: "apps/three/index.html", x: 20, y: 204 },
    ];
    expect(findOpenOsViewDesktopSlot(icons, { width: 400, height: 300 })).toEqual({ x: 108, y: 20 });
    expect(findOpenOsViewDesktopSlot([
      { path: "apps/moved/index.html", x: 24, y: 24 },
    ], { width: 400, height: 300 })).toEqual({ x: 20, y: 204 });
    expect(findOpenOsViewDesktopSlot([
      ...icons,
      { path: "apps/four/index.html", x: 108, y: 20 },
      { path: "apps/five/index.html", x: 108, y: 112 },
      { path: "apps/six/index.html", x: 108, y: 204 },
      { path: "apps/seven/index.html", x: 196, y: 20 },
      { path: "apps/eight/index.html", x: 196, y: 112 },
      { path: "apps/nine/index.html", x: 196, y: 204 },
    ], { width: 280, height: 300 })).toBeNull();
  });

  it("derives safe viewport positions without mutating canonical coordinates", () => {
    const canonical = [
      { path: "apps/visible/index.html", x: 20, y: 20 },
      { path: "apps/offscreen/index.html", x: 20, y: 900 },
    ];
    const fitted = fitOsViewDesktopIconsToViewport(canonical, { width: 400, height: 300 });
    expect(fitted).toEqual([
      canonical[0],
      { path: "apps/offscreen/index.html", x: 20, y: 112 },
    ]);
    expect(canonical[1]).toEqual({ path: "apps/offscreen/index.html", x: 20, y: 900 });
  });

  it("preserves every icon in an overflow column when a short viewport cannot fit them all", () => {
    const canonical = Array.from({ length: 5 }, (_, index) => ({
      path: `apps/app-${index}/index.html`,
      x: 20,
      y: 20 + index * 92,
    }));

    const fitted = fitOsViewDesktopIconsToViewport(canonical, { width: 180, height: 100 });

    expect(fitted).toHaveLength(canonical.length);
    expect(new Set(fitted.map((icon) => icon.path)).size).toBe(canonical.length);
    expect(fitted.some((icon) => icon.x + 64 > 180)).toBe(true);
  });

  it("defines one canonical ten-icon Desktop layout for every renderer", () => {
    expect(DEFAULT_OS_VIEW_DESKTOP_APP_PATHS).toEqual([
      "__chat__",
      "__terminal__",
      "__file-browser__",
      "__editor__",
      "__vscode__",
      "__settings__",
      "__plugins__",
      "__browser__",
      "apps/notes/index.html",
      "apps/whiteboard/index.html",
    ]);
    expect(createDefaultOsViewDesktopIcons()).toEqual(
      DEFAULT_OS_VIEW_DESKTOP_APP_PATHS.map((path, index) => ({
        path,
        x: 20 + (index % 2) * 88,
        y: 20 + Math.floor(index / 2) * 92,
      })),
    );
    expect(createDefaultOsViewDocument().desktop.icons).toEqual(createDefaultOsViewDesktopIcons());
    expect(normalizeOsViewDesktopAppPath("__notes__")).toBe("apps/notes/index.html");
    expect(normalizeOsViewDesktopAppPath("apps/whiteboard/dist/index.html")).toBe("apps/whiteboard/index.html");
    expect(normalizeOsViewDesktopIcons([
      { path: "__notes__", x: 20, y: 20 },
      { path: "apps/notes/index.html", x: 108, y: 20 },
    ])).toEqual([{ path: "apps/notes/index.html", x: 20, y: 20 }]);
    expect(LegacyDesktopImportSchema.parse({})).toEqual({});
    expect(legacyDesktopImportFromConfig({ background: { type: "solid" } })).toEqual({});
    expect(legacyDesktopImportFromConfig({ pinnedApps: ["__chat__"] })).toEqual({ pinnedApps: ["__chat__"] });
    expect(legacyDesktopImportFromConfig({ desktopIcons: [] })).toEqual({ desktopIcons: [] });
    expect(legacyDesktopImportFromConfig({ desktopIcons: "invalid" })).toBeNull();
    expect(legacyDesktopImportFromConfig({
      pinnedApps: ["__terminal__", "__file-browser__", "__chat__"],
      legacyDesktopImport: {},
    })).toEqual({});
    expect(legacyDesktopImportFromConfig({
      pinnedApps: ["__terminal__", "__file-browser__", "__chat__"],
      legacyDesktopImport: { pinnedApps: ["__chat__"], desktopIcons: [] },
    })).toEqual({ pinnedApps: ["__chat__"], desktopIcons: [] });
  });

  it("defines the same launcher destinations for Web and Electron clients", () => {
    expect(OS_VIEW_LABELS).toEqual({ desktop: "Desktop", canvas: "Canvas" });
    expect(OS_VIEW_DESTINATION_PATHS).toEqual({
      desktop: "__os-view-desktop__",
      canvas: "__os-view-canvas__",
    });
    expect(isOsViewDestinationPath(OS_VIEW_DESTINATION_PATHS.desktop)).toBe(true);
    expect(isOsViewDestinationPath(OS_VIEW_DESTINATION_PATHS.canvas)).toBe(true);
  });

  it("keeps Desktop as the fallback and returns the reciprocal destination", () => {
    expect(normalizeOsViewMode("canvas")).toBe("canvas");
    expect(normalizeOsViewMode("desktop")).toBe("desktop");
    expect(normalizeOsViewMode("removed-mode")).toBe("desktop");
    expect(otherOsViewMode("desktop")).toBe("canvas");
    expect(otherOsViewMode("canvas")).toBe("desktop");
  });

  it("shares fixed launcher appearance across Web and Electron paths", () => {
    expect(OS_VIEW_CREATE_APP_APPEARANCE).toEqual({
      background: "var(--accent)",
      foreground: "white",
    });
    expect(osViewFixedAppAppearanceForPath("__chat__")).toBe(OS_VIEW_FIXED_APP_APPEARANCES.chat);
    expect(osViewFixedAppAppearanceForPath("__os-view-canvas__"))
      .toBe(OS_VIEW_FIXED_APP_APPEARANCES.canvas);
    expect(osViewFixedAppAppearanceForPath("__os-view-desktop__"))
      .toBe(OS_VIEW_FIXED_APP_APPEARANCES.desktop);
    expect(osViewFixedAppAppearanceForPath("apps/browser/dist/index.html"))
      .toBe(OS_VIEW_FIXED_APP_APPEARANCES.browser);
    expect(OS_VIEW_FIXED_APP_APPEARANCES.browser.iconSource).toBe("fixed");
    expect(osViewFixedAppAppearanceForPath("apps/notes/index.html"))
      .toBe(OS_VIEW_FIXED_APP_APPEARANCES.notes);
    expect(osViewFixedAppAppearanceForPath("__notes__"))
      .toBe(OS_VIEW_FIXED_APP_APPEARANCES.notes);
    expect(OS_VIEW_FIXED_APP_APPEARANCES.notes).toMatchObject({
      iconSource: "app",
      background: "var(--surface-purple-emphasis, #8B6BB1)",
    });
    expect(osViewFixedAppAppearanceForPath("apps/custom/index.html")).toBeUndefined();
  });

  it("keeps Desktop and Canvas presentation geometry in separate namespaces", () => {
    const initial = createDefaultOsViewDocument();
    const next = mergeOsViewStatePatch(initial, {
      apps: [{ path: "__chat__", title: "Chat", state: "open" }],
      desktop: { windows: [{ path: "__chat__", x: 40, y: 60, width: 800, height: 600 }] },
      canvas: {
        windows: [{ path: "__chat__", x: -900, y: 240, width: 720, height: 540 }],
        transform: { panX: 120, panY: -80, zoom: 0.75 },
      },
    });

    expect(next.desktop.windows[0]?.x).toBe(40);
    expect(next.canvas.windows[0]?.x).toBe(-900);
    expect(next.canvas.transform).toEqual({ panX: 120, panY: -80, zoom: 0.75 });
  });

  it("requires bounded revisioned mutations", () => {
    expect(PatchOsViewStateRequestSchema.safeParse({
      baseRevision: 1,
      mutationId: `osvm_${"a".repeat(32)}`,
      patch: { desktop: { icons: [{ path: "__chat__", x: 20, y: 20 }] } },
    }).success).toBe(true);
    expect(PatchOsViewStateRequestSchema.safeParse({
      baseRevision: 0,
      mutationId: "retry-me",
      patch: {},
    }).success).toBe(false);
  });

  it("preserves validated terminal layout identity in window geometry", () => {
    const request = PatchOsViewStateRequestSchema.parse({
      baseRevision: 1,
      mutationId: `osvm_${"a".repeat(32)}`,
      patch: {
        desktop: {
          windows: [{
            path: "__terminal__",
            x: 20,
            y: 30,
            width: 900,
            height: 640,
            terminalLayoutId: "term-layout_0123456789abcdef0123456789abcdef",
          }],
        },
      },
    });

    expect(request.patch.desktop?.windows?.[0]?.terminalLayoutId)
      .toBe("term-layout_0123456789abcdef0123456789abcdef");
    expect(PatchOsViewStateRequestSchema.safeParse({
      baseRevision: 1,
      mutationId: `osvm_${"b".repeat(32)}`,
      patch: {
        desktop: {
          windows: [{
            path: "__terminal__",
            x: 20,
            y: 30,
            width: 900,
            height: 640,
            terminalLayoutId: "unsafe-layout-id",
          }],
        },
      },
    }).success).toBe(false);
  });

  it("rebases stale collection snapshots without losing concurrent entity or field edits", () => {
    const base = mergeOsViewStatePatch(createDefaultOsViewDocument(), {
      apps: [{ path: "__chat__", title: "Chat", state: "open" }],
      pinnedApps: ["__chat__"],
      desktop: {
        windows: [{ path: "__chat__", x: 20, y: 30, width: 800, height: 600 }],
      },
    });
    const latest = mergeOsViewStatePatch(base, {
      apps: [
        { path: "__chat__", title: "Chat", state: "open" },
        { path: "__terminal__", title: "Terminal", state: "open" },
      ],
      pinnedApps: ["__chat__", "__terminal__"],
      desktop: {
        windows: [
          { path: "__chat__", x: 140, y: 30, width: 800, height: 600 },
          { path: "__terminal__", x: 80, y: 90, width: 900, height: 640 },
        ],
      },
    });

    expect(rebaseOsViewStatePatch(base, latest, {
      apps: [
        { path: "__chat__", title: "Chat", state: "minimized" },
        { path: "__file-browser__", title: "Files", state: "open" },
      ],
      pinnedApps: ["__chat__", "__file-browser__"],
      desktop: {
        windows: [
          { path: "__chat__", x: 20, y: 220, width: 800, height: 600 },
          { path: "__file-browser__", x: 60, y: 70, width: 880, height: 620 },
        ],
      },
    })).toEqual({
      apps: [
        { path: "__chat__", title: "Chat", state: "minimized" },
        { path: "__terminal__", title: "Terminal", state: "open" },
        { path: "__file-browser__", title: "Files", state: "open" },
      ],
      pinnedApps: ["__chat__", "__terminal__", "__file-browser__"],
      desktop: {
        windows: [
          { path: "__chat__", x: 140, y: 220, width: 800, height: 600 },
          { path: "__terminal__", x: 80, y: 90, width: 900, height: 640 },
          { path: "__file-browser__", x: 60, y: 70, width: 880, height: 620 },
        ],
      },
    });
  });
});
