// @vitest-environment jsdom

import React from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalKeyBar } from "../../shell/src/components/terminal/TerminalKeyBar.js";

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
  });

  it("uses virtual keyboard env inset when visualViewport has no keyboard overlap", () => {
    render(<TerminalKeyBar onSend={vi.fn()} />);

    const keyBar = screen.getByTestId("terminal-key-bar");
    expect(keyBar.style.getPropertyValue("--matrix-terminal-keybar-bottom")).toBe("env(keyboard-inset-height, 0px)");
  });

  it("tracks visualViewport keyboard overlap for mobile browsers without keyboard-inset env support", () => {
    const viewport = installVisualViewportMock({ height: 560, offsetTop: 0 });

    render(<TerminalKeyBar onSend={vi.fn()} />);

    const keyBar = screen.getByTestId("terminal-key-bar");
    expect(keyBar.style.getPropertyValue("--matrix-terminal-keybar-bottom")).toBe("240px");

    act(() => {
      viewport.height = 800;
      viewport.dispatch("resize");
    });

    expect(keyBar.style.getPropertyValue("--matrix-terminal-keybar-bottom")).toBe("env(keyboard-inset-height, 0px)");
  });
});
