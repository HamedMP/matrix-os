import { z } from "zod/v4";
import { wrapExternalContent } from "../security/external-content.js";
import type { BrainAgentResult, BrainCiteView, BrainIndexFreshness, BrainReadToolName } from "./brain-read-types.js";

// Shared text rules of the Company Brain read tools (brain_search ... brain_impact); brain_why keeps its own.

export type BrainReadToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
/** text: the answer; external: it holds document text and is wrapped as untrusted content. */
export interface BrainReadAnswer { readonly text: string; readonly external: boolean }

/** Format characters (zero-width, bidi controls) could hide a wrapper marker or reorder text. */
const FORMAT_CHARS = /\p{Cf}/gu;
/** Every other line break folds to "\n", so document text cannot start an unindented line of its own. */
const LINE_BREAKS = /\r\n?|[\v\f\x1c-\x1e\x85\u2028\u2029]/g;
/** Room for the last line: a 640-char cursor in the `More:` line, or the left-out hint. */
const FOOTER_RESERVE_CHARS = 720;
export const EXCERPT_MAX_CHARS = 400;
export const TITLE_MAX_CHARS = 200;

export function clean(value: string): string {
  return value.replace(FORMAT_CHARS, "").replace(LINE_BREAKS, "\n");
}

/** Third-party one-line field: cleaned, line breaks joined with spaces, cut to `max`. */
export function oneLine(value: string, max = EXCERPT_MAX_CHARS): string {
  return cutTo(clean(value).replace(/\n+/g, " "), max);
}

/** Cut to `max` UTF-16 units, never inside a surrogate pair, marking the cut with "...". */
export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 4)) ? max - 4 : max - 3;
  return `${text.slice(0, end)}...`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const CITE_KIND_WORDS: Readonly<Record<string, string>> = {
  pr: "PR", commit: "Commit", spec: "Spec", review: "Review", comment: "Comment", issue: "Issue", note: "Note",
  file: "File", chat: "Chat", doc: "Doc", event: "Event", update: "Update", thread: "Thread", document: "Document",
};

export function kindWord(kind: string): string {
  return CITE_KIND_WORDS[kind] ?? "Document";
}

/** "PR #12 - 2026-09-28 - Title"; a label equal to the title is shown once. */
export function citeText(cite: Pick<BrainCiteView, "kind" | "label" | "title" | "date">): string {
  const label = oneLine(cite.label, TITLE_MAX_CHARS);
  const title = oneLine(cite.title, TITLE_MAX_CHARS);
  const day = oneLine(cite.date.slice(0, 10), 10);
  return label === title ? `${kindWord(cite.kind)} ${label} - ${day}` : `${kindWord(cite.kind)} ${label} - ${day} - ${title}`;
}

/** Short reference for lists: "PR #12 (2026-09-28)". */
export function citeShort(cite: Pick<BrainCiteView, "kind" | "label" | "date">): string {
  return `${kindWord(cite.kind)} ${oneLine(cite.label, 80)} (${oneLine(cite.date.slice(0, 10), 10)})`;
}

/** The permalink line under an item, or nothing when the document has none. */
export function permalinkLines(cite: Pick<BrainCiteView, "permalink">, indent = "   "): string[] {
  return cite.permalink ? [`${indent}${oneLine(cite.permalink, 600)}`] : [];
}

export function freshnessClause(freshness: BrainIndexFreshness): string {
  if (freshness.caughtUp) return "";
  const count = `${freshness.pendingDocuments}${freshness.pendingCapped ? "+" : ""}`;
  return ` The index is catching up (${count} documents pending).`;
}

export interface BrainAnswerParts {
  readonly maxChars: number;
  /** The first line; `shown` is how many blocks fit. */
  readonly header: (shown: number) => string;
  /** Lines always shown after the header (a summary, notices); kept short by the caller. */
  readonly preface?: readonly string[];
  readonly blocks: readonly string[];
  /** The `More:` line when every block fit, or null. */
  readonly more: string | null;
  /** The last line when blocks were left out for length. */
  readonly leftOut: (left: number, shown: number) => string;
}

