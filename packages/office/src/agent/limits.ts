/**
 * Bounds of the agent bridge. Agent answers and document text are untrusted,
 * so every loop here runs against one of these.
 */

/** Longest agent answer that is read, in UTF-16 code units (1 MiB). */
export const MAX_ANSWER_LENGTH = 1_048_576;
/** Most edits in one envelope. */
export const MAX_EDITS = 500;
/** Longest string in an envelope. */
export const MAX_STRING_LENGTH = 20_000;
/** Most cells in one `setRange`, and most cells one `clearRange` expands to. */
export const MAX_RANGE_CELLS = 10_000;
/** Largest `maxChars` a description accepts. */
export const MAX_DESCRIPTION_CHARS = 4_000_000;
/** Most cells `describeSheet` looks at before it reports a truncated description. */
export const MAX_SCANNED_CELLS = 2_000_000;
/** Share of a document description the outline may take. */
export const OUTLINE_SHARE = 0.4;
/** Characters of a paragraph that `deleteParagraph.startsWith` must quote. */
export const STARTS_WITH_LENGTH = 40;
/** Marks text that was cut to fit a budget. */
export const ELLIPSIS = "…";
