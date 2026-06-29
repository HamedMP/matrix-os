// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ModeSwitcherBar", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders both visible modes and marks the active one", async () => {
    const { useDesktopMode } = await import("../../shell/src/stores/desktop-mode.js");
    const { ModeSwitcherBar } = await import("../../shell/src/components/ModeSwitcherBar.js");
    useDesktopMode.setState({ mode: "dev" });
    render(<ModeSwitcherBar />);
    expect(screen.getByRole("button", { name: /developer/i }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /canvas/i }).getAttribute("aria-pressed")).toBe("false");
  });

  it("switches mode on click", async () => {
    const { useDesktopMode } = await import("../../shell/src/stores/desktop-mode.js");
    const { ModeSwitcherBar } = await import("../../shell/src/components/ModeSwitcherBar.js");
    useDesktopMode.setState({ mode: "dev" });
    render(<ModeSwitcherBar />);
    fireEvent.click(screen.getByRole("button", { name: /canvas/i }));
    expect(useDesktopMode.getState().mode).toBe("canvas");
  });
});