/** Deterministic compact answer: header, preface, as many blocks as fit, then one footer line; at most maxChars. */
export function composeAnswer(parts: BrainAnswerParts): string {
  const head = [parts.header(parts.blocks.length), ...(parts.preface ?? [])].join("\n");
  // Measured with every block shown, so the real header (fewer shown) is never longer.
  const budget = parts.maxChars - head.length - 1 - FOOTER_RESERVE_CHARS;
  const shown: string[] = [];
  let used = 0;
  for (const block of parts.blocks) {
    if (shown.length > 0 && used + block.length + 1 > budget) break;
    shown.push(cutTo(block, Math.max(budget - 1, 40)));
    used += shown[shown.length - 1]!.length + 1;
  }
  const lines = [parts.header(shown.length), ...(parts.preface ?? []), ...shown];
  const left = parts.blocks.length - shown.length;
  if (left > 0) lines.push(parts.leftOut(left, shown.length));
  else if (parts.more) lines.push(parts.more);
  return lines.join("\n");
}

export function moreLine(tool: BrainReadToolName, cursor: string | null): string | null {
  return cursor ? `More: call ${tool} with cursor "${oneLine(cursor, 700)}".` : null;
}

/** The left-out hint of cursor-paged tools: ask for fewer items, so the cursor continues after the shown ones. */
export function pagedLeftOut(noun: string, nouns: string) {
  return (left: number, shown: number) =>
    `${left} more ${left === 1 ? `${noun} was` : `${nouns} were`} left out for length; call again with limit ` +
    `${shown} for a cursor that continues after the ${nouns} shown here.`;
}

export function linesLeftOut(left: number): string {
  return `${left} more ${left === 1 ? "line was" : "lines were"} left out for length.`;
}

// Input pieces shared by the tool shapes (bounds mirror the gateway routes).

const NO_CONTROL = /^[^\p{Cc}]*$/u;
export const PROJECT_REF_INPUT = z.string().regex(/^(?:proj_[A-Za-z0-9_-]{1,128}|[a-z0-9][a-z0-9-]{0,62})$/)
  .describe("Project id (proj_...) or slug (the <slug> in ~/projects/<slug>/repo)");
export const REPO_PATH_INPUT = z.string().min(1).max(1024).refine((value) => !value.includes("\0"))
  .describe("Repo-relative file or folder; end with / for a folder only");
export const DATE_INPUT = z.string().max(40)
  .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/);
export const cursorInput = (tool: BrainReadToolName, max: number) =>
  z.string().min(1).max(max).regex(NO_CONTROL).describe(`Cursor from a previous ${tool} answer`);
export const limitInput = (max: number, fallback: number, noun: string) =>
  z.number().int().min(1).max(max).describe(`${noun} per answer, 1-${max} (default ${fallback})`);

// Handler.

export interface BrainReadMessages {
  readonly notFound: string; readonly invalid: string; readonly notConfigured?: string;
}
const UNAVAILABLE = "Company Brain is temporarily unavailable.";
const NOT_CONFIGURED = "That Company Brain feature is turned off for this project.";

function textResult(text: string, isError = false): BrainReadToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

export function wrapBrainAnswer(answer: BrainReadAnswer): string {
  return answer.external
    ? wrapExternalContent(answer.text, { source: "api", from: "Company Brain", includeWarning: true })
    : answer.text;
}

/** Read-only handler: fixed texts for every non-ok status, and one fixed unavailable answer for any failure. */
export function createBrainReadHandler<TInput, TView>(options: {
  readonly tool: BrainReadToolName;
  readonly call: (input: TInput) => Promise<BrainAgentResult<TView>>;
  readonly render: (view: TView) => BrainReadAnswer;
  readonly messages: BrainReadMessages;
}) {
  return async (input: TInput): Promise<BrainReadToolResult> => {
    try {
      const result = await options.call(input);
      if (result.status === "not_found") return textResult(options.messages.notFound);
      if (result.status === "invalid") return textResult(options.messages.invalid);
      if (result.status === "not_configured") return textResult(options.messages.notConfigured ?? NOT_CONFIGURED);
      if (result.status !== "ok") return textResult(UNAVAILABLE, true);
      return textResult(wrapBrainAnswer(options.render(result)));
    } catch (error: unknown) {
      console.error(`[brain-read] ${options.tool} failed:`, error instanceof Error ? error.name : typeof error);
      return textResult(UNAVAILABLE, true);
    }
  };
}
