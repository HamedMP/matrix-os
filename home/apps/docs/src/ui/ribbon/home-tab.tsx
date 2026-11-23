/** The Home tab: history, clipboard, font, paragraph, styles and find. */

import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  AArrowDown,
  AArrowUp,
  Baseline,
  Bold,
  ClipboardPaste,
  Copy,
  Eraser,
  Highlighter,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Redo2,
  Replace,
  Scissors,
  Search,
  Strikethrough,
  Subscript,
  Superscript,
  Underline,
  Undo2,
  UnfoldVertical,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ParagraphAlignment, RunFormat } from "../../../../_shared/office-engine/index";
import type { RibbonGroup, RibbonItem, RibbonPanelTab } from "../../../../_shared/office-ui";
import { currentStyleId } from "./styles-model";
import type { DocsRibbonContext } from "./types";

export const FONT_FAMILIES = ["Aptos", "Arial", "Calibri", "Cambria", "Courier New", "Georgia", "Helvetica", "Times New Roman", "Verdana"] as const;
export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72] as const;
const DEFAULT_FONT_SIZE = 11;
/** The largest size the file format stores (1638 pt). */
const MAX_FONT_SIZE = 1638;
/** One indent step: half an inch. */
export const INDENT_STEP_PT = 36;
const SPACING_STEPS = [0, 6, 12, 18] as const;

/** Highlight colours the file format names; others are stored as shading. */
const HIGHLIGHTS = [
  { value: "#ffff00", name: "Yellow" },
  { value: "#00ff00", name: "Bright green" },
  { value: "#00ffff", name: "Turquoise" },
  { value: "#ff00ff", name: "Pink" },
  { value: "#0000ff", name: "Blue" },
  { value: "#ff0000", name: "Red" },
  { value: "#000080", name: "Dark blue" },
  { value: "#008080", name: "Teal" },
  { value: "#008000", name: "Green" },
  { value: "#800080", name: "Violet" },
  { value: "#800000", name: "Dark red" },
  { value: "#808000", name: "Dark yellow" },
  { value: "#808080", name: "Gray" },
  { value: "#c0c0c0", name: "Light gray" },
  { value: "#000000", name: "Black" },
] as const;

const CLEAR_FORMAT: Partial<RunFormat> = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: null,
  highlight: null,
  fontSizePt: null,
  fontFamily: null,
  verticalAlign: "baseline",
};

const ALIGNMENTS: ReadonlyArray<{ id: ParagraphAlignment; label: string; shortcut?: string; icon: ReactNode }> = [
  { id: "left", label: "Align left", icon: <AlignLeft size={16} /> },
  { id: "center", label: "Center", icon: <AlignCenter size={16} /> },
  { id: "right", label: "Align right", icon: <AlignRight size={16} /> },
  { id: "justify", label: "Justify", icon: <AlignJustify size={16} /> },
];

const isColor = (value: string | null): value is string => value !== null && /^#[0-9a-f]{6}$/i.test(value);

/** A typed font size, or null when it is not a size the file can store. Rounded to half points. */
export function parseFontSize(value: string): number | null {
  const size = Number.parseFloat(value.replace(/\s*pt$/i, ""));
  if (!Number.isFinite(size) || size < 1 || size > MAX_FONT_SIZE) return null;
  return Math.round(size * 2) / 2;
}

/** The next preset size above or below the current one. */
export function stepFontSize(current: number | null, direction: 1 | -1): number {
  const size = current ?? DEFAULT_FONT_SIZE;
  if (direction > 0) return FONT_SIZES.find((preset) => preset > size) ?? Math.min(MAX_FONT_SIZE, size + 12);
  return [...FONT_SIZES].reverse().find((preset) => preset < size) ?? Math.max(1, size - 1);
}

function historyGroup({ state, actions }: DocsRibbonContext): RibbonGroup {
  return {
    id: "history",
    label: "Undo",
    items: [
      { kind: "button", id: "undo", label: "Undo", shortcut: "Ctrl+Z", icon: <Undo2 size={16} />, showLabel: false, disabled: !state.canUndo || !state.hasEditor, onClick: actions.undo },
      { kind: "button", id: "redo", label: "Redo", shortcut: "Ctrl+Y", icon: <Redo2 size={16} />, showLabel: false, disabled: !state.canRedo || !state.hasEditor, onClick: actions.redo },
    ],
  };
}

