// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalKeyBar } from "../../shell/src/components/terminal/TerminalKeyBar.js";

const originalInnerHeight = Object.getOwnPropertyDescriptor(window, "innerHeight");
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

function restoreWindowProperty(name: "innerHeight" | "visualViewport", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) {
    Object.defineProperty(window, name, descriptor);
    return;
  }
  Reflect.deleteProperty(window, name);
}

function installVisualViewportMock(input: { height: number; offsetTop: number }) {
  const listeners = new Map<string, Set<() => void>>();
  const viewport = {
    height: input.height,
    offsetTop: input.offsetTop,
    addEventListener: vi.fn((type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(type, set);
    }),
    removeEventListener: vi.fn((type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener);
    }),
    dispatch(type: string) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

describe("TerminalKeyBar", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreWindowProperty("innerHeight", originalInnerHeight);
    restoreWindowProperty("visualViewport", originalVisualViewport);
  });

  it("resets the shared terminal keyboard height when visualViewport has no keyboard overlap", () => {
    render(<TerminalKeyBar onSend={vi.fn()} />);

    const keyBar = screen.getByTestId("terminal-key-bar");
    expect(keyBar.style.bottom).toBe("var(--terminal-keyboard-height, 0px)");
    expect(document.documentElement.style.getPropertyValue("--terminal-keyboard-height")).toBe("0px");
  });

  it("tracks visualViewport keyboard overlap in the shared terminal keyboard height", () => {
    const viewport = installVisualViewportMock({ height: 560, offsetTop: 0 });

    render(<TerminalKeyBar onSend={vi.fn()} />);

    expect(document.documentElement.style.getPropertyValue("--terminal-keyboard-height")).toBe("240px");

    act(() => {
      viewport.height = 800;
      viewport.dispatch("resize");
    });

    expect(document.documentElement.style.getPropertyValue("--terminal-keyboard-height")).toBe("0px");
  });

  it("sends enter from the primary mobile key row", () => {
    const onSend = vi.fn();

    render(<TerminalKeyBar onSend={onSend} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Enter" }));

    expect(onSend).toHaveBeenCalledWith("\r");
  });

  it("shows a full English keyboard when expanded", () => {
    render(<TerminalKeyBar onSend={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Show more keys" }));

    expect(screen.getByRole("tab", { name: "ABC keyboard" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "letter q" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "letter m" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Space" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Backspace" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Enter" })).toHaveLength(1);
  });

  it("keeps the More button outside the scrollable key row so it stays tappable on narrow viewports", () => {
    render(<TerminalKeyBar onSend={vi.fn()} />);

    const moreButton = screen.getByRole("button", { name: "Show more keys" });
    // Fixed-width control, never subject to the key row's horizontal scroll/clip.
    expect(moreButton.style.flex).toBe("0 0 auto");
    expect(moreButton.style.marginLeft).toBe("");
    expect(moreButton.className).toContain("mtk-ghost");

    // Primary keys live in a sibling scroller that falls back to horizontal
    // scrolling when they overflow a narrow (<=360px) viewport.
    const scroller = screen.getByRole("button", { name: "Enter" }).parentElement as HTMLElement;
    expect(scroller.style.overflowX).toBe("auto");
    expect(scroller.style.touchAction).toBe("pan-x");

    // The More button must not be clipped along with the overflowing keys.
    expect(scroller.contains(moreButton)).toBe(false);
  });

  it("switches expanded keyboard layers without hiding the collapse action", () => {
    render(<TerminalKeyBar onSend={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Show more keys" }));
    fireEvent.click(screen.getByRole("tab", { name: "Sym keyboard" }));

    const symTab = screen.getByRole("tab", { name: "Sym keyboard" });
    expect(symTab.getAttribute("aria-selected")).toBe("true");
    expect(symTab.className).toContain("mtk-tab");
    expect(screen.getByRole("button", { name: "$" })).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Nav keyboard" }));

    expect(screen.getByRole("button", { name: "Control U" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show fewer keys" }).className).toContain("mtk-ghost");
  });
});
