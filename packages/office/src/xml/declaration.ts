/**
 * The `<?xml … ?>` declaration. It is kept verbatim for output; the pseudo
 * attributes are read only so callers can inspect them.
 */

import type { XmlDocument } from "../api/xml.js";
import { isXmlSpace } from "./chars.js";
import { malformed } from "./errors.js";
import type { WritableDeclaration } from "./nodes.js";

const VERSION = /^1\.[0-9]{1,8}$/;
const ENCODING = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const ORDER = ["version", "encoding", "standalone"] as const;
/** Anything longer than this is not a declaration an office application wrote. */
const MAX_DECLARATION_LENGTH = 256;

/** True when a declaration starts at `start`: `<?xml` followed by whitespace. */
export function startsDeclaration(text: string, start: number): boolean {
  return text.startsWith("<?xml", start) && isXmlSpace(text.charCodeAt(start + 5));
}

/**
 * Parses the declaration that starts at `start`.
 * Returns the node and the offset just after `?>`.
 */
export function parseDeclaration(
  text: string,
  start: number,
  parent: XmlDocument,
): { node: WritableDeclaration; end: number } {
  const fail = (message: string) => malformed(text, start, message, "declaration");
  const close = text.indexOf("?>", start + 5);
  if (close === -1 || close - start > MAX_DECLARATION_LENGTH) throw fail("the XML declaration is not terminated");

  const found: Record<(typeof ORDER)[number], string | null> = { version: null, encoding: null, standalone: null };
  let position = 0;
  let at = start + 5;
  for (;;) {
    const spaceStart = at;
    while (at < close && isXmlSpace(text.charCodeAt(at))) at++;
    if (at === close) break;
    if (at === spaceStart) throw fail("expected whitespace in the XML declaration");
    const nameStart = at;
    while (at < close && text.charCodeAt(at) >= 0x61 && text.charCodeAt(at) <= 0x7a) at++;
    const name = text.slice(nameStart, at);
    while (position < ORDER.length && ORDER[position] !== name) position++;
    if (position === ORDER.length) throw fail("unknown or misplaced attribute in the XML declaration");
    while (at < close && isXmlSpace(text.charCodeAt(at))) at++;
    if (text.charCodeAt(at) !== 0x3d /* = */) throw fail("expected '=' in the XML declaration");
    at++;
    while (at < close && isXmlSpace(text.charCodeAt(at))) at++;
    const quote = text.charCodeAt(at);
    if (quote !== 0x22 && quote !== 0x27) throw fail("expected a quoted value in the XML declaration");
    const valueEnd = text.indexOf(quote === 0x22 ? '"' : "'", at + 1);
    if (valueEnd === -1 || valueEnd >= close) throw fail("unterminated value in the XML declaration");
    found[ORDER[position] as (typeof ORDER)[number]] = text.slice(at + 1, valueEnd);
    position++;
    at = valueEnd + 1;
  }

  const { version, encoding, standalone } = found;
  if (version === null || !VERSION.test(version)) throw fail("the XML declaration needs version 1.x");
  if (encoding !== null && !ENCODING.test(encoding)) throw fail("invalid encoding name in the XML declaration");
  if (standalone !== null && standalone !== "yes" && standalone !== "no") {
    throw fail("standalone must be 'yes' or 'no' in the XML declaration");
  }
  const node: WritableDeclaration = {
    kind: "declaration",
    raw: text.slice(start, close + 2),
    version,
    encoding,
    standalone,
    parent,
  };
  return { node, end: close + 2 };
}
