/**
 * Applying a style patch: finds or adds the font, fill, border, number
 * format and cell format records that describe the patched style. Records
 * are only ever appended, so existing style ids keep their meaning.
 */

import type { BorderEdge, CellStylePatch, StyleId } from "../../api/xlsx.js";
import type { XmlElement } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import {
  appendChild,
  cloneNode,
  createElement,
  getAttr,
  remove,
  removeAttr,
  replaceNode,
  serializeXml,
  setAttr,
} from "../../xml/index.js";
import { FIRST_CUSTOM_FORMAT_ID, builtinFormatId } from "../format/builtin.js";
import { isHexColor, toArgb } from "./colors.js";
import type { StyleTable } from "./styles.js";
import { boolAttr, insertInOrder, kid, localOf, qualify, setChildren } from "./xml-util.js";

const STYLE_SHEET_ORDER = [
  "numFmts",
  "fonts",
  "fills",
  "borders",
  "cellStyleXfs",
  "cellXfs",
  "cellStyles",
  "dxfs",
  "tableStyles",
  "colors",
  "extLst",
];
const FONT_ORDER = ["b", "i", "strike", "condense", "extend", "outline", "shadow", "u", "vertAlign", "sz", "color", "name", "family", "charset", "scheme"];
const BORDER_ORDER = ["start", "left", "end", "right", "top", "bottom", "diagonal", "vertical", "horizontal"];
const XF_ORDER = ["alignment", "protection", "extLst"];
const LINE_STYLES = new Set(["none", "thin", "medium", "thick", "dashed", "dotted", "double", "hair"]);
const EDGES = ["top", "right", "bottom", "left"] as const;

/** Most cell formats a workbook may hold. */
export const MAX_CELL_FORMATS = 64_000;
/**
 * Most fonts, fills, borders or custom number formats a style write leaves
 * in the workbook. Each cell format names one of each, so more could never
 * be used; a table read from a file may already hold more and keeps them.
 */
export const MAX_STYLE_RECORDS = MAX_CELL_FORMATS;
const PATCH_CACHE_LIMIT = 4096;

interface WriteState {
  /** Serialised record to its index, per list. Never larger than the lists themselves. */
  fonts: Map<string, number>;
  fills: Map<string, number>;
  borders: Map<string, number>;
  xfs: Map<string, number>;
  /** `baseId|patch` to the resulting id. Cleared when it reaches {@link PATCH_CACHE_LIMIT}. */
  patches: Map<string, StyleId>;
}

const states = new WeakMap<StyleTable, WriteState>();

function index(records: readonly XmlElement[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < records.length; i++) {
    const key = serializeXml(records[i] as XmlElement);
    if (!map.has(key)) map.set(key, i);
  }
  return map;
}

function stateOf(table: StyleTable): WriteState {
  let state = states.get(table);
  if (state === undefined) {
    state = {
      fonts: index(table.fonts),
      fills: index(table.fills),
      borders: index(table.borders),
      xfs: index(table.xfs),
      patches: new Map(),
    };
    states.set(table, state);
  }
  return state;
}

function bad(message: string): OfficeError {
  return new OfficeError("invalid_argument", message);
}

function checkColor(value: unknown, what: string): void {
  if (value !== null && !isHexColor(value)) throw bad(`${what} must be #rrggbb or null`);
}

function checkPatch(patch: CellStylePatch): void {
  if (patch === null || typeof patch !== "object") throw bad("style patch must be an object");
  const font = patch.font;
  if (font !== undefined) {
    if (font.name !== undefined && (typeof font.name !== "string" || font.name === "" || font.name.length > 31)) {
      throw bad("font name must be 1 to 31 characters");
    }
    if (font.sizePt !== undefined && !(typeof font.sizePt === "number" && font.sizePt >= 1 && font.sizePt <= 409)) {
      throw bad("font size must be 1 to 409 points");
    }
    for (const key of ["bold", "italic", "underline", "strike"] as const) {
      if (font[key] !== undefined && typeof font[key] !== "boolean") throw bad(`font ${key} must be a boolean`);
    }
    if (font.color !== undefined) checkColor(font.color, "font colour");
  }
  if (patch.fill?.color !== undefined) checkColor(patch.fill.color, "fill colour");
  if (patch.border !== undefined) {
    for (const side of EDGES) {
      const edge = patch.border[side];
      if (edge === undefined) continue;
      if (edge === null || typeof edge !== "object" || !LINE_STYLES.has(edge.style)) throw bad("unknown border line style");
      checkColor(edge.color ?? null, "border colour");
    }
  }
  const alignment = patch.alignment;
  if (alignment !== undefined) {
    if (alignment.horizontal !== undefined && !["general", "left", "center", "right", "justify"].includes(alignment.horizontal)) {
      throw bad("unknown horizontal alignment");
    }
    if (alignment.vertical !== undefined && !["top", "middle", "bottom"].includes(alignment.vertical)) {
      throw bad("unknown vertical alignment");
    }
    if (alignment.wrapText !== undefined && typeof alignment.wrapText !== "boolean") throw bad("wrapText must be a boolean");
    if (alignment.indent !== undefined && !(Number.isInteger(alignment.indent) && alignment.indent >= 0 && alignment.indent <= 250)) {
      throw bad("indent must be 0 to 250");
    }
  }
  const code = patch.numberFormat;
  if (code !== undefined && (typeof code !== "string" || code === "" || code.length > 255)) {
    throw bad("number format must be 1 to 255 characters");
  }
}

