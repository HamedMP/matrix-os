/**
 * `toMarkdown`: the body as Markdown (CommonMark with pipe tables,
 * strikethrough and footnotes).
 *
 * Headings (and the Title style) become `#` headings, numbered paragraphs
 * list items (`-` for bullets, `N.` with the paragraph's own counter
 * otherwise, nested by level), tables pipe tables with the first row as the
 * header, the Quote style `>` and the Code Block style a fenced block.
 * Footnote and endnote references become `[^label]` with their text at the
 * end. In `markup` deletions are shown as `~~struck~~` text.
 *
 * All document text is escaped, so it cannot turn into Markdown syntax or
 * raw HTML; links are kept only for `http`, `https` and `mailto`.
 */

import type { DocxDocument } from "../../api/docx.js";
import type { DocxStory, DocxTextView, InlineRun, ParagraphAlignment } from "../../api/docx-model.js";
import { OfficeError } from "../../errors.js";
import { isMonospace, safeExternalHref } from "./escape.js";
import { type FlatBlock, type FlatParagraph, type FlatTable, type RunFilter, flattenBlocks } from "./flatten.js";
import { runsText } from "./plain-text.js";
import { runFilterFor } from "./visibility.js";

export interface MarkdownExportOptions {
  /** Default `final`. */
  view?: DocxTextView;
}

const VIEWS: ReadonlySet<string> = new Set(["markup", "final", "original"]);
const OBJECT_CHAR = "￼";

interface MarkdownContext {
  view: DocxTextView;
  filter: RunFilter;
  /** Note story id to its Markdown label, in reference order. */
  notes: Map<string, string>;
}

/** Escapes text so that every character stays literal. */
export function escapeMarkdownText(text: string): string {
  return text.replace(/[\\`*_[\]<>#|~&!]/g, "\\$&");
}

/** Escapes what would start a block at the beginning of a line. */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)([-+=])(?=\s|$)/, "$1\\$2").replace(/^(\s*\d{1,9})([.)])/, "$1\\$2");
}

function noteLabel(label: string, storyId: string, context: MarkdownContext): string {
  const existing = context.notes.get(storyId);
  if (existing !== undefined) return existing;
  const clean = label.replace(/[^A-Za-z0-9]/g, "");
  let candidate = clean === "" ? String(context.notes.size + 1) : clean;
  const taken = new Set(context.notes.values());
  while (taken.has(candidate)) candidate = `${candidate}x`;
  context.notes.set(storyId, candidate);
  return candidate;
}

interface Piece {
  text: string;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  href: string | null;
}

function pieceOf(run: InlineRun, context: MarkdownContext, plainWeight: boolean): Piece | string {
  if (run.footnoteRef !== null) return `[^${noteLabel(run.footnoteRef.label, run.footnoteRef.storyId, context)}]`;
  const removal = run.revision !== null && (run.revision.kind === "delete" || run.revision.kind === "moveFrom");
  return {
    text: run.text.replace(new RegExp(OBJECT_CHAR, "g"), ""),
    bold: run.bold && !plainWeight,
    italic: run.italic,
    strike: run.strike || (context.view === "markup" && removal),
    code: isMonospace(run.fontFamily),
    href: safeExternalHref(run.hyperlink?.href ?? null),
  };
}

function wrap(piece: Piece): string {
  if (piece.text === "") return "";
  if (piece.code) {
    const longest = Math.max(0, ...(piece.text.match(/`+/g) ?? []).map((ticks) => ticks.length));
    const fence = "`".repeat(longest + 1);
    const pad = piece.text.startsWith("`") || piece.text.endsWith("`") ? " " : "";
    let code = `${fence}${pad}${piece.text.replace(/\n/g, " ")}${pad}${fence}`;
    if (piece.href !== null) code = `[${code}](${encodeHref(piece.href)})`;
    return code;
  }
  const lead = /^\s*/.exec(piece.text)?.[0] ?? "";
  const trail = /\s*$/.exec(piece.text.slice(lead.length))?.[0] ?? "";
  const core = piece.text.slice(lead.length, piece.text.length - trail.length);
  if (core === "") return inlineWhitespace(piece.text);
  let out = escapeMarkdownText(core).replace(/\t/g, " ").replace(/\n/g, "\\\n");
  if (piece.italic) out = `*${out}*`;
  if (piece.bold) out = `**${out}**`;
  if (piece.strike) out = `~~${out}~~`;
  if (piece.href !== null) out = `[${out}](${encodeHref(piece.href)})`;
  return inlineWhitespace(lead) + out + inlineWhitespace(trail);
}

