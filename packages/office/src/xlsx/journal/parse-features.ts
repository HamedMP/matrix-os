/** Reading the sheet features a saved deletion kept. Untrusted like the rest of the journal part. */

import { MAX_COLS, MAX_ROWS } from "../workbook/a1.js";
import { MAX_FEATURE_ITEMS, MAX_FEATURE_TEXT, type SheetFeatureState } from "../workbook/features.js";
import { MAX_NOTE_PARTS } from "../workbook/notes.js";
import { MAX_TABLES_PER_SHEET } from "../workbook/tables.js";
import { fail, int, list, obj, text } from "./parse-util.js";

const MAX_ATTRS = 64;
const MAX_ATTR_TEXT = 1024;
const MAX_REF_TEXT = 64;
const MAX_PART_NAME = 512;
const MAX_ELEMENTS = 10_000;

function attrs(value: unknown): Array<[string, string]> {
  return list(value, MAX_ATTRS).map((item) => {
    const pair = list(item, 2);
    if (pair.length !== 2) fail();
    const name = text(pair[0], MAX_ATTR_TEXT, 1);
    // An attribute name goes into markup as it is.
    if (!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(name)) fail();
    return [name, text(pair[1], MAX_ATTR_TEXT)];
  });
}

function refOrNull(value: unknown): string | null {
  return value === null ? null : text(value, MAX_REF_TEXT, 1);
}

/** The features of a deletion entry: null, or a state whose every field is of the right type and within bounds. */
export function features(value: unknown): SheetFeatureState | null {
  if (value === null) return null;
  const o = obj(value);
  let budget = MAX_FEATURE_TEXT;
  const markup = (item: unknown): string => {
    const s = text(item, MAX_FEATURE_TEXT);
    budget -= s.length;
    if (budget < 0) fail();
    return s;
  };
  return {
    ns: attrs(o.ns),
    elements: list(o.elements, MAX_ELEMENTS).map(markup),
    tables: list(o.tables, MAX_TABLES_PER_SHEET).map((item) => {
      const t = obj(item);
      return { part: text(t.part, MAX_PART_NAME, 1), refs: list(t.refs, MAX_ELEMENTS).map(refOrNull) };
    }),
    notes: list(o.notes, MAX_NOTE_PARTS).map((item) => {
      const n = obj(item);
      return { name: text(n.name, MAX_PART_NAME, 1), text: markup(n.text) };
    }),
    arrays: list(o.arrays, MAX_FEATURE_ITEMS).map((item) => {
      const a = obj(item);
      return { row: int(a.row, 0, MAX_ROWS - 1), col: int(a.col, 0, MAX_COLS - 1), attrs: attrs(a.attrs), ref: refOrNull(a.ref) };
    }),
    rows: list(o.rows, MAX_FEATURE_ITEMS).map((item) => {
      const r = obj(item);
      if (typeof r.hidden !== "boolean") fail();
      return { index: int(r.index, 0, MAX_ROWS - 1), hidden: r.hidden, attrs: attrs(r.attrs) };
    }),
    columns:
      o.columns === null
        ? null
        : list(o.columns, MAX_COLS).map((item) => {
            const c = obj(item);
            const min = int(c.min, 0, MAX_COLS - 1);
            const width = c.width;
            if (width !== null && !(typeof width === "number" && Number.isFinite(width) && width >= 0 && width <= 255)) fail();
            if (typeof c.hidden !== "boolean") fail();
            return { min, max: int(c.max, min, MAX_COLS - 1), width: width as number | null, hidden: c.hidden, other: attrs(c.other) };
          }),
  };
}