/** The list element (`fonts`, `cellXfs`, …), created in schema order when the sheet lacks it. */
function listElement(table: StyleTable, local: string): XmlElement {
  const root = table.doc.root;
  let element = kid(root, local);
  if (element === null) {
    element = createElement(qualify(root, local), { count: "0" });
    insertInOrder(root, element, STYLE_SHEET_ORDER);
  }
  return element;
}

/** Appends a record to its list unless an identical one exists; returns its index. */
function intern(table: StyleTable, local: string, records: XmlElement[], keys: Map<string, number>, record: XmlElement): number {
  const planned = plan(table, local, records, keys, record, Number.POSITIVE_INFINITY, local);
  planned.append?.();
  return planned.id;
}

/** A record's index, and the step that appends it (null when an identical record is in the list already). */
interface Planned {
  id: number;
  append: (() => void) | null;
}

/**
 * Finds a record in its list, or plans its append. Nothing changes until
 * `append` runs, so a write that fails a later limit leaves the tables as
 * they were. Throws `limit_exceeded` when the list already holds `max`.
 */
function plan(table: StyleTable, local: string, records: XmlElement[], keys: Map<string, number>, record: XmlElement, max: number, what: string): Planned {
  const key = serializeXml(record);
  const found = keys.get(key);
  if (found !== undefined) return { id: found, append: null };
  if (records.length >= max) throw new OfficeError("limit_exceeded", `too many ${what}`, { details: { max } });
  const id = records.length;
  return {
    id,
    append: () => {
      const list = listElement(table, local);
      appendChild(list, record);
      records.push(record);
      setAttr(list, "count", String(records.length));
      keys.set(key, id);
      table.dirty = true;
    },
  };
}

function setValueChild(parent: XmlElement, local: string, value: string | null, order: readonly string[]): void {
  const existing = kid(parent, local);
  if (value === null) {
    if (existing !== null) remove(existing);
  } else if (existing !== null) {
    if (getAttr(existing, "val") !== value) setAttr(existing, "val", value);
  } else {
    insertInOrder(parent, createElement(qualify(parent, local), { val: value }), order);
  }
}

function setFlagChild(parent: XmlElement, local: string, on: boolean, order: readonly string[]): void {
  const existing = kid(parent, local);
  const current = existing !== null && boolAttr(getAttr(existing, "val"), true);
  if (current === on) return;
  if (existing !== null) remove(existing);
  if (on) insertInOrder(parent, createElement(qualify(parent, local)), order);
}

function colorElement(parent: XmlElement, local: string, color: string): XmlElement {
  return createElement(qualify(parent, local), { rgb: toArgb(color) });
}

/**
 * Puts the children of a new element into schema order. A font copied from
 * a file can have them in another order, which lenient readers accept; one
 * the engine writes follows the sequence every reader accepts. Children the
 * order does not name keep their place after the others.
 */
function sortChildren(element: XmlElement, order: readonly string[]): void {
  const ranked = element.children.map((node, position) => {
    const rank = node.kind === "element" ? order.indexOf(localOf(node.name)) : -1;
    return { node, position, rank: rank === -1 ? order.length : rank };
  });
  const sorted = [...ranked].sort((a, b) => a.rank - b.rank || a.position - b.position);
  if (sorted.every((entry, at) => entry === ranked[at])) return;
  setChildren(element, sorted.map((entry) => entry.node));
}

