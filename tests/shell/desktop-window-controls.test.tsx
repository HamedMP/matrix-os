// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  desktopWindowTitleBarStyle,
  desktopWindowTop,
  WindowControls,
} from "@/components/desktop/DesktopWindow";

describe("web desktop window controls", () => {
  it("keeps floating windows below the desktop header", () => {
    expect(desktopWindowTop(20, 38)).toBe("58px");
  });

  it("centers title-bar content with equal vertical clearance", () => {
    expect(desktopWindowTitleBarStyle(false)).toMatchObject({
      alignItems: "center",
      paddingTop: 0,
      paddingBottom: 0,
      borderBottom: "1px solid var(--border)",
    });
  });

  it("uses compact native traffic lights with hover-only glyphs", () => {
    render(
      <WindowControls
        title="Terminal"
        onClose={vi.fn()}
        onMinimize={vi.fn()}
        onMaximize={vi.fn()}
      />,
    );

    const close = screen.getByRole("button", { name: "Close Terminal" });
    const minimize = screen.getByRole("button", { name: "Minimize Terminal" });
    const maximize = screen.getByRole("button", { name: "Maximize Terminal" });

    for (const control of [close, minimize, maximize]) {
      expect(control.className).toContain("size-5");
      expect(control.className).toContain("rounded-full");
      expect((control as HTMLElement).style.background).toBe("");
      expect(control.querySelector("svg")).toBeNull();
      const light = control.querySelector<HTMLElement>("[data-window-control-light]");
      expect(light).toBeTruthy();
      expect(light?.className).toContain("size-3");
      expect(light?.className).toContain("rounded-full");
      expect(light?.querySelector("[data-window-control-glyph]")?.className).toContain("opacity-0");
      expect(light?.querySelector("[data-window-control-glyph]")?.className).toContain("group-hover/window-controls:opacity-100");
    }

    expect(close.parentElement?.className).toContain("w-16");
    expect(close.querySelector("[data-window-control-light]")?.className).toContain("bg-[#ff5f57]");
    expect(minimize.querySelector("[data-window-control-light]")?.className).toContain("bg-[#febc2e]");
    expect(maximize.querySelector("[data-window-control-light]")?.className).toContain("bg-[#28c840]");
  });
});
