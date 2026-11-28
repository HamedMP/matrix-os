/**
 * Event descriptions to plain text.
 *
 * Providers return descriptions as HTML (Google when the
 * organiser used formatting). The output is only ever rendered as text. The
 * scanner walks the input once, so hostile markup cannot make it slow.
 */

/** Descriptions longer than this are cut before conversion. */
export const MAX_DESCRIPTION_INPUT = 200_000;

const SKIPPED_ELEMENTS = new Set(["script", "style", "head", "title", "noscript", "template", "svg", "object"]);
const BLOCK_ELEMENTS = new Set([
  "br", "p", "div", "li", "ul", "ol", "tr", "table", "tbody", "thead", "blockquote", "pre", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer", "dl", "dt", "dd",
]);
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™", euro: "€", bull: "•", middot: "·",
};
const ENTITY = /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi;
const LOOKS_LIKE_HTML = /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>/i;

export function decodeEntities(text: string): string {
  return text.replace(ENTITY, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Raw line breaks in HTML text are spacing, not structure. */
function flat(segment: string): string {
  return segment.replace(/[\r\n\u0000]+/g, " ");
}

function tagName(tag: string): string {
  const match = /^\/?\s*([a-z][a-z0-9]*)/i.exec(tag);
  return match ? match[1].toLowerCase() : "";
}

/** Plain text of an HTML fragment or document. Scripts, styles and the head are dropped. */
export function htmlToText(html: string): string {
  const input = html.length > MAX_DESCRIPTION_INPUT ? html.slice(0, MAX_DESCRIPTION_INPUT) : html;
  const lower = input.toLowerCase();
  let out = "";
  let index = 0;
  while (index < input.length) {
    const open = input.indexOf("<", index);
    if (open === -1) {
      out += flat(input.slice(index));
      break;
    }
    out += flat(input.slice(index, open));
    if (input.startsWith("<!--", open)) {
      const close = input.indexOf("-->", open + 4);
      index = close === -1 ? input.length : close + 3;
      continue;
    }
    const close = input.indexOf(">", open + 1);
    if (close === -1) break;
    const tag = input.slice(open + 1, close);
    const name = tagName(tag);
    index = close + 1;
    if (!tag.startsWith("/") && SKIPPED_ELEMENTS.has(name)) {
      const end = lower.indexOf(`</${name}`, index);
      if (end === -1) break;
      const endClose = input.indexOf(">", end);
      index = endClose === -1 ? input.length : endClose + 1;
      continue;
    }
    if (BLOCK_ELEMENTS.has(name)) out += "\n";
    else if (name === "td" || name === "th") out += " ";
  }
  return tidy(decodeEntities(out));
}

/** A provider description as plain text: HTML is converted, plain text keeps its lines. */
export function descriptionToText(value: string, contentType?: string): string {
  if (!value) return "";
  const isHtml = contentType === undefined ? LOOKS_LIKE_HTML.test(value) : contentType.toLowerCase() === "html";
  if (isHtml) return htmlToText(value);
  const text = value.length > MAX_DESCRIPTION_INPUT ? value.slice(0, MAX_DESCRIPTION_INPUT) : value;
  return text.replace(/\r\n?/g, "\n").trim();
}
