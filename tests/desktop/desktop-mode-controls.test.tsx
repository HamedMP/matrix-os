// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    render(<DesktopModeControls />);

    const labels = screen.getAllByRole("button").map((button) => (
      button.getAttribute("aria-label") ?? button.textContent
    ));
    expect(labels).toEqual([
      "Search",
      "Support",
      "Join Discord",
      "Main computer",
      "Getting started — 0 of 5",
      "Update Matrix OS to 1.2.3",
      "Open account menu",
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Join Discord" }));
    expect(window.operator.invoke).toHaveBeenCalledWith("shell:open-external", {
      url: "https://discord.gg/WHbvTG33w",
    });

    const update = screen.getByRole("button", { name: "Update Matrix OS to 1.2.3" });
    const avatar = screen.getByRole("button", { name: "Open account menu" }).querySelector("span");
    expect(update.className).toContain("size-6");
    expect(avatar?.className).toContain("size-6");
  });
});
