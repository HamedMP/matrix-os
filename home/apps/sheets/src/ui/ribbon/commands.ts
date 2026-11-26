/**
 * Every ribbon command of Sheets, by id, with the handler that performs it.
 *
 * The ribbon tabs refer to commands by these ids only (an item's id is its
 * command id), so a tab can never show a control without a handler: the
 * table is typed `Record<SheetCommandId, ...>` and a test walks the tabs.
 * Handlers act through the grid controller, the session, the review
 * controller and the assistant; refusals are shown through `notify`.
 */
import type { SheetsAssistant } from "../../agent";
import type { SheetGridController } from "../../grid";
import type { SheetReviewController } from "../../review";
import type { CellStyle } from "../../session/engine";
import type { EditResult } from "../../session/types";
import { selectionFromGrid } from "../agent";
import type { Notify } from "../file-actions";
import { NUMBER_FORMAT_PRESETS, changeDecimals } from "../number-format";
import { BORDER_PRESETS, type BorderPreset, type FreezePreset, applyBorders, applyFreeze } from "../ribbon-commands";
import { SPLIT_DELIMITERS, type SplitDelimiterId, removeDuplicateRows, splitTextToColumns } from "./data-tools";
import { TRACE_LAYER, autoSum, goToName, isAutoSumFunction, traceActiveCell } from "./formula-tools";

export const SHEET_COMMAND_IDS = [
  "file-new", "file-open-matrix", "file-open-local", "file-import-csv", "file-save", "file-save-copy", "file-download-xlsx", "file-download-csv", "file-close",
  "undo", "redo", "cut", "copy", "paste",
  "font-family", "font-size", "bold", "italic", "underline", "text-color", "fill-color", "borders",
  "align-left", "align-center", "align-right", "align-top", "align-middle", "align-bottom", "wrap-text", "merge",
  "number-format", "currency", "percent", "decimals-more", "decimals-less",
  "insert-cells", "delete-cells", "fill", "clear", "sort", "filter", "find", "replace",
  "insert-rows", "insert-columns", "insert-sheet", "insert-function",
  "autosum", "trace-precedents", "trace-dependents", "trace-clear", "recalculate", "defined-names",
  "sort-asc", "sort-desc", "filter-toggle", "remove-duplicates", "text-to-columns",
  "review-panel", "review-markup", "change-previous", "change-next", "change-accept", "change-reject", "change-accept-all", "change-reject-all",
  "freeze", "formula-bar", "gridlines",
  "assistant-panel", "assistant-explain", "assistant-trace", "assistant-check", "assistant-format-table",
] as const;

export type SheetCommandId = (typeof SHEET_COMMAND_IDS)[number];
/** `arg` is the chosen menu entry, select value or colour (null for automatic). */
export type SheetCommand = (arg?: string | null) => void;
export type SheetCommands = Record<SheetCommandId, SheetCommand>;

export type PanelId = "review" | "assistant";

export interface ViewOptions {
  formulaBar: boolean;
  gridlines: boolean;
}

/** File commands the app shell performs (dialogs, pickers, the start screen). */
export interface FileCommands {
  newWorkbook(): void;
  openFromMatrix(): void;
  openFromComputer(): void;
  importCsv(): void;
  save(): void;
  saveCopy(): void;
  downloadXlsx(): void;
  downloadCsv(): void;
  close(): void;
}

export interface SheetCommandContext {
  controller: SheetGridController;
  /** Style of the active cell. */
  style: CellStyle;
  review: SheetReviewController;
  assistant: SheetsAssistant;
  notify: Notify;
  file: FileCommands;
  /** Opens a panel, or closes it when it is the one open. */
  togglePanel(id: PanelId): void;
  /** Opens a panel and keeps it open. */
  openPanel(id: PanelId): void;
  view: ViewOptions;
  setView(patch: Partial<ViewOptions>): void;
  openFind(replace: boolean): void;
  openFunctionPicker(): void;
}

const MIN_FONT_PT = 1;
const MAX_FONT_PT = 409;

/** What a trace that marked only the first `count` cells says. */
function traceTruncated(direction: "precedents" | "dependents", count: number): string {
  const shown = count.toLocaleString("en-US");
  return direction === "precedents" ? `Marked the first ${shown} cells this formula reads; it reads more.` : `Marked the first ${shown} formulas that read this cell; more read it.`;
}

/**
 * Commands that leave the text in the cell editor alone: they open a panel or
 * a dialog, change the view, step between changes, or add to the text being
 * typed. Every other command stores that text first (see `createSheetCommands`).
 */
const LEAVES_EDITOR: ReadonlySet<SheetCommandId> = new Set<SheetCommandId>([
  "insert-function", "find", "replace",
  "review-panel", "review-markup", "change-previous", "change-next",
  "formula-bar", "gridlines", "assistant-panel",
]);

