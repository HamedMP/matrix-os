// @vitest-environment jsdom
/**
 * Every Docs ribbon command does something: each button, toggle, menu entry,
 * list choice, colour, style and File entry is invoked with a context whose
 * actions are spies, and the test fails for any command that calls none of
 * them. Spot checks pin the commands whose arguments matter.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackstageItem, RibbonItem, RibbonTab } from "../../../../home/apps/_shared/office-ui";
import {
  type DocsRibbonActions,
  type DocsRibbonState,
  buildDocsRibbon,
  parseFontSize,
  stepFontSize,
  stepZoom,
  styleChoices,
} from "../../../../home/apps/docs/src/ui/ribbon/index";

afterEach(cleanup);

type Spies = DocsRibbonActions & { calls(): Array<[string, unknown[]]> };

function spyActions(): Spies {
  const log: Array<[string, unknown[]]> = [];
  const cache = new Map<string, (...args: unknown[]) => void>();
  return new Proxy({} as Spies, {
    get(_target, key: string) {
      if (key === "calls") return () => log;
      let fn = cache.get(key);
      if (fn === undefined) {
        fn = vi.fn((...args: unknown[]) => {
          log.push([key, args]);
        });
        cache.set(key, fn);
      }
      return fn;
    },
  });
}

function fullState(patch: Partial<DocsRibbonState> = {}): DocsRibbonState {
  return {
    hasEditor: true,
    editable: true,
    hasSelection: true,
    canUndo: true,
    canRedo: true,
    format: { bold: false, italic: true, underline: false, strike: false, headingLevel: 0, alignment: "left", styleName: "Normal", inTable: true },
    caret: { fontFamily: "Calibri", fontSizePt: 11, color: null, highlight: null, verticalAlign: "baseline", indentLeftPt: 36, spacingBeforePt: 0, spacingAfterPt: 6, row: { tableId: "t1", rowIndex: 1, rowCount: 3 } },
    styles: styleChoices([{ styleId: "BodyText", name: "Body Text" }]),
    tracking: false,
    viewMode: "markup",
    revisions: { total: 2, shown: 2 },
    zoom: 125,
    findOpen: false,
    outlineOpen: true,
    panel: null,
    source: "matrix",
    hasPath: true,
    saving: false,
    colors: { font: "#dc2626", highlight: "#ffff00" },
    ...patch,
  };
}

interface Command {
  id: string;
  disabled: boolean;
  /** Each entry is one way to run the command (a menu entry, a list choice ...). */
  runs: Array<() => void>;
}

const api = { close: vi.fn(), select: vi.fn() };

function renderedButtons(node: ReactNode): Array<() => void> {
  const view = render(<>{node}</>);
  const buttons = [...view.container.querySelectorAll("button")];
  return buttons.map((button) => () => fireEvent.click(button));
}

function itemCommands(item: RibbonItem): Command[] {
  const base = { id: item.id, disabled: "disabled" in item ? item.disabled === true : false };
  switch (item.kind) {
    case "button":
      return [{ ...base, runs: [item.onClick] }];
    case "toggle":
      return [{ ...base, runs: [() => item.onToggle(!item.pressed)] }];
    case "split":
      return [{ ...base, runs: [item.onClick, ...item.menu.map((entry) => () => item.onMenuSelect(entry.id))] }];
    case "menu":
      return [{ ...base, runs: item.menu.map((entry) => () => item.onMenuSelect(entry.id)) }];
    case "select":
      return [{ ...base, runs: item.options.filter((option) => option.value !== item.value).map((option) => () => item.onChange(option.value)) }];
    case "color":
      return [{ ...base, runs: [() => item.onChange("#ff0000"), () => item.onChange(null)] }];
    case "gallery":
      return [{ ...base, runs: item.options.map((option) => () => item.onSelect(option.id)) }];
    case "stack":
      return item.rows.flat().flatMap(itemCommands);
    default:
      return [];
  }
}

function backstageCommands(item: BackstageItem): Command {
  const runs = item.onSelect ? [() => item.onSelect!(api)] : item.render ? renderedButtons(item.render(api)) : [];
  return { id: `file:${item.id}`, disabled: item.disabled === true, runs };
}

function commands(tabs: RibbonTab[]): Command[] {
  return tabs.flatMap((tab) => (tab.mode === "backstage" ? tab.backstage.items.map(backstageCommands) : tab.groups.flatMap((group) => group.items.flatMap(itemCommands))));
}