const inlineWhitespace = (text: string): string => text.replace(/\t/g, " ").replace(/\n/g, "\\\n");
const encodeHref = (href: string): string => href.replace(/[()\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

function sameFormat(a: Piece, b: Piece): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.href === b.href;
}

/** The inline Markdown of runs; `plainWeight` drops bold, which a heading style implies. */
function inlineMarkdown(runs: readonly InlineRun[], context: MarkdownContext, plainWeight = false): string {
  let out = "";
  let current: Piece | null = null;
  const flush = (): void => {
    if (current !== null) out += wrap(current);
    current = null;
  };
  for (const run of runs) {
    const piece = pieceOf(run, context, plainWeight);
    if (typeof piece === "string") {
      flush();
      out += piece;
    } else if (current !== null && sameFormat(current, piece)) {
      current.text += piece.text;
    } else {
      flush();
      current = piece;
    }
  }
  flush();
  return out;
}

function codeBlock(paragraph: FlatParagraph): string {
  const text = runsText(paragraph.runs);
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((ticks) => ticks.length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}

function tableMarkdown(table: FlatTable, context: MarkdownContext): string {
  const rows = table.rows.map((row) =>
    row.slots.flatMap(({ cell, flat }) => {
      // A cell hidden by a vertical merge keeps its column, empty.
      const blocks = flat?.blocks ?? [];
      const text = blocks
        .map((block) => (block.type === "paragraph" ? inlineMarkdown(block.runs, context) : ""))
        .filter((part) => part !== "")
        .join(" ")
        .replace(/\\\n/g, " ");
      return [text, ...new Array<string>(Math.max(0, Math.min(cell.colSpan, 64) - 1)).fill("")];
    }),
  );
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const firstRow = table.rows[0];
  const alignOf = (column: number): ParagraphAlignment | null => {
    const first = firstRow?.cells[column]?.blocks[0];
    return first !== undefined && first.type === "paragraph" ? first.block.style.alignment : null;
  };
  const delimiter = Array.from({ length: columns }, (_, column) => {
    const align = alignOf(column);
    return align === "center" ? ":---:" : align === "right" ? "---:" : "---";
  });
  const line = (cells: readonly string[]): string => {
    const padded = [...cells];
    while (padded.length < columns) padded.push("");
    return `| ${padded.join(" | ")} |`;
  };
  const [header = [], ...body] = rows;
  return [line(header), line(delimiter), ...body.map(line)].join("\n");
}

/** Renders blocks; list items are tight, everything else is separated by a blank line. */
function blocksMarkdown(blocks: readonly FlatBlock[], context: MarkdownContext): string {
  let out = "";
  let previousWasList = false;
  const contentColumns: number[] = [];
  for (const block of blocks) {
    if (block.type === "sectionBreak") continue;
    let text: string;
    let isList = false;
    if (block.type === "table") {
      text = tableMarkdown(block, context);
    } else {
      const style = block.block.style;
      const numbering = block.block.numbering;
      const heading = style.headingLevel > 0 || style.styleId === "Title";
      // Markdown cannot show leading or trailing spaces of a paragraph, and four would start a code block.
      const inline = inlineMarkdown(block.runs, context, heading).replace(/^ +/, "").replace(/ +$/, "");
      if (style.styleId === "CodeBlock") {
        text = codeBlock(block);
      } else if (heading) {
        text = `${"#".repeat(Math.min(Math.max(style.headingLevel, 1), 6))} ${inline.replace(/\\\n/g, " ")}`.trimEnd();
      } else if (numbering !== null) {
        isList = true;
        const level = Math.max(0, Math.min(numbering.level, 8));
        contentColumns.length = Math.min(contentColumns.length, level);
        while (contentColumns.length < level) contentColumns.push((contentColumns[contentColumns.length - 1] ?? 0) + 2);
        const indent = level === 0 ? 0 : (contentColumns[level - 1] as number);
        const marker = numbering.format === "bullet" ? "-" : `${numbering.counters[level] ?? 1}.`;
        contentColumns.push(indent + marker.length + 1);
        const pad = " ".repeat(indent + marker.length + 1);
        text = `${" ".repeat(indent)}${marker} ${inline.replace(/\\\n/g, `\\\n${pad}`)}`.trimEnd();
      } else if (style.styleId === "Quote") {
        text = escapeLineStart(inline)
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
      } else {
        text = escapeLineStart(inline);
        if (text === "") continue;
      }
    }
    if (!isList) contentColumns.length = 0;
    if (out !== "") out += isList && previousWasList ? "\n" : "\n\n";
    out += text;
    previousWasList = isList;
  }
  return out;
}

function notesMarkdown(stories: readonly DocxStory[], context: MarkdownContext): string {
  const byId = new Map(stories.map((story) => [story.id, story]));
  const lines: string[] = [];
  // Notes can reference further notes; the map grows while it is walked.
  for (const [storyId, label] of context.notes) {
    const story = byId.get(storyId);
    if (story === undefined) continue;
    const blocks = flattenBlocks(story.blocks, context.view, context.filter).map((block) =>
      block.type === "paragraph"
        ? { ...block, runs: block.runs.filter((run) => run.footnoteRef?.storyId !== storyId) }
        : block,
    );
    const body = blocksMarkdown(blocks, context).trim().replace(/\n/g, "\n    ");
    lines.push(`[^${label}]: ${body}`);
  }
  return lines.join("\n");
}

/** The body as Markdown. See the module comment. */
export function toMarkdown(doc: DocxDocument, options: MarkdownExportOptions = {}): string {
  const view = options.view ?? "final";
  if (!VIEWS.has(view)) throw new OfficeError("invalid_argument", "unknown text view");
  const model = doc.getView();
  const context: MarkdownContext = { view, filter: runFilterFor(doc), notes: new Map() };
  const body = blocksMarkdown(flattenBlocks(model.body.blocks, view, context.filter), context);
  const notes = notesMarkdown([...model.footnotes, ...model.endnotes], context);
  const text = notes === "" ? body : `${body}\n\n${notes}`;
  return text === "" ? "" : `${text}\n`;
}
