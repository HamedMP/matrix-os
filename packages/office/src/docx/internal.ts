/**
 * Internal API of the document model, for the other modules of `src/docx/`
 * (editing, revision resolution, compare, export). Not part of `DocxModule`.
 *
 * ## The model in one paragraph
 *
 * The lossless XML trees of `word/document.xml` and the other parts ARE the
 * document. `DocxIndex` is a thin index over them: it never holds a second
 * tree. To edit, change the XML with the helpers of `../xml/index.js` and
 * call `index.markDirty(element)`. Everything else (block list, paragraph
 * text, numbering labels, revisions, the view model) is derived again from
 * the trees on the next read.
 *
 * ```ts
 * const index = getDocxIndex(document);            // from a handle
 * const record = index.requireBlock(blockId, "paragraph"); // stale_reference / invalid_operation
 * const { point } = splitRunAt(index, { blockId, offset });
 * // insert into point.parent before point.before, then:
 * index.markDirty(record.element);
 * ```
 *
 * ## Identity
 *
 * - Block ids, revision ids and field ids live on the XML element object
 *   (`index.store.tags`). An element keeps its ids for the life of the handle
 *   however the tree around it changes, and through `snapshot`/`restore`.
 * - A new `w:p`, `w:tbl` or section `w:sectPr` gets a fresh id the first time
 *   the structure is read after `markDirty`: `index.blockOf(element)?.id`.
 *   Ids are never reused. `cloneNode` copies carry no identity; use
 *   `index.adoptIdentity(from, to)` when a rebuilt element replaces another.
 *   Remove `w14:paraId` from a copied paragraph (or set
 *   `index.allocateParaId()`): two paragraphs must not share one.
 * - `splitParagraph`: keep the original `w:p` as the first half, so it keeps
 *   its block id, and create a new `w:p` for the second half.
 *
 * ## Blocks and stories: `index.structure`
 *
 * - `index.block(id)` / `index.requireBlock(id, type?)` give a `BlockRecord`:
 *   `element` (the `w:p`, the `w:tbl`, or for a section break the `w:sectPr`
 *   inside the last paragraph of the section), `storyId`, `container` (the
 *   logical parent: `w:body`, `w:hdr`, `w:ftr`, `w:footnote`, `w:endnote` or
 *   a `w:tc`), `indexInContainer`, `parentTableId`, `topLevelId`.
 * - `index.blocksIn(container)` lists sibling blocks in order. Two paragraphs
 *   are siblings in the sense of `TextRange` when their `container` is the
 *   same element. Content controls (`w:sdt`) and `w:customXml` wrappers are
 *   looked through, so `element.parent` is not always `container`: insert a
 *   sibling with `insertBefore`/`insertAfter` on `element` itself.
 * - `index.story(id)` gives a `StoryRecord` with `container`, top-level
 *   `blocks` and every paragraph in document order in `paragraphs`.
 *   Story ids: `body`, `header:<part name>`, `footer:<part name>`,
 *   `footnote:<w:id>`, `endnote:<w:id>`.
 * - `tableRows(tbl)` and `rowCells(tr)` list `w:tr` and `w:tc` elements.
 *
 * ## Paragraph text: `index.scan(paragraph)`
 *
 * A `ParagraphScan` lists the paragraph's `atoms`: each `InlineAtom` is one
 * XML node that stands for one or more characters of the markup text (the
 * coordinate space of `TextPosition`): a `w:t` or `w:delText` (`kind: "text"`,
 * any length), or one character for `w:tab` (`\t`), `w:br`/`w:cr` (`\n`),
 * `w:noBreakHyphen` (U+2011), `w:softHyphen` (U+00AD) and every inline object
 * (U+FFFC: drawings, page and column breaks, note references, math, unknown
 * content). `atom.start` is its markup offset, `atom.node` the element,
 * `atom.run` its `w:r` (null for an object directly in the paragraph), and
 * `atom.context` says what surrounds it: `revisions` (enclosing `w:ins`,
 * `w:del`, `w:moveFrom`, `w:moveTo`, outermost first), `hyperlink`, `fields`
 * (the fields whose result it is part of), `deleted`, `inserted`.
 *
 * - Field codes are not text: runs between a field's begin and separator
 *   produce no atoms. Field results are ordinary atoms.
 * - `w:commentReference`, bookmark, comment-range and move-range markers are
 *   zero width; they are in `scan.markers` with their offset.
 * - `scan.marks` are the tracked changes of the paragraph mark
 *   (`w:pPr/w:rPr/w:ins|w:del|w:moveFrom|w:moveTo`; a mark one author
 *   inserted and another deleted has two) and `scan.mark` the one a reader
 *   is shown, a deletion before an insertion; `revisionsGoneInView` says
 *   whether such a mark, or a row (`rowRevisionElements`), is in a view.
 *   A cell carries `w:cellIns` and `w:cellDel` (`cellRevisionElements`);
 *   `cellGoneInView`, `rowGoneInView` and `tableGoneInView` say what a view
 *   keeps of a table, a row with no cell left and a table with no row left
 *   being gone too.
 *   `scan.propertiesChange` is
 *   the `w:pPrChange`, `scan.markFormatChange` the `w:pPr/w:rPr/w:rPrChange`,
 *   and `scan.contentSpans` and `scan.formatSpans` give the extent of every
 *   revision container and run `w:rPrChange`.
 * - A paragraph whose mark is deleted or moved away runs on into the next
 *   paragraph in the `final` view (an inserted or moved-in mark does so in
 *   `original`); `blocksText` and `rangeText` apply that rule, a scan does not.
 * - Views: `atomInView(atom, view)`; `scanText(scan, view)` (objects kept);
 *   `paragraphText(scan, view, from?, to?)` (objects dropped, markup offsets
 *   as bounds); `textSegments(scan, view)` to walk the text of a view with
 *   the atom and markup offset of every stretch; `viewToMarkupOffset` and
 *   `markupToViewOffset` to convert offsets. `final` leaves out atoms with
 *   `context.deleted`, `original` those with `context.inserted`.
 *
 * ## Positions: `./model/positions.ts`
 *
 * - `resolvePosition(index, position)` validates a `TextPosition` and returns
 *   the atom that contains it or starts at it (`atom`, `offsetInAtom`), the
 *   atom that ends at it or contains it (`before`), and the scan.
 * - `splitRunAt(index, position)` makes the position a boundary between two
 *   sibling nodes. Inside a `w:t` it splits the text and the run; both halves
 *   keep the run properties (a copied `w:rPrChange` gets a new `w:id`). It
 *   returns the runs on both sides and three `InsertionPoint`s (`parent`,
 *   `before`): `afterPrevious` (directly after the run that ends at the
 *   position, inside whatever wraps that run), `beforeNext` (directly in
 *   front of the run that starts there), and `point`, the one typed text
 *   should use: `afterPrevious`, except where a field result or a hyperlink
 *   ends, so that new text does not become part of the field or the link.
 * - `splitContainerAt(index, point)` lifts a point out of one inline wrapper
 *   (`w:ins`, `w:del`, `w:hyperlink`, …), cutting the wrapper in two unless
 *   the point is at its edge; `liftToParagraph` repeats that up to the `w:p`.
 * - None of these change the markup text, so offsets stay valid across them.
 *
 * ## Revisions: `index.revisions`
 *
 * `groups` are the logical revisions in the order of `listRevisions`. A
 * `RevisionGroup` has the public `revision` and its `members`: every XML
 * revision element with its `role` (`content`, `paragraphMark`, `tableRow`,
 * `runFormat`, `paragraphFormat`, `otherFormat`), its `owner` and `blockId`.
 * `byId` finds a group; `marks` maps a revision element to the `RevisionMark`
 * the view shows. A revision keeps its id while any of its elements remain;
 * put new revision elements next to existing ones of the same kind, author
 * and date and they join that revision. `moveName` is the `w:name` of the
 * move range markers, which a resolver has to remove with the move.
 *
 * ## Ids for new XML
 *
 * - `index.allocateAnnotationId()`: `w:id` for a new `w:ins`, `w:del`, move,
 *   property change, bookmark or range marker. Unique across all parts.
 * - `index.allocateCommentId()`: `w:id` for a new `w:comment`.
 * - `index.allocateParaId()`: `w14:paraId` / `w15:paraId`.
 * The engine never reads a clock: authors and dates come from the caller.
 *
 * ## Parts
 *
 * `index.partRoot(kind)` is the parsed root of `styles`, `numbering`,
 * `settings`, `comments`, `commentsExtended`, `footnotes`, `endnotes`,
 * `theme` or `coreProperties`, or null. `index.ensurePart(kind)` creates a
 * missing part; its relationship and content type are added on save. Edit
 * the root like any other tree and call `markDirty`. Styles and numbering are
 * resolved by `index.resolver` (`resolver.styles`, `resolver.numbering`,
 * `resolver.paragraph(p, tableStyleId)`, `resolver.numberingOf(p, tableStyleId)`,
 * `resolver.runFormat(base, rPr)`, with `tableStyleIdOf(tbl)` for a
 * paragraph in a table cell and null outside one);
 * `index.labels` holds the numbering label of every numbered `w:p`.
 * `index.package` is the OPC package for everything else (media, relationship
 * targets); changes made there are not covered by `restore`.
 *
 * ## Undo and atomic edits
 *
 * `index.snapshot()` is cheap (it copies only the units changed since the
 * last one; a unit is a top-level block, one note, one comment or one style)
 * and `index.restore(snapshot)` brings back trees, ids and parts. An engine
 * that can fail half way takes a snapshot first and restores it before it
 * throws. Element objects of a changed unit are replaced by a restore: look
 * elements up again through block ids afterwards, never keep them across it.
 *
 * ## The rule that makes all of this work
 *
 * Every change to a tree is followed by `index.markDirty(element)` on the
 * deepest attached element that contains the whole change, before the index
 * is read again. For a change inside one paragraph that is the `w:p`; after
 * inserting or removing blocks it is the new block, or the parent that lost
 * one. A change without `markDirty` is not saved and leaves stale scans.
 *
 * ## Plugging into the handle
 *
 * - `applyOps`, `acceptRevisions` and `rejectRevisions` are `DocxEngines`:
 *   functions that take the `DocxIndex` first and then the arguments of the
 *   handle method. `./index.ts` lists them in `ENGINES`.
 * - `createDocx` and `compareDocx` are `DocxFactories`. `createDocx` builds
 *   an `OpcPackage` (`createPackage`, `setPart`, `addRelationship`) and
 *   returns `finish(pkg, texts)`, where `texts` maps the part name of every
 *   XML part it wrote that the model reads (document, styles, numbering,
 *   settings, core properties, …) to its text; no await is involved.
 *   `compareDocx` gets `open`, the `openDocx` of the build.
 * - Until `./index.ts` lists a function, test it directly: an engine with
 *   `getDocxIndex(await openDocx(bytes))` or through
 *   `openDocxWith({ applyOps }, bytes)`; a factory by calling it with
 *   `documentFromPackage` or `openDocx` as its last argument.
 */