describe("Docs ribbon commands", () => {
  it("wires every command to an action", () => {
    const actions = spyActions();
    const list = commands(buildDocsRibbon({ state: fullState(), actions }));
    expect(list.length).toBeGreaterThan(50);
    const ids = list.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    const silent: string[] = [];
    for (const command of list) {
      expect(command.disabled, `${command.id} is disabled with everything available`).toBe(false);
      expect(command.runs.length, `${command.id} has no way to run`).toBeGreaterThan(0);
      for (const [index, run] of command.runs.entries()) {
        const before = actions.calls().length;
        run();
        if (actions.calls().length === before) silent.push(`${command.id}#${index}`);
      }
    }
    expect(silent).toEqual([]);
  });

  it.each([
    ["file:new", "file:open-matrix", "file:open-computer", "file:save", "file:save-copy", "file:download", "file:export", "file:close"],
    ["undo", "redo", "cut", "copy", "paste", "bold", "italic", "underline", "strike", "font-family", "font-size", "font-color", "highlight"],
    ["align-left", "align-center", "align-right", "align-justify", "indent-less", "indent-more", "styles", "find", "replace"],
    ["insert-paragraph", "insert-line-break", "row-above", "row-below", "row-delete", "insert-comment"],
    ["track-changes", "markup-view", "change-previous", "change-next", "change-accept", "change-reject", "accept-all", "reject-all", "new-comment", "compare", "review-panel"],
    ["zoom-out", "zoom-level", "zoom-in", "show-outline", "show-panel", "assistant-open", "assistant-tighten", "assistant-summarise", "assistant-explain"],
  ])("offers the required commands %#", (...required) => {
    const ids = commands(buildDocsRibbon({ state: fullState(), actions: spyActions() })).map((command) => command.id);
    for (const id of required) expect(ids, id).toContain(id);
  });

  it("passes the arguments the editor and session need", () => {
    const actions = spyActions();
    const find = (id: string) => commands(buildDocsRibbon({ state: fullState(), actions })).find((command) => command.id === id)!;
    find("bold").runs[0]!();
    find("indent-more").runs[0]!();
    find("indent-less").runs[0]!();
    find("row-below").runs[0]!();
    find("superscript").runs[0]!();
    find("assistant-explain").runs[0]!();
    expect(actions.calls()).toEqual([
      ["toggleFormat", ["bold"]],
      ["setParagraphStyle", [{ indentLeftPt: 72 }]],
      ["setParagraphStyle", [{ indentLeftPt: 0 }]],
      ["insertTableRow", ["below"]],
      ["setRunFormat", [{ verticalAlign: "superscript" }]],
      ["assistant", ["explain"]],
    ]);
  });

  it("puts the last chosen colour on the face of each colour button, so the face applies it", () => {
    const actions = spyActions();
    const tabs = buildDocsRibbon({ state: fullState({ colors: { font: "#2563eb", highlight: "#00ff00" } }), actions });
    const items = tabs.flatMap((tab) => (tab.mode === "backstage" ? [] : tab.groups.flatMap((group) => group.items))).flatMap((item) => (item.kind === "stack" ? item.rows.flat() : [item]));
    const font = items.find((item) => item.id === "font-color");
    const highlight = items.find((item) => item.id === "highlight");
    if (font?.kind !== "color" || highlight?.kind !== "color") throw new Error("the colour buttons are missing");
    expect([font.value, highlight.value]).toEqual(["#2563eb", "#00ff00"]);
    font.onChange(font.value);
    highlight.onChange(null);
    font.onChange("#16A34A");
    expect(actions.calls()).toEqual([
      ["setFontColor", ["#2563eb"]],
      ["setHighlight", [null]],
      ["setFontColor", ["#16a34a"]],
    ]);
  });

  it("names the copy command after the source and disables edits in the read-only view", () => {
    const local = commands(buildDocsRibbon({ state: fullState({ source: "local", hasPath: false }), actions: spyActions() }));
    const tabs = buildDocsRibbon({ state: fullState({ source: "local", hasPath: false }), actions: spyActions() });
    const file = tabs[0]!;
    expect(file.mode === "backstage" && file.backstage.items.find((item) => item.id === "save-copy")?.label).toBe("Save a copy to Matrix…");
    expect(local.find((command) => command.id === "file:download")?.disabled).toBe(false);

    const readOnly = commands(buildDocsRibbon({ state: fullState({ editable: false }), actions: spyActions() }));
    for (const id of ["paste", "cut", "bold", "font-size", "styles", "align-center", "insert-paragraph", "row-above", "change-accept", "new-comment", "assistant-tighten"]) {
      expect(readOnly.find((command) => command.id === id)?.disabled, id).toBe(true);
    }
    for (const id of ["copy", "find", "change-next", "zoom-in", "assistant-summarise", "file:save"]) {
      expect(readOnly.find((command) => command.id === id)?.disabled, id).toBe(false);
    }
  });

  it("offers table rows only inside a table and keeps the last row", () => {
    const outside = commands(buildDocsRibbon({ state: fullState({ caret: { ...fullState().caret!, row: null } }), actions: spyActions() }));
    expect(outside.filter((command) => command.id.startsWith("row-")).every((command) => command.disabled)).toBe(true);
    const single = commands(buildDocsRibbon({ state: fullState({ caret: { ...fullState().caret!, row: { tableId: "t", rowIndex: 0, rowCount: 1 } } }), actions: spyActions() }));
    expect(single.find((command) => command.id === "row-delete")?.disabled).toBe(true);
  });
});

describe("Docs ribbon helpers", () => {
  it("parses typed font sizes and steps through the presets", () => {
    expect(parseFontSize("14")).toBe(14);
    expect(parseFontSize("10.3 pt")).toBe(10.5);
    expect(parseFontSize("abc")).toBeNull();
    expect(parseFontSize("0")).toBeNull();
    expect(parseFontSize("5000")).toBeNull();
    expect(stepFontSize(11, 1)).toBe(12);
    expect(stepFontSize(null, -1)).toBe(10.5);
    expect(stepFontSize(72, 1)).toBe(84);
  });

  it("steps the zoom between presets", () => {
    expect(stepZoom(100, 1)).toBe(110);
    expect(stepZoom(100, -1)).toBe(90);
    expect(stepZoom(200, 1)).toBe(200);
    expect(stepZoom(50, -1)).toBe(50);
  });
});
