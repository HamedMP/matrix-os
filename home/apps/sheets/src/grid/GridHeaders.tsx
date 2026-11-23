import { memo } from "react";
import { columnLabel } from "../session/engine";
import type { GridLayout } from "./context";
import { HEADER_HEIGHT_PX, ROW_HEADER_WIDTH_PX } from "./geometry";
import { type Selection, columnFullySelected, columnTouched, rowFullySelected, rowTouched } from "./selection";
import { type Span, columnX, rowY } from "./viewport";

export interface GridHeadersProps {
  layout: GridLayout;
  selection: Selection;
  /** True when a filter hides rows; the corner shows it. */
  filtered: boolean;
}

function indexes(frozen: Span, scrolling: Span): number[] {
  const out: number[] = [];
  for (let index = frozen.start; index <= frozen.end; index++) out.push(index);
  for (let index = scrolling.start; index <= scrolling.end; index++) out.push(index);
  return out;
}

function headerClass(base: string, selected: boolean, touched: boolean, frozen: boolean): string {
  return `${base}${selected ? " is-selected" : touched ? " is-touched" : ""}${frozen ? " is-frozen" : ""}`;
}

/**
 * Column letters, row numbers and the select-all corner, with a grip on each
 * edge for resizing. The pointer logic lives in the grid; the elements carry
 * `data-header`, `data-index` and `data-resize` for it.
 */
export const GridHeaders = memo(function GridHeaders({ layout, selection, filtered }: GridHeadersProps) {
  const { axes, viewport } = layout;
  const columns = indexes(viewport.frozenCols, viewport.cols);
  const rows = indexes(viewport.frozenRows, viewport.rows);
  return (
    <>
      <div role="row" aria-rowindex={1} className="sg-colheads" style={{ left: ROW_HEADER_WIDTH_PX, height: HEADER_HEIGHT_PX }}>
        {columns.map((col) => {
          const width = axes.cols.sizeOf(col);
          if (width === 0) return null;
          const frozen = col <= viewport.frozenCols.end;
          const left = columnX(axes, viewport, col);
          // A scrolling header that slid under the frozen ones is not drawn.
          if (!frozen && left + width <= viewport.frozenWidth) return null;
          const label = columnLabel(col);
          return (
            <div
              key={col}
              role="columnheader"
              aria-colindex={col + 2}
              aria-label={`Column ${label}`}
              aria-selected={columnFullySelected(selection, col)}
              data-header="col"
              data-index={col}
              className={headerClass("sg-head sg-head--col", columnFullySelected(selection, col), columnTouched(selection, col), frozen)}
              style={{ left, width, height: HEADER_HEIGHT_PX }}
            >
              {label}
              <span className="sg-grip sg-grip--col" data-resize="col" data-index={col} role="separator" aria-orientation="vertical" aria-label={`Resize column ${label}`} />
            </div>
          );
        })}
      </div>
      <div className="sg-rowheads" style={{ top: HEADER_HEIGHT_PX, width: ROW_HEADER_WIDTH_PX }}>
        {rows.map((row) => {
          const height = axes.rows.sizeOf(row);
          if (height === 0) return null;
          const frozen = row <= viewport.frozenRows.end;
          const top = rowY(axes, viewport, row);
          if (!frozen && top + height <= viewport.frozenHeight) return null;
          return (
            <div
              key={row}
              role="row"
              aria-rowindex={row + 2}
              data-header="row"
              data-index={row}
              className={headerClass("sg-head sg-head--row", rowFullySelected(selection, row), rowTouched(selection, row), frozen)}
              style={{ top, height, width: ROW_HEADER_WIDTH_PX }}
            >
              <span role="rowheader" aria-label={`Row ${row + 1}`} aria-selected={rowFullySelected(selection, row)}>
                {row + 1}
              </span>
              <span className="sg-grip sg-grip--row" data-resize="row" data-index={row} role="separator" aria-orientation="horizontal" aria-label={`Resize row ${row + 1}`} />
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className={`sg-corner${filtered ? " is-filtered" : ""}`}
        data-header="all"
        tabIndex={-1}
        aria-label={filtered ? "Select all cells. Some rows are hidden by a filter." : "Select all cells"}
        title={filtered ? "Some rows are hidden by a filter" : "Select all"}
        style={{ width: ROW_HEADER_WIDTH_PX, height: HEADER_HEIGHT_PX }}
      />
    </>
  );
});
