// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Monitor, PanelLeft } from "lucide-react";
import DesktopTab from "../../desktop/src/renderer/src/features/desktop-shell/DesktopTab";

describe("DesktopTab", () => {
  it("renders an icon-only tab with 14px icon sizing and vertical borders", () => {
    render(
      <DesktopTab
        mode="iconOnly"
        label="Desktop"
        icon={<Monitor />}
        selected
        onClick={vi.fn()}
      />,
    );

    const tab = screen.getByRole("tab", { name: "Desktop" });
    const icon = tab.querySelector("svg");
    expect(tab.style.height).toBe("var(--titlebar-height)");
    expect(tab.className).toContain("border-l");
    expect(tab.className).toContain("p-3");
    expect(icon?.getAttribute("width")).toBe("14");
    expect(icon?.getAttribute("height")).toBe("14");
  });

  it("renders close controls only for closeable full tabs", () => {
    const onClose = vi.fn();
    render(
      <>
        <DesktopTab
          mode="full"
          label="Files"
          icon={<PanelLeft />}
          canClose
          onClick={vi.fn()}
          onClose={onClose}
        />
        <DesktopTab
          mode="full"
          label="Settings"
          icon={<PanelLeft />}
          canClose={false}
          onClick={vi.fn()}
        />
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close Files" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.getByRole("tab", { name: "Files" }).parentElement?.style.height)
      .toBe("var(--titlebar-height)");
    expect(screen.queryByRole("button", { name: "Close Settings" })).toBeNull();
  });
});