export { DocxIndex, type CreatablePartKind } from "./model/doc-index.js";
export { type DocxEngines, type DocxFactories, createDocumentHandle, getDocxIndex } from "./model/document.js";
export { documentFromPackage, openDocxWith, readPartTexts } from "./model/open.js";
export { DEFAULT_DOCX_LIMITS, type DocxLimits, type DocxOpenLimits, documentTooLarge, resolveDocxLimits } from "./model/limits.js";
export { type ElementTags, type PartSlot, PartStore, containerOf, discoverParts } from "./model/parts.js";
export {
  type BlockRecord,
  type SectionRecord,
  type StoryRecord,
  type Structure,
  expandChildren,
  paragraphSectPr,
  rowCells,
  tableRows,
} from "./model/structure.js";
export {
  type AtomKind,
  type FieldFrame,
  type InlineAtom,
  type InlineContext,
  type InlineMarker,
  OBJECT_CHAR,
  type ParagraphScan,
  type RevisionSpan,
  atomInView,
  atomIndexAt,
  paragraphMarkRevision,
  revisionsGoneInView,
  scanParagraph,
  scanText,
} from "./model/inline.js";
export type { CommentAnchor, Flow, TextPoint } from "./model/flow.js";
export {
  type InsertionPoint,
  type ResolvedPosition,
  type RunBoundary,
  type TextSegment,
  liftToParagraph,
  markupToViewOffset,
  resolvePosition,
  splitContainerAt,
  splitRunAt,
  textSegments,
  viewToMarkupOffset,
} from "./model/positions.js";
export { blocksText, paragraphText, rangeText } from "./model/plain-text.js";
export {
  type RevisionGroup,
  type RevisionIndex,
  type RevisionMember,
  type RevisionMemberRole,
  cellGoneInView,
  cellRevisionElements,
  rowGoneInView,
  rowRevisionElement,
  rowRevisionElements,
  tableGoneInView,
} from "./model/revisions.js";
export { FormatResolver, type ResolvedParagraph, tableStyleIdOf } from "./model/resolve.js";
export {
  type ParagraphProps,
  type RunProps,
  type ThemeFonts,
  completeRunFormat,
  hexColor,
  readParagraphProps,
  readRunProps,
} from "./model/props.js";
export { type StyleRecord, StyleSheet, displayStyleName, headingLevelOfName } from "./model/styles.js";
export { type LevelDefinition, NumberingDefinitions } from "./model/numbering.js";
export { formatCounter, toLetters, toRoman } from "./model/number-format.js";
export { type LabelIndex, type ParagraphLabel, buildLabelIndex, buildOutline, typedLabel } from "./model/labels.js";
export { commentElements, listComments } from "./model/comments.js";
export { findCrossReferences } from "./model/crossrefs.js";
export { findDefinedTerms } from "./model/terms.js";
export { type ParsedField, hyperlinkOfField, parseFieldInstruction } from "./model/fields.js";
export { buildBlock, buildStory, buildView, fieldInfoOf, readTrackRevisions } from "./model/view.js";
export {
  type DocxPartKind,
  type DocxSlotKind,
  PART_KINDS,
  REVISION_CONTAINERS,
  WORD_NAMESPACES,
  ancestor,
  attr,
  childToggle,
  childVal,
  closest,
  elementChildren,
  firstChild,
  intAttr,
  isOn,
  twipsToPt,
} from "./model/names.js";
