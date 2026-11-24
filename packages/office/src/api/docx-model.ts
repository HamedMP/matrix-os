/**
 * Contract: the serialisable view model of a `.docx` document.
 * Produced by the handle in `./docx.ts`; implemented by `src/docx/`.
 *
 * Everything here is plain JSON-safe data (no functions, no cycles, no
 * `undefined` inside arrays) so a view can cross `postMessage` or HTTP.
 *
 * Units: every length is in points; font sizes are in points.
 * Colours are `#rrggbb` in lower case.
 */

/**
 * Opaque id of a block (paragraph, table or section break).
 *
 * - Stable for the life of the handle: it survives edits to other blocks,
 *   edits inside the block, accept/reject, and `snapshot`/`restore`.
 * - Unique across all stories of the document.
 * - Deterministic: opening the same bytes twice gives the same ids.
 * - Never reused within one handle after its block is removed.
 *
 * Ids should survive save and reopen where the file allows it (for example by
 * using `w14:paraId`), but a caller that holds an id across a reopen must
 * also check the text it expects and treat a mismatch as `stale_reference`.
 */
export type BlockId = string;

/** Opaque id of a story; stable and deterministic like {@link BlockId}. */
export type StoryId = string;

/**
 * Id of one logical tracked change. Unique in the document and stable for the
 * life of the handle. Not the `w:id` of the underlying elements, which is
 * neither unique nor grouped.
 */
export type RevisionId = string;

/** Id of a comment, unique in the document and stable across save and reopen. */
export type CommentId = string;

/**
 * A position in the text of a paragraph.
 *
 * `offset` counts UTF-16 code units in the paragraph's markup text, which is
 * `ParagraphBlock.text`: the text of all runs in order, including text inside
 * tracked deletions and insertions. `0` is before the first character and
 * `text.length` is after the last one. Characters that stand for inline
 * content are listed on {@link InlineRun.text}.
 */
export interface TextPosition {
  blockId: BlockId;
  offset: number;
}

/**
 * A range of text, `start` inclusive and `end` exclusive. `start` must not be
 * after `end` in document order. Both ends are in the same story, and either
 * in the same paragraph or in two paragraphs that are siblings (both directly
 * in the body, or both in the same table cell or note).
 */
export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

/** Which text a reader sees. `markup` is the coordinate space of {@link TextPosition}. */
export type DocxTextView =
  /** Pending insertions included, pending deletions excluded: the document if all revisions were accepted. */
  | "final"
  /** Pending insertions excluded, pending deletions included: the document if all were rejected. */
  | "original"
  /** Both included. */
  | "markup";

export type RevisionKind = "insert" | "delete" | "moveFrom" | "moveTo" | "format";

/** The tracked change a run, paragraph mark or table row belongs to. */
export interface RevisionMark {
  revisionId: RevisionId;
  kind: RevisionKind;
  author: string;
  /** ISO 8601 as stored in the file, or null when the file has none. */
  date: string | null;
}

export interface Hyperlink {
  /** External address, or null for a link inside the document. */
  href: string | null;
  /** Bookmark name for a link inside the document. */
  anchor: string | null;
  tooltip: string | null;
}

export interface NoteReference {
  kind: "footnote" | "endnote";
  /** The story that holds the note. */
  storyId: StoryId;
  /** The mark as displayed, for example `1` or `iv`. */
  label: string;
}

export type FieldKind = "ref" | "pageRef" | "noteRef" | "hyperlink" | "toc" | "page" | "numPages" | "date" | "other";

/** A field whose displayed result the run is part of. */
export interface FieldInfo {
  /** Same for every run of one field; unique in the document. */
  fieldId: string;
  kind: FieldKind;
  /** The field code as written, trimmed, for example `REF _Ref123 \r \h`. */
  instruction: string;
  /** Bookmark the field points at (`ref`, `pageRef`, `noteRef`), else null. */
  targetBookmark: string | null;
  /** The block that holds that bookmark, or null when it cannot be resolved. */
  targetBlockId: BlockId | null;
}

/** Inline content that is not text. It takes exactly one U+FFFC in the run text. */
export type InlineObject =
  | { kind: "image"; partName: string | null; contentType: string | null; widthPt: number | null; heightPt: number | null; altText: string | null }
  | { kind: "break"; breakType: "page" | "column" }
  | { kind: "noteReference" }
  | { kind: "other"; elementName: string };

/** Character formatting. In a view every field is resolved through the style chain. */
export interface RunFormat {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** Null means automatic. */
  color: string | null;
  /** Highlight or character shading, or null for none. */
  highlight: string | null;
  fontSizePt: number | null;
  fontFamily: string | null;
  verticalAlign: "baseline" | "superscript" | "subscript";
}

/**
 * A maximal stretch of a paragraph with the same formatting and the same
 * marks. Runs partition the paragraph: `start` of a run is the end of the one
 * before, and the run texts concatenated are `ParagraphBlock.text`.
 */
