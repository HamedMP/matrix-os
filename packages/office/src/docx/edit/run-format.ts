/** Character formatting: writing a `RunFormat` patch into a `w:rPr`. */

import type { RunFormat } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { createElement, remove, removeAttr, setAttr } from "../../xml/index.js";
import type { BlockRecord, DocxIndex } from "../internal.js";
import { firstChild, tableStyleIdOf } from "../internal.js";
import { RPR_ORDER } from "./schema-order.js";
import { ensureChild, insertOrdered } from "./xml-util.js";

/** Resolves a `w:rPr` (possibly null) to the format a reader sees. */
export type RunResolver = (properties: XmlElement | null) => RunFormat;

const HIGHLIGHT_NAMES: Readonly<Record<string, string>> = {
  "#000000": "black",
  "#0000ff": "blue",
  "#00ffff": "cyan",
  "#00ff00": "green",
  "#ff00ff": "magenta",
  "#ff0000": "red",
  "#ffff00": "yellow",
  "#ffffff": "white",
  "#000080": "darkBlue",
  "#008080": "darkCyan",
  "#008000": "darkGreen",
  "#800080": "darkMagenta",
  "#800000": "darkRed",
  "#808000": "darkYellow",
  "#808080": "darkGray",
  "#c0c0c0": "lightGray",
};

const FORMAT_KEYS: ReadonlySet<string> = new Set([
  "bold",
  "italic",
  "underline",
  "strike",
  "color",
  "highlight",
  "fontSizePt",
  "fontFamily",
  "verticalAlign",
]);

function invalid(message: string): OfficeError {
  return new OfficeError("invalid_argument", message);
}

function requireColor(value: unknown, what: string): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))) {
    throw invalid(`${what} must be #rrggbb or null`);
  }
}

/** Checks a format patch (`invalid_argument`). */
export function requireRunFormat(value: unknown, what = "format"): asserts value is Partial<RunFormat> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(`${what} must be an object`);
  const patch = value as Record<string, unknown>;
  for (const key of Object.keys(patch)) {
    if (!FORMAT_KEYS.has(key)) throw invalid(`${what} has an unknown property`);
    const entry = patch[key];
    if (entry === undefined) continue;
    switch (key) {
      case "bold":
      case "italic":
      case "underline":
      case "strike":
        if (typeof entry !== "boolean") throw invalid(`${what}.${key} must be a boolean`);
        break;
      case "color":
      case "highlight":
        requireColor(entry, `${what}.${key}`);
        break;
      case "fontSizePt":
        if (entry !== null && (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0 || entry > 1638)) {
          throw invalid(`${what}.fontSizePt must be a size in points or null`);
        }
        break;
      case "fontFamily":
        if (entry !== null && (typeof entry !== "string" || entry === "" || entry.length > 255 || /[\u0000-\u001f]/.test(entry))) {
          throw invalid(`${what}.fontFamily must be a font name or null`);
        }
        break;
      default:
        if (entry !== "baseline" && entry !== "superscript" && entry !== "subscript") {
          throw invalid(`${what}.verticalAlign is not a known value`);
        }
    }
  }
}

/** The resolver for runs of one paragraph: its style chain under the direct properties. */
export function runResolverFor(index: DocxIndex, record: BlockRecord): RunResolver {
  const table = record.parentTableId === null ? null : index.block(record.parentTableId);
  const base = index.resolver.paragraph(record.element, tableStyleIdOf(table?.element ?? null)).runBase;
  return (properties) => index.resolver.runFormat(base, properties);
}

function drop(properties: XmlElement, ...names: string[]): void {
  for (const name of names) {
    const element = firstChild(properties, name);
    if (element !== null) remove(element);
  }
}

function put(properties: XmlElement, name: string, attrs: ReadonlyArray<readonly [string, string]> = []): void {
  drop(properties, name);
  insertOrdered(properties, createElement(name, attrs), RPR_ORDER);
}

