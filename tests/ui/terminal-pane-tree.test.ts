import { describe, expect, it } from "vitest";
import {
  closePane,
  focusPane,
  leaves,
  MAX_PANES_PER_TAB,
  movePane,
  neighborPane,
  paneRects,
  pruneTab,
  resizeSplit,
  singlePaneTab,
  splitPane,
  swapPanes,
  toggleZoom,
  type PaneTab,
} from "../../packages/ui/src/terminal-pane-tree/index.js";

// Spec 2706 layer 6: a tab is a tree of rows and columns with one terminal
// per leaf, as in Herdr; split, close, focus, swap, resize, zoom and drag.

let next = 0;
const id = () => `p${++next}`;
const terms = (tab: PaneTab) => leaves(tab.root).map((leaf) => leaf.terminal);

function grid(): PaneTab {
  // a | b
  //   | c
  let tab = singlePaneTab("a", id);
  tab = splitPane(tab, tab.focus, "right", "b", id)!;
  tab = splitPane(tab, tab.focus, "down", "c", id)!;
  return tab;
}

describe("terminal pane tree", () => {
  it("splits right and down, focusing the new terminal", () => {
    const tab = grid();
    expect(terms(tab)).toEqual(["a", "b", "c"]);
    expect(leaves(tab.root).find((leaf) => leaf.id === tab.focus)?.terminal).toBe("c");
    const rects = paneRects(tab.root);
    const byTerminal = Object.fromEntries(leaves(tab.root).map((leaf) => [leaf.terminal, rects.get(leaf.id)]));
    expect(byTerminal).toEqual({
      a: { x: 0, y: 0, width: 0.5, height: 1 },
      b: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
      c: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
    });
  });

  it("refuses a split past 16 panes", () => {
    let tab = singlePaneTab("t0", id);
    for (let index = 1; index < MAX_PANES_PER_TAB; index += 1) tab = splitPane(tab, tab.focus, index % 2 ? "right" : "down", `t${index}`, id)!;
    expect(leaves(tab.root)).toHaveLength(16);
    expect(splitPane(tab, tab.focus, "right", "t16", id)).toBeNull();
  });

  it("moves focus and swaps by direction", () => {
    let tab = grid();
    const leafOf = (terminal: string) => leaves(tab.root).find((leaf) => leaf.terminal === terminal)!.id;
    expect(neighborPane(tab, leafOf("c"), "up")).toBe(leafOf("b"));
    expect(neighborPane(tab, leafOf("c"), "left")).toBe(leafOf("a"));
    expect(neighborPane(tab, leafOf("a"), "left")).toBeNull();
    tab = focusPane(tab, "left");
    expect(tab.focus).toBe(leafOf("a"));
    // Swapping moves the focused terminal and keeps focus on it.
    tab = swapPanes(tab, "right");
    expect(terms(tab)).toEqual(["b", "a", "c"]);
    expect(leaves(tab.root).find((leaf) => leaf.id === tab.focus)?.terminal).toBe("a");
    expect(swapPanes(tab, "up")).toBe(tab);
  });

  it("closes a pane, giving its space to its sibling, and never closes the last", () => {
    const tab = grid();
    const b = leaves(tab.root).find((leaf) => leaf.terminal === "b")!.id;
    const closed = closePane(tab, b)!;
    expect(terms(closed)).toEqual(["a", "c"]);
    expect(paneRects(closed.root).get(leaves(closed.root)[1]!.id)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
    expect(closePane(singlePaneTab("x", id), singlePaneTab("x", id).focus)).toBeNull();
  });

  it("resizes a split within bounds and zooms the focused pane", () => {
    let tab = grid();
    const split = tab.root.type === "split" ? tab.root.id : "";
    tab = resizeSplit(tab, split, 0.97);
    expect(tab.root.type === "split" && tab.root.ratio).toBe(0.9);
    tab = toggleZoom(tab);
    expect(tab.zoom).toBe(tab.focus);
    expect(toggleZoom(tab).zoom).toBeNull();
  });

  it("drags a pane onto another pane's edge to split there", () => {
    const tab = grid();
    const leafOf = (terminal: string) => leaves(tab.root).find((leaf) => leaf.terminal === terminal)!.id;
    // c onto a's top edge: a column of c over a, beside b.
    const moved = movePane(tab, leafOf("c"), leafOf("a"), "up", id);
    expect(terms(moved)).toEqual(["c", "a", "b"]);
    const rects = paneRects(moved.root);
    const at = (terminal: string) => rects.get(leaves(moved.root).find((leaf) => leaf.terminal === terminal)!.id);
    expect(at("c")).toEqual({ x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(at("b")).toEqual({ x: 0.5, y: 0, width: 0.5, height: 1 });
    expect(leaves(moved.root).find((leaf) => leaf.id === moved.focus)?.terminal).toBe("c");
    // Dropping a pane on itself changes nothing.
    expect(movePane(tab, leafOf("a"), leafOf("a"), "left", id)).toBe(tab);
  });

  it("drops panes whose terminal is gone and keeps focus valid", () => {
    const tab = toggleZoom(grid());
    const pruned = pruneTab(tab, (terminal) => terminal !== "c")!;
    expect(terms(pruned)).toEqual(["a", "b"]);
    expect(leaves(pruned.root).some((leaf) => leaf.id === pruned.focus)).toBe(true);
    expect(pruned.zoom).toBeNull();
    expect(pruneTab(tab, () => false)).toBeNull();
    expect(pruneTab(tab, () => true)).toBe(tab);
  });
});

describe("resizing the focused pane by key", () => {
  it("moves the nearest divider on that axis and leaves a tab without one alone", async () => {
    const { resizeFocusedPane } = await import("../../packages/ui/src/terminal-pane-tree/index.js");
    const tab = grid();
    const narrower = resizeFocusedPane(tab, "left");
    expect(narrower.root.type === "split" && narrower.root.ratio).toBeCloseTo(0.45);
    const taller = resizeFocusedPane(tab, "down");
    const column = taller.root.type === "split" && taller.root.second.type === "split" ? taller.root.second.ratio : 0;
    expect(column).toBeCloseTo(0.55);
    const single = singlePaneTab("x", id);
    expect(resizeFocusedPane(single, "right")).toBe(single);
  });
});
