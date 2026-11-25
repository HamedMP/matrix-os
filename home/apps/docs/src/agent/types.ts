/**
 * Types of the Docs assistant. See `./index.ts` for the overview.
 */

import type { DocumentSession } from "../session/index";
import type { AgentDocxEdit, BlockId, CommentId, RejectedEditCode, RevisionId, RevisionKind, TextRange } from "./engine";

/** `window.MatrixOS.ai.generate`, or a stand-in with the same shape. */
export type AgentGenerate = (input: { prompt: string }) => Promise<{ text: string }>;

export interface AssistantDeps {
  session: DocumentSession;
  generate: AgentGenerate;
  /** Author of the revisions and comments. Default {@link ASSISTANT_AUTHOR}. */
  author?: string;
  /** Upper bound on one prompt. Default and maximum 32 000 (the app AI bridge limit). */
  promptBudget?: number;
  log?: (message: string, error: unknown) => void;
}

export type AgentPhase = "reading" | "asking" | "validating" | "retrying" | "applying" | "done";

export interface AgentProgress {
  phase: AgentPhase;
  /** 1-based number of the part of the document being worked on. */
  chunk: number;
  chunks: number;
  /** A fixed sentence for the owner. */
  message: string;
}

/** Which part of the document an edit request covers. */
export type EditScope =
  /** The selection when there is one; otherwise the whole document, or the clauses the instruction names when it is long. */
  | "auto"
  /** Every paragraph, in parts when the document is long. */
  | "document"
  /** The selection and its clause. */
  | "selection";

export interface EditRequest {
  instruction: string;
  selection?: TextRange | null;
  /** `comment` adds comments only and changes no text. Default `edit`. */
  mode?: "edit" | "comment";
  scope?: EditScope;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
}

export type DroppedEditCode = RejectedEditCode | "out_of_scope" | "not_allowed";

/** An edit the agent proposed that was not applied. */
export interface DroppedEdit {
  /** 1-based part of the document the edit came from. */
  chunk: number;
  /** Index of the edit in the agent's answer. */
  index: number;
  op: AgentDocxEdit["op"];
  blockId: BlockId;
  code: DroppedEditCode;
  /** For logs and for the retry prompt; may quote the agent's text. */
  message: string;
}

/** An edit whose quoted text was found at another place than the agent said. */
export interface RelocatedEdit {
  chunk: number;
  index: number;
  fromBlockId: BlockId;
  toBlockId: BlockId;
  /** How it was found. */
  how: "exact" | "normalised" | "fuzzy";
}

/** One proposed change, for the result card. */
export interface ChangeSummaryItem {
  /** The revision to jump to, accept or reject; a replacement lists both halves. */
  revisionIds: RevisionId[];
  kind: "insert" | "delete" | "replace" | "move" | "format";
  blockId: BlockId;
  range: TextRange | null;
  /** Removed text, cut to a preview length. */
  before: string;
  /** Inserted text, cut to a preview length. */
  after: string;
}

export interface CommentSummaryItem {
  commentId: CommentId;
  blockId: BlockId | null;
  range: TextRange | null;
  text: string;
  anchorText: string;
}

export type EditRunResult =
  | {
      status: "applied";
      revisionIds: RevisionId[];
      commentIds: CommentId[];
      changes: ChangeSummaryItem[];
      comments: CommentSummaryItem[];
      /** The agent's one-sentence summary, if it gave one. Untrusted text: render as text. */
      summary: string | null;
      dropped: DroppedEdit[];
      relocated: RelocatedEdit[];
      chunks: number;
    }
  | { status: "no_changes"; summary: string | null; dropped: DroppedEdit[]; relocated: RelocatedEdit[]; chunks: number }
  /** An answer could not be read even after the retry. Nothing was applied. */
  | { status: "invalid_reply"; chunk: number; message: string }
  | { status: "cancelled" }
  | { status: "failed"; reason: AssistantFailure; message: string };

export type AssistantFailure =
  | "no_document"
  | "empty_instruction"
  | "instruction_too_long"
  | "unavailable"
  | "document_changed"
  | "apply_failed";

/** Part of an answer: plain text or a citation of a block. */
export type AnswerSegment = { type: "text"; text: string } | { type: "citation"; blockId: BlockId; number: number };

export type AnswerResult =
  | { status: "answered"; text: string; segments: AnswerSegment[]; citedBlockIds: BlockId[] }
  | { status: "cancelled" }
  | { status: "failed"; reason: AssistantFailure; message: string };

export interface RevisionKindCount {
  kind: RevisionKind;
  count: number;
}