export interface InlineRun extends RunFormat {
  /** Offset of the run in the paragraph's markup text. */
  start: number;
  /**
   * Never empty. A tab is `\t`, a line break `\n`, a non-breaking hyphen
   * U+2011, a soft hyphen U+00AD. Every other inline object (image, page
   * break, note reference mark, unknown content) is one U+FFFC described by
   * `object`. Field codes are not text; the field result is.
   */
  text: string;
  hyperlink: Hyperlink | null;
  /** Set on the single U+FFFC run of a footnote or endnote reference. */
  footnoteRef: NoteReference | null;
  /** Comments whose range covers this run, outermost first. */
  commentIds: CommentId[];
  field: FieldInfo | null;
  /** Content revision: `insert`, `delete`, `moveFrom` or `moveTo`. */
  revision: RevisionMark | null;
  /** Formatting revision (`kind: "format"`); a run can carry both marks. */
  formatRevision: RevisionMark | null;
  object: InlineObject | null;
}

export type ParagraphAlignment = "left" | "center" | "right" | "justify";

/** Paragraph formatting resolved through the style chain and numbering level. */
export interface ResolvedParagraphStyle {
  styleId: string | null;
  /** Display name of the style, for example `Heading 2`. */
  styleName: string | null;
  /** 1 to 9 for a heading (outline level), 0 for body text. */
  headingLevel: number;
  alignment: ParagraphAlignment;
  indentLeftPt: number;
  indentRightPt: number;
  /** First-line indent; negative for a hanging indent. */
  firstLineIndentPt: number;
  spacingBeforePt: number;
  spacingAfterPt: number;
  /** Line spacing as a multiple of single spacing, or null for exact or at-least spacing. */
  lineSpacing: number | null;
  pageBreakBefore: boolean;
  keepWithNext: boolean;
}

export type NumberingFormat =
  | "decimal"
  | "lowerLetter"
  | "upperLetter"
  | "lowerRoman"
  | "upperRoman"
  | "bullet"
  | "none"
  | "other";

/** The automatic number or bullet of a paragraph, computed in document order. */
export interface NumberingLabel {
  /** The label as displayed, for example `3.1`, `(a)`, `Article IV` or a bullet character. */
  text: string;
  /** 0 to 8. */
  level: number;
  /** The numbering instance (`w:numId`). */
  numId: string;
  format: NumberingFormat;
  /** Counter values for levels 0 to `level`, for example `[3, 1]`. Empty for bullets. */
  counters: number[];
}

export interface ParagraphBlock {
  type: "paragraph";
  id: BlockId;
  style: ResolvedParagraphStyle;
  numbering: NumberingLabel | null;
  /** The markup text: every run text concatenated. See {@link TextPosition}. */
  text: string;
  runs: InlineRun[];
  /**
   * Revision of the paragraph mark: `insert` when the paragraph break was
   * inserted, `delete` when it will merge with the next paragraph.
   */
  markRevision: RevisionMark | null;
  /** Paragraph formatting revision (`kind: "format"`). */
  formatRevision: RevisionMark | null;
  /** Names of the bookmarks that start in this paragraph. */
  bookmarks: string[];
}

export interface TableCell {
  /** Never empty: a cell holds at least one paragraph. */
  blocks: DocxBlock[];
  /** Grid columns spanned. */
  colSpan: number;
  /** Rows spanned by a vertical merge; 1 when not merged. */
  rowSpan: number;
  /** True for a cell that continues a vertical merge from the row above (not drawn). */
  mergedAbove: boolean;
  widthPt: number | null;
  /** Cell shading, or null. */
  fill: string | null;
}

export interface TableRow {
  cells: TableCell[];
  /** Repeats as a header row on each page. */
  isHeader: boolean;
  /** `insert` or `delete` when the whole row is a tracked change. */
  revision: RevisionMark | null;
}

export interface TableBlock {
  type: "table";
  id: BlockId;
  rows: TableRow[];
  /** Widths of the grid columns. */
  columnWidthsPt: number[];
}

/** A section break between two blocks. The last section has no break; see `DocxView.sections`. */
export interface SectionBreakBlock {
  type: "sectionBreak";
  id: BlockId;
  /** Index into `DocxView.sections` of the section that ends here. */
  sectionIndex: number;
  /** How the next section starts. */
  breakType: "nextPage" | "continuous" | "evenPage" | "oddPage" | "nextColumn";
}

export type DocxBlock = ParagraphBlock | TableBlock | SectionBreakBlock;

export type HeaderFooterType = "default" | "first" | "even";

export interface DocxSection {
  index: number;
  pageWidthPt: number;
  pageHeightPt: number;
  orientation: "portrait" | "landscape";
  marginTopPt: number;
  marginRightPt: number;
  marginBottomPt: number;
  marginLeftPt: number;
  columns: number;
  /** Stories used by this section, by type. A section without its own header inherits the previous one. */
  headers: Partial<Record<HeaderFooterType, StoryId>>;
  footers: Partial<Record<HeaderFooterType, StoryId>>;
}

export type StoryKind = "body" | "header" | "footer" | "footnote" | "endnote";

