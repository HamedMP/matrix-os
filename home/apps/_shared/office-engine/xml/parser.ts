/**
 * The tokenizer and tree builder: one forward pass over the text, no
 * recursion, no regular expressions on the hot path.
 *
 * Everything an XML processor normally discards is stored on the nodes
 * (quote style, entity spelling, whitespace inside tags), which is what lets
 * the serialiser reproduce the source exactly. Element nesting is tracked
 * through the `parent` links, so depth is limited only by `maxDepth`.
 */

import type { ParseXml, XmlAttr, XmlChildNode, XmlNode, XmlParseLimits } from "../api/xml.js";
import { ASCII_CLASS, FORBIDDEN_CHARS, NAME_CHAR, NAME_START, firstNonSpace, isHighNameChar, isHighNameStart } from "./chars.js";
import { parseDeclaration, startsDeclaration } from "./declaration.js";
import { invalidArgument, limitExceeded, malformed, quoteName } from "./errors.js";
import type { WritableDocument, WritableElement } from "./nodes.js";
import { decodeReferences } from "./references.js";

/**
 * A node of the tree costs about 200 bytes of heap, so the default node
 * count keeps one parsed document under half a gigabyte. A reader that knows
 * its documents are smaller should pass a smaller budget.
 */
export const DEFAULT_XML_LIMITS: Readonly<XmlParseLimits> = Object.freeze({ maxDepth: 512, maxNodes: 2_000_000 });

/** Attribute count from which duplicate detection switches from a scan to a set. */
const DUPLICATE_SCAN_LIMIT = 8;
/** Slots of the name cache; a power of two. */
const NAME_CACHE_SIZE = 1024;

function resolveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && (value === Number.POSITIVE_INFINITY || (Number.isInteger(value) && value >= 1))) {
    return value;
  }
  throw invalidArgument(`${name} must be a positive integer`);
}

