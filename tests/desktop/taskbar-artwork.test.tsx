// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopTaskbar from "@desktop/renderer/src/features/desktop-shell/DesktopTaskbar";
import { useTabs, type Tab } from "@desktop/renderer/src/stores/tabs";
import { useDesktopSurfaces } from "@desktop/renderer/src/stores/desktop-surfaces";
import { reconcileNativeProductSurfaces } from "@desktop/renderer/src/features/desktop-shell/browser-product-surfaces";

beforeEach(() => {
  useTabs.setState(useTabs.getInitialState(), true);
  useDesktopSurfaces.setState(useDesktopSurfaces.getInitialState(), true);
});
afterEach(cleanup);

describe("DesktopTaskbar artwork", () => {
  it.each([
    ["matrix-browser", "Browser", "v2/browser.png"],
    ["matrix-cloud-desktop", "Cloud desktop", "v3/desktop.png"],
  ] as const)("retains %s artwork and activation when an iconless product is restored and minimized", (appIdentity, title, artwork) => {
    const id = useTabs.getState().openTab({ kind: "app", title, slug: "browser-lab", appIdentity });
    reconcileNativeProductSurfaces([id], { width: 1200, height: 800 });
    const onActivate = vi.fn((tabId: string) => useDesktopSurfaces.getState().activateSurface(tabId));
    const taskbar = () => <DesktopTaskbar
      tabs={useTabs.getState().tabs}
      surfaces={useDesktopSurfaces.getState().surfaces}
      activeTabId={id}
      onOpenApps={vi.fn()}
      onOpenFiles={vi.fn()}
      launcherOpen={false}
      onActivate={onActivate}
    />;
    const view = render(taskbar());
    const focus = screen.getByRole("button", { name: `Focus ${title}` });
    expect(focus.querySelector("img")).not.toBeNull();
    expect(focus.querySelector("img")?.getAttribute("src")).toContain(artwork);
    expect(focus.parentElement?.querySelector("[data-taskbar-running-indicator]")).toBeTruthy();

    act(() => useDesktopSurfaces.getState().minimizeSurface(id));
    view.rerender(taskbar());
    const restore = screen.getByRole("button", { name: `Restore ${title}` });
    expect(restore.querySelector("img")?.getAttribute("src")).toContain(artwork);
    fireEvent.click(restore);
    expect(onActivate).toHaveBeenCalledWith(id);
    expect(useDesktopSurfaces.getState().surfaces[id]?.mode).toBe("window");
    view.rerender(taskbar());
    expect(screen.getByRole("button", { name: `Focus ${title}` }).querySelector("img")?.getAttribute("src")).toContain(artwork);

    act(() => useTabs.setState(state => ({ tabs: state.tabs.map(tab => tab.id === id ? { ...tab, icon: "/icons/owner-choice.png" } : tab) })));
    view.rerender(taskbar());
    expect(screen.getByRole("button", { name: `Focus ${title}` }).querySelector("img")?.getAttribute("src")).toBe("/icons/owner-choice.png");

    act(() => useDesktopSurfaces.getState().closeSurface(id));
    view.rerender(taskbar());
    expect(screen.queryByRole("button", { name: `Focus ${title}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Restore ${title}` })).toBeNull();
  });

  it("fills pinned and running controls with unframed artwork while retaining activation", () => {
    const onActivate = vi.fn();
    const tab = { id: "subscriptions", kind: "app", title: "Subscriptions", icon: "/icons/subscriptions.png" } as Tab;
    render(<DesktopTaskbar
      tabs={[tab]}
      surfaces={{ subscriptions: { tabId: tab.id, mode: "minimized", restoreMode: "window", bounds: { x: 0, y: 0, width: 800, height: 600 }, zIndex: 1 } }}
      activeTabId={null}
      onOpenApps={vi.fn()}
      onOpenFiles={vi.fn()}
      launcherOpen={false}
      onActivate={onActivate}
    />);

    for (const label of ["Open Files", "Restore Subscriptions"]) {
      const button = screen.getByRole("button", { name: label });
      const artwork = button.querySelector<HTMLElement>("[data-desktop-app-icon]")!;
      expect(artwork.style.background).toBe("");
      expect(artwork.querySelector("[data-desktop-app-icon-shine]")).toBeNull();
      const image = artwork.querySelector("img")!;
      expect(image.width).toBe(44);
      expect(image.height).toBe(44);
      expect(image.className).toContain("object-contain");
      expect(image.className).not.toContain("rounded");
    }
    const installed = screen.getByRole("button", { name: "Restore Subscriptions" });
    expect(installed.querySelector("img")?.getAttribute("src")).toBe(tab.icon);
    expect(installed.parentElement?.querySelector("[data-taskbar-running-indicator]")).toBeTruthy();
    fireEvent.click(installed);
    expect(onActivate).toHaveBeenCalledWith(tab.id);

    const launcher = screen.getByRole("button", { name: "Open App Launcher" });
    expect(launcher.querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background).toBe("");
    expect(launcher.querySelector("img")?.getAttribute("src")).toContain("v3-app-gallery.png");
    expect(launcher.querySelector("img")?.width).toBe(44);
    expect(launcher.querySelector("img")?.height).toBe(44);

    fireEvent.error(installed.querySelector("img")!);
    expect(installed.querySelector("svg")?.getAttribute("width")).toBe("44");
    expect(installed.querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background).toBe("");
  });
});
