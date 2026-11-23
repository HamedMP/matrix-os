import { memo } from "react";
import type { CellRange } from "../session/engine";
import type { GridLayout } from "./context";
import type { FormulaRef } from "./formula-edit";
import { type Selection, activeRange, mergeAt } from "./selection";
import type { CopyMark, FillDrag } from "./store";
import { rangeOnScreen } from "./viewport";

export interface GridOverlaysProps {
  layout: GridLayout;
  selection: Selection;
  /** Ranges a formula being edited refers to on this sheet, with their colours. */
  references: readonly FormulaRef[];
  fill: FillDrag | null;
  /** The copied cells, when they are on this sheet. */
  copy: CopyMark | null;
  /** False while a cell is edited: the fill handle and the active outline give way to the editor. */
  showActive: boolean;
}

function box(layout: GridLayout, range: CellRange): { left: number; top: number; width: number; height: number } | null {
  const rect = rangeOnScreen(layout.axes, layout.viewport, range);
  return rect === null ? null : { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

/** Everything drawn over the cells: the selection, the active cell, the fill handle, copy and formula outlines. */
export const GridOverlays = memo(function GridOverlays({ layout, selection, references, fill, copy, showActive }: GridOverlaysProps) {
  const merges = layout.info.mergedRanges;
  const activeMerge = mergeAt(merges, selection.active.row, selection.active.col);
  const activeBox = box(layout, activeMerge ?? { start: selection.active, end: selection.active });
  const range = activeRange(selection);
  const rangeBox = box(layout, range);
  const fillBox = fill !== null && fill.target !== null ? box(layout, fill.target) : null;
  const copyBox = copy === null ? null : box(layout, copy.range);
  return (
    <div className="sg-overlays" aria-hidden="true">
      {selection.ranges.map((entry, index) => {
        const rect = box(layout, entry);
        if (rect === null) return null;
        const single = entry.start.row === entry.end.row && entry.start.col === entry.end.col;
        return <div key={`${entry.start.row}:${entry.start.col}:${entry.end.row}:${entry.end.col}:${index}`} className={`sg-selection${single ? " is-single" : ""}${index === selection.ranges.length - 1 ? " is-current" : ""}`} style={rect} />;
      })}
      {references.map((reference, index) => {
        const rect = box(layout, reference.range);
        return rect === null ? null : <div key={`${index}-${reference.start}`} className={`sg-reference sg-reference--${reference.color}`} style={rect} />;
      })}
      {copyBox === null ? null : <div className={`sg-copy${copy?.cut === true ? " is-cut" : ""}`} style={copyBox} />}
      {fillBox === null ? null : <div className="sg-fill-target" style={fillBox} />}
      {showActive && activeBox !== null ? <div className="sg-active" style={activeBox} /> : null}
      {showActive && rangeBox !== null && range.kind === "cells" ? (
        <div className="sg-fill-handle" data-fill-handle="true" style={{ left: rangeBox.left + rangeBox.width - 4, top: rangeBox.top + rangeBox.height - 4 }} />
      ) : null}
    </div>
  );
});
