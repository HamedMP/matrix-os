/** Bounds of the Sheets assistant. Every prompt, reply, walk and scan stays inside them. */

/** The app AI bridge accepts prompts of at most this many characters. */
export const MAX_PROMPT_CHARS = 32_000;
/** Reply text read from the model; the bridge caps replies at 64 000. */
export const MAX_REPLY_CHARS = 64_000;
/** Most characters of sheet text in one prompt. */
export const MAX_SHEET_CONTEXT_CHARS = 18_000;
/** Most characters of the owner's instruction in one prompt. */
export const MAX_INSTRUCTION_CHARS = 4_000;
/** Most characters of a plain-language answer shown to the owner. */
export const MAX_ANSWER_CHARS = 6_000;
/** Most cells one assistant proposal may change. */
export const MAX_PROPOSED_CELLS = 5_000;
/** Most cells read by the deterministic checks per sheet. */
export const MAX_CHECK_CELLS_PER_SHEET = 250_000;
/** Most findings reported by one check run. */
export const MAX_FINDINGS = 200;
/** Trace bounds. */
export const MAX_TRACE_NODES = 400;
export const MAX_TRACE_DEPTH = 10;
export const MAX_TRACE_RANGE_CELLS = 60;
/** Most precedent cells highlighted on the grid. */
export const MAX_HIGHLIGHTS = 2_000;
/** How long one model call may take before the assistant gives up. */
export const AI_TIMEOUT_MS = 45_000;
/** Author of every proposal the assistant makes. */
export const ASSISTANT_AUTHOR = "Matrix Assistant";
