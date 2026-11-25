/**
 * What `[Content_Types].xml` and relationship parts need from XML: element
 * start tags and their attributes, read through the strict parser of `../xml`.
 * That parser refuses a document type declaration and every entity other than
 * the five predefined ones and numeric character references, so nothing in a
 * part can expand.
 */

import type { XmlChildNode, XmlDocument, XmlElement } from "../api/xml.js";
import { isOfficeError } from "../errors.js";
import { localName } from "../xml/names.js";
import { parseXml } from "../xml/parser.js";
import { fault } from "./errors.js";

export interface XmlStartTag {
  /** Name without its namespace prefix. */
  readonly localName: string;
  /** Zero for the document element. */
  readonly depth: number;
  /** Attributes by qualified name, already entity-decoded. */
  readonly attributes: ReadonlyMap<string, string>;
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "\t": "&#9;",
  "\n": "&#10;",
  "\r": "&#13;",
};

/** Decodes a part to text, honouring a UTF-8 or UTF-16 byte order mark. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  let encoding = "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw fault("invalid_text", "part is not valid UTF-8 or UTF-16 text", undefined, error);
    }
    throw error;
  }
}

export function escapeXmlAttribute(value: string): string {
  return value.replace(/[&<>"\t\n\r]/g, (char) => ESCAPES[char] as string);
}

/**
 * Lists every element start tag in document order. The part is parsed by the
 * strict XML parser, so anything that is not well-formed XML is refused: text
 * outside the document element, an undefined entity, a forbidden character, a
 * document type declaration. The caller keeps the original bytes; nothing here
 * is written back.
 */
export function scanStartTags(xml: string): XmlStartTag[] {
  let doc: XmlDocument;
  try {
    doc = parseXml(xml);
  } catch (error) {
    if (isOfficeError(error, "malformed_xml", "limit_exceeded")) {
      throw fault("invalid_xml", "part is not well-formed XML", undefined, error);
    }
    throw error;
  }
  const tags: XmlStartTag[] = [];
  // Depth-first, children in order. Bounded by the parser's depth and node limits.
  const pending: { element: XmlElement; depth: number }[] = [{ element: doc.root, depth: 0 }];
  while (pending.length > 0) {
    const { element, depth } = pending.pop() as { element: XmlElement; depth: number };
    const attributes = new Map<string, string>();
    for (const attr of element.attrs) attributes.set(attr.name, attr.value);
    tags.push({ localName: localName(element.name), depth, attributes });
    for (let index = element.children.length - 1; index >= 0; index--) {
      const child = element.children[index] as XmlChildNode;
      if (child.kind === "element") pending.push({ element: child, depth: depth + 1 });
    }
  }
  return tags;
}