/** One flow of blocks: the body, one header or footer part, or one note. */
export interface DocxStory {
  id: StoryId;
  kind: StoryKind;
  /** Human-readable, for example `Body`, `Header (first page)`, `Footnote 3`. */
  label: string;
  blocks: DocxBlock[];
}

export interface DocxView {
  body: DocxStory;
  /** One story per header part, in the order the sections reference them. */
  headers: DocxStory[];
  footers: DocxStory[];
  /** One story per footnote, in document order of their references. Separators are left out. */
  footnotes: DocxStory[];
  endnotes: DocxStory[];
  sections: DocxSection[];
  /** The `trackRevisions` setting of the file. */
  trackRevisions: boolean;
  revisionCount: number;
  commentCount: number;
}

/** Which part of the document a revision changes. */
export type RevisionScope =
  /** Text and inline content, possibly across paragraph marks. */
  | "text"
  /** Run formatting. */
  | "runFormat"
  /** Paragraph formatting or style. */
  | "paragraphFormat"
  /** A whole table row. */
  | "tableRow";

/**
 * One logical tracked change.
 *
 * Grouping rule: neighbouring revision elements of the same kind, author and
 * date in one story form a single revision, also across paragraph marks that
 * carry the same revision. Two inserted paragraphs typed in one edit are one
 * revision; a replacement is two revisions (`delete` and `insert`) that name
 * each other in `pairedWith`; a move is a `moveFrom` and a `moveTo` that name
 * each other.
 */
export interface Revision {
  id: RevisionId;
  kind: RevisionKind;
  scope: RevisionScope;
  author: string;
  date: string | null;
  storyId: StoryId;
  /** Blocks the revision touches, in document order; never empty. */
  blockIds: BlockId[];
  /** The affected text in markup coordinates, or null for `tableRow` and `paragraphFormat`. */
  range: TextRange | null;
  /** The inserted, deleted or moved text (paragraph marks as `\n`), or the text whose formatting changed. */
  text: string;
  /** For `format`: the properties that changed, before and after. Null otherwise. */
  formatChange: { before: Partial<RunFormat> & Partial<ParagraphStylePatch>; after: Partial<RunFormat> & Partial<ParagraphStylePatch> } | null;
  /** The other half of a replacement or move, or null. */
  pairedWith: RevisionId | null;
}

/** Paragraph properties an edit can set. Used by `setParagraphStyle` and in `Revision.formatChange`. */
export interface ParagraphStylePatch {
  /** A style id that exists in the document; unknown ids throw `invalid_operation`. */
  styleId: string | null;
  /** 1 to 9 applies the built-in heading style of that level (created when missing); 0 applies the default paragraph style. Wins over `styleId`. */
  headingLevel: number;
  alignment: ParagraphAlignment;
  indentLeftPt: number;
  indentRightPt: number;
  firstLineIndentPt: number;
  spacingBeforePt: number;
  spacingAfterPt: number;
}

export interface DocxComment {
  id: CommentId;
  /** The comment this one replies to, or null for the first comment of a thread. */
  parentId: CommentId | null;
  author: string;
  initials: string | null;
  date: string | null;
  /** Plain text; paragraphs separated by `\n`. */
  text: string;
  /** The range the thread is anchored to, or null when the anchor is gone. Replies share the parent's range. */
  range: TextRange | null;
  /** The anchored text in the `final` view. */
  anchorText: string;
  /** True when the thread is marked as done. A reply has the value of its thread. */
  resolved: boolean;
}

export interface OutlineItem {
  blockId: BlockId;
  /** 1 to 9. */
  level: number;
  /** Heading text in the `final` view, without the numbering label. */
  text: string;
  numberingLabel: string | null;
}

/**
 * A term the document defines: quoted or bold text followed by `means`,
 * `shall mean`, `has the meaning` or a similar defining phrase.
 */
export interface DefinedTerm {
  /** The term without its quotation marks. */
  term: string;
  /** The definition: the text of the defining sentence or paragraph after the term, in the `final` view. */
  definition: string;
  /** The paragraph that defines the term. */
  blockId: BlockId;
  /** The range of the term itself. */
  range: TextRange;
  marker: "quoted" | "bold";
}

export interface CrossReference {
  blockId: BlockId;
  range: TextRange;
  /** The reference as written, for example `Clause 3.1` or `Section 4(b)`. */
  text: string;
  /** `field` for a REF or PAGEREF field; `text` for a typed reference matched against numbering labels. */
  source: "field" | "text";
  /** The paragraph referred to, or null when it cannot be found. */
  targetBlockId: BlockId | null;
  targetLabel: string | null;
  /** The start of the target paragraph in the `final` view, for a preview; at most 240 characters. */
  targetText: string | null;
  /** True when no target was found. */
  broken: boolean;
}

/** Core properties of the package. A missing property is null. */
export interface DocxProperties {
  title: string | null;
  creator: string | null;
  lastModifiedBy: string | null;
  created: string | null;
  modified: string | null;
}
