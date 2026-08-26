// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OSWindow, TopBar } from "../../desktop/src/renderer/src/features/desktop-shell/OSWindow.js";

describe("Electron OS window chrome", () => {
  it("uses the shared base surface for every OS window", () => {
    const { container } = render(<OSWindow surfaceId="terminal-window" />);

    const window = container.firstElementChild as HTMLElement;
    expect(window.style.background).toBe("var(--surface-base-background, #FFFFFD)");
    expect(window.style.getPropertyValue("--bg-surface")).toBe("var(--surface-base-background, #FFFFFD)");
    expect(window.style.getPropertyValue("--bg-sunken")).toBe("var(--surface-base-background, #FFFFFD)");
  });

  it("keeps a full-width transparent gesture layer when Terminal controls use the sidebar", () => {
    const onClose = vi.fn();
    const { container } = render(
      <TopBar
        chromePlacement="sidebar"
        onClose={onClose}
        onMinimize={vi.fn()}
        onMaximize={vi.fn()}
        onDragStart={vi.fn()}
      />,
    );

    const gestureLayer = container.querySelector("[data-os-window-gesture-layer]");
    expect(gestureLayer).toBeTruthy();
    expect(gestureLayer?.className).toContain("z-20");
    expect((container.querySelector('[data-os-window-chrome-placement="sidebar"]') as HTMLElement).style.width).toBe("280px");
    expect(gestureLayer?.className).not.toContain("bg-");
    expect(container.querySelector("[data-os-window-traffic-lights]")?.className).toContain("z-30");
    expect(screen.queryByText("Terminal")).toBeNull();

    const closeButton = screen.getByRole("button", { name: "Close" });
    expect(closeButton.className).toContain("size-4");
    expect(closeButton.className).toContain("rounded-[4.8px]");
    expect((closeButton as HTMLElement).style.background).toBe("var(--surface-primary, #FFFEFC)");

    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
