/**
 * Tracked changes inside a stored draft body.
 *
 * A draft with pending changes is saved as the redline's markup view, with
 * inline styles added so that any mail client shows it as marked-up text:
 * insertions as a coloured underline, deletions as a coloured strikethrough
 * (`degradeMarkup`). The plain-text part marks them as `{+inserted+}` and
 * `[-deleted-]` (`markedText`).
 *
 * When the draft is opened here again, `redlineFromDraftHtml` reads the
 * `ins` and `del` elements back (by their `redline-` class), rebuilds the
 * original and the revised text, and replays each author's changes so the
 * body is a live redline again. Stored HTML is untrusted: it is only ever
 * read through the redline engine, which keeps an allowlisted structure.
 */
import { createRedline, type TrackedRedline } from "../../../_shared/office-engine/redline/index";

export const INS_STYLE = "color:#1a7f37;text-decoration:underline;text-decoration-color:#1a7f37";
export const DEL_STYLE = "color:#b42318;text-decoration:line-through;text-decoration-color:#b42318";
/** Author used when stored markup does not say who made a change. */
export const UNKNOWN_AUTHOR = "Earlier edit";
const FIXED_DATE = "2000-01-01T00:00:00.000Z";
const MAX_AUTHOR_CHARS = 120;
/** Distinct authors replayed when a stored body is reopened; later ones are folded into the last. */
const MAX_AUTHORS = 20;
/** Largest stored body read back as a redline; the draft request itself is capped well below this. */
export const MAX_TRACKED_HTML_CHARS = 400_000;

const OPEN_TAG = /<(ins|del)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const MERGE = "";
const SPLIT = "";
const BLOCK = "div|p|li|h[1-6]|pre|blockquote";

function attr(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function isTracked(attrs: string): boolean {
  return /\bredline-(?:ins|del|move-from|move-to)\b/i.test(attr(attrs, "class") ?? "");
}

function isParagraphMark(attrs: string): boolean {
  return /\bredline-para\b/i.test(attr(attrs, "class") ?? "");
}

const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

function authorOf(attrs: string, kind: "ins" | "del"): string {
  let raw = attr(attrs, "data-author");
  if (raw === null) {
    const title = attr(attrs, "title");
    const prefix = kind === "ins" ? "Inserted by " : "Deleted by ";
    const decodedTitle = title === null ? "" : decodeEntities(title);
    raw = decodedTitle.startsWith(prefix) ? decodedTitle.slice(prefix.length) : "";
  } else {
    raw = decodeEntities(raw);
  }
  const clean = raw.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, MAX_AUTHOR_CHARS);
  return clean || UNKNOWN_AUTHOR;
}

