/**
 * Word-level text diff and tracked changes for plain text and simple HTML.
 * The contract and its rules are in `../api/redline.ts`.
 *
 * Contract values: `diffWords`, `diffSequences`, `createRedline`,
 * `loadRedline`. Additions: `diffParagraphs` (paragraph alignment with
 * splits, merges and moves, for document comparison), `applyUserEdit`,
 * `serialiseRedline` / `deserialiseRedline`, `sanitiseHtml`, `tokenize`.
 */

export type * from "../api/redline.js";
export { MAX_SEQUENCE_LENGTH, MAX_TEXT_LENGTH, diffSequences, diffWords } from "./diff.js";
export { applyUserEdit, createRedline, deserialiseRedline, loadRedline, sanitiseHtml, serialiseRedline } from "./doc.js";
export type { TrackedRedline, UserEditOptions } from "./doc.js";
export { MAX_REDLINE_LENGTH } from "./model.js";
export { diffParagraphs } from "./paragraphs.js";
export type { ParagraphDiffOp, ParagraphDiffOptions, ParagraphOpType } from "./paragraphs.js";
export { tokenize } from "./tokenize.js";
export type { TokenizeOptions } from "./tokenize.js";
