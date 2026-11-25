/**
 * Escaping for values that have no source spelling: text and attributes that
 * were created or changed through a helper.
 *
 * Characters XML 1.0 cannot carry at all (most C0 controls, U+FFFE, U+FFFF)
 * are dropped: there is no way to write them, and a part containing one would
 * be refused by every reader. A carriage return in text is written as a
 * character reference: a reader turns a literal one into a line feed.
 */

import type { EscapeXmlAttr, EscapeXmlText } from "../api/xml.js";

const TEXT_SPECIAL = /[&<>\r\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const TEXT_SPECIAL_ALL = /[&<>\r\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const DOUBLE_QUOTED_SPECIAL = /[&<"\t\n\r\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const DOUBLE_QUOTED_SPECIAL_ALL = /[&<"\t\n\r\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const SINGLE_QUOTED_SPECIAL = /[&<'\t\n\r\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const SINGLE_QUOTED_SPECIAL_ALL = /[&<'\t\n\r\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

function replacement(char: string): string {
  switch (char) {
    case "&":
      return "&amp;";
    case "<":
      return "&lt;";
    case ">":
      return "&gt;";
    case '"':
      return "&quot;";
    case "'":
      return "&apos;";
    case "\t":
      return "&#9;";
    case "\n":
      return "&#10;";
    case "\r":
      return "&#13;";
    default:
      return "";
  }
}

/** Escapes `&`, `<`, `>` and the carriage return for element content. */
export const escapeXmlText: EscapeXmlText = (value) =>
  TEXT_SPECIAL.test(value) ? value.replace(TEXT_SPECIAL_ALL, replacement) : value;

/** Escapes a value for a double-quoted attribute. */
export const escapeXmlAttr: EscapeXmlAttr = (value) =>
  DOUBLE_QUOTED_SPECIAL.test(value) ? value.replace(DOUBLE_QUOTED_SPECIAL_ALL, replacement) : value;

/** Escapes a value for an attribute written with the given quote character. */
export function escapeAttrValue(value: string, quote: '"' | "'"): string {
  if (quote === '"') return escapeXmlAttr(value);
  return SINGLE_QUOTED_SPECIAL.test(value) ? value.replace(SINGLE_QUOTED_SPECIAL_ALL, replacement) : value;
}