export const parseXml: ParseXml = (text, limits) => {
  if (typeof text !== "string") throw invalidArgument("parseXml expects the document as a string");
  const maxDepth = resolveLimit(limits?.maxDepth, DEFAULT_XML_LIMITS.maxDepth, "maxDepth");
  const maxNodes = resolveLimit(limits?.maxNodes, DEFAULT_XML_LIMITS.maxNodes, "maxNodes");
  const length = text.length;

  const forbidden = text.search(FORBIDDEN_CHARS);
  if (forbidden !== -1) {
    throw malformed(text, forbidden, "character that XML does not allow", "forbidden_character");
  }

  const doc: WritableDocument = { kind: "document", children: [], root: null as never, bom: false };

  // Children are collected in one scratch buffer per nesting level and copied
  // into an array of the exact size when their element closes. Appending to
  // each element's own array instead would leave every array with spare
  // capacity, which more than doubles the memory of a large tree.
  const levels: XmlNode[][] = [[]];
  const savedCounts: number[] = [];
  let buffer = levels[0] as XmlNode[];
  let count = 0;
  const attrBuffer: XmlAttr[] = [];

  let pos = 0;
  if (text.charCodeAt(0) === 0xfeff) {
    doc.bom = true;
    pos = 1;
  }

  let nodes = 0;
  if (startsDeclaration(text, pos)) {
    const declaration = parseDeclaration(text, pos, doc);
    if (++nodes > maxNodes) throw limitExceeded("maxNodes", maxNodes, pos);
    buffer[count++] = declaration.node;
    pos = declaration.end;
  }

  // Names repeat constantly in office documents. A small direct-mapped cache
  // returns the string already made for a name, so equal names share memory.
  const nameCache: (string | undefined)[] = new Array<string | undefined>(NAME_CACHE_SIZE).fill(undefined);
  const internName = (start: number, end: number): string => {
    const size = end - start;
    const slot =
      (size * 31 + text.charCodeAt(start) * 7 + text.charCodeAt(end - 1) * 13 + text.charCodeAt(start + (size >> 1))) &
      (NAME_CACHE_SIZE - 1);
    const cached = nameCache[slot];
    if (cached !== undefined && cached.length === size && text.startsWith(cached, start)) return cached;
    const name = text.slice(start, end);
    nameCache[slot] = name;
    return name;
  };

  /** The open element, or null at the top level of the document. */
  let open: WritableElement | null = null;
  let depth = 0;
  let root: WritableElement | null = null;

  while (pos < length) {
    const lt = text.indexOf("<", pos);
    if (lt !== pos) {
      const end = lt === -1 ? length : lt;
      if (open === null) {
        const stray = firstNonSpace(text, pos, end);
        if (stray !== -1) throw malformed(text, stray, "text outside the document element");
      }
      // A literal `]]>` in text is tolerated: it is kept as written, and text
      // written by a helper escapes `>` so it can never be produced here.
      const raw = text.slice(pos, end);
      const value = raw.indexOf("&") === -1 ? raw : decodeReferences(raw, text, pos);
      if (++nodes > maxNodes) throw limitExceeded("maxNodes", maxNodes, pos);
      buffer[count++] = { kind: "text", value, raw, parent: open ?? doc };
      if (lt === -1) break;
    }

    let code = text.charCodeAt(lt + 1);

    if (code === 0x2f /* / */) {
      // End tag.
      if (open === null) throw malformed(text, lt, "end tag without a start tag", "mismatched_tag");
      const name = open.name;
      let at = lt + 2;
      if (!text.startsWith(name, at)) {
        throw malformed(text, lt, `end tag does not match <${quoteName(name)}>`, "mismatched_tag");
      }
      at += name.length;
      code = text.charCodeAt(at);
      if (code !== 0x3e /* > */) {
        const tailStart = at;
        while (code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d) code = text.charCodeAt(++at);
        if (code !== 0x3e) {
          throw at === tailStart && code === code
            ? malformed(text, lt, `end tag does not match <${quoteName(name)}>`, "mismatched_tag")
            : malformed(text, lt, "end tag is not terminated");
        }
        open.closeTagTail = text.slice(tailStart, at);
      }
      pos = at + 1;
      if (count > 0) open.children = buffer.slice(0, count) as XmlChildNode[];
      depth--;
      buffer = levels[depth] as XmlNode[];
      count = savedCounts[depth] as number;
      open = depth === 0 ? null : (open.parent as WritableElement);
      continue;
    }

    if (code === 0x21 /* ! */) {
      if (text.startsWith("--", lt + 2)) {
        const end = text.indexOf("--", lt + 4);
        if (end === -1) throw malformed(text, lt, "comment is not terminated");
        if (text.charCodeAt(end + 2) !== 0x3e) throw malformed(text, end, "'--' is not allowed inside a comment");
        if (++nodes > maxNodes) throw limitExceeded("maxNodes", maxNodes, lt);
        buffer[count++] = { kind: "comment", value: text.slice(lt + 4, end), parent: open ?? doc };
        pos = end + 3;
      } else if (text.startsWith("[CDATA[", lt + 2)) {
        if (open === null) throw malformed(text, lt, "CDATA section outside the document element");
        const end = text.indexOf("]]>", lt + 9);
        if (end === -1) throw malformed(text, lt, "CDATA section is not terminated");
        if (++nodes > maxNodes) throw limitExceeded("maxNodes", maxNodes, lt);
        buffer[count++] = { kind: "cdata", value: text.slice(lt + 9, end), parent: open };
        pos = end + 3;
      } else if (text.startsWith("DOCTYPE", lt + 2)) {
        throw malformed(text, lt, "document type declarations are not supported", "doctype");
      } else {
        throw malformed(text, lt, "unsupported markup declaration");
      }
      continue;
    }

    if (code === 0x3f /* ? */) {
      let at = lt + 2;
      code = text.charCodeAt(at);
      if (!(code < 128 ? (ASCII_CLASS[code] as number) & NAME_START : isHighNameStart(code))) {
        throw malformed(text, lt, "processing instruction without a target");
      }
      code = text.charCodeAt(++at);
      while (code < 128 ? (ASCII_CLASS[code] as number) & NAME_CHAR : isHighNameChar(code)) code = text.charCodeAt(++at);
      const target = text.slice(lt + 2, at);
      if (target.length === 3 && target.toLowerCase() === "xml") {
        throw malformed(text, lt, "an XML declaration is only allowed at the very start of the document", "declaration");
      }
      const end = text.indexOf("?>", at);
      if (end === -1) throw malformed(text, lt, "processing instruction is not terminated");
      if (end !== at && code !== 0x20 && code !== 0x0a && code !== 0x09 && code !== 0x0d) {
        throw malformed(text, at, "expected whitespace after the processing instruction target");
      }
      if (++nodes > maxNodes) throw limitExceeded("maxNodes", maxNodes, lt);
      buffer[count++] = { kind: "pi", target, data: text.slice(at, end), parent: open ?? doc };
      pos = end + 2;
      continue;
    }

    // Start tag.
    if (!(code < 128 ? (ASCII_CLASS[code] as number) & NAME_START : isHighNameStart(code))) {
      throw code === code
        ? malformed(text, lt, "'<' must start a tag; write &lt; for a literal less-than sign")
        : malformed(text, length, "unexpected end of input after '<'", "unclosed");
    }
    if (open === null && root !== null) throw malformed(text, lt, "more than one document element");
    if (depth >= maxDepth) throw limitExceeded("maxDepth", maxDepth, lt);
    if (++nodes > maxNodes) throw limitExceeded("maxNodes", maxNodes, lt);

    let at = lt + 2;
    code = text.charCodeAt(at);
    while (code < 128 ? (ASCII_CLASS[code] as number) & NAME_CHAR : isHighNameChar(code)) code = text.charCodeAt(++at);
    const name = internName(lt + 1, at);

    let attrCount = 0;
    let seen: Set<string> | null = null;
    let openTagTail = "";
    let selfClosing = false;
    for (;;) {
      const spaceStart = at;
      while (code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d) code = text.charCodeAt(++at);
      if (code === 0x3e /* > */) {
        if (at !== spaceStart) openTagTail = text.slice(spaceStart, at);
        at++;
        break;
      }
      if (code === 0x2f /* / */) {
        if (text.charCodeAt(at + 1) !== 0x3e) throw malformed(text, at, "expected '>' after '/' in a tag");
        if (at !== spaceStart) openTagTail = text.slice(spaceStart, at);
        selfClosing = true;
        at += 2;
        break;
      }
      if (code !== code) throw malformed(text, length, "unexpected end of input inside a tag", "unclosed");
      if (at === spaceStart) throw malformed(text, at, "expected whitespace, '>' or '/>' in a tag");
      if (!(code < 128 ? (ASCII_CLASS[code] as number) & NAME_START : isHighNameStart(code))) {
        throw malformed(text, at, "invalid attribute name");
      }

      const nameStart = at;
      code = text.charCodeAt(++at);
      while (code < 128 ? (ASCII_CLASS[code] as number) & NAME_CHAR : isHighNameChar(code)) code = text.charCodeAt(++at);
      const attrName = internName(nameStart, at);

      // `name="` is by far the usual form; anything else keeps its spacing.
      let eq = "=";
      const nameEnd = at;
      if (code === 0x3d && ((code = text.charCodeAt(at + 1)) === 0x22 || code === 0x27)) {
        at++;
      } else {
        code = text.charCodeAt(at);
        while (code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d) code = text.charCodeAt(++at);
        if (code !== 0x3d) {
          throw code === code
            ? malformed(text, at, "expected '=' after the attribute name")
            : malformed(text, length, "unexpected end of input inside a tag", "unclosed");
        }
        code = text.charCodeAt(++at);
        while (code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d) code = text.charCodeAt(++at);
        if (code !== 0x22 && code !== 0x27) {
          throw code === code
            ? malformed(text, at, "attribute value must be quoted")
            : malformed(text, length, "unexpected end of input inside a tag", "unclosed");
        }
        eq = text.slice(nameEnd, at);
      }

      const quoteCode = code;
      const valueStart = at + 1;
      let valueEnd = valueStart;
      let hasReference = false;
      for (;;) {
        code = text.charCodeAt(valueEnd);
        if (code === quoteCode) break;
        if (code === 0x26 /* & */) hasReference = true;
        else if (code === 0x3c /* < */) throw malformed(text, valueEnd, "'<' is not allowed in an attribute value");
        else if (code !== code) throw malformed(text, length, "attribute value is not terminated", "unclosed");
        valueEnd++;
      }
      const raw = text.slice(valueStart, valueEnd);
      const value = hasReference ? decodeReferences(raw, text, valueStart) : raw;

      if (attrCount < DUPLICATE_SCAN_LIMIT) {
        for (let index = 0; index < attrCount; index++) {
          if ((attrBuffer[index] as XmlAttr).name === attrName) {
            throw malformed(text, nameStart, `duplicate attribute ${quoteName(attrName)}`, "duplicate_attribute");
          }
        }
      } else {
        // Lives for one start tag; its size is bounded by that tag's attribute count.
        if (seen === null) {
          seen = new Set<string>();
          for (let index = 0; index < attrCount; index++) seen.add((attrBuffer[index] as XmlAttr).name);
        }
        if (seen.has(attrName)) {
          throw malformed(text, nameStart, `duplicate attribute ${quoteName(attrName)}`, "duplicate_attribute");
        }
        seen.add(attrName);
      }

      attrBuffer[attrCount++] = {
        name: attrName,
        value,
        raw,
        quote: quoteCode === 0x22 ? '"' : "'",
        lead: nameStart - spaceStart === 1 && text.charCodeAt(spaceStart) === 0x20 ? " " : text.slice(spaceStart, nameStart),
        eq,
      };
      at = valueEnd + 1;
      code = text.charCodeAt(at);
    }

    const element: WritableElement = {
      kind: "element",
      name,
      attrs: attrCount === 0 ? [] : attrBuffer.slice(0, attrCount),
      children: [],
      parent: open ?? doc,
      selfClosing,
      openTagTail,
      closeTagTail: "",
    };
    buffer[count++] = element;
    if (open === null) root = element;
    if (!selfClosing) {
      open = element;
      savedCounts[depth] = count;
      depth++;
      buffer = levels[depth] ?? (levels[depth] = []);
      count = 0;
    }
    pos = at;
  }

  if (open !== null) {
    throw malformed(text, length, `unexpected end of input: <${quoteName(open.name)}> is not closed`, "unclosed");
  }
  if (root === null) throw malformed(text, length, "the document has no element", "no_root");
  doc.children = buffer.slice(0, count);
  doc.root = root;
  return doc;
};