function clipboardGroup({ state, actions }: DocsRibbonContext): RibbonGroup {
  return {
    id: "clipboard",
    label: "Clipboard",
    items: [
      { kind: "button", id: "paste", label: "Paste", shortcut: "Ctrl+V", size: "large", icon: <ClipboardPaste size={20} />, disabled: !state.editable, onClick: actions.paste },
      {
        kind: "stack",
        id: "clipboard-rows",
        rows: [
          [{ kind: "button", id: "cut", label: "Cut", shortcut: "Ctrl+X", icon: <Scissors size={16} />, disabled: !state.editable || !state.hasSelection, onClick: actions.cut }],
          [{ kind: "button", id: "copy", label: "Copy", shortcut: "Ctrl+C", icon: <Copy size={16} />, disabled: !state.hasEditor || !state.hasSelection, onClick: actions.copy }],
        ],
      },
    ],
  };
}

function fontGroup({ state, actions }: DocsRibbonContext): RibbonGroup {
  const off = !state.editable;
  const format = state.format;
  const caret = state.caret;
  const size = caret?.fontSizePt ?? null;
  const toggle = (id: "bold" | "italic" | "underline" | "strike", label: string, icon: ReactNode, shortcut?: string): RibbonItem => ({
    kind: "toggle",
    id,
    label,
    shortcut,
    icon,
    showLabel: false,
    pressed: format?.[id] ?? false,
    disabled: off,
    onToggle: () => actions.toggleFormat(id),
  });
  const script = (id: "subscript" | "superscript", label: string, icon: ReactNode): RibbonItem => ({
    kind: "toggle",
    id,
    label,
    icon,
    showLabel: false,
    pressed: caret?.verticalAlign === id,
    disabled: off,
    onToggle: (next) => actions.setRunFormat({ verticalAlign: next ? id : "baseline" }),
  });
  return {
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
              placeholder: "Font",
              width: 132,
              value: caret?.fontFamily ?? "",
              options: FONT_FAMILIES.map((family) => ({ value: family, label: family, style: { fontFamily: family } })),
              disabled: off,
              onChange: (value) => {
                if (value !== "") actions.setRunFormat({ fontFamily: value });
              },
            },
            {
              kind: "select",
              id: "font-size",
              label: "Font size",
              editable: true,
              width: 56,
              value: size === null ? "" : String(size),
              placeholder: String(DEFAULT_FONT_SIZE),
              options: FONT_SIZES.map((preset) => ({ value: String(preset), label: String(preset) })),
              disabled: off,
              onChange: (value) => {
                const parsed = parseFontSize(value);
                if (parsed !== null) actions.setRunFormat({ fontSizePt: parsed });
              },
            },
            { kind: "button", id: "font-grow", label: "Increase font size", icon: <AArrowUp size={16} />, showLabel: false, disabled: off, onClick: () => actions.setRunFormat({ fontSizePt: stepFontSize(size, 1) }) },
            { kind: "button", id: "font-shrink", label: "Decrease font size", icon: <AArrowDown size={16} />, showLabel: false, disabled: off, onClick: () => actions.setRunFormat({ fontSizePt: stepFontSize(size, -1) }) },
          ],
          [
            toggle("bold", "Bold", <Bold size={16} />, "Ctrl+B"),
            toggle("italic", "Italic", <Italic size={16} />, "Ctrl+I"),
            toggle("underline", "Underline", <Underline size={16} />, "Ctrl+U"),
            toggle("strike", "Strikethrough", <Strikethrough size={16} />),
            script("subscript", "Subscript", <Subscript size={16} />),
            script("superscript", "Superscript", <Superscript size={16} />),
            {
              kind: "color",
              id: "font-color",
              label: "Font colour",
              icon: <Baseline size={16} />,
              value: state.colors.font,
              allowNone: true,
              noneLabel: "Automatic",
              disabled: off,
              onChange: (color) => actions.setFontColor(isColor(color) ? color.toLowerCase() : null),
            },
            {
              kind: "color",
              id: "highlight",
              label: "Text highlight colour",
              icon: <Highlighter size={16} />,
              value: state.colors.highlight,
              palette: HIGHLIGHTS,
              allowNone: true,
              noneLabel: "No colour",
              disabled: off,
              onChange: (color) => actions.setHighlight(isColor(color) ? color.toLowerCase() : null),
            },
            { kind: "button", id: "clear-format", label: "Clear formatting", icon: <Eraser size={16} />, showLabel: false, disabled: off, onClick: () => actions.setRunFormat(CLEAR_FORMAT) },
          ],
        ],
      },
    ],
  };
}

