import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerDesktopShellEffects,
  toggleActiveAppFullSize,
} from "@desktop/renderer/src/features/desktop-shell/app-switching";
import {
  moveAppWindow,
  restoreActiveAppSize,
  tileActiveApp,
  tileBounds,
} from "@desktop/renderer/src/features/desktop-shell/window-tiling";
import { runShortcutAction } from "@desktop/renderer/src/features/mission-control/shortcuts";
import {
  isDesktopSurfaceVisible,
  useDesktopSurfaces,
  type DesktopSurfaceBounds,
} from "@desktop/renderer/src/stores/desktop-surfaces";
import { useNativeDesktopMode } from "@desktop/renderer/src/stores/native-desktop-mode";
import { useTabs } from "@desktop/renderer/src/stores/tabs";

const VIEWPORT = { width: 1280, height: 800 };
const LEFT = { x: 0, y: 0, width: 640, height: 800 };
const RIGHT = { x: 640, y: 0, width: 640, height: 800 };
const TOP = { x: 0, y: 0, width: 1280, height: 400 };
const BOTTOM = { x: 0, y: 400, width: 1280, height: 400 };

let unregister: (() => void) | null = null;
const schedulePersist = vi.fn();
const applyWindowBounds = vi.fn((tabId: string, bounds: DesktopSurfaceBounds) => {
  // What the mounted shell does at the end of a drag.
  useDesktopSurfaces.getState().setSurfaceBounds(tabId, bounds, VIEWPORT);
  schedulePersist();
});

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
  useNativeDesktopMode.setState({ mode: "desktop" });
  schedulePersist.mockClear();
  applyWindowBounds.mockClear();
  unregister = registerDesktopShellEffects({
    schedulePersist,
    openRoot: (open) => open(),
    viewport: () => VIEWPORT,
    applyWindowBounds,
  });
});

afterEach(() => {
  unregister?.();
  unregister = null;
});

/** Notes and Terminal open as windows; Notes selected. */
function twoApps() {
  const notes = useTabs.getState().openTab({ kind: "notes", title: "Notes" });
  const terminal = useTabs.getState().openTab({ kind: "terminals", title: "Terminal" });
  useDesktopSurfaces.getState().reconcileTabs([notes, terminal], VIEWPORT);
  useTabs.getState().focusTab(notes);
  useDesktopSurfaces.getState().activateSurface(notes);
  return { notes, terminal, original: { ...useDesktopSurfaces.getState().surfaces[notes]!.bounds } };
}

const surface = (id: string) => useDesktopSurfaces.getState().surfaces[id]!;

describe("tileBounds", () => {
  it("splits the shell's desktop viewport into halves that cover it exactly", () => {
    expect(tileBounds("left", VIEWPORT)).toEqual(LEFT);
    expect(tileBounds("right", VIEWPORT)).toEqual(RIGHT);
    expect(tileBounds("top", VIEWPORT)).toEqual(TOP);
    expect(tileBounds("bottom", VIEWPORT)).toEqual(BOTTOM);
    const odd = { width: 1001, height: 701 };
    expect(tileBounds("left", odd).width + tileBounds("right", odd).width).toBe(1001);
    expect(tileBounds("top", odd).height + tileBounds("bottom", odd).height).toBe(701);
  });
});

