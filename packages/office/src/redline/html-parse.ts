/**
 * Reads untrusted HTML into the flat item list of one side of a document.
 *
 * A tolerant tokeniser, not a browser parser: nothing is executed and the
 * result holds only text, line breaks and the allowed structure named in
 * `../api/redline.ts`. Unknown elements lose their tags and keep their text;
 * `script`, `style`, `head`, `iframe`, `object` and `embed` go with their
 * content; every attribute goes except a safe `href` on `a`. Whatever the
 * tokeniser misreads ends up as text, which is escaped on output.
 */

import { OfficeError } from "../errors.js";
import { decodeEntities } from "./html-entities.js";
import {
  BLOCK_CHAR,
  BLOCK_TAGS,
  BREAK_CHAR,
  INLINE_TAGS,
  KIND_BLOCK,
  KIND_BREAK,
  KIND_TEXT,
  MAX_REDLINE_LENGTH,
  inlinePresentation,
  safeHref,
  type SideItem,
} from "./model.js";

/** Elements dropped together with everything inside them. */
const DROPPED = new Set(["script", "style", "head", "iframe", "object"]);
/** Unknown elements that still end the current block, so their text does not run into its neighbours. */
const BREAKING = new Set([
  "address", "article", "aside", "body", "caption", "center", "dd", "details", "dl", "dt", "fieldset", "figcaption",
  "figure", "footer", "form", "header", "hr", "html", "main", "nav", "section", "summary", "tfoot", "title",
]);
/** Deepest nesting of kept elements. Deeper elements are read as unknown ones. */
const MAX_DEPTH = 64;
const REMOVED_CHARS = /[\u0000-\u0008\u000B\u000E-\u001F\u007F\uFFFE\uFFFF]/g;

interface Open {
  tag: string;
  block: boolean;
  id: string;
  href: string | null;
  /** A block element that already holds a block (text or a nested element). */
  filled: boolean;
}

/** Hands out ids for block elements, unique within one document. */
export interface IdSource {
  next: number;
}

class Builder {
  readonly items: SideItem[] = [{ k: KIND_BLOCK, t: "", p: "" }];
  private readonly stack: Open[] = [];
  private started = false;
  private blockOpen = false;
  private lastSpace = true;
  private preDepth = 0;
  private preJustOpened = false;
  private inline: string | null = null;

  constructor(private readonly ids: IdSource) {}

  private chain(): string {
    let out = "";
    for (const entry of this.stack) if (entry.block) out += `${out === "" ? "" : "/"}${entry.tag}:${entry.id}`;
    return out;
  }

  private presentation(): string {
    if (this.inline !== null) return this.inline;
    const tags: string[] = [];
    let href: string | null = null;
    for (const entry of this.stack) {
      if (entry.block) continue;
      tags.push(entry.tag);
      if (entry.tag === "a") href = entry.href;
    }
    this.inline = inlinePresentation(tags, href);
    return this.inline;
  }

  private startBlock(): void {
    const chain = this.chain();
    if (this.started) this.items.push({ k: KIND_BLOCK, t: BLOCK_CHAR, p: chain });
    else (this.items[0] as SideItem).p = chain;
    this.started = true;
    for (const entry of this.stack) if (entry.block) entry.filled = true;
    this.blockOpen = true;
    this.lastSpace = true;
  }

  private endBlock(): void {
    if (!this.blockOpen) return;
    this.blockOpen = false;
    const last = this.items[this.items.length - 1] as SideItem;
    if (this.preDepth === 0 && last.k === KIND_TEXT && last.t.endsWith(" ")) {
      last.t = last.t.slice(0, -1);
      if (last.t === "") this.items.pop();
    }
  }

  private pushText(text: string): void {
    if (text === "") return;
    if (!this.blockOpen) this.startBlock();
    const p = this.presentation();
    const last = this.items[this.items.length - 1] as SideItem;
    if (last.k === KIND_TEXT && last.p === p) last.t += text;
    else this.items.push({ k: KIND_TEXT, t: text, p });
  }

