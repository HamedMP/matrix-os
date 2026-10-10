// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCloseSelectedAppShortcut } from "@desktop/renderer/src/features/mission-control/shortcuts";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
beforeEach(() => { useTabs.setState(useTabs.getInitialState(), true); useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true); });
describe("Utilities Electron tab retention", () => {
  it("keeps Utilities as a single native instance even through the lower-level instance API", () => {
    const first = useTabs.getState().openTabInstance({ kind: "app", slug: "utilities", title: "Utilities" });
    expect(useTabs.getState().openTabInstance({ kind: "app", slug: "utilities", title: "Utilities" })).toBe(first);
    expect(useTabs.getState().tabs).toHaveLength(1);
  });
  it("retains its mounted tab and active selection until the native view approves", async () => {
    let resolve!: (reply: { ok: boolean }) => void;
    const invoke = vi.fn(() => new Promise<{ ok: boolean }>(r => { resolve = r; }));
    window.operator = { invoke, on: () => () => undefined };
    const id = useTabs.getState().openTab({ kind: "app", slug: "utilities", title: "Utilities" });
    const pending = useTabs.getState().closeTab(id);
    expect(invoke).toHaveBeenCalledWith("embed:close-utilities", {});
    expect(useTabs.getState().activeTabId).toBe(id);
    expect(useTabs.getState().tabs).toHaveLength(1);
    resolve({ ok: false }); expect(await pending).toBe(false);
    expect(useTabs.getState().tabs).toHaveLength(1);
    const accepted = useTabs.getState().closeTab(id); resolve({ ok: true });
    expect(await accepted).toBe(true); expect(useTabs.getState().tabs).toHaveLength(0);
  });
  it("retains the newly selected app when a delayed shortcut close is approved", async () => {
    let resolve!: (reply: { ok: boolean }) => void;
    window.operator = { invoke: vi.fn(() => new Promise<{ ok: boolean }>(done => { resolve = done; })), on: () => () => undefined };
    const utilities = useTabs.getState().openTab({ kind: "app", slug: "utilities", title: "Utilities" });
    useDesktopSurfaces.getState().reconcileTabs([utilities], { width: 1280, height: 800 });
    handleCloseSelectedAppShortcut({ preventDefault: vi.fn() });
    const settings = useTabs.getState().openTab({ kind: "settings", title: "Settings" });
    useDesktopSurfaces.getState().reconcileTabs([utilities, settings], { width: 1280, height: 800 });
    useDesktopSurfaces.getState().activateSurface(settings);
    resolve({ ok: true });
    await vi.waitFor(() => expect(useTabs.getState().tabs.some(tab => tab.id === utilities)).toBe(false));
    expect(useTabs.getState().activeTabId).toBe(settings);
    expect(useDesktopSurfaces.getState().surfaces[settings]?.mode).toBe("window");
  });
  it("fails closed on bridge failure and never evicts Utilities when opening more apps", async () => {
    window.operator = { invoke: vi.fn().mockRejectedValue(new Error("synthetic")), on: () => () => undefined };
    const id = useTabs.getState().openTab({ kind: "app", slug: "utilities", title: "Utilities" });
    useTabs.getState().openTab({ kind: "files", title: "Files" });
    for (let i = 0; i < 70; i++) useTabs.getState().openTabInstance({ kind: "app", slug: `app-${i}`, title: `App ${i}` });
    expect(useTabs.getState().tabs.some(tab => tab.id === id)).toBe(true);
    expect(await useTabs.getState().closeTab(id)).toBe(false);
    expect(useTabs.getState().tabs.some(tab => tab.id === id)).toBe(true);
  });
});
