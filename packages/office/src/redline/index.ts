/**
 * Word-level text diff and tracked changes for plain text and simple HTML.
 * The contract and its rules are in `../api/redline.ts`.
 */

export type * from "../api/redline.js";
export { MAX_SEQUENCE_LENGTH, MAX_TEXT_LENGTH, diffSequences, diffWords } from "./diff.js";
export { tokenize } from "./tokenize.js";
export type { TokenizeOptions } from "./tokenize.js";