  text(raw: string): void {
    let text = decodeEntities(raw).replace(REMOVED_CHARS, "");
    if (this.preDepth > 0) {
      if (this.preJustOpened) text = text.replace(/^\r?\n/, "");
      this.preJustOpened = false;
      const lines = text.split(/\r\n|[\r\n\u2028\u2029]/);
      lines.forEach((line, index) => {
        if (index > 0) this.lineBreak();
        this.pushText(line);
      });
      return;
    }
    text = text.replace(/[ \t\n\r\f\u2028\u2029]+/g, " ");
    if ((this.lastSpace || !this.blockOpen) && text.startsWith(" ")) text = text.slice(1);
    if (text === "") return;
    this.pushText(text);
    this.lastSpace = text.endsWith(" ");
  }

  lineBreak(): void {
    if (!this.blockOpen) this.startBlock();
    this.items.push({ k: KIND_BREAK, t: BREAK_CHAR, p: this.presentation() });
    this.lastSpace = true;
  }

  /** Closes the element at `index` and everything opened inside it. */
  private closeAt(index: number): void {
    while (this.stack.length > index) {
      const entry = this.stack[this.stack.length - 1] as Open;
      if (entry.block) {
        this.endBlock();
        if (!entry.filled) {
          // An empty element is kept as an empty block: a blank paragraph, an empty cell.
          this.startBlock();
          this.blockOpen = false;
        }
        if (entry.tag === "pre") this.preDepth -= 1;
      }
      this.stack.pop();
    }
    this.inline = null;
  }

  /** Closes the nearest open element among `targets`, looking no further out than an element in `within`. */
  private closeImplied(targets: ReadonlySet<string>, within: ReadonlySet<string>): void {
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const tag = (this.stack[i] as Open).tag;
      if (targets.has(tag)) {
        this.closeAt(i);
        return;
      }
      if (within.has(tag)) return;
    }
  }

  open(tag: string, href: string | null): void {
    if (tag === "br") {
      this.lineBreak();
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (!block && !INLINE_TAGS.has(tag)) {
      if (BREAKING.has(tag)) this.endBlock();
      return;
    }
    if (block) {
      if (tag === "li") this.closeImplied(LI, LISTS);
      else if (tag === "td" || tag === "th") this.closeImplied(CELLS, ROW_SCOPE);
      else if (tag === "tr") this.closeImplied(ROWS, TABLE);
      else if (tag === "thead" || tag === "tbody") this.closeImplied(SECTIONS, TABLE);
      // A paragraph cannot hold another block: the new block ends it.
      for (let i = this.stack.length - 1; i >= 0; i -= 1) {
        const entry = this.stack[i] as Open;
        if (!entry.block) continue;
        if (entry.tag === "p") this.closeAt(i);
        break;
      }
      this.endBlock();
    }
    if (this.stack.length >= MAX_DEPTH) return;
    if (block) {
      for (const entry of this.stack) if (entry.block) entry.filled = true;
      this.stack.push({ tag, block: true, id: (this.ids.next++).toString(36), href: null, filled: false });
      if (tag === "pre") {
        this.preDepth += 1;
        this.preJustOpened = true;
      }
    } else {
      this.stack.push({ tag, block: false, id: "", href: tag === "a" ? href : null, filled: false });
      this.inline = null;
    }
  }

  close(tag: string): void {
    const block = BLOCK_TAGS.has(tag);
    if (!block && !INLINE_TAGS.has(tag)) {
      if (BREAKING.has(tag)) this.endBlock();
      return;
    }
    for (let i = this.stack.length - 1; i >= 0; i -= 1) {
      const entry = this.stack[i] as Open;
      if (entry.tag === tag) {
        this.closeAt(i);
        return;
      }
      // An inline end tag never closes a block it was opened outside of.
      if (!block && entry.block) return;
    }
  }

  finish(): SideItem[] {
    this.closeAt(0);
    this.endBlock();
    return this.items;
  }
}

