/**
 * Renders one paragraph of the engine's view model as DOM.
 *
 * The DOM is output only. Every piece of text sits in a "leaf" that records
 * where it is in the paragraph's markup text (`data-s` start, `data-l`
 * length), which is all `./position-map.ts` needs to translate between the
 * DOM selection and engine positions. Text is always set with `textContent`,
 * never parsed as HTML.
 *
 * Layout of a paragraph element:
 *   [numbering label] [leaves and links] [paragraphs merged into this one] [mark] [filler]
 */

import type { Hyperlink, InlineRun, ParagraphBlock, RevisionMark, RunFormat } from "../../../_shared/office-engine/index";
import { authorColorSlot } from "./authors";
import type { ViewMode } from "./types";
import { runVisible } from "./visibility";

export const BLOCK_ID = "data-block-id";
export const BLOCK_TYPE = "data-block-type";
/** Start of a leaf in the markup text of its paragraph. */
export const LEAF_START = "data-s";
/** Length of a leaf in the markup text. */
export const LEAF_LENGTH = "data-l";
/** A leaf that stands for exactly one character and has no editable text (object, line break). */
export const LEAF_ATOM = "data-atom";
/** Decoration that is not document text (numbering label, paragraph mark). */
export const SKIP = "data-doc-skip";
/** Trailing decoration; merged paragraphs are placed before the first one. */
export const TAIL = "data-doc-tail";
export const FILLER = "data-doc-filler";

const OBJECT = "\uFFFC";
const SAFE_LINK = /^(?:https?:|mailto:)/i;

export interface HighlightSpan {
  from: number;
  to: number;
  layer: string;
  id: string | null;
  className: string | null;
}

export interface ParagraphRenderContext {
  mode: ViewMode;
  highlights: readonly HighlightSpan[];
  /** Run formatting before a formatting revision, for the `original` view. */
  formatBefore(revisionId: string): Partial<RunFormat> | null;
}

const REVISION_TITLES: Record<string, string> = {
  insert: "Inserted",
  delete: "Deleted",
  moveFrom: "Moved from here",
  moveTo: "Moved here",
  format: "Formatting changed",
};

function revisionTitle(mark: RevisionMark): string {
  return `${REVISION_TITLES[mark.kind] ?? "Changed"} by ${mark.author}`;
}

/** The address a link may open, or null. Only web and mail addresses are allowed. */
export function safeHref(link: Hyperlink | null): string | null {
  const href = link?.href ?? null;
  return href !== null && SAFE_LINK.test(href.trim()) ? href.trim() : null;
}

function applyRunFormat(element: HTMLElement, format: RunFormat): void {
  const { style } = element;
  if (format.bold) style.fontWeight = "700";
  if (format.italic) style.fontStyle = "italic";
  const lines = [format.underline ? "underline" : "", format.strike ? "line-through" : ""].filter((line) => line !== "");
  if (lines.length > 0) style.textDecorationLine = lines.join(" ");
  if (format.color !== null) style.color = format.color;
  if (format.highlight !== null) style.backgroundColor = format.highlight;
  if (format.fontSizePt !== null) style.fontSize = `${format.fontSizePt}pt`;
  if (format.fontFamily !== null) style.fontFamily = `"${format.fontFamily.replace(/["\\]/g, "")}", var(--doc-font)`;
  if (format.verticalAlign !== "baseline") element.classList.add(format.verticalAlign === "superscript" ? "doc-sup" : "doc-sub");
}

function leafClasses(run: InlineRun, mode: ViewMode, highlights: readonly HighlightSpan[]): string[] {
  const classes = ["doc-run"];
  if (mode === "markup") {
    if (run.revision !== null) classes.push("doc-rev", `doc-rev-${run.revision.kind}`);
    if (run.formatRevision !== null) classes.push("doc-rev-format");
  }
  if (run.commentIds.length > 0) classes.push("doc-comment");
  if (run.field !== null) classes.push("doc-field");
  for (const highlight of highlights) {
    classes.push("doc-hl", `doc-hl-${highlight.layer}`);
    if (highlight.className !== null) classes.push(...highlight.className.split(/\s+/).filter((name) => name !== ""));
  }
  return [...new Set(classes)];
}

function decorateLeaf(leaf: HTMLElement, run: InlineRun, context: ParagraphRenderContext, highlights: readonly HighlightSpan[], start: number, length: number): void {
  leaf.className = leafClasses(run, context.mode, highlights).join(" ");
  leaf.setAttribute(LEAF_START, String(start));
  leaf.setAttribute(LEAF_LENGTH, String(length));
  if (context.mode === "markup") {
    const mark = run.revision ?? run.formatRevision;
    if (mark !== null) {
      leaf.setAttribute("data-author-color", String(authorColorSlot(mark.author)));
      leaf.title = revisionTitle(mark);
    }
    if (run.revision !== null) leaf.setAttribute("data-revision-id", run.revision.revisionId);
    if (run.formatRevision !== null) leaf.setAttribute("data-format-revision-id", run.formatRevision.revisionId);
  }
  if (run.commentIds.length > 0) leaf.setAttribute("data-comment-ids", run.commentIds.join(" "));
  if (run.field !== null) leaf.setAttribute("data-field-kind", run.field.kind);
  const ids = highlights.map((highlight) => highlight.id).filter((id): id is string => id !== null);
  if (ids.length > 0) leaf.setAttribute("data-hl-id", ids.join(" "));
}

