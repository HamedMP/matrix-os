/** The Home tab: history, clipboard, font, alignment, number, cells and editing. */
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  ArrowDownToLine,
  ArrowUpNarrowWide,
  Baseline,
  BetweenHorizontalStart,
  Bold,
  ClipboardPaste,
  Copy,
  DecimalsArrowLeft,
  DecimalsArrowRight,
  DollarSign,
  Eraser,
  Filter,
  Grid3x3,
  Italic,
  PaintBucket,
  Percent,
  Redo2,
  Replace,
  Scissors,
  Search,
  TableCellsMerge,
  Trash2,
  Underline,
  Undo2,
  WrapText,
} from "lucide-react";
import type { ReactNode } from "react";
import type { RibbonItem, RibbonPanelTab } from "../../../../_shared/office-ui";
import { NUMBER_FORMAT_PRESETS, presetOf } from "../number-format";
import { BORDER_PRESETS, FILL_COLORS, FONT_FAMILIES, FONT_SIZES, TEXT_COLORS } from "../ribbon-commands";
import type { SheetCommandId, SheetCommands } from "./commands";
import { type RibbonModel, commandButton, commandToggle } from "./model";

const ICON = 16;
const BIG = 20;

const swatches = (colors: ReadonlyArray<{ label: string; color: string | null }>) =>
  colors.filter((entry): entry is { label: string; color: string } => entry.color !== null).map((entry) => ({ value: entry.color, name: entry.label }));

