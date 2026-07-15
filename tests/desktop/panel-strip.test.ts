// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  groupLayoutForPanels,
  PanelErrorBoundary,
  panelSizesFromGroupLayout,
} from "@desktop/renderer/src/features/workspace/PanelStrip";
import type { PanelKind } from "@desktop/renderer/src/stores/workspace";

const baseSizes: Record<PanelKind, number> = {
  terminal: 70,
  editor: 30,
  git: 0,
  browser: 0,
  artifacts: 0,
  processes: 0,
};

describe("PanelStrip layout adapters", () => {
  afterEach(cleanup);

  it("passes react-resizable-panels a keyed layout", () => {
    expect(groupLayoutForPanels(["terminal", "editor"], baseSizes)).toEqual({
      terminal: 70,
      editor: 30,
    });
  });

  it("uses an even fallback for newly visible panels without persisted size", () => {
    expect(groupLayoutForPanels(["terminal", "git"], baseSizes)).toEqual({
      terminal: 70,
      git: 50,
    });
  });

  it("maps keyed group layout changes back to persisted panel sizes", () => {
    expect(panelSizesFromGroupLayout(["terminal", "editor"], { terminal: 62, editor: 38 }, baseSizes)).toEqual({
      ...baseSizes,
      terminal: 62,
      editor: 38,
    });
  });

  it("ignores missing and non-finite panel values", () => {
    expect(panelSizesFromGroupLayout(["terminal", "editor"], { terminal: 64, editor: Number.NaN }, baseSizes)).toEqual({
      ...baseSizes,
      terminal: 64,
    });
  });

  it("contains a failing legacy panel without hiding the rest of the task", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    function BrokenPanel(): React.ReactNode {
      throw new Error("private file path");
    }

    render(React.createElement(
      "div",
      null,
      React.createElement(
        PanelErrorBoundary,
        { panel: "terminal" },
        React.createElement(BrokenPanel),
      ),
      React.createElement("p", null, "Files panel remains available"),
    ));

    expect(screen.getByText("Terminal panel couldn't open.")).toBeTruthy();
    expect(screen.getByText("Files panel remains available")).toBeTruthy();
    expect(screen.queryByText(/private file path/i)).toBeNull();
    warn.mockRestore();
  });
});