function patchFont(table: StyleTable, state: WriteState, baseId: number, patch: NonNullable<CellStylePatch["font"]>): Planned {
  const base = table.fonts[baseId];
  const font = base === undefined ? createElement(qualify(table.doc.root, "font")) : cloneNode(base);
  const before = serializeXml(font);
  if (patch.bold !== undefined) setFlagChild(font, "b", patch.bold, FONT_ORDER);
  if (patch.italic !== undefined) setFlagChild(font, "i", patch.italic, FONT_ORDER);
  if (patch.strike !== undefined) setFlagChild(font, "strike", patch.strike, FONT_ORDER);
  if (patch.underline !== undefined) {
    const existing = kid(font, "u");
    const shown = existing !== null && getAttr(existing, "val") !== "none";
    if (patch.underline !== shown) setFlagChild(font, "u", patch.underline, FONT_ORDER);
  }
  if (patch.sizePt !== undefined) setValueChild(font, "sz", String(patch.sizePt), FONT_ORDER);
  if (patch.color !== undefined) {
    const existing = kid(font, "color");
    const same = patch.color === null ? existing === null : existing !== null && getAttr(existing, "rgb") === toArgb(patch.color);
    if (!same) {
      if (existing !== null) remove(existing);
      if (patch.color !== null) insertInOrder(font, colorElement(font, "color", patch.color), FONT_ORDER);
    }
  }
  if (patch.name !== undefined) {
    setValueChild(font, "name", patch.name, FONT_ORDER);
    // A theme font scheme would override the name.
    setValueChild(font, "scheme", null, FONT_ORDER);
  }
  // A patch that changes nothing keeps the font it started from, whatever its order.
  if (serializeXml(font) !== before) sortChildren(font, FONT_ORDER);
  return plan(table, "fonts", table.fonts, state.fonts, font, MAX_STYLE_RECORDS, "fonts");
}

function patchFill(table: StyleTable, state: WriteState, color: string | null): Planned {
  const root = table.doc.root;
  // Indexes 0 and 1 are reserved for the empty and the grey pattern. At most these two are added before the limits are checked.
  while (table.fills.length < 2) {
    const pattern = createElement(qualify(root, "patternFill"), { patternType: table.fills.length === 0 ? "none" : "gray125" });
    const filler = createElement(qualify(root, "fill"), undefined, [pattern]);
    const list = listElement(table, "fills");
    appendChild(list, filler);
    table.fills.push(filler);
    setAttr(list, "count", String(table.fills.length));
    state.fills.set(serializeXml(filler), table.fills.length - 1);
    table.dirty = true;
  }
  if (color === null) return { id: 0, append: null };
  const pattern = createElement(qualify(root, "patternFill"), { patternType: "solid" }, [
    createElement(qualify(root, "fgColor"), { rgb: toArgb(color) }),
    createElement(qualify(root, "bgColor"), { indexed: "64" }),
  ]);
  const fill = createElement(qualify(root, "fill"), undefined, [pattern]);
  return plan(table, "fills", table.fills, state.fills, fill, MAX_STYLE_RECORDS, "fills");
}

function patchBorder(table: StyleTable, state: WriteState, baseId: number, patch: NonNullable<CellStylePatch["border"]>): Planned {
  const root = table.doc.root;
  const base = table.borders[baseId];
  const border =
    base === undefined
      ? createElement(qualify(root, "border"), undefined, ["left", "right", "top", "bottom", "diagonal"].map((side) => createElement(qualify(root, side))))
      : cloneNode(base);
  for (const side of EDGES) {
    const edge: BorderEdge | undefined = patch[side];
    if (edge === undefined) continue;
    const element =
      edge.style === "none"
        ? createElement(qualify(border, side))
        : createElement(
            qualify(border, side),
            { style: edge.style },
            edge.color === null || edge.color === undefined ? [] : [colorElement(border, "color", edge.color)],
          );
    const existing = kid(border, side);
    if (existing !== null) replaceNode(existing, element);
    else insertInOrder(border, element, BORDER_ORDER);
  }
  return plan(table, "borders", table.borders, state.borders, border, MAX_STYLE_RECORDS, "borders");
}

