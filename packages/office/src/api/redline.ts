/**
 * Contract: word-level text diff and a tracked-changes model for plain text
 * and simple HTML. Implemented by `src/redline/index.ts`.
 *
 * Type-only. Each function type is implemented as a value export with the
 * camelCase name given in {@link RedlineModule}.
 *
 * Used by the document comparison (`compareDocx`) and by the mail composer.
 * All offsets count UTF-16 code units.
 */

export type DiffGranularity = "word" | "char";

export interface DiffOptions {
  /**
   * `word` (default) compares tokens: a run of letters, digits and
   * apostrophes, a run of whitespace, or one other character. `char`
   * compares single characters.
   */
  granularity?: DiffGranularity;
  /** Report relocated text as a move instead of a deletion and an insertion. Default true. */
  detectMoves?: boolean;
  /** Smallest number of non-whitespace tokens that counts as a move. Default 4. */
  minMoveTokens?: number;
  /**
   * Bound on the work done. Above this many tokens in either text the
   * common prefix and suffix are still matched, the middle is compared line
   * by line and only the lines that differ are compared word by word. A
   * middle that is still too large is reported as one deletion and one
   * insertion. Default 20 000.
   */
  maxTokens?: number;
}

export type DiffOpType = "equal" | "insert" | "delete" | "moveFrom" | "moveTo";

/**
 * One step of a diff from `a` to `b`.
 *
 * Every op has a range in `a` and a range in `b`; one of them is empty where
 * the text exists on one side only:
 *
 * | type       | range in `a`            | range in `b`            |
 * | ---------- | ----------------------- | ----------------------- |
 * | `equal`    | the text                | the same text           |
 * | `delete`   | the deleted text        | empty, where it was     |
 * | `moveFrom` | the moved text          | empty, where it was     |
 * | `insert`   | empty, where it goes    | the inserted text       |
 * | `moveTo`   | empty, where it goes    | the moved text          |
 *
 * Invariants, in the order of the returned array:
 * - the `a` ranges are contiguous and cover `a`; the `b` ranges are
 *   contiguous and cover `b`
 * - `equal`, `delete` and `moveFrom` texts concatenated give `a`
 * - `equal`, `insert` and `moveTo` texts concatenated give `b`
 * - no op has empty text, and neighbouring `equal`, `insert` or `delete` ops
 *   never have the same type (they are merged)
 * - each `moveFrom` has exactly one `moveTo` with the same `moveId` and text
 */
export interface DiffOp {
  type: DiffOpType;
  text: string;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  /** Pairs a `moveFrom` with its `moveTo`; null for the other types. */
  moveId: string | null;
}

/** Compares two texts. Deterministic: the same inputs give the same ops. */
export type DiffWords = (a: string, b: string, options?: DiffOptions) => DiffOp[];

/** One step of a diff between two sequences of keys. Ranges are index ranges, end exclusive. */
export interface SequenceDiffOp {
  type: DiffOpType;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  moveId: string | null;
}

/**
 * The same diff over arbitrary items given as strings that are equal when
 * the items are equal, for example one key per paragraph. Same invariants
 * as {@link DiffOp}, over indexes instead of offsets. `minMoveTokens`
 * defaults to 1 and `granularity` is ignored.
 */
export type DiffSequences = (a: readonly string[], b: readonly string[], options?: DiffOptions) => SequenceDiffOp[];

export type RedlineFormat = "text" | "html";

export interface RedlineOptions {
  /** Author of the changes. */
  author: string;
  /** ISO 8601, supplied by the caller. */
  date: string;
  /** How `original` and `revised` are read. Default `text`. */
  format?: RedlineFormat;
  detectMoves?: boolean;
}

export type RedlineChangeKind = "insert" | "delete" | "moveFrom" | "moveTo";

/** One pending change. A replacement is a `delete` and an `insert` that name each other. */
export interface RedlineChange {
  /** Unique in the document, stable until the change is resolved. */
  id: string;
  kind: RedlineChangeKind;
  /** The inserted, deleted or moved text, without markup. */
  text: string;
  author: string;
  date: string;
  /** The other half of a replacement or a move, or null. */
  pairedWith: string | null;
}

/** How a redline is rendered. */
export type RedlineMode =
  /** Insertions and deletions both shown and marked. */
  | "markup"
  /** As if every pending change were accepted. */
  | "final"
  /** As if every pending change were rejected. */
  | "original";

/** JSON-safe state of a {@link RedlineDoc}, for keeping a draft between sessions. Opaque apart from `version`. */
export interface RedlineState {
  version: 1;
  format: RedlineFormat;
  [key: string]: unknown;
}

/**
 * A text with tracked changes.
 *
 * HTML handling: the input is untrusted. It is read with a tolerant
 * tokeniser, never executed and never handed to a browser parser. Only this
 * structure is kept: `p div br ul ol li blockquote pre h1`–`h6 b strong i
 * em u s span a table thead tbody tr th td`, the `href` of `a` when it is
 * `http:`, `https:` or `mailto:`, and no other attribute. Other elements are
 * dropped with their text kept, except `script`, `style`, `head`, `iframe`,
 * `object` and `embed`, which are dropped whole. `toHtml` therefore returns
 * markup that is safe to insert into a page. The comparison is made on the
 * text; a change inside formatting keeps the formatting of the side it comes
 * from. A `br` counts as the character U+2028 in the compared text, and a
 * paragraph moved to the very start or end is reported with one deleted and
 * one inserted paragraph boundary beside the move.
 */
export interface RedlineDoc {
  readonly format: RedlineFormat;
  /** Pending changes in the order they appear in the markup view. */
  listChanges(): RedlineChange[];
  /** Makes changes permanent: insertions stay, deletions go. Resolving one half of a move resolves both. An unknown id throws `stale_reference`. */
  accept(ids: readonly string[] | "all"): void;
  /** Undoes changes: insertions go, deletions stay. */
  reject(ids: readonly string[] | "all"): void;
  /**
   * Renders HTML. For the `text` format, text is escaped and line breaks
   * become `<br>`.
   *
   * In `markup` mode a pending change is wrapped as
   * `<ins class="redline-ins" data-change-id="…" data-author="…" data-date="…">`,
   * `<del class="redline-del" …>`, or with the classes `redline-move-from`
   * (on `del`) and `redline-move-to` (on `ins`). `final` and `original`
   * contain no `ins` or `del`.
   */
  toHtml(mode: RedlineMode): string;
  /** Plain text in the given mode. For HTML, block boundaries and `br` become `\n`. */
  toText(mode: RedlineMode): string;
  /** Same as `toText("final")`. */
  toFinalText(): string;
  toJSON(): RedlineState;
}

/** Compares two versions and returns the revised text with its differences from the original as pending changes. */
export type CreateRedline = (original: string, revised: string, options: RedlineOptions) => RedlineDoc;

/** Rebuilds a document from `toJSON()`. Throws `invalid_argument` for a state it does not recognise. */
export type LoadRedline = (state: RedlineState) => RedlineDoc;

/** The value exports of `src/redline/index.ts`. */
export interface RedlineModule {
  diffWords: DiffWords;
  diffSequences: DiffSequences;
  createRedline: CreateRedline;
  loadRedline: LoadRedline;
}
