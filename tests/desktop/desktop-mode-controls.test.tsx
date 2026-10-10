// @vitest-environment jsdom

import React from "react";
import { GettingStartedVisibilityProvider } from "@matrix-os/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DesktopModeControls from "@desktop/renderer/src/features/desktop-shell/DesktopModeControls";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { useDesktopUpdate } from "@desktop/renderer/src/stores/desktop-update";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { useUi } from "@desktop/renderer/src/stores/ui";

vi.mock("@desktop/renderer/src/features/runtime/RuntimeComputerMenu", () => ({
  default: () => <button type="button">Main computer</button>,
}));
vi.mock("@desktop/renderer/src/features/support/DesktopSupportButton", () => ({
  default: () => <button type="button">Support</button>,
}));

describe("Desktop mode controls", () => {
  beforeEach(() => {
    useConnection.setState(useConnection.getInitialState(), true);
    useConnection.setState({ handle: "neo", displayName: "Neo", imageUrl: null });
    useDesktopUpdate.setState({
      snapshot: { status: "ready", version: "1.2.3", progress: 100 },
      installing: false,
    });
    useTabs.setState(useTabs.getInitialState(), true);
    useUi.setState(useUi.getInitialState(), true);
    window.operator = {
      invoke: vi.fn(async () => ({ ok: true })),
      on: vi.fn(() => () => undefined),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("places the ready Update control immediately left of the same-size account avatar", () => {
    render(<GettingStartedVisibilityProvider scope="controls-test"><DesktopModeControls /></GettingStartedVisibilityProvider>);

    const labels = screen.getAllByRole("button").map((button) => (
      button.getAttribute("aria-label") ?? button.textContent
    ));
    expect(labels).toEqual([
      "Search",
      "Inbox",
      "Help",
      "Main computer",
      "Update Matrix OS to 1.2.3",
      "Open account menu",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(useUi.getState().rendererOverlayCount).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Join Discord" }).getAttribute("href")).toBe("https://discord.gg/WHbvTG33w");

    const update = screen.getByRole("button", { name: "Update Matrix OS to 1.2.3" });
    const avatar = screen.getByRole("button", { name: "Open account menu" }).querySelector("span");
    expect(update.className).toContain("size-6");
    expect(avatar?.className).toContain("size-6");
  });
  it("opens and toggles the checklist through the actual nested Help controls", async () => {
    render(<GettingStartedVisibilityProvider scope="controls-test"><DesktopModeControls /></GettingStartedVisibilityProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    const trigger = await screen.findByRole("button", { name: "Getting started — 0 of 5" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Getting started" })).toBeNull());
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Getting started" })).not.toBeNull();
  });

});
