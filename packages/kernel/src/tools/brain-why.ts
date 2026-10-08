import { z } from "zod/v4";
import { wrapExternalContent } from "../security/external-content.js";

// Structural mirror of the gateway's Company Brain why shapes (the kernel cannot import the gateway).

export type BrainWhyAgentDetail = "brief" | "full";
export interface BrainWhyAgentExcerpt { readonly heading: string | null; readonly text: string; readonly truncated: boolean }
export interface BrainWhyAgentItem {
  readonly kind: "pr" | "commit" | "spec"; readonly label: string; readonly title: string; readonly date: string;
  readonly permalink: string; readonly link: "explicit" | "inferred" | "none";
  readonly summary: BrainWhyAgentExcerpt | null; readonly invariants: BrainWhyAgentExcerpt | null;
  readonly specs: readonly string[]; readonly matchedPaths: readonly string[]; readonly matchedPathCount: number;
}
export interface BrainWhyAgentLastSync { readonly status: string; readonly finishedAt: string | null; readonly nextAction: string }
export interface BrainWhyAgentPage {
  readonly path: string; readonly match: "file_or_folder" | "folder"; readonly total: number;
  readonly totalCapped: boolean; readonly items: readonly BrainWhyAgentItem[]; readonly nextCursor: string | null;
  readonly source: { readonly webBase: string | null; readonly lastSync: BrainWhyAgentLastSync | null } | null;
}
export interface BrainWhyAgentOk extends BrainWhyAgentPage { readonly status: "ok" }
export type BrainWhyAgentResult = BrainWhyAgentOk | { readonly status: "not_found" } | { readonly status: "invalid" }
  | { readonly status: "unavailable" };
export interface BrainWhyAgentInput {
  readonly project: string; readonly path: string; readonly limit?: number; readonly cursor?: string;
  readonly detail?: BrainWhyAgentDetail;
}
/** Owner-bound in the gateway; the kernel never passes an owner, scope or checkout path. */
export interface BrainAgentTools { why(input: BrainWhyAgentInput): Promise<BrainWhyAgentResult> }

export const BRAIN_WHY_DESCRIPTION =
  "Explain why a file or folder in a Matrix project is the way it is: the pull requests, commits and specs that " +
  "changed it, newest first, with permalinks and their Summary and Invariants sections. Read-only; answers from " +
  "the last Company Brain sync. Pass the project id or slug and a repo-relative path.";

export const BRAIN_WHY_INPUT_SHAPE = {
  project: z.string().regex(/^(?:proj_[A-Za-z0-9_-]{1,128}|[a-z0-9][a-z0-9-]{0,62})$/)
    .describe("Project id (proj_...) or slug (the <slug> in ~/projects/<slug>/repo)"),
  path: z.string().min(1).max(1024).refine((value) => !value.includes("\0"))
    .describe("Repo-relative file or folder; end with / for a folder only"),
  limit: z.number().int().min(1).max(50).optional().describe("Changes per answer, 1-50 (default 5)"),
  cursor: z.string().min(1).max(256).optional().describe("Cursor from a previous brain_why answer"),
  detail: z.enum(["brief", "full"]).optional().describe("brief (default) or full for longer excerpts"),
};

/** Answer length bounds; items that would pass the bound are left out. */
export const BRAIN_WHY_TEXT_MAX_CHARS: Readonly<Record<BrainWhyAgentDetail, number>> = { brief: 8_000, full: 32_000 };
/** Changes per answer when the agent passes no limit; keeps a default answer short. */
export const BRAIN_WHY_TOOL_DEFAULT_LIMIT = 5;
/** Room for the last line: a 256-char cursor in the `More:` line, or the left-out hint. */
const FOOTER_RESERVE_CHARS = 300;
const EXCERPT_INDENT = "     ";
/** Format characters (zero-width, bidi controls) could hide a wrapper marker or reorder text. */
const FORMAT_CHARS = /\p{Cf}/gu;
/** Every other line break folds to "\n", so document text cannot start an unindented line of its own. */
const LINE_BREAKS = /\r\n?|[\v\f\x1c-\x1e\x85\u2028\u2029]/g;

const MESSAGES = {
  notFound: "That project was not found.",
  invalid:
    "That path or cursor is not valid. Pass a repo-relative path such as packages/gateway/src/ and only a cursor " +
    "from a previous brain_why answer.",
  unavailable: "Company Brain history is temporarily unavailable.",
} as const;

type BrainWhyToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function textResult(text: string, isError = false): BrainWhyToolResult {
  return isError ? { content: [{ type: "text", text }], isError: true } : { content: [{ type: "text", text }] };
}

/** Commit, PR and spec text is third-party: no format characters, and "\n" as the only line break. */
function clean(value: string): string {
  return value.replace(FORMAT_CHARS, "").replace(LINE_BREAKS, "\n");
}

function oneLine(value: string): string {
  return clean(value).replace(/\n+/g, " ");
}

function displayPath(page: Pick<BrainWhyAgentPage, "path" | "match">): string {
  return oneLine(page.match === "folder" ? `${page.path}/` : page.path);
}

