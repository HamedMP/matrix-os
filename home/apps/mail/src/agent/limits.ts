/** Bounds for every Mail agent feature. The AI bridge enforces the first two. */

/** `MatrixOS.ai.generate` accepts at most this many prompt characters. */
export const MAX_PROMPT_CHARS = 32_000;
/** The bridge returns at most this many reply characters; longer text is cut before parsing. */
export const MAX_REPLY_CHARS = 64_000;
/** The owner's typed instruction inside a prompt. */
export const MAX_INSTRUCTION_CHARS = 2_000;

/** Sent messages sampled for a voice profile, per recipient and overall. */
export const VOICE_SAMPLE_PER_RECIPIENT = 10;
export const VOICE_SAMPLE_OVERALL_THREADS = 5;
/** A cached voice profile is re-derived after this long. */
export const VOICE_PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Voice profiles kept in memory. */
export const MAX_VOICE_PROFILES_IN_MEMORY = 100;

/** Characters of one message body in a thread prompt before the budget share applies. */
export const MAX_MESSAGE_CHARS = 8_000;
/** Messages of a thread included in a prompt (the most recent ones). */
export const MAX_THREAD_MESSAGES = 12;
/** Attachment names listed per thread. */
export const MAX_ATTACHMENT_NAMES = 30;

/** Agentic search. */
export const MAX_SEARCH_QUERIES_PER_ACCOUNT = 5;
export const MAX_SEARCH_CANDIDATES = 30;
export const MAX_SEARCH_BODIES_READ = 6;
export const SEARCH_BODY_BUDGET_CHARS = 18_000;
export const MAX_SEARCH_RESULTS = 8;

/** Triage suggestions: threads per request. */
export const MAX_TRIAGE_THREADS = 50;

/** Bulk drafts. */
export const MAX_BULK_ROWS = 200;
export const MAX_BULK_COLUMNS = 30;
export const MAX_BULK_CELL_CHARS = 2_000;
export const BULK_CONCURRENCY = 3;

/** Panel feed sizes. */
export const MAX_PANEL_MESSAGES = 50;
export const MAX_PANEL_RESULTS = 30;
export const MAX_PANEL_STATUS_LINES = 20;
/** Agent-written text shown in one line (reasons, titles). */
export const MAX_REASON_CHARS = 200;