describe("tileActiveApp", () => {
  it("moves the selected app to each half through the drag persistence path", () => {
    const { notes, terminal } = twoApps();
    const terminalBounds = surface(terminal).bounds;

    for (const [side, expected] of [["left", LEFT], ["right", RIGHT], ["top", TOP], ["bottom", BOTTOM]] as const) {
      applyWindowBounds.mockClear();
      tileActiveApp(side);
      expect(applyWindowBounds, side).toHaveBeenCalledWith(notes, expected);
      expect(surface(notes).bounds, side).toEqual(expected);
      expect(surface(notes).mode).toBe("window");
    }
    expect(useTabs.getState().activeTabId).toBe(notes);
    expect(surface(terminal).bounds).toEqual(terminalBounds);
    expect(schedulePersist).toHaveBeenCalled();
  });

  it("returns to the original floating bounds after tiling more than once", () => {
    const { notes, original } = twoApps();

    tileActiveApp("left");
    tileActiveApp("right");
    tileActiveApp("bottom");
    restoreActiveAppSize();

    expect(surface(notes).bounds).toEqual(original);
    expect(useDesktopSurfaces.getState().tileRestoreBounds).not.toHaveProperty(notes);
  });

  it("makes a full-size app a floating window, then tiles it", () => {
    const { notes, original } = twoApps();
    toggleActiveAppFullSize();
    expect(surface(notes).mode).toBe("tab");

    tileActiveApp("left");
    expect(surface(notes)).toMatchObject({ mode: "window", restoreMode: "window", bounds: LEFT });
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
    expect(isDesktopSurfaceVisible(notes, useDesktopSurfaces.getState())).toBe(true);

    restoreActiveAppSize();
    expect(surface(notes).bounds).toEqual(original);
  });

  it("brings back a selected minimized app as a tiled window", () => {
    const { notes } = twoApps();
    useDesktopSurfaces.getState().minimizeSurface(notes);
    expect(useTabs.getState().activeTabId).toBe(notes);

    tileActiveApp("right");
    expect(surface(notes)).toMatchObject({ mode: "window", bounds: RIGHT });
    expect(isDesktopSurfaceVisible(notes, useDesktopSurfaces.getState())).toBe(true);
  });

  it("does nothing without a selected app", () => {
    twoApps();
    useTabs.setState({ activeTabId: null });
    const before = useDesktopSurfaces.getState().surfaces;

    tileActiveApp("left");
    restoreActiveAppSize();
    expect(useDesktopSurfaces.getState().surfaces).toBe(before);
    expect(applyWindowBounds).not.toHaveBeenCalled();
  });

  it("does nothing when the selected app is hidden by Show desktop", () => {
    const { notes } = twoApps();
    useDesktopSurfaces.getState().showDesktop();
    const bounds = surface(notes).bounds;

    tileActiveApp("left");
    expect(surface(notes).bounds).toEqual(bounds);
    expect(applyWindowBounds).not.toHaveBeenCalled();
  });

  it("does nothing on the Canvas, where windows are not placed on the screen", () => {
    const { notes, original } = twoApps();
    useNativeDesktopMode.setState({ mode: "canvas" });

    tileActiveApp("left");
    expect(surface(notes).bounds).toEqual(original);
    expect(useDesktopSurfaces.getState().tileRestoreBounds).toEqual({});
  });

  it("does nothing without a mounted shell to measure the desktop", () => {
    const { notes, original } = twoApps();
    unregister?.();
    unregister = null;

    tileActiveApp("left");
    expect(surface(notes).bounds).toEqual(original);
    expect(useDesktopSurfaces.getState().tileRestoreBounds).toEqual({});
  });
});

describe("restoreActiveAppSize", () => {
  it("leaves a floating window alone when nothing is remembered", () => {
    const { notes, original } = twoApps();
    restoreActiveAppSize();
    expect(surface(notes).bounds).toEqual(original);
    expect(applyWindowBounds).not.toHaveBeenCalled();
  });

  it("returns a full-size app to its floating window when nothing is remembered", () => {
    const { notes, original } = twoApps();
    toggleActiveAppFullSize();

    restoreActiveAppSize();
    expect(surface(notes)).toMatchObject({ mode: "window", bounds: original });
    expect(useDesktopSurfaces.getState().workspaceView).toBe("desktop");
  });

  it("returns a tiled app made full size to its size before the tile", () => {
    const { notes, original } = twoApps();
    tileActiveApp("left");
    toggleActiveAppFullSize();

    restoreActiveAppSize();
    expect(surface(notes)).toMatchObject({ mode: "window", bounds: original });
  });

  it("keeps the toggle's own restore: full size back to the tiled half", () => {
    const { notes } = twoApps();
    tileActiveApp("left");
    toggleActiveAppFullSize();
    toggleActiveAppFullSize();
    expect(surface(notes)).toMatchObject({ mode: "window", bounds: LEFT });
  });
});

describe("moveAppWindow", () => {
  it("is a manual placement: it forgets the bounds from before the tile", () => {
    const { notes } = twoApps();
    tileActiveApp("left");
    const dragged = { x: 100, y: 50, width: 640, height: 800 - 50 };

    moveAppWindow(notes, dragged);
    expect(applyWindowBounds).toHaveBeenLastCalledWith(notes, dragged);
    expect(useDesktopSurfaces.getState().tileRestoreBounds).not.toHaveProperty(notes);

    restoreActiveAppSize();
    expect(surface(notes).bounds).toEqual(dragged);

    tileActiveApp("right");
    restoreActiveAppSize();
    expect(surface(notes).bounds).toEqual(dragged);
  });
});

describe("arrangement shortcuts", () => {
  it("run the shared tiling helpers", () => {
    const { notes, original } = twoApps();
    runShortcutAction("app.tile-left");
    expect(surface(notes).bounds).toEqual(LEFT);
    runShortcutAction("app.tile-right");
    expect(surface(notes).bounds).toEqual(RIGHT);
    runShortcutAction("app.tile-top");
    expect(surface(notes).bounds).toEqual(TOP);
    runShortcutAction("app.tile-bottom");
    expect(surface(notes).bounds).toEqual(BOTTOM);
    runShortcutAction("app.restore-size");
    expect(surface(notes).bounds).toEqual(original);
  });
});
