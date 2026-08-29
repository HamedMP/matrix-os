// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ModeSwitcherBar", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders Canvas alongside the canonical Desktop mode", async () => {
    const { useDesktopMode } = await import("../../shell/src/stores/desktop-mode.js");
    const { ModeSwitcherBar } = await import("../../shell/src/components/ModeSwitcherBar.js");
    useDesktopMode.setState({ mode: "desktop" });
    render(<ModeSwitcherBar />);
    expect(screen.getByRole("button", { name: /desktop/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("button", { name: /developer/i })).toBeNull();
    expect(screen.getByRole("button", { name: /canvas/i }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Desktop").className).toContain("hidden");
    expect(screen.getByText("Desktop").className).toContain("lg:inline");
  });

  it("returns a Canvas selection to Desktop on click", async () => {
    const { useDesktopMode } = await import("../../shell/src/stores/desktop-mode.js");
    const { ModeSwitcherBar } = await import("../../shell/src/components/ModeSwitcherBar.js");
    useDesktopMode.setState({ mode: "canvas" });
    render(<ModeSwitcherBar />);
    fireEvent.click(screen.getByRole("button", { name: /desktop/i }));
    expect(useDesktopMode.getState().mode).toBe("desktop");
  });
});
