/**
 * Contract: the `.docx` document handle. Implemented by `src/docx/index.ts`.
 *
 * Type-only. The view model is in `./docx-model.ts` and the edit operations
 * in `./docx-ops.ts`; both are re-exported here. Each function type is
 * implemented as a value export with the camelCase name given in
 * {@link DocxModule}.
 *
 * The handle owns an OPC package and the parsed XML of the parts it
 * understands. Everything else in the package is kept byte for byte, and a
 * document that is opened and saved without edits has byte-identical parts.
 * All methods except `save` are synchronous.
 */

import type { OpcPackage, ZipLimits } from "./opc.js";
import type {
  BlockId,
  CrossReference,
  DefinedTerm,
  DocxBlock,
  DocxComment,
  DocxProperties,
  DocxStory,
  DocxTextView,
  DocxView,
  OutlineItem,
  ParagraphStylePatch,
  Revision,
  RevisionId,
  StoryId,
  TextRange,
} from "./docx-model.js";
import type { ApplyOptions, ApplyResult, DocxOp, InsertableText, ResolveRevisionsResult } from "./docx-ops.js";

export type * from "./docx-model.js";
export type * from "./docx-ops.js";

/**
 * An immutable copy of the whole document state, for undo. Opaque: only the
 * handle that made it can restore it. Holding many snapshots must be cheap
 * (share unchanged structure rather than copying the package).
 */
export interface DocxSnapshot {
  readonly kind: "docx-snapshot";
}

export interface PlainTextOptions {
  /** Default: the whole body story. */
  range?: TextRange;
  /** A story other than the body. Ignored when `range` is given. */
  storyId?: StoryId;
  /** Default `final`. */
  view?: DocxTextView;
}

export interface DocxDocument {
  /** The underlying package, for parts the document model does not cover. Edits made here bypass the model. */
  readonly package: OpcPackage;

  /** The whole document as plain data. Build it once, then refresh with `getBlock` after each edit. */
  getView(): DocxView;
  /**
   * One block by id: a top-level block or one nested in a table cell.
   * Null when the id is unknown or its block was removed.
   */
  getBlock(blockId: BlockId): DocxBlock | null;
  /** One story by id, or null. */
  getStory(storyId: StoryId): DocxStory | null;
  getProperties(): DocxProperties;

  /**
   * Applies operations in order. Each operation sees the document as the
   * previous ones left it, so to apply several edits that were computed
   * against one state, order them from the end of the document to the start.
   *
   * All or nothing: when one operation fails validation the call throws an
   * `OfficeError` and the document is unchanged.
   */
  applyOps(ops: readonly DocxOp[], options: ApplyOptions): ApplyResult;

  /** Whether the file asks editors to track changes (`w:trackRevisions`). */
  getTrackRevisions(): boolean;
  /** Sets that flag in the saved file. It does not change how `applyOps` behaves. */
  setTrackRevisions(enabled: boolean): void;

  /** Pending tracked changes of all stories in document order, body first. */
  listRevisions(): Revision[];
  /**
   * Accepts revisions: insertions become normal content, deletions are
   * removed, new formatting is kept. Resolving one half of a move resolves
   * the other half too. An unknown id throws `stale_reference` and nothing
   * changes. `"all"` on a document without revisions is a no-op.
   */
  acceptRevisions(ids: readonly RevisionId[] | "all"): ResolveRevisionsResult;
  /** Rejects revisions: insertions are removed, deletions restored, old formatting restored. */
  rejectRevisions(ids: readonly RevisionId[] | "all"): ResolveRevisionsResult;

  /** All comments in document order of their anchors; replies follow their parent, oldest first. */
  listComments(): DocxComment[];

  /** Headings of the body in document order. */
  getOutline(): OutlineItem[];
  /** Defined terms of the body in document order. */
  getDefinedTerms(): DefinedTerm[];
  /** Cross-references of the body in document order. */
  getCrossReferences(): CrossReference[];
  /**
   * Plain text. Paragraphs end with `\n`; table cells are separated by `\t`
   * and rows by `\n`; U+FFFC objects are left out; numbering labels are not
   * included.
   */
  getPlainText(options?: PlainTextOptions): string;

  /** Captures the current state. */
  snapshot(): DocxSnapshot;
  /**
   * Returns to a captured state. Block, story, revision and comment ids that
   * were valid when the snapshot was taken are valid again. A snapshot from
   * another handle throws `invalid_argument`.
   */
  restore(snapshot: DocxSnapshot): void;

  /** Serialises the document. The handle stays usable. */
  save(): Promise<Uint8Array>;
}

/** A paragraph for `createDocx`: plain text, or text with paragraph properties. */
export type NewParagraph = InsertableText | { text: InsertableText; style?: Partial<ParagraphStylePatch> };

export interface CreateDocxOptions {
  title?: string;
  /** Stored as creator and last modifier. */
  author?: string;
  /** ISO 8601 creation time, supplied by the caller. Omitted from the file when absent. */
  date?: string;
  /** Initial body content. Default: one empty paragraph. */
  paragraphs?: NewParagraph[];
}

export interface CompareOptions {
  /** Author of the generated revisions. */
  author: string;
  /** ISO 8601 timestamp of the generated revisions. */
  date: string;
  /** Report relocated paragraphs as moves instead of a deletion and an insertion. Default true. */
  detectMoves?: boolean;
  limits?: Partial<ZipLimits>;
}

/**
 * Opens a `.docx`. Throws the errors of `openPackage`, `unsupported_format`
 * when the package is not a word-processing document, and `corrupt_package`
 * or `malformed_xml` when a required part is missing or broken.
 */
export type OpenDocx = (bytes: Uint8Array, limits?: Partial<ZipLimits>) => Promise<DocxDocument>;

/**
 * Creates a new document with the default styles (Normal, Heading 1 to 9),
 * an A4 portrait section and the given paragraphs. The result opens in
 * independent word processors.
 */
export type CreateDocx = (options?: CreateDocxOptions) => DocxDocument;

/**
 * Compares two versions and returns a new document whose differences from
 * `original` are native tracked revisions by `options.author`:
 * text only in `revised` is an insertion, text only in `original` a deletion,
 * relocated paragraphs a move. Accepting everything gives the text of
 * `revised`; rejecting everything gives the text of `original`.
 *
 * The result is built on the package of `original` (its styles, numbering
 * and settings). Revisions already pending in an input are treated as
 * accepted for the comparison. The body, the notes both versions refer to at
 * the same place, and the headers and footers of the same section and type
 * are compared; a header or footer only one version has is taken from
 * `original`. Formatting that differs on unchanged text is a formatting
 * revision. The result is checked against the texts of both inputs before it
 * is returned, and neither input is modified.
 *
 * `compareDocxDetailed` of `src/docx/index.ts` returns the same document
 * with a summary of its revisions (counts by kind, each change classified as
 * substantive or formatting only).
 */
export type CompareDocx = (
  original: Uint8Array | DocxDocument,
  revised: Uint8Array | DocxDocument,
  options: CompareOptions,
) => Promise<DocxDocument>;

/** The value exports of `src/docx/index.ts`. */
export interface DocxModule {
  openDocx: OpenDocx;
  createDocx: CreateDocx;
  compareDocx: CompareDocx;
}
