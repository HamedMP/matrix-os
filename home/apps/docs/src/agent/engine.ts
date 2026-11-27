/**
 * The parts of the document engine the assistant uses, imported file by file:
 * the engine's root index would pull the workbook and formula engine into Docs.
 */

export { describeDocx } from "../../../_shared/office-engine/agent/describe-docx";
export { toDocxOps } from "../../../_shared/office-engine/agent/docx-plan";
export { agentEditInstructions } from "../../../_shared/office-engine/agent/instructions";
export { parseAgentEdits } from "../../../_shared/office-engine/agent/parse";
export { MAX_DESCRIPTION_CHARS, STARTS_WITH_LENGTH } from "../../../_shared/office-engine/agent/limits";
export { flattenStories, occurrences, paragraphFinalText } from "../../../_shared/office-engine/agent/text";
export { isOfficeError } from "../../../_shared/office-engine/errors";

export type {
  AgentCommentEdit,
  AgentDeleteParagraphEdit,
  AgentDocxEdit,
  AgentInsertParagraphEdit,
  AgentReplaceTextEdit,
  DocxEditPlan,
  RejectedEditCode,
} from "../../../_shared/office-engine/api/agent";
export type {
  ApplyResult,
  BlockId,
  CommentId,
  DocxBlock,
  DocxDocument,
  ParagraphBlock,
  Revision,
  RevisionId,
  RevisionKind,
  TextRange,
} from "../../../_shared/office-engine/api/docx";
