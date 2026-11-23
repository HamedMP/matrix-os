/**
 * The runs of one paragraph as HTML. Runs are grouped from the outside in:
 * hyperlink, tracked change (in `markup` only), comment anchors; each run
 * then wraps its text in the semantic elements of its formatting.
 */

import type { DocxTextView, InlineRun, RevisionMark } from "../../api/docx-model.js";
import { escapeHtml, hyperlinkHref, isHexColor, isMonospace, safeToken } from "./escape.js";

/** State shared by the whole export: note references seen, in order. */
export interface InlineContext {
  readonly view: DocxTextView;
  /** Story id of each referenced note, in reference order, with the fragment id of its first reference. */
  readonly noteRefs: Map<string, { refId: string; label: string; kind: "footnote" | "endnote" }>;
  refCounter: number;
}

/** The data attributes of a revision mark, with the given attribute prefix. */
export function revisionAttrs(mark: RevisionMark, prefix = "data-revision"): string {
  let attrs = ` ${prefix}-id="${escapeHtml(mark.revisionId)}" ${prefix}-kind="${escapeHtml(mark.kind)}"`;
  attrs += ` ${prefix}-author="${escapeHtml(mark.author)}"`;
  if (mark.date !== null) attrs += ` ${prefix}-date="${escapeHtml(mark.date)}"`;
  return attrs;
}

/** Line breaks, tabs and the placeholder of an inline object: the characters of run text that are not written as text. */
const TEXT_SPECIAL = /[\n\t\uFFFC]/g;

function textHtml(text: string): string {
  // The stretches between special characters are escaped whole; a run can be megabytes long.
  let html = "";
  let from = 0;
  TEXT_SPECIAL.lastIndex = 0;
  for (let match = TEXT_SPECIAL.exec(text); match !== null; match = TEXT_SPECIAL.exec(text)) {
    if (match.index > from) html += escapeHtml(text.slice(from, match.index));
    if (match[0] === "\n") html += "<br>";
    else if (match[0] === "\t") html += '<span class="tab">\t</span>';
    from = match.index + 1;
  }
  return from === 0 ? escapeHtml(text) : html + escapeHtml(text.slice(from));
}

function objectHtml(run: InlineRun, context: InlineContext): string {
  if (run.footnoteRef !== null) {
    const note = run.footnoteRef;
    const target = `note-${safeToken(note.storyId)}`;
    context.refCounter += 1;
    const refId = `noteref-${context.refCounter}`;
    if (!context.noteRefs.has(note.storyId)) context.noteRefs.set(note.storyId, { refId, label: note.label, kind: note.kind });
    return (
      `<sup class="note-ref note-ref-${note.kind}"><a href="#${target}" id="${refId}" role="doc-noteref">` +
      `${escapeHtml(note.label)}</a></sup>`
    );
  }
  const object = run.object;
  if (object === null) return "";
  switch (object.kind) {
    case "image": {
      const label = object.altText === null || object.altText === "" ? "Image" : object.altText;
      return `<span class="docx-image" role="img" aria-label="${escapeHtml(label)}">[${escapeHtml(label)}]</span>`;
    }
    case "break":
      return `<span class="docx-break docx-break-${object.breakType === "page" ? "page" : "column"}" role="separator"></span>`;
    default:
      return "";
  }
}

function runHtml(run: InlineRun, context: InlineContext): string {
  let html = run.object !== null || run.footnoteRef !== null ? objectHtml(run, context) : textHtml(run.text);
  if (html === "") return "";
  if (isMonospace(run.fontFamily)) html = `<code>${html}</code>`;
  if (run.verticalAlign === "superscript" && run.footnoteRef === null) html = `<sup>${html}</sup>`;
  if (run.verticalAlign === "subscript") html = `<sub>${html}</sub>`;
  if (run.strike) html = `<s>${html}</s>`;
  if (run.underline && run.hyperlink === null) html = `<u>${html}</u>`;
  if (run.italic) html = `<em>${html}</em>`;
  if (run.bold) html = `<strong>${html}</strong>`;
  let style = "";
  if (isHexColor(run.color) && run.hyperlink === null) style += `color:${run.color.toLowerCase()};`;
  if (isHexColor(run.highlight)) style += `background-color:${run.highlight.toLowerCase()};`;
  if (style !== "") html = `<span style="${style}">${html}</span>`;
  return html;
}

/** Splits `items` into maximal stretches with the same key. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): T[][] {
  const groups: T[][] = [];
  let last: string | null = null;
  for (const item of items) {
    const current = key(item);
    if (last !== null && current === last) (groups[groups.length - 1] as T[]).push(item);
    else groups.push([item]);
    last = current;
  }
  return groups;
}

function commentLayer(runs: readonly InlineRun[], context: InlineContext): string {
  return groupBy(runs, (run) => run.commentIds.join(" "))
    .map((group) => {
      const inner = group.map((run) => runHtml(run, context)).join("");
      const ids = (group[0] as InlineRun).commentIds;
      if (ids.length === 0 || inner === "") return inner;
      return `<span class="comment-anchor" data-comment-ids="${escapeHtml(ids.join(" "))}">${inner}</span>`;
    })
    .join("");
}

function revisionLayer(runs: readonly InlineRun[], context: InlineContext): string {
  if (context.view !== "markup") return commentLayer(runs, context);
  const key = (run: InlineRun): string => `${run.revision?.revisionId ?? ""}\u0000${run.formatRevision?.revisionId ?? ""}`;
  return groupBy(runs, key)
    .map((group) => {
      const first = group[0] as InlineRun;
      let inner = commentLayer(group, context);
      if (inner === "") return "";
      if (first.formatRevision !== null) {
        inner = `<span class="rev rev-format"${revisionAttrs(first.formatRevision)}>${inner}</span>`;
      }
      const mark = first.revision;
      if (mark === null) return inner;
      const removal = mark.kind === "delete" || mark.kind === "moveFrom";
      const tag = removal ? "del" : "ins";
      const kindClass = mark.kind === "moveFrom" ? "rev-move-from" : mark.kind === "moveTo" ? "rev-move-to" : `rev-${mark.kind}`;
      return `<${tag} class="rev ${kindClass}"${revisionAttrs(mark)}>${inner}</${tag}>`;
    })
    .join("");
}

/** The HTML of a paragraph's runs. */
export function runsHtml(runs: readonly InlineRun[], context: InlineContext): string {
  const key = (run: InlineRun): string =>
    run.hyperlink === null ? "" : `${run.hyperlink.href ?? ""}\u0000${run.hyperlink.anchor ?? ""}`;
  return groupBy(runs, key)
    .map((group) => {
      const inner = revisionLayer(group, context);
      const link = (group[0] as InlineRun).hyperlink;
      const href = hyperlinkHref(link);
      if (href === null || inner === "") return inner;
      const external = !href.startsWith("#");
      const rel = external ? ' rel="noopener noreferrer nofollow"' : "";
      return `<a href="${escapeHtml(href)}"${rel}>${inner}</a>`;
    })
    .join("");
}
