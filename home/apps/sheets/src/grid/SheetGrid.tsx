import {
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { SheetSession } from "../session/session";
import { copySelection, pasteClipboard } from "./actions-clipboard";
import { acceptCompletion, argumentHint, completionView, editorKey, updateEditCaret, updateEditText } from "./actions-edit";
import { CELL_PADDING_PX, DEFAULT_FONT_PX, textWidth } from "./cell-look";
import { runGridCommand } from "./commands";
import { type GridSelection, SheetGridController } from "./controller";
import { scanReferences } from "./formula-edit";
import { FormulaBar } from "./FormulaBar";
import { FormulaInput } from "./FormulaInput";
import { FunctionPopup, optionId } from "./FunctionPopup";
import { HEADER_HEIGHT_PX, ROW_HEADER_WIDTH_PX } from "./geometry";
import { GridHeaders } from "./GridHeaders";
import { GridMenu } from "./GridMenu";
import { GridOverlays } from "./GridOverlays";
import { GridPane } from "./GridPane";
import { type GridCommand, gridKeyCommand, keyInputOf } from "./keymap";
import { cellElementId, describeActiveCell, paneSpecs } from "./render-model";
import { mergeAt } from "./selection";
import "./sheet-grid.css";
import "./sheet-grid-chrome.css";
import { useGridMouse } from "./use-grid-mouse";
import { createScrollScale, maxScroll, rangeOnScreen } from "./viewport";

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

/** Commands that change the workbook, refused when the grid is read-only. */
const CHANGING: ReadonlySet<GridCommand["type"]> = new Set(["edit", "clear", "undo", "redo", "fill", "format"]);

const EDITOR_FONT = { fontPx: DEFAULT_FONT_PX, bold: false, italic: false, fontFamily: "system-ui, sans-serif" };

/**
 * The spreadsheet grid for a session's active sheet. See `./index.ts`.
 */
export function SheetGrid({ session, controller, ref, showFormulaBar = true, readOnly = false, className, label = "Spreadsheet", onSelectionChange }: SheetGridProps) {
  const own = useMemo(() => controller ?? new SheetGridController(session), [controller, session]);
  const ctx = own.context;
  const gridId = useId();
  const listId = `${gridId}-functions`;
  const scroller = useRef<HTMLDivElement | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  useImperativeHandle(ref, () => own, [own]);

  useEffect(() => {
    own.attach();
    own.focusGrid = () => surface.current?.focus({ preventScroll: true });
    return () => {
      own.focusGrid = null;
      // A controller passed in belongs to the caller, who disposes it.
      if (controller === undefined) own.dispose();
    };
  }, [own, controller]);

  useEffect(() => (onSelectionChange === undefined ? undefined : own.onSelectionChange(onSelectionChange)), [own, onSelectionChange]);

  const subscribeSession = useCallback((notify: () => void) => session.subscribe(notify), [session]);
  const sessionState = useSyncExternalStore(subscribeSession, () => session.getState());
  const state = useSyncExternalStore(ctx.store.subscribe, ctx.store.getState);

  const layout = ctx.layout();
  const { viewport, axes, sheet } = layout;
  const view = ctx.store.view(sheet);
  const selection = view.selection;
  const edit = state.edit;
  const limit = maxScroll(layout.viewportInput);
  const scaleX = useMemo(() => createScrollScale(limit.left), [limit.left]);
  const scaleY = useMemo(() => createScrollScale(limit.top), [limit.top]);

  // Measure the room for cells and follow resizes.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = (): void => {
      const width = element.clientWidth - ROW_HEADER_WIDTH_PX;
      const height = element.clientHeight - HEADER_HEIGHT_PX;
      // Without layout (a test environment) the defaults stay.
      if (width > 0 && height > 0) ctx.store.set({ width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ctx]);

  // Bring the native scrollbars to where the view is (keyboard moves, sheet switches).
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const top = scaleY.toNative(viewport.scrollTop);
    const left = scaleX.toNative(viewport.scrollLeft);
    if (Math.abs(element.scrollTop - top) >= 1) element.scrollTop = top;
    if (Math.abs(element.scrollLeft - left) >= 1) element.scrollLeft = left;
  }, [viewport.scrollTop, viewport.scrollLeft, scaleX, scaleY, sheet]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (element === null) return;
    const current = ctx.layout().viewport;
    const movedTop = Math.abs(element.scrollTop - scaleY.toNative(current.scrollTop)) >= 1;
    const movedLeft = Math.abs(element.scrollLeft - scaleX.toNative(current.scrollLeft)) >= 1;
    if (!movedTop && !movedLeft) return;
    ctx.store.setView(ctx.sheet, {
      scrollTop: movedTop ? scaleY.toSheet(element.scrollTop) : current.scrollTop,
      scrollLeft: movedLeft ? scaleX.toSheet(element.scrollLeft) : current.scrollLeft,
    });
  };

  // When editing ends, the keyboard goes back to the grid.
  const wasEditing = useRef(false);
  useEffect(() => {
    const editing = edit !== null;
    if (wasEditing.current && !editing) {
      const active = root.current?.ownerDocument.activeElement ?? null;
      if (active === null || active === root.current?.ownerDocument.body || root.current?.contains(active) === true) {
        surface.current?.focus({ preventScroll: true });
      }
    }
    wasEditing.current = editing;
  }, [edit]);

  const mouse = useGridMouse(ctx, surface, readOnly);

  const onEditorKey = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const current = ctx.store.getState().edit;
    if (current === null) return false;
    if (event.key === "Enter" && event.altKey) {
      // Alt+Enter: a line break inside the cell.
      const text = `${current.text.slice(0, current.selectionStart)}\n${current.text.slice(current.selectionEnd)}`;
      updateEditText(ctx, text, current.selectionStart + 1, current.selectionStart + 1);
      return true;
    }
    return editorKey(ctx, keyInputOf(event));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (ctx.store.getState().edit !== null) {
      // The focus is on the grid while a formula points at cells.
      if (editorKey(ctx, keyInputOf(event))) event.preventDefault();
      return;
    }
    const command = gridKeyCommand(keyInputOf(event));
    if (command === null) return;
    event.preventDefault();
    if (readOnly && CHANGING.has(command.type)) return;
    runGridCommand(ctx, command);
  };

  const onCopy = (event: ClipboardEvent<HTMLDivElement>, cut: boolean): void => {
    if (ctx.store.getState().edit !== null || event.target !== event.currentTarget) return;
    if (cut && readOnly) return;
    const payload = copySelection(ctx, cut);
    if (payload === null) return;
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
    event.preventDefault();
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>): void => {
    if (ctx.store.getState().edit !== null || event.target !== event.currentTarget || readOnly) return;
    event.preventDefault();
    pasteClipboard(ctx, { text: event.clipboardData.getData("text/plain"), html: event.clipboardData.getData("text/html") });
  };

  const panes = useMemo(() => paneSpecs(layout), [layout]);
  const editing = useMemo(() => (edit === null ? null : { sheet: edit.sheet, row: edit.cell.row, col: edit.cell.col }), [edit]);
  const references = useMemo(() => {
    if (edit === null) return [];
    const name = layout.info.name.toLowerCase();
    return scanReferences(edit.text).filter((reference) => (reference.sheet === null ? edit.sheet === sheet : reference.sheet.toLowerCase() === name));
  }, [edit, layout.info.name, sheet]);

  const completion = edit === null ? null : completionView(ctx);
  const hint = edit === null ? null : argumentHint(ctx);
  const activeOption = completion === null ? undefined : optionId(listId, completion.index);
  const popupFor = (left: number, top: number) =>
    edit === null ? null : (
      <FunctionPopup
        listId={listId}
        items={completion?.items ?? []}
        activeIndex={completion?.index ?? 0}
        summaryOf={(name) => ctx.catalog.hint(name)?.summary ?? ""}
        hint={hint}
        left={left}
        top={top}
        onPick={(name) => acceptCompletion(ctx, name)}
      />
    );

  let editor = null;
  if (edit !== null && edit.sheet === sheet) {
    const merge = mergeAt(layout.info.mergedRanges, edit.cell.row, edit.cell.col);
    const rect = rangeOnScreen(axes, viewport, merge ?? { start: edit.cell, end: edit.cell });
    if (rect !== null) {
      const longest = edit.text.split("\n").reduce((a, b) => (a.length >= b.length ? a : b), "");
      const lines = edit.text.split("\n").length;
      const width = Math.min(Math.max(rect.width + 1, textWidth(longest, EDITOR_FONT) + CELL_PADDING_PX + 12), Math.max(rect.width + 1, state.width - rect.x));
      const height = Math.max(rect.height + 1, lines * (DEFAULT_FONT_PX + 6) + 4);
      editor = (
        <>
          <FormulaInput
            className={`sg-input--cell${edit.error === null ? "" : " is-invalid"}`}
            style={{ left: ROW_HEADER_WIDTH_PX + rect.x - 1, top: HEADER_HEIGHT_PX + rect.y - 1, width, height }}
            label="Cell editor"
            value={edit.text}
            selectionStart={edit.selectionStart}
            selectionEnd={edit.selectionEnd}
            focused={edit.target === "cell"}
            invalid={edit.error !== null}
            listId={edit.target === "cell" ? listId : undefined}
            activeOptionId={edit.target === "cell" ? activeOption : undefined}
            onInput={(text, start, end) => updateEditText(ctx, text, start, end)}
            onCaret={(start, end) => {
              if (ctx.store.getState().edit?.target === "cell") updateEditCaret(ctx, start, end, "cell");
            }}
            onFocus={() => {
              const current = ctx.store.getState().edit;
              if (current !== null && current.target !== "cell") updateEditCaret(ctx, current.selectionStart, current.selectionEnd, "cell");
            }}
            onKey={onEditorKey}
          />
          {edit.target === "cell" ? popupFor(ROW_HEADER_WIDTH_PX + rect.x, HEADER_HEIGHT_PX + rect.y + height + 2) : null}
        </>
      );
    }
  }

  const surfaceWidth = ROW_HEADER_WIDTH_PX + state.width;
  const surfaceHeight = HEADER_HEIGHT_PX + state.height;
  const live = describeActiveCell(ctx);

  return (
    <div ref={root} className={`sheet-grid${className === undefined ? "" : ` ${className}`}${readOnly ? " is-readonly" : ""}`}>
      {showFormulaBar ? (
        <FormulaBar
          ctx={ctx}
          edit={edit}
          revision={sessionState.revision}
          readOnly={readOnly}
          listId={listId}
          activeOptionId={activeOption}
          onKey={onEditorKey}
          onNavigate={() => surface.current?.focus({ preventScroll: true })}
          popup={popupFor(0, 30)}
        />
      ) : null}
      <div ref={scroller} className="sg-scroller" onScroll={onScroll}>
        <div className="sg-sizer" style={{ width: surfaceWidth + scaleX.nativeMax, height: surfaceHeight + scaleY.nativeMax }}>
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
            aria-activedescendant={cellElementId(gridId, selection.active.row, selection.active.col)}
            style={{ width: surfaceWidth, height: surfaceHeight }}
            onKeyDown={onKeyDown}
            onCopy={(event) => onCopy(event, false)}
            onCut={(event) => onCopy(event, true)}
            onPaste={onPaste}
            onMouseDown={mouse.onMouseDown}
            onDoubleClick={mouse.onDoubleClick}
            onContextMenu={mouse.onContextMenu}
          >
            <div className="sg-cells" style={{ left: ROW_HEADER_WIDTH_PX, top: HEADER_HEIGHT_PX, width: state.width, height: state.height }}>
              {panes.map((pane) => (
                <GridPane
                  key={pane.id}
                  ctx={ctx}
                  layout={layout}
                  pane={pane}
                  gridId={gridId}
                  selection={selection}
                  revision={sessionState.revision}
                  decorations={state.decorations}
                  editing={editing}
                />
              ))}
              <GridOverlays
                layout={layout}
                selection={selection}
                references={references}
                fill={state.fill}
                copy={state.copy !== null && state.copy.sheet === sheet ? state.copy : null}
                showActive={edit === null}
              />
              {viewport.frozenHeight > 0 ? <div className="sg-freeze sg-freeze--h" style={{ top: viewport.frozenHeight - 1 }} aria-hidden="true" /> : null}
              {viewport.frozenWidth > 0 ? <div className="sg-freeze sg-freeze--v" style={{ left: viewport.frozenWidth - 1 }} aria-hidden="true" /> : null}
            </div>
            <GridHeaders layout={layout} selection={selection} filtered={view.filter !== null} />
            {editor}
            {state.menu === null ? null : (
              <GridMenu ctx={ctx} menu={state.menu} readOnly={readOnly} onDone={() => surface.current?.focus({ preventScroll: true })} />
            )}
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
        {live}
      </div>
    </div>
  );
}
