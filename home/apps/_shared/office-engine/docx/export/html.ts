/**
 * `toHtml`: a document as semantic, self-contained HTML.
 *
 * Headings become `h1` to `h6`, numbering labels are text in
 * `span.list-label`, tables keep their spans. In `markup` mode tracked
 * changes are `ins` and `del` elements (moves too) with the revision id,
 * kind, author and date in data attributes; in `final` and `original` the
 * document reads as if every change were accepted or rejected. Comment
 * anchors are `span.comment-anchor[data-comment-ids]` and the comments follow
 * the body; footnotes and endnotes follow as lists.
 *
 * Safety: every value taken from the document is escaped, links are kept
 * only for `http`, `https`, `mailto` and in-document bookmarks, images are
 * placeholders, and the full page carries a Content-Security-Policy that
 * allows no script and no remote load.
 */

import type { DocxDocument } from "../../api/docx.js";
import type { DocxComment, DocxStory, DocxTextView, ParagraphBlock } from "../../api/docx-model.js";
import { OfficeError } from "../../errors.js";
import { bookmarkAnchor, escapeHtml, isHexColor, safeToken } from "./escape.js";
import { type FlatBlock, type FlatParagraph, type FlatTable, type RunFilter, flattenBlocks } from "./flatten.js";
import { type InlineContext, revisionAttrs, runsHtml } from "./html-inline.js";
import { DOCUMENT_CSS } from "./html-style.js";
import { runFilterFor } from "./visibility.js";

export type HtmlExportMode = DocxTextView;

export interface HtmlExportOptions {
  /** Which text to show; default `final`. */
  mode?: HtmlExportMode;
  /** Return only the `<article>` element instead of a whole page. Default false. */
  fragment?: boolean;
  /** Page title; default the document title, else `Document`. */
  title?: string;
}

interface HtmlContext extends InlineContext {
  readonly filter: RunFilter;
}

const MODES: ReadonlySet<string> = new Set(["markup", "final", "original"]);
const ALIGN: Record<string, string> = { center: "center", right: "right", justify: "justify" };

function paragraphHtml(paragraph: FlatParagraph, context: InlineContext): string {
  const block: ParagraphBlock = paragraph.block;
  const level = block.style.headingLevel;
  const tag = level >= 1 && level <= 6 ? `h${level}` : "p";
  let attrs = ` data-block-id="${escapeHtml(paragraph.blockIds[0] as string)}"`;
  if (paragraph.blockIds.length > 1) attrs += ` data-merged-block-ids="${escapeHtml(paragraph.blockIds.slice(1).join(" "))}"`;
  if (level > 6) attrs += ` role="heading" aria-level="${level}"`;
  if (block.style.styleName !== null) attrs += ` data-style="${escapeHtml(block.style.styleName)}"`;
  const classes: string[] = [];
  if (block.style.styleId === "Title") classes.push("title");
  if (block.numbering !== null) classes.push("list-item");
  if (classes.length > 0) attrs += ` class="${classes.join(" ")}"`;
  const align = ALIGN[block.style.alignment];
  const indent = block.numbering !== null ? Math.max(0, Math.min(block.numbering.level, 8)) * 1.5 : 0;
  let style = align === undefined ? "" : `text-align:${align};`;
  if (indent > 0) style += `margin-left:${indent}em;`;
  if (style !== "") attrs += ` style="${style}"`;
  if (block.numbering !== null) attrs += ` data-list-level="${block.numbering.level}"`;
  if (context.view === "markup") {
    if (block.markRevision !== null) attrs += revisionAttrs(block.markRevision, "data-mark-revision");
    if (block.formatRevision !== null) attrs += revisionAttrs(block.formatRevision, "data-format-revision");
  }
  let content = paragraph.bookmarks.map((name) => `<a class="bookmark" id="${bookmarkAnchor(name)}"></a>`).join("");
  if (block.numbering !== null) {
    content += `<span class="list-label" data-num-id="${escapeHtml(block.numbering.numId)}">${escapeHtml(block.numbering.text)}</span> `;
  }
  const runs = runsHtml(paragraph.runs, context);
  content += runs === "" && block.numbering === null ? "<br>" : runs;
  return `<${tag}${attrs}>${content}</${tag}>`;
}

