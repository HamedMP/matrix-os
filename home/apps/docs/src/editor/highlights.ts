/**
 * Highlight layers: named, independent lists of ranges to paint (search hits,
 * the active comment, agent proposals). They are turned into per-paragraph
 * spans that the renderer cuts leaves at; the document itself is not touched.
 */

import type { BlockId } from "../../../_shared/office-engine/index";
import type { ModelIndex } from "./model-index";
import type { HighlightSpan } from "./render-paragraph";
import type { EditorHighlight } from "./types";

/** Most highlights one layer keeps; the rest are dropped. */
export const MAX_HIGHLIGHTS_PER_LAYER = 5_000;
/** Most layers; setting another one is ignored. */
export const MAX_HIGHLIGHT_LAYERS = 32;
/** Stands for "to the end of the paragraph". */
const END = Number.MAX_SAFE_INTEGER;

const LAYER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function isLayerName(layer: string): boolean {
  return LAYER_NAME.test(layer);
}

function addSpan(spans: Map<BlockId, HighlightSpan[]>, blockId: BlockId, span: HighlightSpan): void {
  if (span.from >= span.to) return;
  const list = spans.get(blockId);
  if (list === undefined) spans.set(blockId, [span]);
  else list.push(span);
}

/** The spans of every layer by paragraph. Ranges that name unknown blocks are left out. */
export function buildSpans(layers: ReadonlyMap<string, readonly EditorHighlight[]>, index: ModelIndex): Map<BlockId, HighlightSpan[]> {
  const spans = new Map<BlockId, HighlightSpan[]>();
  for (const [layer, highlights] of layers) {
    for (const highlight of highlights) {
      const { start, end } = highlight.range;
      const base = { layer, id: highlight.id ?? null, className: highlight.className ?? null };
      if (start.blockId === end.blockId) {
        if (index.entry(start.blockId) !== null) addSpan(spans, start.blockId, { ...base, from: start.offset, to: end.offset });
        continue;
      }
      const entries = index.between(start.blockId, end.blockId);
      entries.forEach((entry, at) => {
        const from = at === 0 ? start.offset : 0;
        const to = at === entries.length - 1 ? end.offset : END;
        addSpan(spans, entry.id, { ...base, from, to });
      });
    }
  }
  return spans;
}

/** The paragraphs whose spans differ between two span maps. */
export function changedBlocks(before: ReadonlyMap<BlockId, HighlightSpan[]>, after: ReadonlyMap<BlockId, HighlightSpan[]>): BlockId[] {
  const changed: BlockId[] = [];
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (JSON.stringify(before.get(id) ?? []) !== JSON.stringify(after.get(id) ?? [])) changed.push(id);
  }
  return changed;
}

/** The layers of one editor and the spans last built from them. */
export class HighlightLayers {
  private readonly layers = new Map<string, readonly EditorHighlight[]>();
  private current = new Map<BlockId, HighlightSpan[]>();

  get spans(): Map<BlockId, HighlightSpan[]> {
    return this.current;
  }

  /** Replaces one layer; an empty list removes it. */
  set(layer: string, highlights: readonly EditorHighlight[]): void {
    if (!isLayerName(layer)) throw new Error("a highlight layer name is lower-case letters, digits and hyphens");
    if (highlights.length === 0) this.layers.delete(layer);
    else if (this.layers.has(layer) || this.layers.size < MAX_HIGHLIGHT_LAYERS) this.layers.set(layer, highlights.slice(0, MAX_HIGHLIGHTS_PER_LAYER));
  }

  /** Removes one layer, or all of them. */
  clear(layer?: string): void {
    if (layer === undefined) this.layers.clear();
    else this.layers.delete(layer);
  }

  /** Builds the spans for a document structure again. Returns the paragraphs whose spans changed. */
  rebuild(index: ModelIndex): BlockId[] {
    const next = buildSpans(this.layers, index);
    const changed = changedBlocks(this.current, next);
    this.current = next;
    return changed;
  }
}