export function homeTab(cmd: SheetCommands, model: RibbonModel): RibbonPanelTab {
  const { state, style } = model;
  const align = style.alignment;
  const preset = presetOf(style.numberFormat);
  const toggle = (id: SheetCommandId, label: string, icon: ReactNode, pressed: boolean, shortcut?: string): RibbonItem => commandToggle(cmd, id, label, icon, pressed, { shortcut });
  const button = (id: SheetCommandId, label: string, icon: ReactNode, shortcut?: string, disabled?: boolean): RibbonItem => commandButton(cmd, id, label, icon, { shortcut, disabled });

  return {
    id: "home",
    label: "Home",
    groups: [
      {
        id: "history",
        label: "Undo",
        items: [
          {
            kind: "stack",
            id: "history-rows",
            rows: [
              [button("undo", state.undoLabel ? `Undo ${state.undoLabel}` : "Undo", <Undo2 size={ICON} />, "Ctrl+Z", !state.canUndo)],
              [button("redo", state.redoLabel ? `Redo ${state.redoLabel}` : "Redo", <Redo2 size={ICON} />, "Ctrl+Y", !state.canRedo)],
            ],
          },
        ],
      },
      {
        id: "clipboard",
        label: "Clipboard",
        items: [
          { kind: "button", id: "paste", label: "Paste", size: "large", icon: <ClipboardPaste size={BIG} />, shortcut: "Ctrl+V", onClick: () => cmd.paste() },
          { kind: "stack", id: "clipboard-rows", rows: [[button("cut", "Cut", <Scissors size={ICON} />, "Ctrl+X")], [button("copy", "Copy", <Copy size={ICON} />, "Ctrl+C")]] },
        ],
      },
      {
        id: "font",
        label: "Font",
        items: [
          {
            kind: "stack",
            id: "font-rows",
            rows: [
              [
                {
                  kind: "select",
                  id: "font-family",
                  label: "Font",
                  value: style.font.name,
                  width: 130,
                  options: FONT_FAMILIES.map((name) => ({ value: name, label: name, style: { fontFamily: name } })),
                  onChange: (name) => cmd["font-family"](name),
                },
                {
                  kind: "select",
                  id: "font-size",
                  label: "Font size",
                  value: String(style.font.sizePt),
                  width: 56,
                  editable: true,
                  options: FONT_SIZES.map((size) => ({ value: String(size), label: String(size) })),
                  onChange: (size) => cmd["font-size"](size),
                },
              ],
              [
                toggle("bold", "Bold", <Bold size={ICON} />, style.font.bold, "Ctrl+B"),
                toggle("italic", "Italic", <Italic size={ICON} />, style.font.italic, "Ctrl+I"),
                toggle("underline", "Underline", <Underline size={ICON} />, style.font.underline, "Ctrl+U"),
                {
                  kind: "menu",
                  id: "borders",
                  label: "Borders",
                  icon: <Grid3x3 size={ICON} />,
                  showLabel: false,
                  menu: BORDER_PRESETS.map((item) => ({ id: item.id, label: item.label, separatorBefore: item.id === "none" })),
                  onMenuSelect: (id) => cmd.borders(id),
                },
                {
                  kind: "color",
                  id: "fill-color",
                  label: "Fill colour",
                  icon: <PaintBucket size={ICON} />,
                  value: model.colors.fill,
                  palette: swatches(FILL_COLORS),
                  allowNone: true,
                  noneLabel: "No fill",
                  onChange: (color) => cmd["fill-color"](color),
                },
                {
                  kind: "color",
                  id: "text-color",
                  label: "Text colour",
                  icon: <Baseline size={ICON} />,
                  value: model.colors.text,
                  palette: swatches(TEXT_COLORS),
                  allowNone: true,
                  onChange: (color) => cmd["text-color"](color),
                },
              ],
            ],
          },
        ],
      },
      {
        id: "alignment",
        label: "Alignment",
        items: [
          {
            kind: "stack",
            id: "alignment-rows",
            rows: [
              [
                toggle("align-top", "Align top", <AlignVerticalJustifyStart size={ICON} />, align.vertical === "top"),
                toggle("align-middle", "Align middle", <AlignVerticalJustifyCenter size={ICON} />, align.vertical === "middle"),
                toggle("align-bottom", "Align bottom", <AlignVerticalJustifyEnd size={ICON} />, align.vertical === "bottom"),
                toggle("wrap-text", "Wrap text", <WrapText size={ICON} />, align.wrapText),
              ],
              [
                toggle("align-left", "Align left", <AlignLeft size={ICON} />, align.horizontal === "left"),
                toggle("align-center", "Center", <AlignCenter size={ICON} />, align.horizontal === "center"),
                toggle("align-right", "Align right", <AlignRight size={ICON} />, align.horizontal === "right"),
                button("merge", "Merge or unmerge cells", <TableCellsMerge size={ICON} />),
              ],
            ],
          },
        ],
      },
      {
        id: "number",
        label: "Number",
        items: [
          {
            kind: "stack",
            id: "number-rows",
            rows: [
              [
                {
                  kind: "select",
                  id: "number-format",
                  label: "Number format",
                  value: preset ?? "",
                  placeholder: "Custom",
                  width: 110,
                  options: NUMBER_FORMAT_PRESETS.map((item) => ({ value: item.id, label: item.label })),
                  onChange: (id) => cmd["number-format"](id),
                },
              ],
              [
                button("currency", "Currency", <DollarSign size={ICON} />),
                button("percent", "Percent", <Percent size={ICON} />),
                button("decimals-more", "Increase decimals", <DecimalsArrowRight size={ICON} />),
                button("decimals-less", "Decrease decimals", <DecimalsArrowLeft size={ICON} />),
              ],
            ],
          },
        ],
      },
      {
        id: "cells",
        label: "Cells",
        items: [
          {
            kind: "menu",
            id: "insert-cells",
            label: "Insert",
            size: "large",
            icon: <BetweenHorizontalStart size={BIG} />,
            menu: [
              { id: "row-above", label: "Insert row above" },
              { id: "row-below", label: "Insert row below" },
              { id: "col-left", label: "Insert column left", separatorBefore: true },
              { id: "col-right", label: "Insert column right" },
            ],
            onMenuSelect: (id) => cmd["insert-cells"](id),
          },
          {
            kind: "menu",
            id: "delete-cells",
            label: "Delete",
            size: "large",
            icon: <Trash2 size={BIG} />,
            menu: [
              { id: "rows", label: "Delete rows", danger: true },
              { id: "columns", label: "Delete columns", danger: true },
            ],
            onMenuSelect: (id) => cmd["delete-cells"](id),
          },
        ],
      },
      {
        id: "editing",
        label: "Editing",
        items: [
          {
            kind: "stack",
            id: "editing-rows",
            rows: [
              [
                {
                  kind: "menu",
                  id: "fill",
                  label: "Fill",
                  icon: <ArrowDownToLine size={ICON} />,
                  menu: [
                    { id: "down", label: "Fill down", shortcut: "Ctrl+D" },
                    { id: "right", label: "Fill right", shortcut: "Ctrl+R" },
                  ],
                  onMenuSelect: (id) => cmd.fill(id),
                },
                {
                  kind: "menu",
                  id: "clear",
                  label: "Clear",
                  icon: <Eraser size={ICON} />,
                  menu: [
                    { id: "contents", label: "Clear contents", shortcut: "Delete" },
                    { id: "formats", label: "Clear formats" },
                    { id: "all", label: "Clear all" },
                  ],
                  onMenuSelect: (id) => cmd.clear(id),
                },
              ],
              [
                {
                  kind: "menu",
                  id: "sort",
                  label: "Sort",
                  icon: <ArrowUpNarrowWide size={ICON} />,
                  menu: [
                    { id: "asc", label: "Sort A to Z" },
                    { id: "desc", label: "Sort Z to A" },
                  ],
                  onMenuSelect: (id) => cmd.sort(id),
                },
                {
                  kind: "menu",
                  id: "filter",
                  label: model.filtered ? "Filter, on" : "Filter",
                  icon: <Filter size={ICON} />,
                  menu: [
                    { id: "value", label: "Show rows with the selected value" },
                    { id: "clear", label: "Show all rows", disabled: !model.filtered },
                  ],
                  onMenuSelect: (id) => cmd.filter(id),
                },
              ],
              [
                { kind: "button", id: "find", label: "Find", icon: <Search size={ICON} />, shortcut: "Ctrl+F", onClick: () => cmd.find() },
                { kind: "button", id: "replace", label: "Find and replace", icon: <Replace size={ICON} />, shortcut: "Ctrl+H", onClick: () => cmd.replace() },
              ],
            ],
          },
        ],
      },
    ],
  };
}