/** An on/off property: no element when the styles already give the wanted value, else an explicit one. */
function toggle(
  properties: XmlElement,
  names: readonly [string, string | null],
  wanted: boolean,
  read: () => boolean,
): void {
  if (read() === wanted) return;
  drop(properties, names[0]);
  if (names[1] !== null) drop(properties, names[1]);
  if (read() === wanted) return;
  const attrs: Array<readonly [string, string]> = wanted ? [] : [["w:val", "0"]];
  put(properties, names[0], attrs);
  if (names[1] !== null) put(properties, names[1], attrs);
}

/**
 * Writes the given properties into `properties` (a `w:rPr`, changed in
 * place). Properties the patch does not name are left as they are.
 */
export function applyRunFormat(properties: XmlElement, patch: Partial<RunFormat>, resolve: RunResolver): void {
  const seen = (): RunFormat => resolve(properties);
  if (patch.bold !== undefined) toggle(properties, ["w:b", "w:bCs"], patch.bold, () => seen().bold);
  if (patch.italic !== undefined) toggle(properties, ["w:i", "w:iCs"], patch.italic, () => seen().italic);
  if (patch.strike !== undefined && seen().strike !== patch.strike) {
    drop(properties, "w:dstrike");
    toggle(properties, ["w:strike", null], patch.strike, () => seen().strike);
  }
  if (patch.underline !== undefined && seen().underline !== patch.underline) {
    drop(properties, "w:u");
    if (seen().underline !== patch.underline) put(properties, "w:u", [["w:val", patch.underline ? "single" : "none"]]);
  }
  if (patch.color !== undefined && seen().color !== (patch.color?.toLowerCase() ?? null)) {
    drop(properties, "w:color");
    if (patch.color !== null) put(properties, "w:color", [["w:val", patch.color.slice(1).toUpperCase()]]);
    else if (seen().color !== null) put(properties, "w:color", [["w:val", "auto"]]);
  }
  if (patch.highlight !== undefined && seen().highlight !== (patch.highlight?.toLowerCase() ?? null)) {
    drop(properties, "w:highlight", "w:shd");
    if (patch.highlight !== null) {
      const name = HIGHLIGHT_NAMES[patch.highlight.toLowerCase()];
      if (name !== undefined) put(properties, "w:highlight", [["w:val", name]]);
      else {
        put(properties, "w:shd", [
          ["w:val", "clear"],
          ["w:color", "auto"],
          ["w:fill", patch.highlight.slice(1).toUpperCase()],
        ]);
      }
    } else if (seen().highlight !== null) {
      put(properties, "w:highlight", [["w:val", "none"]]);
    }
  }
  if (patch.fontSizePt !== undefined && seen().fontSizePt !== patch.fontSizePt) {
    drop(properties, "w:sz", "w:szCs");
    if (patch.fontSizePt !== null) {
      const halfPoints = String(Math.max(1, Math.round(patch.fontSizePt * 2)));
      put(properties, "w:sz", [["w:val", halfPoints]]);
      put(properties, "w:szCs", [["w:val", halfPoints]]);
    }
  }
  if (patch.fontFamily !== undefined && seen().fontFamily !== patch.fontFamily) {
    if (patch.fontFamily === null) drop(properties, "w:rFonts");
    else {
      const fonts = ensureChild(properties, "w:rFonts", RPR_ORDER);
      for (const theme of ["w:asciiTheme", "w:hAnsiTheme", "w:cstheme", "w:eastAsiaTheme"]) removeAttr(fonts, theme);
      for (const name of ["w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"]) setAttr(fonts, name, patch.fontFamily);
    }
  }
  if (patch.verticalAlign !== undefined && seen().verticalAlign !== patch.verticalAlign) {
    drop(properties, "w:vertAlign");
    if (seen().verticalAlign !== patch.verticalAlign) put(properties, "w:vertAlign", [["w:val", patch.verticalAlign]]);
  }
}
