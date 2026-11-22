/**
 * Herdr's panes (spec 2706 layer 6): a tab is a tree of rows and columns and
 * every leaf is one terminal. Pure and serializable, so a host can save it
 * per machine and Web can adopt it later.
 */

/** Herdr caps a tab at this many panes; a split past it is refused. */
export const MAX_PANES_PER_TAB = 16;
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;
const EPSILON = 1e-6;

export type PaneDirection = "left" | "right" | "up" | "down";

export interface PaneLeaf {
  type: "leaf";
  id: string;
  /** The terminal shown here, as the host names it (a sidebar row key). */
  terminal: string;
}

export interface PaneSplit {
  type: "split";
  id: string;
  /** `row`: side by side (split right). `column`: one above the other (split down). */
  axis: "row" | "column";
  /** The first child's share of the space. */
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneTab {
  id: string;
  root: PaneNode;
  /** The focused leaf's id. */
  focus: string;
  /** The leaf shown alone, or null. */
  zoom: string | null;
}

export interface PaneRect { x: number; y: number; width: number; height: number }

export function leaves(node: PaneNode): PaneLeaf[] {
  return node.type === "leaf" ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

export function singlePaneTab(terminal: string, id: () => string): PaneTab {
  const leaf: PaneLeaf = { type: "leaf", id: id(), terminal };
  return { id: id(), root: leaf, focus: leaf.id, zoom: null };
}

/** Replaces the node with this id; the tree is copied only along the path. */
function replace(node: PaneNode, targetId: string, make: (found: PaneNode) => PaneNode | null): PaneNode | null {
  if (node.id === targetId) return make(node);
  if (node.type === "leaf") return node;
  const first = replace(node.first, targetId, make);
  const second = replace(node.second, targetId, make);
  if (first === node.first && second === node.second) return node;
  // A child that disappeared leaves its sibling in the split's place.
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

function contains(node: PaneNode, leafId: string): boolean {
  return leaves(node).some((leaf) => leaf.id === leafId);
}

/** Splits a leaf, putting a new terminal to its right or below it, and focuses it. Null past the cap. */
export function splitPane(tab: PaneTab, leafId: string, side: "right" | "down", terminal: string, id: () => string): PaneTab | null {
  if (leaves(tab.root).length >= MAX_PANES_PER_TAB || !contains(tab.root, leafId)) return null;
  const leaf: PaneLeaf = { type: "leaf", id: id(), terminal };
  const root = replace(tab.root, leafId, (found) => ({
    type: "split", id: id(), axis: side === "right" ? "row" : "column", ratio: 0.5, first: found, second: leaf,
  }))!;
  return { ...tab, root, focus: leaf.id, zoom: null };
}

/** Removes a leaf; its sibling takes the space. Null for the last leaf. */
export function closePane(tab: PaneTab, leafId: string): PaneTab | null {
  if (!contains(tab.root, leafId) || tab.root.type === "leaf") return null;
  const root = replace(tab.root, leafId, () => null);
  if (!root) return null;
  const remaining = leaves(root);
  const focus = tab.focus === leafId || !remaining.some((leaf) => leaf.id === tab.focus) ? remaining[0]!.id : tab.focus;
  return { ...tab, root, focus, zoom: tab.zoom === leafId ? null : tab.zoom };
}

/** Each leaf's place in a unit square. */
export function paneRects(node: PaneNode, rect: PaneRect = { x: 0, y: 0, width: 1, height: 1 }, out = new Map<string, PaneRect>()): Map<string, PaneRect> {
  if (node.type === "leaf") {
    out.set(node.id, rect);
    return out;
  }
  if (node.axis === "row") {
    const width = rect.width * node.ratio;
    paneRects(node.first, { ...rect, width }, out);
    paneRects(node.second, { ...rect, x: rect.x + width, width: rect.width - width }, out);
  } else {
    const height = rect.height * node.ratio;
    paneRects(node.first, { ...rect, height }, out);
    paneRects(node.second, { ...rect, y: rect.y + height, height: rect.height - height }, out);
  }
  return out;
}

export interface SplitFrame { id: string; axis: "row" | "column"; ratio: number; rect: PaneRect }

/** Each split's place in a unit square, for drawing its divider. */
export function splitFrames(node: PaneNode, rect: PaneRect = { x: 0, y: 0, width: 1, height: 1 }, out: SplitFrame[] = []): SplitFrame[] {
  if (node.type === "leaf") return out;
  out.push({ id: node.id, axis: node.axis, ratio: node.ratio, rect });
  if (node.axis === "row") {
    const width = rect.width * node.ratio;
    splitFrames(node.first, { ...rect, width }, out);
    splitFrames(node.second, { ...rect, x: rect.x + width, width: rect.width - width }, out);
  } else {
    const height = rect.height * node.ratio;
    splitFrames(node.first, { ...rect, height }, out);
    splitFrames(node.second, { ...rect, y: rect.y + height, height: rect.height - height }, out);
  }
  return out;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

/** The nearest leaf in a direction that shares an edge span with this one, or null. */
export function neighborPane(tab: PaneTab, leafId: string, direction: PaneDirection): string | null {
  const rects = paneRects(tab.root);
  const from = rects.get(leafId);
  if (!from) return null;
  let best: { id: string; distance: number; shared: number } | null = null;
  for (const [id, rect] of rects) {
    if (id === leafId) continue;
    const horizontal = direction === "left" || direction === "right";
    const shared = horizontal
      ? overlap(from.y, from.y + from.height, rect.y, rect.y + rect.height)
      : overlap(from.x, from.x + from.width, rect.x, rect.x + rect.width);
    if (shared <= EPSILON) continue;
    const distance = direction === "left" ? from.x - (rect.x + rect.width)
      : direction === "right" ? rect.x - (from.x + from.width)
        : direction === "up" ? from.y - (rect.y + rect.height)
          : rect.y - (from.y + from.height);
    if (distance < -EPSILON) continue;
    if (!best || distance < best.distance - EPSILON || (Math.abs(distance - best.distance) <= EPSILON && shared > best.shared)) {
      best = { id, distance, shared };
    }
  }
  return best?.id ?? null;
}

export function focusPane(tab: PaneTab, direction: PaneDirection): PaneTab {
  const target = neighborPane(tab, tab.focus, direction);
  return target ? { ...tab, focus: target, zoom: tab.zoom ? target : null } : tab;
}

/** Swaps the focused terminal with its neighbor's; focus stays on the moved terminal. */
export function swapPanes(tab: PaneTab, direction: PaneDirection): PaneTab {
  const target = neighborPane(tab, tab.focus, direction);
  if (!target) return tab;
  const terminals = new Map(leaves(tab.root).map((leaf) => [leaf.id, leaf.terminal]));
  const focused = terminals.get(tab.focus)!;
  const other = terminals.get(target)!;
  let root = replace(tab.root, tab.focus, (found) => ({ ...found, terminal: other } as PaneLeaf))!;
  root = replace(root, target, (found) => ({ ...found, terminal: focused } as PaneLeaf))!;
  return { ...tab, root, focus: target, zoom: null };
}

export function resizeSplit(tab: PaneTab, splitId: string, ratio: number): PaneTab {
  const clamped = Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
  const root = replace(tab.root, splitId, (found) => (found.type === "split" ? { ...found, ratio: clamped } : found))!;
  return root === tab.root ? tab : { ...tab, root };
}

export function toggleZoom(tab: PaneTab): PaneTab {
  return { ...tab, zoom: tab.zoom ? null : tab.focus };
}

/**
 * Drag a pane onto another pane's edge: the dragged pane leaves its place and
 * the target splits in that direction, the dragged pane on that side.
 */
export function movePane(tab: PaneTab, sourceId: string, targetId: string, edge: PaneDirection, id: () => string): PaneTab {
  if (sourceId === targetId || !contains(tab.root, sourceId) || !contains(tab.root, targetId)) return tab;
  const source = leaves(tab.root).find((leaf) => leaf.id === sourceId)!;
  const without = replace(tab.root, sourceId, () => null);
  if (!without) return tab;
  const before = edge === "left" || edge === "up";
  const root = replace(without, targetId, (found) => ({
    type: "split", id: id(), axis: edge === "left" || edge === "right" ? "row" : "column", ratio: 0.5,
    first: before ? source : found, second: before ? found : source,
  }))!;
  return { ...tab, root, focus: sourceId, zoom: null };
}

/** Drops leaves whose terminal is gone. Null when none is left; the same tab when nothing changed. */
export function pruneTab(tab: PaneTab, alive: (terminal: string) => boolean): PaneTab | null {
  const dead = leaves(tab.root).filter((leaf) => !alive(leaf.terminal));
  if (dead.length === 0) return tab;
  let root: PaneNode | null = tab.root;
  for (const leaf of dead) {
    if (!root) break;
    root = replace(root, leaf.id, () => null);
  }
  if (!root) return null;
  const remaining = leaves(root);
  const focus = remaining.some((leaf) => leaf.id === tab.focus) ? tab.focus : remaining[0]!.id;
  const zoom = tab.zoom && remaining.some((leaf) => leaf.id === tab.zoom) ? tab.zoom : null;
  return { ...tab, root, focus, zoom };
}

const RESIZE_STEP = 0.05;

/**
 * Moves the divider nearest the focused pane on that axis (left/up shrink
 * the first side, right/down grow it), as Zellij's resize keys did.
 */
export function resizeFocusedPane(tab: PaneTab, direction: PaneDirection): PaneTab {
  const axis = direction === "left" || direction === "right" ? "row" : "column";
  const path: PaneSplit[] = [];
  const walk = (node: PaneNode): boolean => {
    if (node.type === "leaf") return node.id === tab.focus;
    path.push(node);
    if (walk(node.first) || walk(node.second)) return true;
    path.pop();
    return false;
  };
  if (!walk(tab.root)) return tab;
  const split = [...path].reverse().find((candidate) => candidate.axis === axis);
  if (!split) return tab;
  return resizeSplit(tab, split.id, split.ratio + (direction === "left" || direction === "up" ? -RESIZE_STEP : RESIZE_STEP));
}
