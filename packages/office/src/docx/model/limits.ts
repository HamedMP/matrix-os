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
import type { XmlAttr, XmlDocument, XmlElement, XmlNode } from "../../api/xml.js";
import { OfficeError } from "../../errors.js";
import { escapeXmlAttr, escapeXmlText } from "../../xml/index.js";

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

function count(text: string, char: string): number {
  let found = 0;
  for (let at = text.indexOf(char); at !== -1; at = text.indexOf(char, at + 1)) found += 1;
  return found;
}

/** Length of an attribute value as the serialiser writes it. */
function attrValueLength(attr: XmlAttr): number {
  if (attr.raw != null) return attr.raw.length;
  const escaped = escapeXmlAttr(attr.value);
  // `escapeXmlAttr` escapes for double quotes; with single quotes `"` stays and `'` becomes `&apos;`.
  return attr.quote === '"' ? escaped.length : escaped.length - 5 * count(attr.value, '"') + 5 * count(attr.value, "'");
}

function startTagLength(element: XmlElement): number {
  let length = 1 + element.name.length + element.openTagTail.length;
  for (const attr of element.attrs) length += attr.lead.length + attr.name.length + attr.eq.length + 2 + attrValueLength(attr);
  return length;
}

/**
 * The nodes of a parsed part (as {@link countNodes} counts them) and the
 * characters it serialises to, without building the text: what `openDocx`
 * would count when it opens the saved part again.
 */
export function measureXml(doc: XmlDocument): { nodes: number; chars: number } {
  let nodes = 0;
  let chars = doc.bom ? 1 : 0;
  const stack: XmlNode[] = [...doc.children];
  while (stack.length > 0) {
    const node = stack.pop() as XmlNode;
    nodes += 1;
    switch (node.kind) {
      case "element": {
        const close = 3 + node.name.length + node.closeTagTail.length;
        const children = node.children;
        if (children.length === 0) chars += startTagLength(node) + (node.selfClosing ? 2 : 1 + close);
        else chars += startTagLength(node) + 1 + close;
        for (let index = 0; index < children.length; index++) stack.push(children[index] as XmlNode);
        break;
      }
      case "text":
        chars += node.raw != null ? node.raw.length : escapeXmlText(node.value).length;
        break;
      case "cdata":
        // `]]>` inside the value is written as `]]]]><![CDATA[>`.
        chars += 12 + node.value.length + 12 * (node.value.split("]]>").length - 1);
        break;
      case "comment":
        chars += 7 + node.value.length;
        break;
      case "pi":
        chars += 4 + node.target.length + node.data.length;
        break;
      case "declaration":
        chars += node.raw.length;
        break;
      default:
        break;
    }
  }
  return { nodes, chars };
}
