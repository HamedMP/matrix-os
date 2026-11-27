/**
 * Strict validation of a parsed agent answer against the envelope format of
 * `../api/agent.ts`.
 *
 * Every value is checked, unknown properties and unknown `op` values are
 * rejected, and the envelope that comes out is rebuilt from the checked
 * values only: nothing of the parsed object is passed on as it came.
 */

import type {
  AgentCellInput,
  AgentDocxEdit,
  AgentEditEnvelope,
  AgentEditKind,
  AgentParseError,
  AgentParseErrorCode,
  AgentSheetEdit,
} from "../api/agent.js";
import { MAX_EDITS, MAX_RANGE_CELLS, MAX_STRING_LENGTH } from "./limits.js";

/** Raised inside this file for the first bad value and turned into a result by {@link checkEnvelope}. */
class ShapeProblem {
  constructor(
    readonly code: AgentParseErrorCode,
    readonly path: string | null,
    readonly message: string,
  ) {}
}

type Fields = Record<string, unknown>;

function bad(path: string | null, message: string): never {
  throw new ShapeProblem("invalid_shape", path, message);
}

function tooLarge(path: string | null, message: string): never {
  throw new ShapeProblem("too_large", path, message);
}

function isPlainObject(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(fields: Fields, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : undefined;
}

function at(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** Rejects every property that is not in `allowed`. */
function onlyKeys(fields: Fields, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(fields)) {
    if (allowed.includes(key)) continue;
    // The name is the agent's own text: it is named only when it is short and plain.
    const where = /^[A-Za-z0-9_]{1,40}$/.test(key) ? at(path, key) : path === "" ? null : path;
    bad(where, `unknown property${where === null ? "" : ` ${where}`}`);
  }
}

/** C0 controls other than tab, line feed and carriage return, and DEL. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f) return true;
  }
  return false;
}

interface StringRule {
  /** Reject the empty string. */
  nonEmpty?: boolean;
  /** Allow control characters (cell values keep what they hold). */
  controls?: boolean;
}

function string(fields: Fields, key: string, path: string, rule: StringRule = {}): string {
  const value = own(fields, key);
  const where = at(path, key);
  if (typeof value !== "string") bad(where, `${where} must be a string`);
  if (value.length > MAX_STRING_LENGTH) tooLarge(where, `${where} is longer than ${MAX_STRING_LENGTH} characters`);
  if (rule.nonEmpty === true && value.length === 0) bad(where, `${where} must not be empty`);
  if (rule.controls !== true && hasControlCharacter(value)) bad(where, `${where} holds a control character`);
  return value;
}

function optionalString(fields: Fields, key: string, path: string, rule: StringRule = {}): string | undefined {
  return own(fields, key) === undefined ? undefined : string(fields, key, path, rule);
}