function objectLeaf(doc: Document, run: InlineRun): HTMLElement {
  const leaf = doc.createElement("span");
  leaf.setAttribute(LEAF_ATOM, "");
  leaf.setAttribute("contenteditable", "false");
  const object = run.object;
  if (run.footnoteRef !== null) {
    const mark = doc.createElement("sup");
    mark.className = "doc-note-ref";
    mark.textContent = run.footnoteRef.label;
    mark.title = run.footnoteRef.kind === "footnote" ? `Footnote ${run.footnoteRef.label}` : `Endnote ${run.footnoteRef.label}`;
    leaf.append(mark);
    leaf.setAttribute("data-note-story", run.footnoteRef.storyId);
    leaf.setAttribute("data-object", "note");
  } else if (object?.kind === "image") {
    const box = doc.createElement("span");
    box.className = "doc-image";
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", object.altText ?? "Image");
    if (object.widthPt !== null) box.style.width = `${object.widthPt}pt`;
    if (object.heightPt !== null) box.style.height = `${object.heightPt}pt`;
    box.textContent = object.altText ?? "Image";
    leaf.append(box);
    leaf.setAttribute("data-object", "image");
  } else if (object?.kind === "break") {
    leaf.setAttribute("data-object", object.breakType === "page" ? "page-break" : "column-break");
    leaf.setAttribute("aria-label", object.breakType === "page" ? "Page break" : "Column break");
  } else {
    leaf.setAttribute("data-object", "other");
    leaf.setAttribute("aria-label", "Embedded object");
  }
  return leaf;
}

/** The highlights that cover `[start, end)` completely. */
function covering(highlights: readonly HighlightSpan[], start: number, end: number): HighlightSpan[] {
  return highlights.filter((highlight) => highlight.from <= start && highlight.to >= end);
}

/** Offsets inside a run where a new leaf must start: special characters and highlight edges. */
function cutPoints(run: InlineRun, highlights: readonly HighlightSpan[]): number[] {
  const end = run.start + run.text.length;
  const cuts = new Set<number>([run.start, end]);
  for (let at = 0; at < run.text.length; at++) {
    const character = run.text[at];
    if (character === "\t" || character === "\n" || character === OBJECT) {
      cuts.add(run.start + at);
      cuts.add(run.start + at + 1);
    }
  }
  for (const highlight of highlights) {
    if (highlight.from > run.start && highlight.from < end) cuts.add(highlight.from);
    if (highlight.to > run.start && highlight.to < end) cuts.add(highlight.to);
  }
  return [...cuts].sort((a, b) => a - b);
}

function formatOf(run: InlineRun, context: ParagraphRenderContext): RunFormat {
  if (context.mode !== "original" || run.formatRevision === null) return run;
  const before = context.formatBefore(run.formatRevision.revisionId);
  return before === null ? run : { ...run, ...before };
}

function appendRun(doc: Document, parent: HTMLElement, run: InlineRun, context: ParagraphRenderContext): HTMLElement | null {
  const cuts = cutPoints(run, context.highlights);
  const format = formatOf(run, context);
  let last: HTMLElement | null = null;
  for (let at = 0; at + 1 < cuts.length; at++) {
    const start = cuts[at] as number;
    const end = cuts[at + 1] as number;
    const text = run.text.slice(start - run.start, end - run.start);
    const highlights = covering(context.highlights, start, end);
    let leaf: HTMLElement;
    if (text === "\n") {
      leaf = doc.createElement("br");
      leaf.setAttribute(LEAF_ATOM, "");
    } else if (text === OBJECT) {
      leaf = objectLeaf(doc, run);
    } else {
      leaf = doc.createElement("span");
      leaf.textContent = text;
    }
    decorateLeaf(leaf, run, context, highlights, start, end - start);
    if (text === "\t") leaf.classList.add("doc-tab");
    if (text === OBJECT) leaf.classList.add("doc-object");
    // A note mark is raised by its own <sup>; the reference style must not raise and shrink it again.
    if (text === OBJECT && run.footnoteRef !== null) applyRunFormat(leaf, { ...format, verticalAlign: "baseline", fontSizePt: null });
    else if (text !== "\n") applyRunFormat(leaf, format);
    parent.append(leaf);
    last = leaf;
  }
  return last;
}

