/**
 * How a cell looks: the engine's cell style as CSS, alignment, the width its
 * text needs and how far it may run into empty neighbours, and the words
 * that explain an error value.
 */

import type { BorderEdge, CellStyle, CellValue } from "../session/engine";

export type HorizontalAlign = "left" | "center" | "right";

export interface CellLook {
  /** Inline styles for the cell element. */
  css: Record<string, string | number>;
  align: HorizontalAlign;
  wrap: boolean;
  /** Font size in pixels and weight, for measuring text. */
  fontPx: number;
  bold: boolean;
  italic: boolean;
  fontFamily: string;
}

const DEFAULT_FONT_PT = 11;
export const DEFAULT_FONT_PX = 13;
const FONT_FALLBACK = "var(--app-font, system-ui, sans-serif)";

function fontPx(sizePt: number): number {
  // The default size of a workbook is drawn at the app's text size; other sizes keep their proportion.
  return Math.max(6, Math.round((sizePt / DEFAULT_FONT_PT) * DEFAULT_FONT_PX * 10) / 10);
}

function safeFontName(name: string): string {
  return name.replace(/[^\p{L}\p{N} \-_]/gu, "").trim();
}

const GENERIC_FONTS = new Set(["", "calibri", "arial", "aptos narrow", "aptos", "helvetica", "liberation sans"]);