function paragraphGroup({ state, actions }: DocsRibbonContext): RibbonGroup {
  const off = !state.editable;
  const indent = state.caret?.indentLeftPt ?? 0;
  const before = state.caret?.spacingBeforePt ?? null;
  const after = state.caret?.spacingAfterPt ?? null;
  const spacing = (edge: "before" | "after", current: number | null) =>
    SPACING_STEPS.map((pt, index) => ({
      id: `${edge}-${pt}`,
      label: `${edge === "before" ? "Space before" : "Space after"}: ${pt === 0 ? "none" : `${pt} pt`}`,
      checked: current === pt,
      separatorBefore: edge === "after" && index === 0,
    }));
  return {
    id: "paragraph",
    label: "Paragraph",
    items: [
      {
        kind: "stack",
        id: "paragraph-rows",
        rows: [
          ALIGNMENTS.map(
            (entry): RibbonItem => ({
              kind: "toggle",
              id: `align-${entry.id}`,
              label: entry.label,
              icon: entry.icon,
              showLabel: false,
              pressed: state.format?.alignment === entry.id,
              disabled: off,
              onToggle: () => actions.setParagraphStyle({ alignment: entry.id }),
            }),
          ),
          [
            { kind: "button", id: "indent-less", label: "Decrease indent", icon: <IndentDecrease size={16} />, showLabel: false, disabled: off || indent <= 0, onClick: () => actions.setParagraphStyle({ indentLeftPt: Math.max(0, indent - INDENT_STEP_PT) }) },
            { kind: "button", id: "indent-more", label: "Increase indent", icon: <IndentIncrease size={16} />, showLabel: false, disabled: off, onClick: () => actions.setParagraphStyle({ indentLeftPt: indent + INDENT_STEP_PT }) },
            {
              kind: "menu",
              id: "spacing",
              label: "Paragraph spacing",
              icon: <UnfoldVertical size={16} />,
              showLabel: false,
              disabled: off,
              menu: [...spacing("before", before), ...spacing("after", after)],
              onMenuSelect: (id) => {
                const [edge, value] = id.split("-");
                const pt = Number(value);
                if (!Number.isFinite(pt)) return;
                actions.setParagraphStyle(edge === "before" ? { spacingBeforePt: pt } : { spacingAfterPt: pt });
              },
            },
          ],
        ],
      },
    ],
  };
}

export function homeTab(ctx: DocsRibbonContext): RibbonPanelTab {
  const { state, actions } = ctx;
  return {
    id: "home",
    label: "Home",
    groups: [
      historyGroup(ctx),
      clipboardGroup(ctx),
      fontGroup(ctx),
      paragraphGroup(ctx),
      {
        id: "styles",
        label: "Styles",
        items: [
          {
            kind: "gallery",
            id: "styles",
            label: "Styles",
            options: state.styles.map((style) => ({ id: style.id, label: style.label, style: style.preview })),
            value: currentStyleId(state.format, state.styles),
            disabled: !state.editable,
            onSelect: actions.applyStyle,
          },
        ],
      },
      {
        id: "editing",
        label: "Editing",
        items: [
          { kind: "toggle", id: "find", label: "Find", shortcut: "Ctrl+F", icon: <Search size={16} />, pressed: state.findOpen, disabled: !state.hasEditor, onToggle: actions.toggleFind },
          { kind: "button", id: "replace", label: "Replace", shortcut: "Ctrl+H", icon: <Replace size={16} />, disabled: !state.hasEditor, onClick: actions.openFind },
        ],
      },
    ],
  };
}
