/**
 * The bridge between documents and an AI agent. The contract and its rules
 * are in `../api/agent.ts`.
 *
 * ```ts
 * const description = describeDocx(document, { maxChars: 24_000 });
 * // … the model answers with JSON …
 * const parsed = parseAgentEdits(answer, "docx");
 * if (parsed.ok && parsed.envelope.kind === "docx") {
 *   const plan = toDocxOps(document, parsed.envelope.edits);
 *   document.applyOps(plan.ops, { track: true, author: "Matrix", date });
 * }
 * ```
 *
 * Document text and agent answers are untrusted. Descriptions are plain text
 * that the caller wraps as external content; answers are validated field by
 * field and resolved against the document before anything is applied.
 */

import type { AgentModule } from "../api/agent.js";
import { describeDocx } from "./describe-docx.js";
import { describeSheet } from "./describe-sheet.js";
import { toDocxOps } from "./docx-plan.js";
import { agentEditInstructions } from "./instructions.js";
import { parseAgentEdits } from "./parse.js";
import { applySheetEdits, toSheetEdits } from "./sheet-plan.js";

export type * from "../api/agent.js";
export { MAX_ANSWER_LENGTH, MAX_DESCRIPTION_CHARS, MAX_EDITS, MAX_RANGE_CELLS, MAX_STRING_LENGTH } from "./limits.js";
export { agentEditInstructions, applySheetEdits, describeDocx, describeSheet, parseAgentEdits, toDocxOps, toSheetEdits };

/** Every contract export as one object; also the compile-time proof that the module is complete. */
export const agentModule: AgentModule = Object.freeze({
  describeDocx,
  describeSheet,
  parseAgentEdits,
  agentEditInstructions,
  toDocxOps,
  toSheetEdits,
  applySheetEdits,
});
