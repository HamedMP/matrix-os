// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DesktopTaskbar from "@desktop/renderer/src/features/desktop-shell/DesktopTaskbar";
import launcherIcon from "../../home/system/icons/v3-launcher.svg";
import type { Tab } from "@desktop/renderer/src/stores/tabs";

afterEach(cleanup);

describe("DesktopTaskbar artwork", () => {
  it("fills pinned and running controls with unframed artwork while retaining activation", () => {
    const onActivate = vi.fn();
    const onOpenApps = vi.fn();
    const tab = { id: "subscriptions", kind: "app", title: "App Gallery", icon: "/icons/v3-app-gallery.png" } as Tab;
    render(<DesktopTaskbar
      tabs={[tab]}
      surfaces={{ subscriptions: { tabId: tab.id, mode: "minimized", restoreMode: "window", bounds: { x: 0, y: 0, width: 800, height: 600 }, zIndex: 1 } }}
      activeTabId={null}
      onOpenApps={onOpenApps}
      onOpenFiles={vi.fn()}
      launcherOpen={false}
      onActivate={onActivate}
    />);

    for (const label of ["Open Files", "Restore App Gallery"]) {
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
    const installed = screen.getByRole("button", { name: "Restore App Gallery" });
    expect(installed.querySelector("img")?.getAttribute("src")).toBe(tab.icon);
    expect(installed.parentElement?.querySelector("[data-taskbar-running-indicator]")).toBeTruthy();
    fireEvent.click(installed);
    expect(onActivate).toHaveBeenCalledWith(tab.id);

    const launcher = screen.getByRole("button", { name: "Open App Launcher" });
    expect(launcher.querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background).toBe("");
    expect(launcher.querySelector("img")?.getAttribute("src")).toBe(launcherIcon);
    expect(launcherIcon).not.toBe(tab.icon);
    expect(launcher.querySelector("img")?.width).toBe(44);
    expect(launcher.querySelector("img")?.height).toBe(44);
    fireEvent.click(launcher);
    expect(onOpenApps).toHaveBeenCalledOnce();

    fireEvent.error(installed.querySelector("img")!);
    expect(installed.querySelector("svg")?.getAttribute("width")).toBe("44");
    expect(installed.querySelector<HTMLElement>("[data-desktop-app-icon]")?.style.background).toBe("");
  });
});
