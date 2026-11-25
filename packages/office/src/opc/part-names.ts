/**
 * OPC part names: always absolute (`/word/document.xml`), forward slashes,
 * no empty, `.` or `..` segments, compared without regard to ASCII case and
 * to how unreserved characters are percent-escaped.
 */

import { isOfficeError } from "../errors.js";
import { encodeUtf8 } from "./bytes.js";
import { assertSafeEntryName } from "./entry-names.js";
import { fault } from "./errors.js";

export const PACKAGE_ROOT = "/";
export const CONTENT_TYPES_PART = "/[Content_Types].xml";
export const PACKAGE_RELS_PART = "/_rels/.rels";

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** Decodes percent escapes of unreserved characters and upper-cases the rest. */
function canonicalEscapes(segment: string): string {
  if (!segment.includes("%")) return segment;
  return segment.replace(/%([0-9a-fA-F]{2})/g, (_whole, hex: string) => {
    const char = String.fromCharCode(parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * Appends the segments of `path` to `base`. A relationship target may walk
 * with `.` and `..`; a part name may not contain either.
 */
function joinSegments(base: readonly string[], path: string, allowDotSegments: boolean): string {
  if (path.includes("\\") || path.includes("\0")) {
    throw fault("invalid_part_name", "part name contains a forbidden character");
  }
  const out = [...base];
  for (const segment of path.split("/")) {
    if (segment === "") {
      // The caller already consumed a leading slash, so this is `a//b` or a trailing slash.
      throw fault("invalid_part_name", "part name contains an empty segment");
    }
    if (segment !== "." && segment !== "..") {
      out.push(segment);
    } else if (!allowDotSegments) {
      throw fault("invalid_part_name", "part name contains a dot segment");
    } else if (segment === "..") {
      if (out.length === 0) {
        throw fault("invalid_part_name", "relationship target points outside the package");
      }
      out.pop();
    }
  }
  if (out.length === 0) {
    throw fault("invalid_part_name", "part name is empty");
  }
  return `/${out.join("/")}`;
}

/**
 * Returns the canonical form of a part name. Accepts a ZIP entry name
 * (`word/document.xml`) or a part name (`/word/document.xml`) and refuses a
 * backslash and any empty, `.` or `..` segment.
 */
export function normalizePartName(name: string): string {
  if (typeof name !== "string") {
    throw fault("invalid_part_name", "part name is not a string");
  }
  const path = name.startsWith("/") ? name.slice(1) : name;
  if (path === "") {
    throw fault("invalid_part_name", "part name is empty");
  }
  return joinSegments([], path, false);
}

/** Longest entry name a ZIP header can record, in UTF-8 bytes. */
const MAX_ENTRY_NAME_BYTES = 0xffff;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Refuses a new part name whose ZIP entry the reader would reject, so a
 * package that saves always opens again: a drive prefix, a control character,
 * text that has no UTF-8 form, or a name too long for a ZIP header.
 */
export function assertStorablePartName(partName: string): void {
  const entryName = normalizePartName(partName).slice(1);
  try {
    assertSafeEntryName(entryName);
  } catch (error) {
    if (isOfficeError(error, "corrupt_package")) {
      throw fault("invalid_part_name", "part name cannot be stored as a ZIP entry", undefined, error);
    }
    throw error;
  }
  if (UNPAIRED_SURROGATE.test(entryName)) {
    throw fault("invalid_part_name", "part name is not valid Unicode text");
  }
  if (encodeUtf8(entryName).length > MAX_ENTRY_NAME_BYTES) {
    throw fault("invalid_part_name", "part name is too long for a ZIP entry");
  }
}

/** A name with unreserved characters unescaped and the remaining escapes upper-cased; casing is kept. */
function canonicalSpelling(name: string): string {
  return name.split("/").map(canonicalEscapes).join("/");
}

/** Key under which two part names are the same part. */
export function partNameKey(name: string): string {
  return canonicalSpelling(normalizePartName(name)).replace(/[A-Z]/g, (char) => char.toLowerCase());
}

export function partNamesEqual(a: string, b: string): boolean {
  return partNameKey(a) === partNameKey(b);
}

/** The ZIP entry name that stores a part. */
export function partNameToEntryName(partName: string): string {
  return normalizePartName(partName).slice(1);
}

export function entryNameToPartName(entryName: string): string {
  return normalizePartName(entryName);
}

/** Lower-cased extension without the dot, or an empty string. */
export function partExtension(partName: string): string {
  const base = partName.slice(partName.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot < 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/** Directory of a part, with leading and trailing slash (`/word/`). */
export function partDirectory(partName: string): string {
  const normalized = normalizePartName(partName);
  return normalized.slice(0, normalized.lastIndexOf("/") + 1);
}

/**
 * Name of the relationships part that belongs to `source`. The package itself
 * (`/`) owns `/_rels/.rels`; `/word/document.xml` owns
 * `/word/_rels/document.xml.rels`.
 */
export function relationshipsPartNameFor(source: string): string {
  if (source === PACKAGE_ROOT) return PACKAGE_RELS_PART;
  const normalized = normalizePartName(source);
  const slash = normalized.lastIndexOf("/");
  return `${normalized.slice(0, slash)}/_rels/${normalized.slice(slash + 1)}.rels`;
}

/**
 * True for `/_rels/.rels` and every `…/_rels/*.rels` part, however the name
 * spells its unreserved characters (`%5Frels` is `_rels`).
 */
export function isRelationshipsPartName(partName: string): boolean {
  return /(^|\/)_rels\/[^/]*\.rels$/i.test(canonicalSpelling(partName));
}

/**
 * The part (or `/` for the package) whose relationships `relsPartName` holds,
 * or `null` when the name is not a relationships part. Unreserved characters
 * of the result are unescaped, like the name `relationshipsPartNameFor` takes.
 */
export function relationshipsSourceOf(relsPartName: string): string | null {
  const normalized = canonicalSpelling(normalizePartName(relsPartName));
  const match = /^(.*\/)_rels\/([^/]*)\.rels$/i.exec(normalized);
  if (!match) return null;
  const [, directory, base] = match as unknown as [string, string, string];
  if (base === "") return directory === "/" ? PACKAGE_ROOT : null;
  return `${directory}${base}`;
}

/**
 * Resolves an internal relationship target against the part that owns the
 * relationship. Query and fragment are dropped. `source` is a part name or `/`
 * for package relationships.
 */
export function resolveRelationshipTarget(source: string, target: string): string {
  let path = target;
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (path === "") {
    throw fault("invalid_part_name", "relationship target is empty");
  }
  if (path.startsWith("/")) return joinSegments([], path.slice(1), true);
  const base = source === PACKAGE_ROOT ? [] : normalizePartName(source).slice(1).split("/").slice(0, -1);
  return joinSegments(base, path, true);
}

/**
 * Writes `targetPart` as a reference relative to `source`, the form document
 * producers use for relationship targets (`media/image1.png`, `../customXml/item1.xml`).
 */
export function relativeTargetFor(source: string, targetPart: string): string {
  const target = normalizePartName(targetPart).slice(1).split("/");
  if (source === PACKAGE_ROOT) return target.join("/");
  const base = normalizePartName(source).slice(1).split("/").slice(0, -1);
  let shared = 0;
  while (shared < base.length && shared < target.length - 1 && base[shared] === target[shared]) shared++;
  const up = base.length - shared;
  return [...Array<string>(up).fill(".."), ...target.slice(shared)].join("/");
}
