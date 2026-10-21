// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowManager, resetWindowManagerLayoutPersistenceForTests } from "../../shell/src/hooks/useWindowManager";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ok:true}));
  useDesktopMode.setState({mode:"desktop", _hydrated:true});
  resetWindowManagerLayoutPersistenceForTests();
  useWindowManager.setState({windows:[], nextZ:1, closedPaths:new Set(), closedLayouts:new Map(), focusedWindowId:null, fullscreenWindowId:null});
});
afterEach(() => { resetWindowManagerLayoutPersistenceForTests(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("remote Browser presentation lifecycle", () => {
  it.each(["__browser__", "__cloud-desktop__"])("opens %s with enough room for Chrome and fits the work area", (path) => {
    useWindowManager.getState().openWindow("Browser", path, 0);
    const w=useWindowManager.getState().windows[0];
    expect(w.width).toBeGreaterThan(window.innerWidth * 0.85);
    expect(w.height).toBeGreaterThan((window.innerHeight-124) * 0.85);
    expect(w.width).toBeLessThanOrEqual(window.innerWidth-40);
    expect(w.height).toBeLessThanOrEqual(window.innerHeight-124-40);
  });
  it("reopening a minimized Browser restores the same presentation without duplicating the session", () => {
    const state=()=>useWindowManager.getState();
    state().openWindow("Browser", "__browser__", 0);
    const before=state().windows[0];
    state().minimizeWindow(before.id);
    state().openWindow("Browser", "__browser__", 0);
    expect(state().windows).toHaveLength(1);
    expect(state().windows[0]).toMatchObject({id:before.id, minimized:false, width:before.width, height:before.height});
    expect(state().focusedWindowId).toBe(before.id);
    state().openWindow("Cloud desktop", "__cloud-desktop__", 0);
    expect(state().windows).toHaveLength(2);
  });
});