const LI = new Set(["li"]);
const LISTS = new Set(["ul", "ol"]);
const CELLS = new Set(["td", "th"]);
const ROW_SCOPE = new Set(["tr", "table"]);
const ROWS = new Set(["tr"]);
const SECTIONS = new Set(["thead", "tbody"]);
const TABLE = new Set(["table"]);

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/** Reads a start tag at `html[at] === "<"`. Returns the lower-case name, the raw `href` and where the tag ends. */
function readStartTag(html: string, at: number): { name: string; href: string | null; end: number } {
  const n = html.length;
  let i = at + 1;
  while (i < n && !isSpace(html.charCodeAt(i)) && html[i] !== ">" && html[i] !== "/") i += 1;
  const name = html.slice(at + 1, i).toLowerCase();
  let href: string | null = null;
  while (i < n) {
    while (i < n && (isSpace(html.charCodeAt(i)) || html[i] === "/")) i += 1;
    if (i >= n) break;
    if (html[i] === ">") return { name, href, end: i + 1 };
    const nameStart = i;
    while (i < n && !isSpace(html.charCodeAt(i)) && html[i] !== ">" && html[i] !== "/" && (html[i] !== "=" || i === nameStart)) i += 1;
    const attr = html.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(html.charCodeAt(i))) i += 1;
    if (html[i] !== "=") continue;
    i += 1;
    while (i < n && isSpace(html.charCodeAt(i))) i += 1;
    let value: string;
    if (html[i] === '"' || html[i] === "'") {
      const quote = html[i] as string;
      const close = html.indexOf(quote, i + 1);
      const valueEnd = close === -1 ? n : close;
      value = html.slice(i + 1, valueEnd);
      i = close === -1 ? n : close + 1;
    } else {
      const valueStart = i;
      while (i < n && !isSpace(html.charCodeAt(i)) && html[i] !== ">") i += 1;
      value = html.slice(valueStart, i);
    }
    if (attr === "href" && href === null) href = value;
  }
  return { name, href, end: n };
}

/**
 * Parses `html` into one side of a document. Item 0 opens the first block.
 * Throws `limit_exceeded` above {@link MAX_REDLINE_LENGTH}.
 */
export function parseHtml(html: string, ids: IdSource): SideItem[] {
  if (html.length > MAX_REDLINE_LENGTH) {
    throw new OfficeError("limit_exceeded", "markup is too long for a redline", { details: { limit: MAX_REDLINE_LENGTH } });
  }
  const builder = new Builder(ids);
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      builder.text(html.slice(i));
      break;
    }
    if (lt > i) builder.text(html.slice(i, lt));
    const next = html.charCodeAt(lt + 1);
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
    } else if (next === 33 || next === 63) {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
    } else if (next === 47) {
      const end = html.indexOf(">", lt + 2);
      if (isLetter(html.charCodeAt(lt + 2))) {
        let nameEnd = lt + 2;
        const stop = end === -1 ? n : end;
        while (nameEnd < stop && !isSpace(html.charCodeAt(nameEnd)) && html[nameEnd] !== "/") nameEnd += 1;
        builder.close(html.slice(lt + 2, nameEnd).toLowerCase());
      }
      i = end === -1 ? n : end + 1;
    } else if (isLetter(next)) {
      const tag = readStartTag(html, lt);
      i = tag.end;
      if (DROPPED.has(tag.name)) {
        // The name comes from the fixed DROPPED set, so it is safe inside a pattern.
        const closing = new RegExp(`</${tag.name}`, "gi");
        closing.lastIndex = i;
        const close = closing.exec(html);
        const end = close === null ? -1 : html.indexOf(">", close.index);
        i = end === -1 ? n : end + 1;
      } else if (tag.name !== "embed") {
        builder.open(tag.name, tag.href === null ? null : safeHref(decodeEntities(tag.href)));
      }
    } else {
      builder.text("<");
      i = lt + 1;
    }
  }
  return builder.finish();
}

/** Plain text as one side of a document: a single block of unformatted text. */
export function parseText(text: string): SideItem[] {
  if (text.length > MAX_REDLINE_LENGTH) {
    throw new OfficeError("limit_exceeded", "text is too long for a redline", { details: { limit: MAX_REDLINE_LENGTH } });
  }
  const items: SideItem[] = [{ k: KIND_BLOCK, t: "", p: "" }];
  if (text !== "") items.push({ k: KIND_TEXT, t: text, p: "" });
  return items;
}
