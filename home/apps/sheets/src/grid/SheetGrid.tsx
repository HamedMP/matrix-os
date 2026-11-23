import { type Ref, useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useSyncExternalStore } from "react";
import type { SheetSession } from "../session/session";
import { CellEditor } from "./CellEditor";
import { type GridSelection, SheetGridController } from "./controller";
import { FormulaBar } from "./FormulaBar";
import { HEADER_HEIGHT_PX, ROW_HEADER_WIDTH_PX } from "./geometry";
import { handleCopy, handleGridKey, handlePaste } from "./grid-keys";
import { GridMouse } from "./grid-mouse";
import { GridBody } from "./GridBody";
import { GridMenu } from "./GridMenu";
import { activeOnScreen, cellElementId, describeActiveCell } from "./render-model";
import "./sheet-grid.css";
import "./sheet-grid-chrome.css";
import { useGridEditing } from "./use-grid-editing";
import { useGridScroll } from "./use-grid-scroll";

export interface SheetGridProps {
  session: SheetSession;
  /** The controller to use. Without it the grid makes its own; get it through `ref`. */
  controller?: SheetGridController;
  /** Receives the controller. */
  ref?: Ref<SheetGridController>;
  /** Shows the address box and the content input above the grid. Default true. */
  showFormulaBar?: boolean;
  /** Blocks every change to the workbook; selecting, scrolling and copying still work. */
  readOnly?: boolean;
  className?: string;
  /** Name of the grid for screen readers. Default "Spreadsheet". */
  label?: string;
  onSelectionChange?(selection: GridSelection): void;
}

/** The spreadsheet grid for a session's active sheet. See `./index.ts`. */
export function SheetGrid({ session, controller, ref, showFormulaBar = true, readOnly = false, className, label = "Spreadsheet", onSelectionChange }: SheetGridProps) {
  const own = useMemo(() => controller ?? new SheetGridController(session), [controller, session]);
  const ctx = own.context;
  const gridId = useId();
  const listId = `${gridId}-functions`;
  const scroller = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const mouse = useMemo(() => new GridMouse(ctx, () => surface.current), [ctx]);
  const focusGrid = useCallback(() => surface.current?.focus({ preventScroll: true }), []);

  useImperativeHandle(ref, () => own, [own]);

  useEffect(() => {
    own.attach();
    own.focusGrid = focusGrid;
    return () => {
      own.focusGrid = null;
      // A controller passed in belongs to the caller, who disposes it.
      if (controller === undefined) own.dispose();
    };
  }, [own, controller, focusGrid]);

  useEffect(() => () => mouse.dispose(), [mouse]);

  useEffect(() => (onSelectionChange === undefined ? undefined : own.onSelectionChange(onSelectionChange)), [own, onSelectionChange]);

  const subscribeSession = useCallback((notify: () => void) => session.subscribe(notify), [session]);
  const sessionState = useSyncExternalStore(subscribeSession, () => session.getState());
  const state = useSyncExternalStore(ctx.store.subscribe, ctx.store.getState);

  const layout = ctx.layout();
  const view = ctx.store.view(layout.sheet);
  const selection = view.selection;
  const edit = state.edit;
  const scroll = useGridScroll(ctx, scroller, layout);

  const editing = useGridEditing(ctx, edit, listId, root, focusGrid);

  const surfaceWidth = ROW_HEADER_WIDTH_PX + state.width;
  const surfaceHeight = HEADER_HEIGHT_PX + state.height;

  return (
    <div ref={root} className={`sheet-grid${className === undefined ? "" : ` ${className}`}${readOnly ? " is-readonly" : ""}`}>
      {showFormulaBar ? (
        <FormulaBar
          ctx={ctx}
          edit={edit}
          readOnly={readOnly}
          listId={listId}
          activeOptionId={editing.activeOptionId}
          onKey={editing.onKey}
          onNavigate={focusGrid}
          popup={editing.popupAt(0, 30)}
        />
      ) : null}
      <div ref={scroller} className="sg-scroller" onScroll={scroll.onScroll}>
        <div className="sg-sizer" style={{ width: surfaceWidth + scroll.nativeWidth, height: surfaceHeight + scroll.nativeHeight }}>
          <div
            ref={surface}
            className="sg-surface"
            role="grid"
            tabIndex={0}
            aria-label={label}
            aria-rowcount={layout.extent.rows + 1}
            aria-colcount={layout.extent.cols + 1}
            aria-multiselectable="true"
            aria-readonly={readOnly ? true : undefined}
            aria-activedescendant={activeOnScreen(layout, selection.active) ? cellElementId(gridId, selection.active.row, selection.active.col) : undefined}
            style={{ width: surfaceWidth, height: surfaceHeight }}
            onKeyDown={(event) => {
              if (event.target === event.currentTarget && handleGridKey(ctx, event, readOnly)) event.preventDefault();
            }}
            onCopy={(event) => handleCopy(ctx, event, false, readOnly)}
            onCut={(event) => handleCopy(ctx, event, true, readOnly)}
            onPaste={(event) => handlePaste(ctx, event, readOnly)}
            onMouseDown={(event) => mouse.down(event, readOnly)}
            onDoubleClick={(event) => mouse.doubleClick(event, readOnly)}
            onContextMenu={(event) => mouse.contextMenu(event)}
          >
            <GridBody
              ctx={ctx}
              layout={layout}
              gridId={gridId}
              selection={selection}
              revision={sessionState.revision}
              decorations={state.decorations}
              edit={edit}
              fill={state.fill}
              copy={state.copy}
              filtered={view.filter !== null}
              width={state.width}
              height={state.height}
            />
            {edit === null ? null : (
              <CellEditor ctx={ctx} layout={layout} edit={edit} areaWidth={state.width} listId={listId} activeOptionId={editing.activeOptionId} onKey={editing.onKey} popupAt={editing.popupAt} />
            )}
            {state.menu === null ? null : <GridMenu ctx={ctx} menu={state.menu} readOnly={readOnly} onDone={focusGrid} />}
          </div>
        </div>
      </div>
      {state.notice === null ? null : (
        <div className="sg-notice" role="alert">
          <span>{state.notice}</span>
          <button type="button" className="sg-notice__close" aria-label="Dismiss" onClick={() => ctx.notice(null)}>
            ×
          </button>
        </div>
      )}
      <div className="sg-live" role="status" aria-live="polite" aria-atomic="true">
        {describeActiveCell(ctx)}
      </div>
    </div>
  );
}
