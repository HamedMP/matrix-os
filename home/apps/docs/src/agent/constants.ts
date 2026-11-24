/** Bounds and fixed texts of the Docs assistant. */

/** Author of every revision and comment the assistant makes. */
export const ASSISTANT_AUTHOR = "Matrix Assistant";

/** The app AI bridge accepts prompts of 1 to 32 000 characters. */
export const MAX_PROMPT_CHARS = 32_000;

/** Longest owner instruction, so the document always keeps most of the prompt. */
export const MAX_INSTRUCTION_CHARS = 8_000;

/** Prompt room kept free for the validation errors of a retry. */
export const RETRY_RESERVE_CHARS = 2_400;

/** Most problems listed in a retry prompt, and the longest line for one. */
export const MAX_RETRY_PROBLEMS = 8;
export const MAX_RETRY_PROBLEM_CHARS = 240;

/** Longest reply that is read (the bridge returns at most 64 000). */
export const MAX_REPLY_CHARS = 64_000;

/** Most parts a long document is cut into for one request. */
export const MAX_CHUNKS = 40;

/** Longest selection text put in a prompt. */
export const MAX_SELECTION_CHARS = 6_000;

/** Preview length of changed text in summaries. */
export const PREVIEW_CHARS = 120;

/** Generic messages for the owner. Detail is logged, never shown. */
export const MESSAGES = {
  no_document: "Open a document first.",
  empty_instruction: "Say what the assistant should do.",
  instruction_too_long: "That instruction is too long. Shorten it and try again.",
  unavailable: "The assistant is unavailable right now. Try again.",
  document_changed: "The document changed while the assistant was working. Nothing was applied.",
  apply_failed: "The proposed changes could not be applied. Nothing was changed.",
  invalid_reply: "The assistant's answer could not be checked against the document. Nothing was applied.",
} as const;
