// @vitest-environment jsdom
/**
 * Ribbon commands and the text still in the cell editor: a command that
 * changes cells or the sheet stores that text first, and does nothing when
 * the editor refuses it, so the editor never writes to a cell the command moved.
 */
import { describe, expect, it, vi } from "vitest";
import { SheetsAssistant } from "../../../../home/apps/sheets/src/agent";
import { createSheetGridController } from "../../../../home/apps/sheets/src/grid";
import { SheetReviewController } from "../../../../home/apps/sheets/src/review";
import { createSheetSession } from "../../../../home/apps/sheets/src/session";
import { SHEET_COMMAND_IDS, type SheetCommandId, createSheetCommands } from "../../../../home/apps/sheets/src/ui/ribbon/commands";
import { harness } from "../session/fakes";

/** Commands that leave the editor alone: they open a panel or a dialog, change the view, step between changes, or add to the text being typed. */
const LEAVE_EDITOR: readonly SheetCommandId[] = [
  "insert-function", "find", "replace",
  "review-panel", "review-markup", "change-previous", "change-next",
  "formula-bar", "gridlines", "assistant-panel",
];

/** An argument each command accepts, as its control passes it. */
const ARGS: Partial<Record<SheetCommandId, string>> = {
  "font-family": "Arial", "font-size": "12", "text-color": "#123456", "fill-color": "#123456", borders: "all",
  "number-format": "currency", "insert-cells": "row-above", "delete-cells": "rows", fill: "down", clear: "contents",
  sort: "asc", filter: "value", "insert-rows": "above", "insert-columns": "left", autosum: "SUM",
  "defined-names": "Inputs", "text-to-columns": "comma", freeze: "row",
};

function setup() {
  const h = harness();
  const session = createSheetSession(h.deps);
  const controller = createSheetGridController(session);
  const review = new SheetReviewController(session, controller);
  const assistant = new SheetsAssistant({ session, ai: null, grid: controller });
  const sheet = session.getState().activeSheetId;
  session.setInputs(sheet, { row: 0, col: 0 }, [["a", "1"], ["b", "2"], ["c", "3"]]);
  session.workbook.setDefinedName({ name: "Inputs", refersTo: "Sheet1!$C$2:$D$4", scope: null });
  const style = session.workbook.getStyle(session.cell(sheet, 0, 0).styleId);
  const calls: string[] = [];
  const track = (name: string) => () => void calls.push(name);
  const commands = createSheetCommands({
    controller,
    style,
    review,
    assistant,
    notify: track("notify"),
    file: {
      newWorkbook: track("file"), openFromMatrix: track("file"), openFromComputer: track("file"), importCsv: track("file"), save: track("file"),
      saveCopy: track("file"), downloadXlsx: track("file"), downloadCsv: track("file"), close: track("file"),
    },
    togglePanel: track("togglePanel"),
    openPanel: track("openPanel"),
    view: { formulaBar: true, gridlines: true },
    setView: track("setView"),
    openFind: track("openFind"),
    openFunctionPicker: track("openFunctionPicker"),
  });
  /** Records the calls a command would make past the editor, from here on. */
  const watch = (): void => {
    for (const method of ["copyToClipboard", "pasteFromClipboard"] as const) {
      vi.spyOn(controller, method).mockImplementation(() => {
        calls.push(method);
        return Promise.resolve("none" as never);
      });
    }
    for (const method of ["decorate", "clearDecorations", "select"] as const) {
      vi.spyOn(controller, method).mockImplementation(() => void calls.push(method));
    }
    for (const method of ["acceptCurrent", "rejectCurrent", "accept", "reject"] as const) {
      vi.spyOn(review, method).mockImplementation(() => {
        calls.push(method);
        return { ok: true } as never;
      });
    }
  };
  return { session, sheet, controller, commands, calls, watch };
}

describe("Sheets ribbon commands with text in the cell editor", () => {
  it.each(SHEET_COMMAND_IDS.filter((id) => !LEAVE_EDITOR.includes(id)).map((id) => [id]))(
    "%s runs nothing while the editor refuses its text",
    (id: SheetCommandId) => {
      const { session, controller, commands, calls, watch } = setup();
      // Something to undo and redo.
      controller.setCell({ row: 4, col: 4 }, "x");
      controller.undo();
      controller.select({ row: 1, col: 0 });
      calls.length = 0;
      controller.startEdit("=1+*");
      watch();
      const revision = session.getState().revision;
      const selection = controller.getSelection();

      commands[id](ARGS[id]);

      expect(controller.isEditing).toBe(true);
      expect(session.getState().revision).toBe(revision);
      expect(controller.getSelection()).toEqual(selection);
      // The refusal itself is shown by the editor; nothing else ran.
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ["delete-cells", "rows", "c"],
    ["insert-cells", "row-above", null],
    ["insert-rows", "above", null],
  ] as const)("%s %s stores the typed text in its cell before the rows move", (id, arg, nowInA2) => {
    const { session, sheet, controller, commands } = setup();
    controller.select({ row: 1, col: 0 });
    controller.startEdit("typed");

    commands[id](arg);

    expect(controller.isEditing).toBe(false);
    expect(session.cell(sheet, 1, 0).value).toBe(nowInA2);
    // Committing again writes nothing over the cell that moved into A2.
    expect(controller.commitEdit()).toBe(true);
    expect(session.cell(sheet, 1, 0).value).toBe(nowInA2);
    controller.undo();
    expect(session.cell(sheet, 1, 0).value).toBe("typed");
  });
});
