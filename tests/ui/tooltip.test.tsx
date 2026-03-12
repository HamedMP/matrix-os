// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Tooltip } from "../../packages/ui/src/Tooltip";

describe("Tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders children", () => {
    render(
      <Tooltip content="Help text">
        <button>Hover me</button>
      </Tooltip>
    );
    expect(screen.getByText("Hover me")).toBeTruthy();
  });

  it("shows tooltip content on hover after delay", () => {
    render(
      <Tooltip content="Help text" delay={300}>
        <button>Hover me</button>
      </Tooltip>
    );
    const wrapper = screen.getByText("Hover me").parentElement!;
    fireEvent.mouseEnter(wrapper);
    act(() => { vi.advanceTimersByTime(300); });
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.style.opacity).toBe("1");
  });

  it("hides tooltip on mouse leave", () => {
    render(
      <Tooltip content="Help text" delay={0}>
        <button>Hover me</button>
      </Tooltip>
    );
    const wrapper = screen.getByText("Hover me").parentElement!;
    fireEvent.mouseEnter(wrapper);
    act(() => { vi.advanceTimersByTime(0); });
    fireEvent.mouseLeave(wrapper);
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.style.opacity).toBe("0");
  });

  it("renders tooltip text", () => {
    render(
      <Tooltip content="Helpful info">
        <span>Target</span>
      </Tooltip>
    );
    expect(screen.getByRole("tooltip")).toHaveTextContent("Helpful info");
  });

  it("supports different positions", () => {
    const positions = ["top", "bottom", "left", "right"] as const;
    for (const position of positions) {
      const { unmount } = render(
        <Tooltip content="Tip" position={position}>
          <span>Target</span>
        </Tooltip>
      );
      expect(screen.getByRole("tooltip")).toBeTruthy();
      unmount();
    }
  });

  it("has role=tooltip", () => {
    render(
      <Tooltip content="Accessible">
        <span>Target</span>
      </Tooltip>
    );
    expect(screen.getByRole("tooltip")).toBeTruthy();
  });
});