/**
 * The handlers of every command. A command that changes cells or the sheet
 * first stores the text still in the cell editor and does nothing when the
 * editor refuses it: run with the editor open, a row deletion would move
 * another cell under the editor's address, and the pending text would then
 * overwrite it.
 */
export function createSheetCommands(ctx: SheetCommandContext): SheetCommands {
  const handlers = sheetCommandHandlers(ctx);
  const commands = {} as SheetCommands;
  for (const id of SHEET_COMMAND_IDS) {
    const handler = handlers[id];
    commands[id] = LEAVES_EDITOR.has(id) ? handler : (arg) => void ctx.controller.afterEdit(() => handler(arg));
  }
  return commands;
}

function sheetCommandHandlers(ctx: SheetCommandContext): SheetCommands {
  const { controller, notify } = ctx;
  const session = controller.session;
  const align = ctx.style.alignment;
  const done = (): void => controller.focus();
  const run = (action: () => void): void => {
    action();
    done();
  };
  const check = (result: EditResult | { ok: true } | { ok: false; message: string }): void => {
    if (!result.ok) notify(result.message, "warning");
    done();
  };
  const report = (result: { ok: boolean; message: string }): void => {
    notify(result.message, result.ok ? "info" : "warning");
    done();
  };
  const horizontal = (value: "left" | "center" | "right") => () => run(() => controller.format({ alignment: { horizontal: align.horizontal === value ? "general" : value } }));
  const vertical = (value: "top" | "middle" | "bottom") => () => run(() => controller.format({ alignment: { vertical: value } }));
  const formatCode = (id: string) => NUMBER_FORMAT_PRESETS.find((preset) => preset.id === id)?.code ?? null;
  const toClipboard = (cut: boolean): void => {
    void controller.copyToClipboard(cut).then((outcome) => {
      if (outcome === "own") notify(`${cut ? "Cut" : "Copied"} for pasting in this workbook. To paste in another app, press ${cut ? "Ctrl+X" : "Ctrl+C"}.`, "info");
      // An editor opened while the browser was answering keeps the caret.
      if (!controller.isEditing) done();
    });
  };
  const withSelection = (action: (selection: NonNullable<ReturnType<typeof selectionFromGrid>>) => void) => () => {
    const selection = selectionFromGrid(controller);
    if (selection === null) return;
    ctx.openPanel("assistant");
    action(selection);
  };
  const reviewAction = (action: () => { ok: true } | { ok: false; message: string }) => () => {
    const result = action();
    if (!result.ok) notify(result.message, "warning");
  };

  return {
    "file-new": () => ctx.file.newWorkbook(),
    "file-open-matrix": () => ctx.file.openFromMatrix(),
    "file-open-local": () => ctx.file.openFromComputer(),
    "file-import-csv": () => ctx.file.importCsv(),
    "file-save": () => ctx.file.save(),
    "file-save-copy": () => ctx.file.saveCopy(),
    "file-download-xlsx": () => ctx.file.downloadXlsx(),
    "file-download-csv": () => ctx.file.downloadCsv(),
    "file-close": () => ctx.file.close(),

    undo: () => check(controller.undo()),
    redo: () => check(controller.redo()),
    cut: () => toClipboard(true),
    copy: () => toClipboard(false),
    paste: () => {
      void controller.pasteFromClipboard().then((outcome) => {
        if (outcome === "blocked") notify("This window may not read the clipboard. Press Ctrl+V to paste.", "warning");
        // A paste cancelled because the owner moved on leaves the focus where they put it.
        if (outcome !== "cancelled") done();
      });
    },

    "font-family": (name) => {
      if (name) run(() => controller.format({ font: { name } }));
    },
    "font-size": (value) => {
      const size = Number(value);
      if (!Number.isFinite(size) || size < MIN_FONT_PT || size > MAX_FONT_PT) {
        notify(`Type a font size from ${MIN_FONT_PT} to ${MAX_FONT_PT}.`, "warning");
        return;
      }
      run(() => controller.format({ font: { sizePt: Math.round(size * 2) / 2 } }));
    },
    bold: () => run(() => controller.toggleFormat("bold")),
    italic: () => run(() => controller.toggleFormat("italic")),
    underline: () => run(() => controller.toggleFormat("underline")),
    "text-color": (color) => run(() => controller.format({ font: { color: color ?? null } })),
    "fill-color": (color) => run(() => controller.format({ fill: { color: color ?? null } })),
    borders: (preset) => {
      if (BORDER_PRESETS.some((item) => item.id === preset)) check(applyBorders(controller, preset as BorderPreset));
    },

    "align-left": horizontal("left"),
    "align-center": horizontal("center"),
    "align-right": horizontal("right"),
    "align-top": vertical("top"),
    "align-middle": vertical("middle"),
    "align-bottom": vertical("bottom"),
    "wrap-text": () => run(() => controller.format({ alignment: { wrapText: !align.wrapText } })),
    merge: () => run(() => controller.toggleMerge()),

    "number-format": (id) => {
      const code = formatCode(id ?? "");
      if (code !== null) run(() => controller.format({ numberFormat: code }));
    },
    currency: () => run(() => controller.format({ numberFormat: formatCode("currency") ?? "General" })),
    percent: () => run(() => controller.format({ numberFormat: "0%" })),
    "decimals-more": () => run(() => controller.format({ numberFormat: changeDecimals(ctx.style.numberFormat, 1) })),
    "decimals-less": () => run(() => controller.format({ numberFormat: changeDecimals(ctx.style.numberFormat, -1) })),

    "insert-cells": (where) => {
      if (where === "row-above" || where === "row-below") run(() => controller.insertRows(where === "row-above" ? "before" : "after"));
      else if (where === "col-left" || where === "col-right") run(() => controller.insertColumns(where === "col-left" ? "before" : "after"));
    },
    "delete-cells": (what) => {
      if (what === "rows") run(() => controller.deleteRows());
      else if (what === "columns") run(() => controller.deleteColumns());
    },
    fill: (direction) => {
      if (direction === "down" || direction === "right") run(() => controller.fill(direction));
    },
    clear: (what) => {
      if (what === "contents" || what === "formats" || what === "all") run(() => controller.clear(what));
    },
    sort: (order) => run(() => controller.sort(order === "desc")),
    filter: (what) => run(() => (what === "clear" ? controller.filter(null) : controller.filterByValue())),
    find: () => ctx.openFind(false),
    replace: () => ctx.openFind(true),

    "insert-rows": (where) => run(() => controller.insertRows(where === "below" ? "after" : "before")),
    "insert-columns": (where) => run(() => controller.insertColumns(where === "right" ? "after" : "before")),
    "insert-sheet": () => check(session.addSheet()),
    "insert-function": () => ctx.openFunctionPicker(),

    autosum: (fn) => {
      const result = autoSum(controller, isAutoSumFunction(fn) ? fn : "SUM");
      if (result.ok === "editing") return;
      check(result);
    },
    "trace-precedents": () => {
      const result = traceActiveCell(controller, "precedents");
      if (!result.ok) notify(result.message, "info");
      else if (result.truncated) notify(traceTruncated("precedents", result.count), "warning");
    },
    "trace-dependents": () => {
      const result = traceActiveCell(controller, "dependents");
      if (!result.ok) notify(result.message, "info");
      else if (result.truncated) notify(traceTruncated("dependents", result.count), "warning");
    },
    "trace-clear": () => run(() => controller.clearDecorations(TRACE_LAYER)),
    recalculate: () => {
      session.recalculate();
      notify(session.getState().calcComplete ? "Recalculated every formula." : "Recalculated as far as the limits allow; some values may be out of date.", "info");
      done();
    },
    "defined-names": (name) => {
      if (name) check(goToName(controller, name));
    },

    "sort-asc": () => run(() => controller.sort(false)),
    "sort-desc": () => run(() => controller.sort(true)),
    "filter-toggle": () => run(() => (controller.isFiltered ? controller.filter(null) : controller.filterByValue())),
    "remove-duplicates": () => report(removeDuplicateRows(controller)),
    "text-to-columns": (id) => {
      if (SPLIT_DELIMITERS.some((entry) => entry.id === id)) report(splitTextToColumns(controller, id as SplitDelimiterId));
    },

    "review-panel": () => ctx.togglePanel("review"),
    "review-markup": () => ctx.review.toggleMarkup(),
    "change-previous": () => ctx.review.previous(),
    "change-next": () => ctx.review.next(),
    "change-accept": reviewAction(() => ctx.review.acceptCurrent()),
    "change-reject": reviewAction(() => ctx.review.rejectCurrent()),
    "change-accept-all": reviewAction(() => ctx.review.accept("all")),
    "change-reject-all": reviewAction(() => ctx.review.reject("all")),

    freeze: (preset) => {
      if (preset === "selection" || preset === "row" || preset === "column" || preset === "none") check(applyFreeze(controller, preset as FreezePreset));
    },
    "formula-bar": () => ctx.setView({ formulaBar: !ctx.view.formulaBar }),
    gridlines: () => ctx.setView({ gridlines: !ctx.view.gridlines }),

    "assistant-panel": () => ctx.togglePanel("assistant"),
    "assistant-explain": withSelection((selection) => void ctx.assistant.explain(selection)),
    "assistant-trace": withSelection((selection) => void ctx.assistant.trace(selection)),
    "assistant-check": () => {
      ctx.openPanel("assistant");
      void ctx.assistant.check();
    },
    "assistant-format-table": withSelection((selection) => void ctx.assistant.formatTable(selection)),
  };
}
