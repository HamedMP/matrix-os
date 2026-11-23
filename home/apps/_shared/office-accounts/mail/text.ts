/**
 * Text helpers for provider replies: base64 forms, charsets, RFC 2047 header
 * words, HTML entities and an HTML-to-text pass.
 *
 * Everything here produces plain text. `htmlToText` reads untrusted HTML but
 * its output is only ever rendered as text, never as markup. The scanners are
 * linear so hostile input cannot make them slow.
 */

const UTF8 = "utf-8";

/** Bytes of standard or URL-safe base64, with or without padding. Throws `RangeError` on bad input. */
export function base64ToBytes(base64: string): Uint8Array {
  const standard = base64UrlToBase64(base64.replace(/\s+/g, ""));
  let binary: string;
  try {
    binary = atob(standard);
  } catch (error: unknown) {
    // atob signals malformed input with a DOMException; anything else is a fault.
    if (error instanceof Error && error.name === "InvalidCharacterError") throw new RangeError("Malformed base64");
    throw error;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** URL-safe base64 to standard base64 with padding. Standard input passes through, padded. */
export function base64UrlToBase64(value: string): string {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const remainder = standard.length % 4;
  if (remainder === 1) throw new RangeError("Malformed base64");
  return remainder === 0 ? standard : standard + "=".repeat(4 - remainder);
}

/** Decodes bytes in the named charset; an unknown charset falls back to UTF-8. */
export function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? UTF8).trim().replace(/^["']|["']$/g, "").toLowerCase() || UTF8;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch (error: unknown) {
    // An unsupported label is a RangeError; decode as UTF-8 instead.
    if (!(error instanceof RangeError)) throw error;
    return new TextDecoder(UTF8).decode(bytes);
  }
}

/** Base64url (or base64) text content in a charset. */
export function decodeBase64Text(data: string, charset?: string): string {
  return decodeBytes(base64ToBytes(data), charset);
}

const ENCODED_WORD = /=\?([^?\s]{1,40})\?([BbQq])\?([^?\s]*)\?=/g;
const BETWEEN_WORDS = /(=\?[^?\s]{1,40}\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g;

function decodeQ(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === "_") bytes.push(0x20);
    else if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else bytes.push(char.charCodeAt(0) & 0xff);
  }
  return Uint8Array.from(bytes);
}

/** Decodes RFC 2047 encoded words (`=?UTF-8?B?...?=`) in a header value. Malformed words stay as written. */
export function decodeEncodedWords(value: string): string {
  if (!value.includes("=?")) return value;
  return value.replace(BETWEEN_WORDS, "$1").replace(ENCODED_WORD, (word, charset: string, encoding: string, text: string) => {
    try {
      const bytes = encoding.toUpperCase() === "B" ? base64ToBytes(text) : decodeQ(text);
      return decodeBytes(bytes, charset.split("*")[0]);
    } catch (error: unknown) {
      if (error instanceof RangeError) return word;
      throw error;
    }
  });
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", euro: "€", zwnj: "", zwj: "",
  shy: "", middot: "·", bull: "•", laquo: "«", raquo: "»",
};

function codePointText(codePoint: number, original: string): string {
  if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
    return original;
  }
  return String.fromCodePoint(codePoint);
}

/** Decodes the HTML entities mail commonly carries. Unknown entities stay as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (entity, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      return codePointText(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10), entity);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

const SKIPPED_ELEMENTS = new Set(["script", "style", "head", "title", "template", "noscript", "svg", "xml"]);
const BLOCK_ELEMENTS = new Set([
  "p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "table", "ul", "ol", "hr", "section",
  "article", "header", "footer",
]);
/** Upper bound on HTML read for the text form; the text of a mail longer than this is cut. */
export const MAX_HTML_TEXT_INPUT = 2_000_000;

function tagName(html: string, start: number): { name: string; closing: boolean } {
  let index = start + 1;
  const closing = html[index] === "/";
  if (closing) index++;
  let name = "";
  while (index < html.length && /[A-Za-z0-9]/.test(html[index]) && name.length < 16) name += html[index++];
  return { name: name.toLowerCase(), closing };
}

/**
 * Readable plain text from untrusted HTML: drops scripts, styles and comments,
 * turns block boundaries into line breaks, decodes entities and trims runs of
 * blank lines. The result is text and must be rendered as text.
 */
export function htmlToText(html: string): string {
  const source = html.length > MAX_HTML_TEXT_INPUT ? html.slice(0, MAX_HTML_TEXT_INPUT) : html;
  const lower = source.toLowerCase();
  let out = "";
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf("<", index);
    if (open === -1) { out += source.slice(index); break; }
    out += source.slice(index, open);
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      index = end === -1 ? source.length : end + 3;
      continue;
    }
    const close = source.indexOf(">", open + 1);
    if (close === -1) break;
    const { name, closing } = tagName(source, open);
    index = close + 1;
    if (!closing && SKIPPED_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, index);
      if (end === -1) break;
      const endClose = source.indexOf(">", end);
      index = endClose === -1 ? source.length : endClose + 1;
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) out += "\n";
    else if (name === "td" || name === "th") out += " ";
  }
  return decodeEntities(out)
    .replace(/ /g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Escapes plain text into minimal HTML with line breaks; for providers that store only HTML bodies. */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped.replace(/\r\n|\r|\n/g, "<br>");
}

/** One line of plain text, at most `max` characters. */
export function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Removes control characters (keeps none), for names and subjects sent to a provider. */
export function stripControl(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, "");
}
