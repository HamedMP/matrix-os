/**
 * Types of the document comparison: the options and result of
 * `compareDocxDetailed`, and the internal records the comparison passes
 * between its steps.
 */

import type { CompareOptions, DocxDocument } from "../../api/docx.js";
import type { BlockId, RevisionId, RevisionKind, RevisionScope, StoryId } from "../../api/docx-model.js";
import type { XmlElement } from "../../api/xml.js";
import type { FieldFrame } from "../model/inline.js";

/** `CompareOptions` of the contract, with the additions of this module. */
export interface CompareDetailedOptions extends CompareOptions {
  /**
   * Report differences in run and paragraph formatting of unchanged text as
   * formatting revisions (`w:rPrChange`, `w:pPrChange`). Default true.
   */
  compareFormatting?: boolean;
}

/** Whether a change alters what the document says or only how it looks. */
export type ChangeClassification = "substantive" | "formatting";

/** One revision of the result, classified. Same order as `DocxDocument.listRevisions()`. */
export interface CompareChange {
  revisionId: RevisionId;
  kind: RevisionKind;
  scope: RevisionScope;
  /** `formatting` for a formatting revision, `substantive` for every change of content. */
  classification: ChangeClassification;
  storyId: StoryId;
  blockIds: BlockId[];
  /** The inserted, deleted or moved text, or the text whose formatting changed. */
  text: string;
  /** The other half of a replacement or move, or null. */
  pairedWith: RevisionId | null;
}

export interface CompareSummary {
  /** True when the comparison found no difference. */
  identical: boolean;
  /** Number of revisions in the result. */
  total: number;
  /** Revisions by kind. */
  counts: Record<RevisionKind, number>;
  /** Revisions that change content. */
  substantive: number;
  /** Revisions that change formatting only. */
  formattingOnly: number;
  /** Whole paragraphs that were inserted, deleted or relocated (a relocated paragraph counts once). */
  paragraphs: { inserted: number; deleted: number; moved: number };
  /** Whole table rows that were inserted or deleted, rows of inserted and deleted tables included. */
  tableRows: { inserted: number; deleted: number };
  changes: CompareChange[];
}

/** The texts one compared story must have in the two views of the result. */
export interface StoryExpectation {
  /** What the story is, for messages: `body`, `header 1`, `footnote 2`, … */
  label: string;
  /** Text of the story in the original document. */
  original: string;
  /** Text of the story in the revised document. */
  revised: string;
}

/**
 * What the result of a comparison has to satisfy; checked by
 * `verifyComparison` before the result is returned.
 */
export interface CompareExpectation {
  /** The body. */
  body: StoryExpectation;
  /** Headers and footers that were compared, by the story id they have in the result. */
  stories: Array<StoryExpectation & { storyId: StoryId }>;
  /** Texts of the footnotes and endnotes, in the order the body refers to them. */
  notes: {
    footnote: { original: string[]; revised: string[] };
    endnote: { original: string[]; revised: string[] };
  };
}

export interface CompareResult {
  /** The original document with every difference as a tracked revision. */
  document: DocxDocument;
  summary: CompareSummary;
  /** The texts the self-check held the result to. */
  check: CompareExpectation;
}

/** `details.check` of the `OfficeError` thrown when a result fails its self-check. */
export const COMPARE_SELF_CHECK = "compare_self_check";

/** The four content revision elements, without the `w:` prefix. */
export type ContentKind = "ins" | "del" | "moveFrom" | "moveTo";

/** Author, date and id source of the revisions a comparison writes. */
export interface Stamp {
  readonly author: string;
  readonly date: string;
  /** A `w:id` no annotation of the result carries yet. */
  nextId(): string;
  /** Records that a tree was changed without a new id (a run was split). */
  touch(): void;
}

/** A paragraph of one of the two documents. */
export interface ParaNode {
  readonly kind: "paragraph";
  readonly element: XmlElement;
  /** Fields left open by the paragraphs before it. */
  readonly fieldsIn: readonly FieldFrame[];
  /** The comparison text: the markup text with every inline object replaced by a character that stands for its kind. */
  readonly text: string;
  /** True when the paragraph ends a section (`w:pPr/w:sectPr`). */
  readonly endsSection: boolean;
}

export interface CellNode {
  readonly element: XmlElement;
  readonly blocks: BlockNode[];
}

export interface RowNode {
  readonly element: XmlElement;
  readonly cells: CellNode[];
  /** Text of the cells, tab separated. */
  readonly text: string;
}

export interface TableNode {
  readonly kind: "table";
  readonly element: XmlElement;
  readonly rows: RowNode[];
  /** Text of the whole table. */
  readonly text: string;
}

export type BlockNode = ParaNode | TableNode;

/** Counters the build updates while it writes revisions. */
export interface BuildCounters {
  insertedParagraphs: number;
  deletedParagraphs: number;
  movedParagraphs: number;
  insertedRows: number;
  deletedRows: number;
}