function numberFormatId(table: StyleTable, code: string): Planned {
  const builtin = builtinFormatId(code);
  if (builtin !== null) return { id: builtin, append: null };
  let highest = FIRST_CUSTOM_FORMAT_ID - 1;
  for (const [id, existing] of table.numFmts) {
    if (existing === code) return { id, append: null };
    if (id > highest) highest = id;
  }
  if (table.numFmts.size >= MAX_STYLE_RECORDS) {
    throw new OfficeError("limit_exceeded", "too many number formats", { details: { max: MAX_STYLE_RECORDS } });
  }
  const id = highest + 1;
  return {
    id,
    append: () => {
      const list = listElement(table, "numFmts");
      appendChild(list, createElement(qualify(table.doc.root, "numFmt"), { numFmtId: String(id), formatCode: code }));
      table.numFmts.set(id, code);
      setAttr(list, "count", String(table.numFmts.size));
      table.dirty = true;
    },
  };
}

function patchAlignment(xf: XmlElement, patch: NonNullable<CellStylePatch["alignment"]>): boolean {
  let alignment = kid(xf, "alignment");
  const before = alignment === null ? "" : serializeXml(alignment);
  if (alignment === null) {
    alignment = createElement(qualify(xf, "alignment"));
    insertInOrder(xf, alignment, XF_ORDER);
  }
  const set = (name: string, value: string | null): void => {
    if (value === null) removeAttr(alignment as XmlElement, name);
    else setAttr(alignment as XmlElement, name, value);
  };
  if (patch.horizontal !== undefined) set("horizontal", patch.horizontal === "general" ? null : patch.horizontal);
  if (patch.vertical !== undefined) {
    set("vertical", patch.vertical === "bottom" ? null : patch.vertical === "middle" ? "center" : "top");
  }
  if (patch.wrapText !== undefined) set("wrapText", patch.wrapText ? "1" : null);
  if (patch.indent !== undefined) set("indent", patch.indent === 0 ? null : String(patch.indent));
  if (alignment.attrs.length === 0 && alignment.children.length === 0) {
    remove(alignment);
    return before !== "";
  }
  return serializeXml(alignment) !== before;
}

function intOf(element: XmlElement | undefined, name: string): number {
  const value = element === undefined ? 0 : Number(getAttr(element, name) ?? "0");
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/** The style id of `baseId` with `patch` applied. Equal results share one id. */
export function applyStylePatch(table: StyleTable, baseId: StyleId, patch: CellStylePatch): StyleId {
  const base = table.clamp(baseId);
  const state = stateOf(table);
  const cacheKey = `${base}|${JSON.stringify(patch)}`;
  const cached = state.patches.get(cacheKey);
  if (cached !== undefined) return cached;
  checkPatch(patch);
  const root = table.doc.root;
  if (table.xfs.length === 0) {
    // A sheet without cell formats: make the default one so ids start at 0.
    const first = createElement(qualify(root, "xf"), { numFmtId: "0", fontId: "0", fillId: "0", borderId: "0" });
    intern(table, "cellXfs", table.xfs, state.xfs, first);
  }
  const baseXf = table.xfs[base] as XmlElement;
  const xf = cloneNode(baseXf);
  // Every record is planned first and appended only once all limits hold, so a refused write adds nothing.
  const appends: Array<() => void> = [];
  const change = (attr: string, apply: string, planned: Planned): void => {
    if (planned.append !== null) appends.push(planned.append);
    if (planned.id === intOf(baseXf, attr)) return;
    setAttr(xf, attr, String(planned.id));
    setAttr(xf, apply, "1");
  };
  if (patch.font !== undefined && Object.keys(patch.font).length > 0) {
    change("fontId", "applyFont", patchFont(table, state, intOf(baseXf, "fontId"), patch.font));
  }
  if (patch.fill?.color !== undefined) change("fillId", "applyFill", patchFill(table, state, patch.fill.color));
  if (patch.border !== undefined && Object.keys(patch.border).length > 0) {
    change("borderId", "applyBorder", patchBorder(table, state, intOf(baseXf, "borderId"), patch.border));
  }
  if (patch.numberFormat !== undefined) change("numFmtId", "applyNumberFormat", numberFormatId(table, patch.numberFormat));
  if (patch.alignment !== undefined && patchAlignment(xf, patch.alignment)) setAttr(xf, "applyAlignment", "1");
  const cellFormat = plan(table, "cellXfs", table.xfs, state.xfs, xf, MAX_CELL_FORMATS, "cell formats");
  for (const append of appends) append();
  cellFormat.append?.();
  const id = cellFormat.id;
  if (state.patches.size >= PATCH_CACHE_LIMIT) state.patches.clear();
  state.patches.set(cacheKey, id);
  return id;
}
