// @vitest-environment jsdom
/**
 * Paste started by a click waits for the browser's clipboard. The cells it
 * writes are the ones selected when the owner clicked: when the selection,
 * the sheet, the workbook or the cell editor changed while the browser was
 * answering, the paste writes nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSheetGridController } from "../../../../home/apps/sheets/src/grid";
import { createSheetSession } from "../../../../home/apps/sheets/src/session";
import { harness } from "../session/fakes";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A clipboard whose read answers only when the test says so. */
function slowClipboard(text: string | null) {
  let answer: () => void = () => undefined;
  const readText = () =>
    new Promise<string>((resolve, reject) => {
      answer = () => (text === null ? reject(new DOMException("refused", "NotAllowedError")) : resolve(text));
    });
  vi.stubGlobal("navigator", { ...navigator, clipboard: { readText, writeText: async () => undefined } });
  return { answer: () => answer() };
}

function setup() {
  const session = createSheetSession(harness().deps);
  const controller = createSheetGridController(session);
  const sheet = session.getState().activeSheetId;
  controller.select({ row: 0, col: 0 });
  return { session, controller, sheet };
}

describe("a paste started by a click", () => {
  it("pastes at the cells selected when it was clicked", async () => {
    const { session, controller, sheet } = setup();
    const clipboard = slowClipboard("x\ty");
    const pasted = controller.pasteFromClipboard();
    clipboard.answer();
    expect(await pasted).toBe("system");
    expect([session.cell(sheet, 0, 0).value, session.cell(sheet, 0, 1).value]).toEqual(["x", "y"]);
  });

  it("writes nothing when another cell was selected while the clipboard was read", async () => {
    const { session, controller, sheet } = setup();
    const clipboard = slowClipboard("x\ty");
    const pasted = controller.pasteFromClipboard();
    controller.select({ row: 5, col: 3 });
    clipboard.answer();
    expect(await pasted).toBe("cancelled");
    expect(session.cell(sheet, 5, 3).value).toBeNull();
    expect(session.cell(sheet, 0, 0).value).toBeNull();
    expect(session.getState().canUndo).toBe(false);
  });

  it("writes nothing when another sheet was opened while the clipboard was read", async () => {
    const { session, controller, sheet } = setup();
    const added = session.addSheet("Other");
    const other = added.sheet as string;
    session.setActiveSheet(sheet);
    controller.select({ row: 0, col: 0 });
    const revision = session.getState().revision;
    const clipboard = slowClipboard("x\ty");
    const pasted = controller.pasteFromClipboard();
    session.setActiveSheet(other);
    clipboard.answer();
    expect(await pasted).toBe("cancelled");
    expect(session.cell(other, 0, 0).value).toBeNull();
    expect(session.cell(sheet, 0, 0).value).toBeNull();
    expect(session.getState().revision).toBe(revision);
  });

  it("writes nothing when the workbook was edited while the clipboard was read", async () => {
    const { session, controller, sheet } = setup();
    const clipboard = slowClipboard("x\ty");
    const pasted = controller.pasteFromClipboard();
    session.setInputs(sheet, { row: 9, col: 9 }, [["meanwhile"]]);
    clipboard.answer();
    expect(await pasted).toBe("cancelled");
    expect(session.cell(sheet, 0, 0).value).toBeNull();
    expect(session.cell(sheet, 9, 9).value).toBe("meanwhile");
  });

  it("writes nothing and leaves the editor alone when the editor was opened while the clipboard was read", async () => {
    const { session, controller, sheet } = setup();
    const clipboard = slowClipboard("x\ty");
    const pasted = controller.pasteFromClipboard();
    controller.startEdit("typed");
    clipboard.answer();
    expect(await pasted).toBe("cancelled");
    expect(controller.isEditing).toBe(true);
    expect(session.cell(sheet, 0, 0).value).toBeNull();
    expect(controller.commitEdit()).toBe(true);
    expect(session.cell(sheet, 0, 0).value).toBe("typed");
  });

  it("does not fall back to the cells copied in this window for a destination that changed", async () => {
    const { session, controller, sheet } = setup();
    session.setInputs(sheet, { row: 0, col: 0 }, [["kept"]]);
    controller.select({ row: 0, col: 0 });
    expect(controller.copy()).not.toBeNull();
    controller.select({ row: 2, col: 2 });
    const clipboard = slowClipboard(null);
    const pasted = controller.pasteFromClipboard();
    controller.select({ row: 4, col: 4 });
    clipboard.answer();
    expect(await pasted).toBe("cancelled");
    expect(session.cell(sheet, 2, 2).value).toBeNull();
    expect(session.cell(sheet, 4, 4).value).toBeNull();
  });
});
