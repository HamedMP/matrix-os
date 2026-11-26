/**
 * Docs assistant: the owner gives an instruction and the agent's edits
 * arrive as tracked changes to review. Pure orchestration over the session
 * and the engine's agent bridge; the panel is `../ui/agent`.
 *
 * ```ts
 * import { runAssistantEdit, askDocument, fixNumberingAndReferences } from "./agent";
 *
 * const deps = { session, generate: (input) => window.MatrixOS.ai.generate(input) };
 * const result = await runAssistantEdit(deps, { instruction: "Make the payment term 45 days", selection, onProgress });
 * if (result.status === "applied") result.changes; // one item per tracked change, with the block to jump to
 * ```
 *
 * Rules:
 * - Prompts stay within 32 000 characters. A document that fits is sent
 *   whole; otherwise the outline, the selection and the paragraphs a
 *   retrieval step ranks highest, or (for whole-document requests) the
 *   document in parts with progress per part.
 * - Document text is wrapped as untrusted external content; instructions
 *   inside it are ignored.
 * - Every edit is validated against the live document; misquoted text is
 *   relocated within its clause or the edit is dropped and reported.
 *   One retry feeds the problems back. When an answer still cannot be read,
 *   nothing is applied.
 * - Edits are applied in one session call, tracked, by "Matrix Assistant".
 * - Comment-only review adds comments and changes no text.
 * - Numbering and cross-reference fixes are deterministic (no model).
 */

export { ASSISTANT_AUTHOR, MAX_INSTRUCTION_CHARS, MAX_PROMPT_CHARS, MESSAGES, PARTIAL_COVERAGE_NOTE } from "./constants";
export { runAssistantEdit, selectionBlocks } from "./assistant";
export { askDocument, explainSelection, parseCitations, summariseDocument } from "./ask";
export type { AskRequest } from "./ask";
export { fixNumberingAndReferences, findLabelChanges, planStructureFixes } from "./structure";
export type { LabelChange, StructureFixResult, StructurePlan } from "./structure";
export { describeChange, pendingRevisionIds, summariseChanges, summariseComments } from "./summary";
export { planContexts } from "./context";
export type { ContextPlan, PromptContext } from "./context";
export { readDocument } from "./description";
export type { DocumentText } from "./description";
export { buildAnswerPrompt, buildEditPrompt } from "./prompt";
export { validateEdits } from "./validate";
export type { ValidationResult } from "./validate";
export { CLOSE_MARKER, OPEN_MARKER, sanitizeMarkers, wrapUntrusted } from "./untrusted";
export { QUICK_ACTIONS, READ_ONLY_MESSAGE, readingQuickActions } from "./quick-actions";
export type { QuickAction, QuickActionId } from "./quick-actions";
export type * from "./types";