function optionalInteger(fields: Fields, key: string, path: string, min: number, max: number): number | undefined {
  const value = own(fields, key);
  if (value === undefined) return undefined;
  const where = at(path, key);
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    bad(where, `${where} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

const BLOCK_ID_LENGTH = 200;

function blockId(fields: Fields, path: string): string {
  const value = string(fields, "blockId", path, { nonEmpty: true });
  const where = at(path, "blockId");
  if (value.length > BLOCK_ID_LENGTH || /\s/.test(value)) bad(where, `${where} is not a block id`);
  return value;
}

function docxEdit(value: unknown, path: string): AgentDocxEdit {
  if (!isPlainObject(value)) bad(path, `${path} must be an object`);
  const op = own(value, "op");
  switch (op) {
    case "replaceText": {
      onlyKeys(value, ["op", "blockId", "find", "replace", "occurrence"], path);
      const edit: AgentDocxEdit = {
        op,
        blockId: blockId(value, path),
        find: string(value, "find", path, { nonEmpty: true }),
        replace: string(value, "replace", path),
      };
      const occurrence = optionalInteger(value, "occurrence", path, 1, MAX_STRING_LENGTH);
      if (occurrence !== undefined) edit.occurrence = occurrence;
      return edit;
    }
    case "insertParagraph": {
      onlyKeys(value, ["op", "blockId", "position", "text", "headingLevel"], path);
      const edit: AgentDocxEdit = { op, blockId: blockId(value, path), text: string(value, "text", path) };
      const position = own(value, "position");
      if (position !== undefined) {
        if (position !== "after" && position !== "before") bad(at(path, "position"), `${at(path, "position")} must be "after" or "before"`);
        edit.position = position;
      }
      const headingLevel = optionalInteger(value, "headingLevel", path, 1, 9);
      if (headingLevel !== undefined) edit.headingLevel = headingLevel;
      return edit;
    }
    case "deleteParagraph":
      onlyKeys(value, ["op", "blockId", "startsWith"], path);
      return { op, blockId: blockId(value, path), startsWith: string(value, "startsWith", path) };
    case "comment": {
      onlyKeys(value, ["op", "blockId", "find", "occurrence", "text"], path);
      const edit: AgentDocxEdit = {
        op,
        blockId: blockId(value, path),
        find: string(value, "find", path),
        text: string(value, "text", path, { nonEmpty: true }),
      };
      const occurrence = optionalInteger(value, "occurrence", path, 1, MAX_STRING_LENGTH);
      if (occurrence !== undefined) edit.occurrence = occurrence;
      return edit;
    }
    default:
      return bad(at(path, "op"), `${at(path, "op")} is not a document edit operation`);
  }
}

const A1_CELL = /^\$?[A-Za-z]{1,3}\$?[1-9][0-9]{0,6}$/;
const A1_COLUMNS = /^\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}$/;
const A1_ROWS = /^\$?[1-9][0-9]{0,6}:\$?[1-9][0-9]{0,6}$/;

function cellAddress(fields: Fields, key: string, path: string): string {
  const value = string(fields, key, path, { nonEmpty: true }).trim();
  if (!A1_CELL.test(value)) bad(at(path, key), `${at(path, key)} must be a cell address such as B7`);
  return value;
}

function rangeAddress(fields: Fields, key: string, path: string): string {
  const value = string(fields, key, path, { nonEmpty: true }).trim();
  const corners = value.split(":");
  const cells = corners.length <= 2 && corners.every((corner) => A1_CELL.test(corner));
  if (!cells && !A1_COLUMNS.test(value) && !A1_ROWS.test(value)) {
    bad(at(path, key), `${at(path, key)} must be a range such as A2:C9`);
  }
  return value;
}

function cellInput(value: unknown, path: string): AgentCellInput {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) bad(path, `${path} must be a finite number`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) tooLarge(path, `${path} is longer than ${MAX_STRING_LENGTH} characters`);
    return value;
  }
  return bad(path, `${path} must be a string, a number, true, false or null`);
}

function sheetName(fields: Fields, path: string): string {
  return string(fields, "sheet", path, { nonEmpty: true });
}

function rangeValues(value: unknown, path: string): AgentCellInput[][] {
  if (!Array.isArray(value) || value.length === 0) bad(path, `${path} must be a non-empty array of rows`);
  if (value.length > MAX_RANGE_CELLS) tooLarge(path, `${path} holds more than ${MAX_RANGE_CELLS} cells`);
  const rows: AgentCellInput[][] = [];
  let cells = 0;
  for (let r = 0; r < value.length; r++) {
    const row: unknown = value[r];
    const rowPath = `${path}[${r}]`;
    if (!Array.isArray(row)) bad(rowPath, `${rowPath} must be an array of cell values`);
    cells += row.length;
    if (cells > MAX_RANGE_CELLS) tooLarge(path, `${path} holds more than ${MAX_RANGE_CELLS} cells`);
    const checked: AgentCellInput[] = [];
    for (let c = 0; c < row.length; c++) checked.push(cellInput(row[c], `${rowPath}[${c}]`));
    rows.push(checked);
  }
  if (cells === 0) bad(path, `${path} must hold at least one cell`);
  return rows;
}

function sheetEdit(value: unknown, path: string): AgentSheetEdit {
  if (!isPlainObject(value)) bad(path, `${path} must be an object`);
  const op = own(value, "op");
  switch (op) {
    case "setCell": {
      onlyKeys(value, ["op", "sheet", "cell", "value", "expect"], path);
      if (own(value, "value") === undefined) bad(at(path, "value"), `${at(path, "value")} is missing`);
      const edit: AgentSheetEdit = {
        op,
        sheet: sheetName(value, path),
        cell: cellAddress(value, "cell", path),
        value: cellInput(own(value, "value"), at(path, "value")),
      };
      const expect = optionalString(value, "expect", path, { controls: true });
      if (expect !== undefined) edit.expect = expect;
      return edit;
    }
    case "setRange":
      onlyKeys(value, ["op", "sheet", "start", "values"], path);
      return {
        op,
        sheet: sheetName(value, path),
        start: cellAddress(value, "start", path),
        values: rangeValues(own(value, "values"), at(path, "values")),
      };
    case "clearRange":
      onlyKeys(value, ["op", "sheet", "range"], path);
      return { op, sheet: sheetName(value, path), range: rangeAddress(value, "range", path) };
    default:
      return bad(at(path, "op"), `${at(path, "op")} is not a sheet edit operation`);
  }
}

function envelope(value: unknown, expectedKind: AgentEditKind | undefined): AgentEditEnvelope {
  if (!isPlainObject(value)) bad(null, "the answer must be a JSON object");
  const kind = own(value, "kind");
  if (kind !== "docx" && kind !== "sheet") bad("kind", 'kind must be "docx" or "sheet"');
  if (expectedKind !== undefined && kind !== expectedKind) {
    throw new ShapeProblem("wrong_kind", "kind", `expected edits of kind "${expectedKind}"`);
  }
  onlyKeys(value, ["kind", "edits", "summary"], "");
  const edits = own(value, "edits");
  if (!Array.isArray(edits)) bad("edits", "edits must be an array");
  if (edits.length > MAX_EDITS) tooLarge("edits", `more than ${MAX_EDITS} edits`);
  const summary = optionalString(value, "summary", "");
  const result: AgentEditEnvelope =
    kind === "docx"
      ? { kind, edits: edits.map((edit, index) => docxEdit(edit, `edits[${index}]`)) }
      : { kind, edits: edits.map((edit, index) => sheetEdit(edit, `edits[${index}]`)) };
  if (summary !== undefined) result.summary = summary;
  return result;
}

export type EnvelopeCheck = { ok: true; envelope: AgentEditEnvelope } | { ok: false; error: AgentParseError };

/** Checks a parsed JSON value. Never throws for a bad value. */
export function checkEnvelope(value: unknown, expectedKind?: AgentEditKind): EnvelopeCheck {
  try {
    return { ok: true, envelope: envelope(value, expectedKind) };
  } catch (problem) {
    if (problem instanceof ShapeProblem) {
      return { ok: false, error: { code: problem.code, message: problem.message, path: problem.path } };
    }
    throw problem;
  }
}