function syncClause(source: BrainWhyAgentPage["source"]): string {
  const lastSync = source?.lastSync ?? null;
  if (!lastSync) return "Not synced yet.";
  if (lastSync.finishedAt === null) return "A sync is running.";
  const pending = lastSync.nextAction === "run_again" ? ", more history pending" : "";
  return `Last sync ${lastSync.finishedAt.slice(0, 10)} ${oneLine(lastSync.status)}${pending}.`;
}

function excerptLines(label: string, excerpt: BrainWhyAgentExcerpt | null): string[] {
  if (!excerpt) return [];
  const lines = clean(excerpt.text).split("\n")
    .map((line, index) => (index === 0 ? `   ${label}: ${line}` : line && `${EXCERPT_INDENT}${line}`));
  if (excerpt.truncated) lines[lines.length - 1] += " \u2026";
  return lines;
}

function itemBlock(page: BrainWhyAgentPage, item: BrainWhyAgentItem, position: number): string {
  const kindWord = item.kind === "pr" ? "PR" : item.kind === "commit" ? "Commit" : "Spec";
  const link = item.kind === "pr" && item.link !== "none" ? ` [${item.link} link]` : "";
  const day = item.date.slice(0, 10);
  const lines = [`${position}. ${kindWord} ${oneLine(item.label)} \u00b7 ${day} \u00b7 ${oneLine(item.title)}${link}`];
  if (item.permalink) lines.push(`   ${oneLine(item.permalink)}`);
  // A summary without a heading is the message's lead paragraph, not a section the author called a summary.
  const summaryLabel = item.summary?.heading === null ? "Message" : "Summary";
  lines.push(...excerptLines(summaryLabel, item.summary), ...excerptLines("Invariants", item.invariants));
  if (item.specs.length > 0) lines.push(`   Specs: ${item.specs.map(oneLine).join(", ")}`);
  const onlyItself = item.matchedPathCount === 1 && item.matchedPaths[0] === page.path;
  if (item.matchedPaths.length > 0 && !onlyItself) {
    const rest = item.matchedPathCount - item.matchedPaths.length;
    lines.push(`   Paths: ${item.matchedPaths.map(oneLine).join(", ")}${rest > 0 ? ` (+${rest} more)` : ""}`);
  }
  return lines.join("\n");
}

/** Cut to `max` UTF-16 units, never inside a surrogate pair, marking the cut. */
function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text.charAt(max - 3)) ? max - 3 : max - 2;
  return `${text.slice(0, end)} \u2026`;
}

/** Deterministic compact answer for a page with items; newest first, at most BRAIN_WHY_TEXT_MAX_CHARS long. */
export function formatBrainWhy(page: BrainWhyAgentPage, detail: BrainWhyAgentDetail): string {
  const total = `${page.total}${page.totalCapped ? "+" : ""}`;
  const header = (shown: number) =>
    `Why ${displayPath(page)}: ${shown} of ${total} linked changes, newest first. ${syncClause(page.source)}`;
  // Measured with every item shown, so the real header (fewer shown) is never longer.
  const budget = BRAIN_WHY_TEXT_MAX_CHARS[detail] - header(page.items.length).length - 1 - FOOTER_RESERVE_CHARS;
  const blocks: string[] = [];
  let used = 0;
  for (const item of page.items) {
    const block = itemBlock(page, item, blocks.length + 1);
    if (blocks.length > 0 && used + block.length + 1 > budget) break;
    blocks.push(cutTo(block, budget - 1));
    used += blocks[blocks.length - 1]!.length + 1;
  }
  const left = page.items.length - blocks.length;
  const lines = [header(blocks.length), ...blocks];
  if (left > 0) {
    lines.push(`${left} more ${left === 1 ? "change was" : "changes were"} left out for length; call again with ` +
      `limit ${blocks.length} for a cursor that continues after the changes shown here.`);
  } else if (page.nextCursor) {
    lines.push(`More: call brain_why with cursor "${oneLine(page.nextCursor)}".`);
  }
  return lines.join("\n");
}

function answerText(result: BrainWhyAgentResult, detail: BrainWhyAgentDetail): BrainWhyToolResult {
  if (result.status === "not_found") return textResult(MESSAGES.notFound);
  if (result.status === "invalid") return textResult(MESSAGES.invalid);
  if (result.status !== "ok") return textResult(MESSAGES.unavailable, true);
  const path = displayPath(result);
  if (result.source === null) {
    return textResult(`This project has no git source in the Company Brain yet, so there is no history for ${path}.`);
  }
  if (result.items.length === 0) {
    return textResult(`No synced pull request, commit or spec touches ${path}. ${syncClause(result.source)}`);
  }
  const text = formatBrainWhy(result, detail);
  return textResult(wrapExternalContent(text, { source: "api", from: "Company Brain", includeWarning: true }));
}

/** Read-only brain_why handler; every failure reads as one fixed unavailable answer. */
export function createBrainWhyToolHandler(tools: BrainAgentTools) {
  return async (input: BrainWhyAgentInput): Promise<BrainWhyToolResult> => {
    const detail = input.detail ?? "brief";
    try {
      const limit = input.limit ?? BRAIN_WHY_TOOL_DEFAULT_LIMIT;
      return answerText(await tools.why({ ...input, limit, detail }), detail);
    } catch (error: unknown) {
      console.error("[brain-why] Tool call failed:", error instanceof Error ? error.name : typeof error);
      return textResult(MESSAGES.unavailable, true);
    }
  };
}
