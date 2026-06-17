import { describe, expect, it } from "vitest";
import {
  groupLayoutForPanels,
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
});