function tableHtml(table: FlatTable, context: InlineContext): string {
  let html = `<table class="docx-table" data-block-id="${escapeHtml(table.block.id)}"><tbody>`;
  for (const { row, cells } of table.rows) {
    let attrs = "";
    if (context.view === "markup" && row.revision !== null) {
      const removal = row.revision.kind === "delete" || row.revision.kind === "moveFrom";
      attrs = ` class="rev-row ${removal ? "rev-delete" : "rev-insert"}"${revisionAttrs(row.revision)}`;
    }
    html += `<tr${attrs}>`;
    for (const { cell, rowSpan, blocks } of cells) {
      const tag = row.isHeader ? "th" : "td";
      let cellAttrs = "";
      if (cell.colSpan > 1) cellAttrs += ` colspan="${Math.min(cell.colSpan, 1000)}"`;
      if (rowSpan > 1) cellAttrs += ` rowspan="${Math.min(rowSpan, 65534)}"`;
      if (isHexColor(cell.fill)) cellAttrs += ` style="background-color:${cell.fill.toLowerCase()}"`;
      html += `<${tag}${cellAttrs}>${blocksHtml(blocks, context)}</${tag}>`;
    }
    html += "</tr>";
  }
  return `${html}</tbody></table>`;
}

function blocksHtml(blocks: readonly FlatBlock[], context: InlineContext): string {
  let html = "";
  for (const block of blocks) {
    if (block.type === "paragraph") html += paragraphHtml(block, context);
    else if (block.type === "table") html += tableHtml(block, context);
    else html += `<hr class="section-break" data-break-type="${escapeHtml(block.block.breakType)}">`;
  }
  return html;
}

function notesHtml(stories: readonly DocxStory[], kind: "footnote" | "endnote", context: HtmlContext): string {
  const referenced = stories.filter((story) => context.noteRefs.get(story.id)?.kind === kind);
  if (referenced.length === 0) return "";
  const heading = kind === "footnote" ? "Footnotes" : "Endnotes";
  let html = `<section class="docx-notes docx-${kind}s" role="doc-${kind}s" aria-label="${heading}"><ol>`;
  for (const story of referenced) {
    const ref = context.noteRefs.get(story.id) as { refId: string; label: string };
    // The note's own reference mark is shown as the label instead.
    const blocks = flattenBlocks(story.blocks, context.view, context.filter).map((block) =>
      block.type === "paragraph"
        ? { ...block, runs: block.runs.filter((run) => run.footnoteRef?.storyId !== story.id) }
        : block,
    );
    html +=
      `<li id="note-${safeToken(story.id)}" data-story-id="${escapeHtml(story.id)}">` +
      `<span class="note-label">${escapeHtml(ref.label)}</span>` +
      blocksHtml(blocks, context) +
      `<a class="note-back" href="#${ref.refId}" role="doc-backlink" aria-label="Back to text">↩</a></li>`;
  }
  return `${html}</ol></section>`;
}

function commentsHtml(comments: readonly DocxComment[]): string {
  if (comments.length === 0) return "";
  let html = '<aside class="docx-comments" aria-label="Comments"><ol>';
  for (const comment of comments) {
    let attrs = ` id="comment-${safeToken(comment.id)}" data-comment-id="${escapeHtml(comment.id)}"`;
    attrs += ` data-author="${escapeHtml(comment.author)}" data-resolved="${comment.resolved ? "true" : "false"}"`;
    if (comment.parentId !== null) attrs += ` data-parent-id="${escapeHtml(comment.parentId)}" class="reply"`;
    let meta = `<span class="comment-author">${escapeHtml(comment.author)}</span>`;
    if (comment.date !== null) meta += ` <time datetime="${escapeHtml(comment.date)}">${escapeHtml(comment.date)}</time>`;
    const anchor =
      comment.parentId === null && comment.anchorText !== ""
        ? `<blockquote class="comment-anchor-text">${escapeHtml(comment.anchorText)}</blockquote>`
        : "";
    const body = comment.text
      .split("\n")
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join("");
    html += `<li${attrs}><p class="comment-meta">${meta}</p>${anchor}${body}</li>`;
  }
  return `${html}</ol></aside>`;
}

/** The document as HTML. See the module comment for what is kept and how it is made safe. */
export function toHtml(doc: DocxDocument, options: HtmlExportOptions = {}): string {
  const mode = options.mode ?? "final";
  if (!MODES.has(mode)) throw new OfficeError("invalid_argument", "unknown HTML export mode");
  const view = doc.getView();
  const context: HtmlContext = { view: mode, noteRefs: new Map(), refCounter: 0, filter: runFilterFor(doc) };
  const body = blocksHtml(flattenBlocks(view.body.blocks, mode, context.filter), context);
  const article =
    `<article class="docx-document" data-mode="${mode}">${body}` +
    notesHtml(view.footnotes, "footnote", context) +
    notesHtml(view.endnotes, "endnote", context) +
    commentsHtml(doc.listComments()) +
    "</article>";
  if (options.fragment === true) return article;
  const title = options.title ?? doc.getProperties().title ?? "Document";
  return (
    "<!DOCTYPE html>\n" +
    '<html lang="en"><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(title === "" ? "Document" : title)}</title><style>${DOCUMENT_CSS}</style></head>` +
    `<body>${article}</body></html>\n`
  );
}
