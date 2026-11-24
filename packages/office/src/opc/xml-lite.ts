/**
 * The small XML subset needed for `[Content_Types].xml` and relationship parts:
 * element start tags and their attributes. Text, comments and processing
 * instructions are skipped. A document type declaration is refused and only the
 * five predefined entities and numeric character references are decoded, so
 * nothing in a part can expand.
 */

import { fault } from "./errors.js";

export interface XmlStartTag {
  /** Name without its namespace prefix. */
  readonly localName: string;
  /** Zero for the document element. */
  readonly depth: number;
  /** Attributes by qualified name, already entity-decoded. */
  readonly attributes: ReadonlyMap<string, string>;
}

const PREDEFINED: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

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

function decodeEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&([^;&]*);?/g, (whole, body: string) => {
    if (!whole.endsWith(";")) {
      throw fault("invalid_xml", "unterminated entity reference");
    }
    const predefined = PREDEFINED[body];
    if (predefined !== undefined) return predefined;
    const numeric = /^#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}))$/.exec(body);
    if (numeric) {
      const code = numeric[1] !== undefined ? parseInt(numeric[1], 16) : parseInt(numeric[2] as string, 10);
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
    }
    throw fault("invalid_xml", "unsupported entity reference");
  });
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function parseAttributes(xml: string, from: number, to: number): Map<string, string> {
  // Bounded by the tag length, which is bounded by the part size limit.
  const attributes = new Map<string, string>();
  let at = from;
  while (at < to) {
    while (at < to && isSpace(xml.charCodeAt(at))) at++;
    if (at >= to) break;
    const nameStart = at;
    while (at < to && xml[at] !== "=" && !isSpace(xml.charCodeAt(at))) at++;
    const name = xml.slice(nameStart, at);
    while (at < to && isSpace(xml.charCodeAt(at))) at++;
    if (name === "" || xml[at] !== "=") {
      throw fault("invalid_xml", "malformed attribute");
    }
    at++;
    while (at < to && isSpace(xml.charCodeAt(at))) at++;
    const quote = xml[at];
    if (quote !== '"' && quote !== "'") {
      throw fault("invalid_xml", "attribute value is not quoted");
    }
    const close = xml.indexOf(quote, at + 1);
    if (close < 0 || close >= to) {
      throw fault("invalid_xml", "unterminated attribute value");
    }
    const raw = xml.slice(at + 1, close);
    if (raw.includes("<") || attributes.has(name)) {
      throw fault("invalid_xml", "malformed attribute");
    }
    attributes.set(name, decodeEntities(raw));
    at = close + 1;
  }
  return attributes;
}

/** Finds the `>` that closes a tag, ignoring any inside quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote = "";
  for (let at = from; at < xml.length; at++) {
    const char = xml[at] as string;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return at;
    }
  }
  return -1;
}

function skipPast(xml: string, from: number, terminator: string): number {
  const end = xml.indexOf(terminator, from);
  if (end < 0) throw fault("invalid_xml", "unterminated markup");
  return end + terminator.length;
}

/** Lists every element start tag in document order. */
export function scanStartTags(xml: string): XmlStartTag[] {
  const tags: XmlStartTag[] = [];
  const open: string[] = [];
  let sawRoot = false;
  let at = 0;
  while (at < xml.length) {
    const lt = xml.indexOf("<", at);
    if (lt < 0) break;
    if (xml.startsWith("<?", lt)) {
      at = skipPast(xml, lt, "?>");
    } else if (xml.startsWith("<!--", lt)) {
      at = skipPast(xml, lt, "-->");
    } else if (xml.startsWith("<![CDATA[", lt)) {
      at = skipPast(xml, lt, "]]>");
    } else if (xml.startsWith("<!", lt)) {
      throw fault("invalid_xml", "document type declarations are not allowed");
    } else if (xml.startsWith("</", lt)) {
      const gt = xml.indexOf(">", lt);
      if (gt < 0) throw fault("invalid_xml", "unterminated end tag");
      if (open.pop() !== xml.slice(lt + 2, gt).trim()) {
        throw fault("invalid_xml", "mismatched end tag");
      }
      at = gt + 1;
    } else {
      const gt = findTagEnd(xml, lt + 1);
      if (gt < 0) throw fault("invalid_xml", "unterminated start tag");
      const selfClosing = xml[gt - 1] === "/";
      const bodyEnd = selfClosing ? gt - 1 : gt;
      let nameEnd = lt + 1;
      while (nameEnd < bodyEnd && !isSpace(xml.charCodeAt(nameEnd))) nameEnd++;
      const name = xml.slice(lt + 1, nameEnd);
      if (name === "" || (open.length === 0 && sawRoot)) {
        throw fault("invalid_xml", "malformed element");
      }
      sawRoot = true;
      const colon = name.indexOf(":");
      tags.push({
        localName: colon < 0 ? name : name.slice(colon + 1),
        depth: open.length,
        attributes: parseAttributes(xml, nameEnd, bodyEnd),
      });
      if (!selfClosing) open.push(name);
      at = gt + 1;
    }
  }
  if (open.length > 0 || !sawRoot) {
    throw fault("invalid_xml", "document is not well formed");
  }
  return tags;
}
