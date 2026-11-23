import { memo, useMemo } from "react";
import type { GridContext, GridLayout } from "./context";
import { type PaneSpec, buildPane } from "./render-model";
import type { Selection } from "./selection";

export interface GridPaneProps {
  ctx: GridContext;
  layout: GridLayout;
  pane: PaneSpec;
  gridId: string;
  selection: Selection;
  /** Grows when the workbook changes. */
  revision: number;
  /** Grows when decorations change. */
  decorations: number;
  editing: { sheet: string; row: number; col: number } | null;
}

/**
 * One part of the cell area: grid lines and the cells that hold something.
 * Rows are `role="row"` and cells `role="gridcell"`, positioned absolutely.
 */
export const GridPane = memo(function GridPane({ ctx, layout, pane, gridId, selection, revision, decorations, editing }: GridPaneProps) {
  const model = useMemo(
    () => buildPane(ctx, layout, pane, { gridId, selection, editing }),
    // `revision` and `decorations` stand for workbook and decoration content, which the model reads through `ctx`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, layout, pane, gridId, selection, editing, revision, decorations],
  );
  return (
    <div className={`sg-pane sg-pane--${pane.id}`} style={{ left: pane.x, top: pane.y, width: pane.width, height: pane.height }}>
      <div className="sg-lines" aria-hidden="true">
        {model.horizontal.map((y) => (
          <div key={`h${y}`} className="sg-line sg-line--h" style={{ top: y }} />
        ))}
        {model.vertical.map((x) => (
          <div key={`v${x}`} className="sg-line sg-line--v" style={{ left: x }} />
        ))}
      </div>
      {model.rows.map((row) => (
        <div key={row.row} role="row" aria-rowindex={row.row + 2} className="sg-row" style={{ top: row.top, height: row.height }}>
          {row.cells.map((cell) => (
            <div
              key={cell.col}
              id={pane.rows.start <= cell.row && pane.cols.start <= cell.col ? cell.id : `${cell.id}-${pane.id}`}
              role="gridcell"
              aria-colindex={cell.col + 2}
              aria-selected={cell.selected}
              aria-description={cell.description}
              title={cell.title}
              data-row={cell.row}
              data-col={cell.col}
              data-change-id={cell.changeId}
              className={cell.className}
              style={{ ...cell.css, left: cell.left, width: cell.width, height: cell.height }}
            >
              {cell.text === "" ? null : <span className="sg-cell__text">{cell.text}</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
});
