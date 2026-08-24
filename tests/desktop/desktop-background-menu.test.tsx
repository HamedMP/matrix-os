// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopBackgroundMenu from "@desktop/renderer/src/features/desktop-shell/DesktopBackgroundMenu";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useUi } from "@desktop/renderer/src/stores/ui";

describe("DesktopBackgroundMenu", () => {
  const get = vi.fn();
  const patch = vi.fn();

  beforeEach(() => {
    get.mockResolvedValue({ wallpapers: ["moraine-lake.jpg", "macos-light.svg"] });
    patch.mockResolvedValue({ background: { type: "wallpaper", name: "macos-light.svg" } });
    useConnection.setState({ api: { get, patch } as never });
    useUi.setState({ desktopBackgroundRefreshRequest: 0 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens from a background right-click and saves a wallpaper selection", async () => {
    render(
      <DesktopBackgroundMenu>
        <div data-testid="desktop-empty-space">Desktop</div>
      </DesktopBackgroundMenu>,
    );

    fireEvent.contextMenu(screen.getByTestId("desktop-empty-space"));
    fireEvent.click(await screen.findByText("Change background…"));

    expect(await screen.findByRole("dialog", { name: "Desktop background" })).toBeTruthy();
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