function luminance(color: string): number {
  const value = Number.parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

function borderCss(edge: BorderEdge): string | null {
  if (edge.style === "none") return null;
  const color = edge.color ?? "currentColor";
  switch (edge.style) {
    case "medium":
      return `2px solid ${color}`;
    case "thick":
      return `3px solid ${color}`;
    case "dashed":
      return `1px dashed ${color}`;
    case "dotted":
    case "hair":
      return `1px dotted ${color}`;
    case "double":
      return `3px double ${color}`;
    default:
      return `1px solid ${color}`;
  }
}

/** The alignment a value gets when the cell does not set one: numbers right, TRUE/FALSE and errors centred, text left. */
export function generalAlign(value: CellValue): HorizontalAlign {
  if (typeof value === "number") return "right";
  if (typeof value === "boolean" || (value !== null && typeof value === "object")) return "center";
  return "left";
}

/** A cell style as CSS. Pure: the same style and kind of value give the same result. */
export function cellLook(style: CellStyle, value: CellValue): CellLook {
  const css: Record<string, string | number> = {};
  const font = style.font;
  const px = fontPx(font.sizePt);
  if (px !== DEFAULT_FONT_PX) css.fontSize = `${px}px`;
  const name = safeFontName(font.name);
  const fontFamily = GENERIC_FONTS.has(name.toLowerCase()) ? FONT_FALLBACK : `"${name}", ${FONT_FALLBACK}`;
  if (fontFamily !== FONT_FALLBACK) css.fontFamily = fontFamily;
  if (font.bold) css.fontWeight = 700;
  if (font.italic) css.fontStyle = "italic";
  const lines = [font.underline ? "underline" : "", font.strike ? "line-through" : ""].filter((line) => line !== "");
  if (lines.length > 0) css.textDecoration = lines.join(" ");
  const fill = style.fill.color;
  if (fill !== null) css.backgroundColor = fill;
  if (font.color !== null && (fill !== null || font.color !== "#000000")) {
    // Black text without a fill is the default look: it follows the theme instead of vanishing on a dark one.
    css.color = font.color;
  } else if (fill !== null) {
    css.color = luminance(fill) > 0.55 ? "#111111" : "#ffffff";
  }
  const top = borderCss(style.border.top);
  const right = borderCss(style.border.right);
  const bottom = borderCss(style.border.bottom);
  const left = borderCss(style.border.left);
  if (top !== null) css.borderTop = top;
  if (right !== null) css.borderRight = right;
  if (bottom !== null) css.borderBottom = bottom;
  if (left !== null) css.borderLeft = left;
  const alignment = style.alignment;
  const align: HorizontalAlign =
    alignment.horizontal === "general" || alignment.horizontal === "justify"
      ? generalAlign(value)
      : alignment.horizontal;
  css.justifyContent = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
  if (align !== "left") css.textAlign = align;
  css.alignItems = alignment.vertical === "top" ? "flex-start" : alignment.vertical === "middle" ? "center" : "flex-end";
  if (alignment.wrapText) css.whiteSpace = "pre-wrap";
  if (alignment.indent > 0) css[align === "right" ? "paddingRight" : "paddingLeft"] = `${4 + alignment.indent * 8}px`;
  return { css, align, wrap: alignment.wrapText, fontPx: px, bold: font.bold, italic: font.italic, fontFamily };
}

/** Horizontal padding inside a cell, both sides together. */
export const CELL_PADDING_PX = 8;

let context: CanvasRenderingContext2D | null | undefined;
const widths = new Map<string, number>();
const MAX_MEASURED = 5000;
/** How long the app font read from the page is reused before it is read again (a theme may change it). */
const APP_FONT_TTL_MS = 5000;
let appFont: { family: string; at: number } | null = null;

function canvasContext(): CanvasRenderingContext2D | null {
  if (context !== undefined) return context;
  context = null;
  try {
    if (typeof document !== "undefined" && !/jsdom/i.test(globalThis.navigator?.userAgent ?? "")) {
      context = document.createElement("canvas").getContext("2d");
      // Widths measured before a web font arrived were measured in its fallback.
      document.fonts?.addEventListener?.("loadingdone", () => widths.clear());
    }
  } catch (error: unknown) {
    console.warn("text measuring falls back to an estimate", error instanceof Error ? error.name : "error");
  }
  return context;
}

/** The font family `--app-font` resolves to on the page: the one the grid draws its text in. */
function pageAppFont(): string {
  const now = Date.now();
  if (appFont !== null && now - appFont.at < APP_FONT_TTL_MS) return appFont.family;
  const family = getComputedStyle(document.documentElement).getPropertyValue("--app-font").trim();
  appFont = { family: family === "" ? "system-ui, sans-serif" : family, at: now };
  return appFont.family;
}

/**
 * The canvas font that measures text the way a cell draws it: the app font
 * stands in for the `var(--app-font, ...)` part of the cell's family, so text
 * is measured in the font it is shown in, not in a wider or narrower one.
 */
export function canvasFont(look: Pick<CellLook, "fontPx" | "bold" | "italic" | "fontFamily">, appFamily: string): string {
  const family = look.fontFamily.includes(FONT_FALLBACK) ? look.fontFamily.replace(FONT_FALLBACK, appFamily) : look.fontFamily;
  return `${look.italic ? "italic " : ""}${look.bold ? "700 " : ""}${look.fontPx}px ${family}`;
}

/** Width of text in pixels: measured on a canvas when there is one, estimated from the character count otherwise. */
export function textWidth(text: string, look: Pick<CellLook, "fontPx" | "bold" | "italic" | "fontFamily">): number {
  if (text === "") return 0;
  const ctx = canvasContext();
  if (ctx === null) return Math.ceil(text.length * look.fontPx * (look.bold ? 0.62 : 0.56));
  const font = canvasFont(look, pageAppFont());
  const key = `${font}|${text}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width);
  if (widths.size >= MAX_MEASURED) widths.clear();
  widths.set(key, width);
  return width;
}

/**
 * How many pixels wider than its column a cell is drawn so that its text
 * shows over empty neighbours, as spreadsheets do for text that does not
 * fit. `neighbour(i)` describes the i-th cell to the right (from 1): its
 * width, or null when it holds something or the sheet ends. Only text that
 * starts at the left edge overflows; numbers never do.
 */
export function overflowWidth(needed: number, own: number, neighbour: (index: number) => number | null, maxCells = 64): number {
  let extra = 0;
  for (let index = 1; index <= maxCells && own + extra < needed; index++) {
    const width = neighbour(index);
    if (width === null) break;
    extra += width;
  }
  return extra;
}

const ERROR_HELP: Record<string, string> = {
  "#DIV/0!": "Division by zero.",
  "#VALUE!": "A value has the wrong type for this formula.",
  "#REF!": "The formula refers to a cell that no longer exists, or to itself.",
  "#NAME?": "The formula uses a name or function that is not known.",
  "#N/A": "No value is available.",
  "#NUM!": "The numbers in the formula give no valid result.",
  "#NULL!": "The ranges in the formula do not meet.",
};

/** A sentence that explains an error value, or null for anything else. */
export function errorHelp(value: CellValue): string | null {
  if (value === null || typeof value !== "object") return null;
  return ERROR_HELP[value.code] ?? "The formula could not be calculated.";
}
