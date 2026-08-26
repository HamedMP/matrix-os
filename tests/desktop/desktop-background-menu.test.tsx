// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopBackgroundMenu from "@desktop/renderer/src/features/desktop-shell/DesktopBackgroundMenu";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useUi } from "@desktop/renderer/src/stores/ui";

describe("DesktopBackgroundMenu", () => {
  const get = vi.fn();
  const getBlob = vi.fn();
  const patch = vi.fn();

  beforeEach(() => {
    get.mockResolvedValue({ wallpapers: ["moraine-lake.jpg", "macos-light.svg"] });
    getBlob.mockResolvedValue(new Blob(["wallpaper"], { type: "image/jpeg" }));
    patch.mockResolvedValue({ background: { type: "wallpaper", name: "macos-light.svg" } });
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:wallpaper-preview"),
      revokeObjectURL: vi.fn(),
    });
    useConnection.setState({ api: { get, getBlob, patch } as never });
    useUi.setState({ desktopBackgroundRefreshRequest: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens from a background right-click and saves a wallpaper selection", async () => {
    render(
      <DesktopBackgroundMenu>
        <div data-testid="desktop-empty-space">Desktop</div>
      </DesktopBackgroundMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("desktop-empty-space"));
    const menu = await screen.findByRole("menu");
    expect(menu.style.borderRadius).toBe("12px");
    expect(menu.style.overflow).toBe("hidden");
    await waitFor(() => expect(getBlob).toHaveBeenCalledWith(
      `/api/files/blob?path=${encodeURIComponent("system/wallpapers/moraine-lake.jpg")}`,
      { maxBytes: 10 * 1024 * 1024 },
    ));
    fireEvent.click(await screen.findByText("Change background…"));

    expect(await screen.findByRole("dialog", { name: "Desktop background" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Moraine Lake" }).getAttribute("src"))
      .toBe("blob:wallpaper-preview");
    expect(screen.getByRole("button", { name: "Matrix Gradient" }).firstElementChild?.getAttribute("style"))
      .toContain("radial-gradient");
    expect(screen.getByRole("button", { name: "Matrix Gradient" }).className)
      .toContain("hover:bg-[var(--bg-hover)]");
    await waitFor(() => expect(useUi.getState().rendererOverlayCount).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "macOS Light" }));

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith("/api/settings/desktop", {
        background: { type: "wallpaper", name: "macos-light.svg" },
      });
    });
    expect(useUi.getState().desktopBackgroundRefreshRequest).toBe(1);
    await waitFor(() => expect(useUi.getState().rendererOverlayCount).toBe(0));
  });
});