function dateOf(attrs: string, fallback: string): string {
  const raw = attr(attrs, "data-date");
  if (!raw) return fallback;
  const ms = Date.parse(decodeEntities(raw));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

/** The markup view with inline styles and tooltips, as stored in the draft. */
export function degradeMarkup(markupHtml: string): string {
  return markupHtml.replace(OPEN_TAG, (whole, tag: string, attrs: string) => {
    if (!isTracked(attrs) || isParagraphMark(attrs)) return whole;
    const kind = tag.toLowerCase() as "ins" | "del";
    const title = `${kind === "ins" ? "Inserted" : "Deleted"} by ${authorOf(attrs, kind)}`;
    const cleaned = attrs.replace(/\s(?:style|title)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/gi, "");
    return `<${tag}${cleaned} style="${kind === "ins" ? INS_STYLE : DEL_STYLE}" title="${escapeAttr(title)}">`;
  });
}

/** The markup view for the editor: deletions cannot be typed into. */
export function editorMarkup(markupHtml: string): string {
  return markupHtml.replace(OPEN_TAG, (whole, tag: string, attrs: string) => {
    if (tag.toLowerCase() !== "del" || !isTracked(attrs) || /contenteditable/i.test(attrs)) return whole;
    return `<${tag}${attrs} contenteditable="false">`;
  });
}

/** True when the HTML holds tracked insertions or deletions made by this composer. */
export function hasTrackedMarkup(html: string): boolean {
  for (const match of html.matchAll(OPEN_TAG)) if (isTracked(match[2])) return true;
  return false;
}

/** Plain text of simple HTML, read through the redline engine (no DOM needed). */
export function htmlToPlainText(html: string): string {
  if (!html.trim()) return "";
  return createRedline(html, html, { author: "text", date: FIXED_DATE, format: "html", detectMoves: false }).toText("final");
}

/** Plain text of a markup view, with `{+inserted+}` and `[-deleted-]` markers. */
export function markedText(markupHtml: string): string {
  const marked = markupHtml
    .replace(OPEN_TAG, (whole, tag: string, attrs: string) => (isTracked(attrs) ? (tag.toLowerCase() === "ins" ? "{+" : "[-") : whole))
    .replace(/<\/ins\s*>/gi, "+}")
    .replace(/<\/del\s*>/gi, "-]");
  return htmlToPlainText(marked).replace(/\{\+\+\}|\[--\]/g, "");
}

interface PlainSegment { kind: "plain"; html: string }
interface ChangeSegment { kind: "ins" | "del"; html: string; author: string; date: string; paragraph: boolean }
type Segment = PlainSegment | ChangeSegment;

/** The end of the element opened just before `from`: index after its matching close tag. */
function closeOf(html: string, tag: string, from: number): { innerEnd: number; end: number } {
  const pattern = new RegExp(`<(/?)${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return { innerEnd: match.index, end: match.index + match[0].length };
  }
  return { innerEnd: html.length, end: html.length };
}

function segmentsOf(html: string, fallbackDate: string): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  const pattern = new RegExp(OPEN_TAG.source, "gi");
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    const attrs = match[2];
    if (!isTracked(attrs)) continue;
    if (match.index > cursor) segments.push({ kind: "plain", html: html.slice(cursor, match.index) });
    const kind = match[1].toLowerCase() as "ins" | "del";
    const innerStart = match.index + match[0].length;
    const { innerEnd, end } = closeOf(html, match[1], innerStart);
    segments.push({ kind, html: html.slice(innerStart, innerEnd), author: authorOf(attrs, kind), date: dateOf(attrs, fallbackDate), paragraph: isParagraphMark(attrs) });
    cursor = end;
    pattern.lastIndex = end;
  }
  if (cursor < html.length) segments.push({ kind: "plain", html: html.slice(cursor) });
  return segments;
}

/** Turns paragraph sentinels back into block structure. */
function settleParagraphs(html: string): string {
  let out = html;
  // A deleted paragraph mark that is kept: split the enclosing block, unless it already starts one.
  out = out.replace(new RegExp(`(<(?:${BLOCK})\\b[^>]*>)${SPLIT}`, "gi"), "$1");
  while (out.includes(SPLIT)) {
    const at = out.indexOf(SPLIT);
    const before = out.slice(0, at);
    const opens = [...before.matchAll(new RegExp(`<(${BLOCK})\\b[^>]*>`, "gi"))];
    const tag = opens.length ? opens[opens.length - 1][1].toLowerCase() : null;
    out = before + (tag ? `</${tag}><${tag}>` : "<br>") + out.slice(at + 1);
  }
  // A paragraph mark that does not exist on this side: join with the block before.
  out = out.replace(new RegExp(`</(${BLOCK})>\\s*<\\1\\b[^>]*>${MERGE}`, "gi"), "");
  const emptyBlock = new RegExp(`<(${BLOCK})\\b[^>]*>\\s*${MERGE}[\\s${MERGE}]*</\\1>`, "gi");
  const emptyList = /<(ul|ol)\b[^>]*>\s*<\/\1>/gi;
  let previous = "";
  while (previous !== out) {
    previous = out;
    out = out.replace(emptyBlock, "").replace(emptyList, "");
  }
  return out.split(MERGE).join("");
}

/** The body as it reads with the changes of the first `applied` authors in effect. */
function stage(segments: readonly Segment[], authors: readonly string[], applied: number): string {
  let html = "";
  for (const segment of segments) {
    if (segment.kind === "plain") {
      html += segment.html;
      continue;
    }
    const inEffect = authors.indexOf(segment.author) < applied;
    if (segment.kind === "ins") html += inEffect ? segment.html : segment.paragraph ? MERGE : "";
    else html += inEffect ? (segment.paragraph ? MERGE : "") : segment.paragraph ? SPLIT : segment.html;
  }
  return settleParagraphs(html);
}

/**
 * A live redline from a stored draft body, or null when the body has no
 * tracked changes. `fallbackDate` dates changes the markup gives no date for.
 */
export function redlineFromDraftHtml(html: string, fallbackDate: string): TrackedRedline | null {
  if (typeof html !== "string" || !html || html.length > MAX_TRACKED_HTML_CHARS) return null;
  const clean = html.replace(/[]/g, "");
  if (!hasTrackedMarkup(clean)) return null;
  const segments = segmentsOf(clean, fallbackDate);
  const authors: string[] = [];
  const dates: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "plain") continue;
    if (!authors.includes(segment.author)) {
      if (authors.length >= MAX_AUTHORS) segment.author = authors[authors.length - 1];
      else {
        authors.push(segment.author);
        dates.push(segment.date);
      }
    }
  }
  const doc = createRedline(stage(segments, authors, 0), stage(segments, authors, 1), { author: authors[0], date: dates[0], format: "html" });
  for (let index = 1; index < authors.length; index++) {
    doc.applyUserEdit(stage(segments, authors, index + 1), { author: authors[index], date: dates[index] });
  }
  return doc;
}
