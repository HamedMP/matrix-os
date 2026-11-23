/**
 * Decoding of the only references this parser knows: the five predefined
 * entities and numeric character references. Nothing is ever expanded twice
 * and no other entity name is accepted, so text cannot grow beyond its source.
 */

import { isXmlCodePoint } from "./chars.js";
import { malformed } from "./errors.js";

const MAX_CODE_POINT = 0x10ffff;

/**
 * Decodes `raw`, which must contain at least one `&`.
 *
 * @param text the whole document, for error positions
 * @param base offset of `raw` inside `text`
 */
export function decodeReferences(raw: string, text: string, base: number): string {
  let out = "";
  let from = 0;
  let amp = raw.indexOf("&");
  while (amp !== -1) {
    if (amp > from) out += raw.slice(from, amp);
    let at = amp + 1;
    let code = raw.charCodeAt(at);
    if (code === 0x23 /* # */) {
      at++;
      let value = 0;
      const digitsStart = at;
      if (raw.charCodeAt(at) === 0x78 /* x */) {
        at++;
        const hexStart = at;
        for (;;) {
          code = raw.charCodeAt(at);
          let digit: number;
          if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
          else if (code >= 0x61 && code <= 0x66) digit = code - 0x57;
          else if (code >= 0x41 && code <= 0x46) digit = code - 0x37;
          else break;
          value = value * 16 + digit;
          if (value > MAX_CODE_POINT) throw badReference(text, base + amp);
          at++;
        }
        if (at === hexStart) throw badReference(text, base + amp);
      } else {
        for (;;) {
          code = raw.charCodeAt(at);
          if (code < 0x30 || code > 0x39 || code !== code) break;
          value = value * 10 + (code - 0x30);
          if (value > MAX_CODE_POINT) throw badReference(text, base + amp);
          at++;
        }
        if (at === digitsStart) throw badReference(text, base + amp);
      }
      if (code !== 0x3b /* ; */ || !isXmlCodePoint(value)) throw badReference(text, base + amp);
      out += String.fromCodePoint(value);
      from = at + 1;
    } else if (code === 0x61 /* a */ && raw.startsWith("mp;", at + 1)) {
      out += "&";
      from = at + 4;
    } else if (code === 0x6c /* l */ && raw.startsWith("t;", at + 1)) {
      out += "<";
      from = at + 3;
    } else if (code === 0x67 /* g */ && raw.startsWith("t;", at + 1)) {
      out += ">";
      from = at + 3;
    } else if (code === 0x71 /* q */ && raw.startsWith("uot;", at + 1)) {
      out += '"';
      from = at + 5;
    } else if (code === 0x61 /* a */ && raw.startsWith("pos;", at + 1)) {
      out += "'";
      from = at + 5;
    } else {
      throw malformed(
        text,
        base + amp,
        "reference to an entity that is not predefined; only &lt; &gt; &amp; &quot; &apos; and character references are supported",
        "undefined_entity",
      );
    }
    amp = raw.indexOf("&", from);
  }
  return from === 0 ? raw : out + raw.slice(from);
}

function badReference(text: string, offset: number) {
  return malformed(text, offset, "malformed character reference or reference to a character XML does not allow", "invalid_reference");
}
