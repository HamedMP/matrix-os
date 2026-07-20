// @vitest-environment jsdom

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DotGrid, useDotGrid } from "../../shell/src/components/DotGrid";
import { useDesktopMode } from "../../shell/src/stores/desktop-mode";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function setThemeStyle(style: string | null) {
  if (style === null) {
    document.documentElement.removeAttribute("data-theme-style");
  } else {
    document.documentElement.setAttribute("data-theme-style", style);
  }
}

describe("DotGrid OS-design gating", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    useDotGrid.setState({ enabled: true });
    useDesktopMode.setState({ mode: "canvas", previousMode: null, _hydrated: true });
    // Reset the attribute before each test (not in afterEach) so the still-
    // mounted MutationObserver never fires outside act after a test ends.
    setThemeStyle(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the grid canvas in the default flat design", () => {
    const { container } = render(<DotGrid />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it("keeps the grid off in Developer mode even when the Canvas preference is enabled", () => {
    useDesktopMode.setState({ mode: "dev", previousMode: "canvas" });
    const { container } = render(<DotGrid />);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("renders the grid canvas in the neumorphic design", () => {
    setThemeStyle("neumorphic");
    const { container } = render(<DotGrid />);
    expect(container.querySelector("canvas")).not.toBeNull();
  });

  it.each(["macos-glass", "winxp", "win11"])(
    "renders nothing and never attaches pointer listeners in the %s design",
    (style) => {
      setThemeStyle(style);
      const addSpy = vi.spyOn(window, "addEventListener");
      const { container } = render(<DotGrid />);

      expect(container.firstChild).toBeNull();
      expect(addSpy).not.toHaveBeenCalledWith("mousemove", expect.any(Function));
      expect(addSpy).not.toHaveBeenCalledWith("mouseleave", expect.any(Function));
    },
  );

  it("stays hidden when the store toggle is off, even in the flat design", () => {
    useDotGrid.setState({ enabled: false });
    const { container } = render(<DotGrid />);
    expect(container.querySelector("canvas")).toBeNull();
  });

  it("hides the grid when the design switches to an OS style at runtime", async () => {
    const { container } = render(<DotGrid />);
    expect(container.querySelector("canvas")).not.toBeNull();

    // Async act flushes the microtask-delivered MutationObserver callback.
    await act(async () => setThemeStyle("win11"));

    await waitFor(() => expect(container.querySelector("canvas")).toBeNull());
  });
});
