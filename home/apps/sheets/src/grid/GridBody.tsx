import { memo, useMemo } from "react";
import type { SheetId } from "../session/engine";
import type { GridContext, GridLayout } from "./context";
import { scanReferences } from "./formula-edit";
import { HEADER_HEIGHT_PX, ROW_HEADER_WIDTH_PX } from "./geometry";
import { GridHeaders } from "./GridHeaders";
import { GridOverlays } from "./GridOverlays";
import { GridPane } from "./GridPane";
import { paneSpecs } from "./render-model";
import type { Selection } from "./selection";
import type { CopyMark, EditState, FillDrag } from "./store";

export interface GridBodyProps {
  ctx: GridContext;
  layout: GridLayout;
  gridId: string;
  selection: Selection;
  /** Grows when the workbook changes. */
  revision: number;
  /** Grows when decorations change. */
  decorations: number;
  edit: EditState | null;
  fill: FillDrag | null;
  copy: CopyMark | null;
  filtered: boolean;
  width: number;
  height: number;
}

/** The references of the formula being edited that point into a sheet. */
function referencesOn(edit: EditState | null, sheet: SheetId, sheetName: string) {
  if (edit === null) return [];
  const name = sheetName.toLowerCase();
  return scanReferences(edit.text).filter((reference) => (reference.sheet === null ? edit.sheet === sheet : reference.sheet.toLowerCase() === name));
}

/** The drawn part of the grid: the panes of cells, what lies over them, and the headers. */
export const GridBody = memo(function GridBody(props: GridBodyProps) {
  const { ctx, layout, gridId, selection, revision, decorations, edit, fill, copy, filtered, width, height } = props;
  const { viewport, sheet } = layout;
  const sheetName = layout.info.name;
  const panes = useMemo(() => paneSpecs(layout), [layout]);
  const editing = useMemo(() => (edit === null ? null : { sheet: edit.sheet, row: edit.cell.row, col: edit.cell.col }), [edit]);
  const references = useMemo(() => referencesOn(edit, sheet, sheetName), [edit, sheet, sheetName]);
  const copyHere = copy !== null && copy.sheet === sheet ? copy : null;
  return (
    <>
      <div className="sg-cells" style={{ left: ROW_HEADER_WIDTH_PX, top: HEADER_HEIGHT_PX, width, height }}>
        {panes.map((pane) => (
          <GridPane key={pane.id} ctx={ctx} layout={layout} pane={pane} gridId={gridId} selection={selection} revision={revision} decorations={decorations} editing={editing} />
        ))}
        <GridOverlays layout={layout} selection={selection} references={references} fill={fill} copy={copyHere} showActive={edit === null} />
        {viewport.frozenHeight > 0 ? <div className="sg-freeze sg-freeze--h" style={{ top: viewport.frozenHeight - 1 }} aria-hidden="true" /> : null}
        {viewport.frozenWidth > 0 ? <div className="sg-freeze sg-freeze--v" style={{ left: viewport.frozenWidth - 1 }} aria-hidden="true" /> : null}
      </div>
      <GridHeaders layout={layout} selection={selection} filtered={filtered} />
    </>
  );
});
