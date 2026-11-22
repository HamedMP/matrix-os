/**
 * Character classes of XML 1.0 (fifth edition), on UTF-16 code units.
 *
 * ASCII goes through one lookup table. Code units from U+0080 up take the
 * range checks below. Surrogate halves are accepted in names so that names
 * with characters outside the basic plane work without decoding pairs.
 */

/** May start a name. */
export const NAME_START = 1;
/** May continue a name. */
export const NAME_CHAR = 2;

/** Class bits for the code units below 128. */
export const ASCII_CLASS: Uint8Array = buildAsciiClasses();

function buildAsciiClasses(): Uint8Array {
  const table = new Uint8Array(128);
  const mark = (from: number, to: number, bits: number): void => {
    for (let code = from; code <= to; code++) table[code] = (table[code] as number) | bits;
  };
  mark(0x41, 0x5a, NAME_START | NAME_CHAR); // A-Z
  mark(0x61, 0x7a, NAME_START | NAME_CHAR); // a-z
  mark(0x5f, 0x5f, NAME_START | NAME_CHAR); // _
  mark(0x3a, 0x3a, NAME_START | NAME_CHAR); // :
  mark(0x30, 0x39, NAME_CHAR); // 0-9
  mark(0x2d, 0x2e, NAME_CHAR); // - .
  return table;
}

/** Name start test for a code unit of 128 or more. False for NaN (past the end). */
export function isHighNameStart(code: number): boolean {
  if (code < 0x300) return code >= 0xc0 && code !== 0xd7 && code !== 0xf7;
  if (code < 0x2000) return code >= 0x370 && code !== 0x37e;
  if (code < 0x3001) {
    return code === 0x200c || code === 0x200d || (code >= 0x2070 && code <= 0x218f) || (code >= 0x2c00 && code <= 0x2fef);
  }
  if (code <= 0xdfff) return true; // CJK, Hangul and both surrogate halves
  return (code >= 0xf900 && code <= 0xfdcf) || (code >= 0xfdf0 && code <= 0xfffd);
}

/** Name continuation test for a code unit of 128 or more. False for NaN. */
export function isHighNameChar(code: number): boolean {
  return isHighNameStart(code) || code === 0xb7 || (code >= 0x300 && code <= 0x36f) || code === 0x203f || code === 0x2040;
}

export function isNameStart(code: number): boolean {
  return code < 128 ? ((ASCII_CLASS[code] as number) & NAME_START) !== 0 : isHighNameStart(code);
}

export function isNameChar(code: number): boolean {
  return code < 128 ? ((ASCII_CLASS[code] as number) & NAME_CHAR) !== 0 : isHighNameChar(code);
}

/** Space, tab, line feed or carriage return. */
export function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d;
}

/** True for a name the tokenizer would accept as written. */
export function isXmlName(name: string): boolean {
  if (name.length === 0 || !isNameStart(name.charCodeAt(0))) return false;
  for (let index = 1; index < name.length; index++) {
    if (!isNameChar(name.charCodeAt(index))) return false;
  }
  return true;
}

/** True for a code point that XML 1.0 allows in a document. */
export function isXmlCodePoint(code: number): boolean {
  if (code < 0x20) return code === 0x09 || code === 0x0a || code === 0x0d;
  if (code <= 0xd7ff) return true;
  if (code < 0xe000) return false;
  if (code <= 0xfffd) return true;
  return code >= 0x10000 && code <= 0x10ffff;
}

/** Code units that may not appear anywhere in a document, escaped or not. */
export const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

/** Offset of the first non-whitespace code unit in `[from, to)`, or -1. */
export function firstNonSpace(text: string, from: number, to: number): number {
  for (let index = from; index < to; index++) {
    const code = text.charCodeAt(index);
    if (code !== 0x20 && code !== 0x0a && code !== 0x09 && code !== 0x0d) return index;
  }
  return -1;
}
