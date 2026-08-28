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

  it("matches the desktop OS square icon controls", () => {
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
      expect(control.className).toContain("size-4");
      expect(control.className).toContain("rounded-[4.8px]");
      expect((control as HTMLElement).style.background).toBe("var(--surface-primary, #FFFEFC)");
      expect((control as HTMLElement).style.border).toBe("0.8px solid var(--border-default, #F3F2F2)");
      expect(control.querySelector("svg")).toBeTruthy();
      expect(control.querySelector("[data-window-control-light]")).toBeNull();
    }

    expect(close.parentElement?.className).toContain("gap-0.5");
    expect(close.parentElement?.className).not.toContain("w-16");
  });
});
