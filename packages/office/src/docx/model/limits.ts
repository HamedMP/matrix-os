/**
 * Bounds on the size of one open document.
 *
 * The ZIP limits bound the bytes a file inflates to; these bound what the
 * bytes turn into. A few kilobytes of deflated XML can describe a table of
 * a million rows, and every row costs a tree node, a block record and a
 * paragraph scan. The defaults fit the largest document a 10 MiB file
 * reasonably holds (about 1,500 pages) and keep the memory of the worst
 * file inside them to a few hundred megabytes.
 *
 * The limits hold for the life of the handle: an edit that would take the
 * document past one fails with `limit_exceeded` and is rolled back.
 */

import type { ZipLimits } from "../../api/opc.js";
import type { XmlDocument, XmlNode } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";

export interface DocxLimits {
  /** XML nodes of all the parts the model parses, together. Default 500,000. */
  maxNodes: number;
  /** Characters of XML of all the parts the model parses, together. Default 32 Mi. */
  maxXmlChars: number;
  /** Paragraphs, tables and section breaks of all stories, cell content included. Default 50,000. */
  maxBlocks: number;
  /** Table rows of all stories. Default 20,000. */
  maxTableRows: number;
  /** Table cells of all stories. Default 50,000. */
  maxTableCells: number;
}

/** What `openDocx` takes: the ZIP limits and the document limits in one object; each key is optional. */
export type DocxOpenLimits = Partial<ZipLimits> & Partial<DocxLimits>;

export const DEFAULT_DOCX_LIMITS: Readonly<DocxLimits> = Object.freeze({
  maxNodes: 500_000,
  maxXmlChars: 32 * 1024 * 1024,
  maxBlocks: 50_000,
  maxTableRows: 20_000,
  maxTableCells: 50_000,
});

const DOCX_KEYS = Object.keys(DEFAULT_DOCX_LIMITS) as ReadonlyArray<keyof DocxLimits>;
const ZIP_KEYS: ReadonlyArray<keyof ZipLimits> = ["maxEntries", "maxEntryBytes", "maxTotalBytes"];

/** The document limits of a caller's object, defaults filled in. Throws `invalid_argument` for a value that is not a positive integer or infinity. */
export function resolveDocxLimits(input?: Partial<DocxLimits>): DocxLimits {
  const resolved: DocxLimits = { ...DEFAULT_DOCX_LIMITS };
  if (input === undefined || input === null) return resolved;
  for (const key of DOCX_KEYS) {
    const value: unknown = input[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !(value === Number.POSITIVE_INFINITY || (Number.isInteger(value) && value >= 1))) {
      throw new OfficeError("invalid_argument", `${key} must be a positive integer`);
    }
    resolved[key] = value;
  }
  return resolved;
}

/** The ZIP limits a caller gave, or undefined when there are none. */
export function zipLimitsOf(input?: DocxOpenLimits): Partial<ZipLimits> | undefined {
  if (input === undefined || input === null) return undefined;
  const limits: Partial<ZipLimits> = {};
  for (const key of ZIP_KEYS) if (input[key] !== undefined) limits[key] = input[key];
  return limits;
}

const WHAT: Readonly<Record<keyof DocxLimits, string>> = {
  maxNodes: "XML nodes",
  maxXmlChars: "characters of XML",
  maxBlocks: "paragraphs and tables",
  maxTableRows: "table rows",
  maxTableCells: "table cells",
};

/** The `limit_exceeded` error of a document limit. */
export function documentTooLarge(limit: keyof DocxLimits, max: number): OfficeError {
  return new OfficeError("limit_exceeded", `the document has more ${WHAT[limit]} than the limit of ${max}`, {
    details: { limit, max },
  });
}

/** The nodes of a parsed part, counted the way the parser counts them: every node but the document itself. */
export function countNodes(doc: XmlDocument): number {
  let count = 0;
  const stack: XmlNode[] = [...doc.children];
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode;
    count += 1;
    if (node.kind !== "element") continue;
    const children = node.children;
    for (let index = 0; index < children.length; index++) stack.push(children[index] as XmlNode);
  }
  return count;
}
