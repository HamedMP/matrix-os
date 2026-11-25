// @vitest-environment jsdom
/**
 * Every ribbon control maps to a command with a handler, and every command
 * is reachable from the ribbon. Fails when a control is added without a
 * handler or a handler is left without a control.
 */
import { describe, expect, it } from "vitest";
import type { BackstageItem, RibbonItem, RibbonTab } from "../../../../home/apps/_shared/office-ui";
import { SheetsAssistant } from "../../../../home/apps/sheets/src/agent";
import { createSheetGridController } from "../../../../home/apps/sheets/src/grid";
import { SheetReviewController } from "../../../../home/apps/sheets/src/review";
import { createSheetSession } from "../../../../home/apps/sheets/src/session";
import { SHEET_COMMAND_IDS, type SheetCommandId, type SheetCommands, createSheetCommands } from "../../../../home/apps/sheets/src/ui/ribbon/commands";
import type { RibbonModel } from "../../../../home/apps/sheets/src/ui/ribbon/model";
import { buildSheetTabs } from "../../../../home/apps/sheets/src/ui/ribbon/tabs";
import { harness } from "../session/fakes";

function setup() {
  const h = harness();
  const session = createSheetSession(h.deps);
  const controller = createSheetGridController(session);
  const review = new SheetReviewController(session, controller);
  const assistant = new SheetsAssistant({ session, ai: null, grid: controller });
  const sheet = session.getState().activeSheetId;
  const style = session.workbook.getStyle(session.cell(sheet, 0, 0).styleId);
  const model: RibbonModel = {
    state: session.getState(),
    style,
    review: review.getState(),
    panel: null,
    view: { formulaBar: true, gridlines: true },
    filtered: false,
    names: ["Inputs"],
    aiAvailable: true,
    assistantBusy: false,
    colors: { text: "#c00000", fill: null },
  };
  const noop = () => undefined;
  const commands = createSheetCommands({
    controller,
    style,
    review,
    assistant,
    notify: noop,
    file: { newWorkbook: noop, openFromMatrix: noop, openFromComputer: noop, importCsv: noop, save: noop, saveCopy: noop, downloadXlsx: noop, downloadCsv: noop, close: noop },
    togglePanel: noop,
    openPanel: noop,
    view: model.view,
    setView: noop,
    openFind: noop,
    openFunctionPicker: noop,
  });
  return { commands, model };
}

type Control = { id: string; fire: () => void };

/** Every control of every tab, with a way to use it as a person would (first menu entry, first option). */
function controls(tabs: readonly RibbonTab[]): Control[] {
  const out: Control[] = [];
  const visit = (item: RibbonItem): void => {
    switch (item.kind) {
      case "separator":
        return;
      case "stack":
        item.rows.flat().forEach(visit);
        return;
      case "button":
        out.push({ id: item.id, fire: item.onClick });
        return;
      case "toggle":
        out.push({ id: item.id, fire: () => item.onToggle(!item.pressed) });
        return;
      case "split":
        out.push({ id: item.id, fire: item.onClick });
        out.push({ id: item.id, fire: () => item.onMenuSelect(item.menu[0]!.id) });
        return;
      case "menu":
        out.push({ id: item.id, fire: () => item.onMenuSelect(item.menu[0]!.id) });
        return;
      case "select":
        out.push({ id: item.id, fire: () => item.onChange(item.options[1]?.value ?? item.options[0]!.value) });
        return;
      case "color":
        out.push({ id: item.id, fire: () => item.onChange("#123456") });
        return;
      case "gallery":
        out.push({ id: item.id, fire: () => item.onSelect(item.options[0]!.id) });
        return;
    }
  };
  for (const tab of tabs) {
    if (tab.mode === "backstage") {
      for (const entry of tab.backstage.items as BackstageItem[]) {
        if (entry.onSelect) out.push({ id: entry.id, fire: () => entry.onSelect!({ close: () => undefined, select: () => undefined }) });
      }
    } else {
      for (const group of tab.groups) group.items.forEach(visit);
    }
  }
  return out;
}

describe("Sheets ribbon commands", () => {
  it("has a handler for every command id", () => {
    const { commands } = setup();
    expect(Object.keys(commands).sort()).toEqual([...SHEET_COMMAND_IDS].sort());
    for (const id of SHEET_COMMAND_IDS) expect(typeof commands[id], id).toBe("function");
  });

  it("names only known commands in the tabs, and every command appears in a tab", () => {
    const { commands, model } = setup();
    const used = new Set(controls(buildSheetTabs(commands, model)).map((control) => control.id));
    const known = new Set<string>(SHEET_COMMAND_IDS);
    expect([...used].filter((id) => !known.has(id))).toEqual([]);
    expect(SHEET_COMMAND_IDS.filter((id) => !used.has(id))).toEqual([]);
  });

  it.each(SHEET_COMMAND_IDS.map((id) => [id]))("runs the %s command from its control", (id: SheetCommandId) => {
    const { model } = setup();
    const calls: string[] = [];
    const spy = Object.fromEntries(SHEET_COMMAND_IDS.map((name) => [name, () => void calls.push(name)])) as SheetCommands;
    const mine = controls(buildSheetTabs(spy, model)).filter((control) => control.id === id);
    expect(mine.length).toBeGreaterThan(0);
    for (const control of mine) {
      calls.length = 0;
      control.fire();
      expect(calls).toEqual([id]);
    }
  });
});
