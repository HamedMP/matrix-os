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
    // Review commands store the editor text themselves: watch the changes they would resolve.
    for (const method of ["acceptChanges", "rejectChanges"] as const) {
      vi.spyOn(session, method).mockImplementation(() => {
        calls.push(method);
        return { resolvedIds: [], stale: [] } as never;
      });
    }
  };
  return { session, sheet, controller, review, commands, calls, watch };
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

  // Outcome: Accept change and Reject change act on the change the owner was looking at. Fault: the
  // ribbon stores the typed text first, which resolves that change and moves on, and the command then
  // resolves the next change.
  it.each([["change-reject"], ["change-accept"]] as const)("%s resolves the current change, not the next one, after the owner typed over its cell", (id) => {
    const { session, sheet, controller, review, commands } = setup();
    session.mutate((workbook) => {
      workbook.beginProposal({ author: "Alex", date: "2026-11-20T10:00:00.000Z", label: "Raise" });
      workbook.setCell(sheet, { row: 1, col: 1 }, 20);
      workbook.setCell(sheet, { row: 2, col: 1 }, 30);
      workbook.endProposal();
    });
    review.next();
    const [, next] = review.getState().items;
    expect(review.getState().current?.location).toBe("Sheet1!B2");
    controller.startEdit("7");

    commands[id](undefined);

    expect(controller.isEditing).toBe(false);
    expect(session.cell(sheet, 1, 1).value).toBe(7);
    expect(session.workbook.listChanges().map((change) => change.id)).toEqual([next!.id]);
    expect(session.cell(sheet, 2, 1).value).toBe(30);
  });
});