function linkElement(doc: Document, link: Hyperlink): HTMLElement {
  const anchor = doc.createElement("a");
  anchor.className = "doc-link";
  const href = safeHref(link);
  if (href !== null) {
    anchor.setAttribute("href", href);
    anchor.setAttribute("rel", "noopener noreferrer");
    anchor.setAttribute("target", "_blank");
  }
  if (link.anchor !== null) anchor.setAttribute("data-anchor", link.anchor);
  anchor.title = link.tooltip ?? href ?? link.anchor ?? "";
  return anchor;
}

function elementName(block: ParagraphBlock): string {
  const level = block.style.headingLevel;
  return level >= 1 && level <= 6 ? `h${level}` : "p";
}

function applyParagraphStyle(element: HTMLElement, block: ParagraphBlock, context: ParagraphRenderContext): void {
  const { style } = block;
  const css = element.style;
  if (style.alignment !== "left") css.textAlign = style.alignment;
  if (style.indentLeftPt !== 0) css.marginLeft = `${style.indentLeftPt}pt`;
  if (style.indentRightPt !== 0) css.marginRight = `${style.indentRightPt}pt`;
  if (style.firstLineIndentPt !== 0) css.textIndent = `${style.firstLineIndentPt}pt`;
  css.marginTop = `${style.spacingBeforePt}pt`;
  css.marginBottom = `${style.spacingAfterPt}pt`;
  if (style.lineSpacing !== null) css.lineHeight = String(Math.round(style.lineSpacing * 1.2 * 100) / 100);
  if (style.headingLevel > 0) element.setAttribute("data-heading", String(style.headingLevel));
  if (style.headingLevel > 6) {
    element.setAttribute("role", "heading");
    element.setAttribute("aria-level", String(style.headingLevel));
  }
  if (style.styleId !== null) element.setAttribute("data-style-id", style.styleId);
  if (style.pageBreakBefore) element.classList.add("doc-page-break-before");
  if (context.mode !== "markup") return;
  const marks = [block.markRevision, block.formatRevision, ...block.runs.flatMap((run) => [run.revision, run.formatRevision])];
  const first = marks.find((mark): mark is RevisionMark => mark !== null);
  if (first === undefined) return;
  // The bar in the margin of a paragraph that carries any tracked change.
  element.classList.add("doc-changed");
  element.setAttribute("data-author-color", String(authorColorSlot(first.author)));
  if (block.formatRevision !== null) {
    element.classList.add("doc-changed-format");
    element.setAttribute("data-format-revision-id", block.formatRevision.revisionId);
  }
}

export function renderParagraph(doc: Document, block: ParagraphBlock, context: ParagraphRenderContext): HTMLElement {
  const element = doc.createElement(elementName(block));
  element.className = "doc-p";
  element.setAttribute(BLOCK_ID, block.id);
  element.setAttribute(BLOCK_TYPE, "paragraph");
  applyParagraphStyle(element, block, context);

  if (block.numbering !== null && block.numbering.text !== "") {
    const label = doc.createElement("span");
    label.className = "doc-num";
    label.setAttribute(SKIP, "");
    label.setAttribute("contenteditable", "false");
    label.textContent = block.numbering.text;
    // The label sits in the hanging indent, so the text starts at the paragraph indent.
    if (block.style.firstLineIndentPt < 0) label.style.minWidth = `${-block.style.firstLineIndentPt}pt`;
    element.append(label);
  }

  let link: { key: string; element: HTMLElement } | null = null;
  let lastLeaf: HTMLElement | null = null;
  for (const run of block.runs) {
    if (!runVisible(run, context.mode)) continue;
    let parent: HTMLElement = element;
    if (run.hyperlink === null) {
      link = null;
    } else {
      const key = JSON.stringify(run.hyperlink);
      if (link === null || link.key !== key) {
        link = { key, element: linkElement(doc, run.hyperlink) };
        element.append(link.element);
      }
      parent = link.element;
    }
    lastLeaf = appendRun(doc, parent, run, context) ?? lastLeaf;
  }

  if (context.mode === "markup" && block.markRevision !== null) {
    const mark = doc.createElement("span");
    mark.className = `doc-mark doc-rev doc-rev-${block.markRevision.kind}`;
    mark.setAttribute(SKIP, "");
    mark.setAttribute(TAIL, "");
    mark.setAttribute("data-revision-id", block.markRevision.revisionId);
    mark.setAttribute("data-author-color", String(authorColorSlot(block.markRevision.author)));
    mark.setAttribute("contenteditable", "false");
    mark.title = revisionTitle(block.markRevision);
    mark.textContent = "\u00B6";
    element.append(mark);
  }
  // An empty line needs a <br> to have height and to hold the caret; so does a line that ends in a line break.
  if (lastLeaf === null || lastLeaf.tagName === "BR") {
    const filler = doc.createElement("br");
    filler.setAttribute(FILLER, "");
    filler.setAttribute(TAIL, "");
    element.append(filler);
  }
  return element;
}
