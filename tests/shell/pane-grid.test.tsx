// @vitest-environment jsdom

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import type { PaneNode } from "../../shell/src/stores/terminal-store.js";

const terminalPaneSpy = vi.fn();

vi.mock("../../shell/src/components/terminal/TerminalPane.js", () => ({
  TerminalPane: (props: unknown) => {
    terminalPaneSpy(props);
    return null;
  },
}));

import { PaneGrid } from "../../shell/src/components/terminal/PaneGrid.js";

describe("PaneGrid", () => {
  beforeEach(() => {
    terminalPaneSpy.mockReset();
  });

  it("passes session persistence props through to TerminalPane", () => {
    const paneTree: PaneNode = {
      type: "pane",
      id: "pane-1",
      cwd: "projects/app",
      sessionId: "session-1",
      claudeMode: true,
    };
    const onFocusPane = vi.fn();
    const onSessionAttached = vi.fn();
    const shouldCachePane = vi.fn(() => true);

    render(
      <PaneGrid
        paneTree={paneTree}
        theme={{ mode: "dark", colors: {} }}
        focusedPaneId="pane-1"
        onFocusPane={onFocusPane}
        onSessionAttached={onSessionAttached}
        shouldCachePane={shouldCachePane}
      />,
    );

    expect(terminalPaneSpy).toHaveBeenCalledTimes(1);
    expect(terminalPaneSpy).toHaveBeenCalledWith(expect.objectContaining({
      paneId: "pane-1",
      sessionId: "session-1",
      onFocus: onFocusPane,
      onSessionAttached,
      shouldCacheOnUnmount: shouldCachePane,
    }));
  });

  it("keeps pane grid and split wrappers as non-scroll containers", () => {
    const paneTree: PaneNode = {
      type: "split",
      id: "split-1",
      direction: "horizontal",
      ratio: 0.5,
      children: [
        { type: "pane", id: "pane-left", cwd: "" },
        { type: "pane", id: "pane-right", cwd: "" },
      ],
    };

    const { container } = render(
      <PaneGrid
        paneTree={paneTree}
        theme={{ mode: "dark", colors: {} }}
        focusedPaneId="pane-left"
      />,
    );

    const gridRoot = container.firstElementChild;
    expect(gridRoot?.className).toContain("overflow-hidden");

    const divs = Array.from(container.querySelectorAll("div"));
    expect(divs.some((node) => node.className.includes("overflow-auto") || node.className.includes("overflow-scroll"))).toBe(false);
    expect(divs.some((node) => node.style.overflow === "auto" || node.style.overflow === "scroll")).toBe(false);
    expect(divs.filter((node) => node.style.overflow === "hidden")).toHaveLength(2);
  });
});
