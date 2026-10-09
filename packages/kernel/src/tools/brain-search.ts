import { z } from "zod/v4";
import {
  composeAnswer, cursorInput, DATE_INPUT, freshnessClause, limitInput, moreLine, oneLine, pagedLeftOut,
  permalinkLines, PROJECT_REF_INPUT, REPO_PATH_INPUT, citeText, type BrainReadAnswer,
} from "./brain-read-format.js";
import {
  BRAIN_AGENT_TEXT_MAX_CHARS, BRAIN_AGENT_TOOL_LIMITS, BRAIN_CITE_KINDS, BRAIN_CLAIM_KINDS, type BrainSearchHitView,
  type BrainSearchView,
} from "./brain-read-types.js";

const LIMITS = BRAIN_AGENT_TOOL_LIMITS.search;

export const BRAIN_SEARCH_DESCRIPTION =
  "Search a Matrix project's Company Brain: pull requests, commits, specs, issues, notes and other synced " +
  "documents, plus the decisions, invariants, commitments and risks found in them. Best match first, with " +
  "permalinks. Read-only; answers from the last sync. Quote a \"phrase\" to match it in order; end a word with * " +
  "for a prefix.";

export const BRAIN_SEARCH_INPUT_SHAPE = {
  project: PROJECT_REF_INPUT,
  query: z.string().trim().min(1).max(500).refine((value) => !value.includes("\0"))
    .describe("Words to find; \"quoted phrase\" matches in order, word* matches a prefix"),
  kinds: z.array(z.enum(BRAIN_CITE_KINDS)).min(1).max(8).optional()
    .describe("Only these document kinds (pr, commit, spec, issue, note, ...)"),
  claimKinds: z.array(z.enum(BRAIN_CLAIM_KINDS)).min(1).max(4).optional()
    .describe("Only claims of these kinds (invariant, decision, commitment, risk)"),
  path: REPO_PATH_INPUT.optional(),
  from: DATE_INPUT.optional().describe("Updated on or after: YYYY-MM-DD or an ISO time with offset"),
  to: DATE_INPUT.optional().describe("Updated before: YYYY-MM-DD or an ISO time with offset"),
  limit: limitInput(LIMITS.max, LIMITS.default, "Results").optional(),
  cursor: cursorInput("brain_search", 512).optional(),
};

const CLAIM_WORDS = { invariant: "Invariant", decision: "Decision", commitment: "Commitment", risk: "Risk" } as const;

function hitBlock(hit: BrainSearchHitView, position: number): string {
  if (hit.claim) {
    const stale = hit.claim.stale ? " [stale]" : "";
    const label = hit.claim.label ? ` (${oneLine(hit.claim.label, 80)})` : "";
    return [
      `${position}. ${CLAIM_WORDS[hit.claim.kind] ?? "Claim"} in ${citeText(hit.cite)}${stale}`,
      ...permalinkLines(hit.cite),
      `   Claim${label}: ${oneLine(hit.claim.statement)}`,
    ].join("\n");
  }
  const snippet = hit.snippet;
  const text = `${snippet.truncatedStart ? "..." : ""}${oneLine(snippet.text)}${snippet.truncatedEnd ? "..." : ""}`;
  return [`${position}. ${citeText(hit.cite)}`, ...permalinkLines(hit.cite), ...(text ? [`   Match: ${text}`] : [])]
    .join("\n");
}

function noticeClause(view: BrainSearchView): string {
  const parts: string[] = [];
  if (view.notices.includes("terms_dropped")) parts.push(" Only the first 16 terms were used.");
  if (view.notices.includes("candidates_capped")) parts.push(" Only the top 200 matches were ranked.");
  if (view.notices.includes("any_term_fallback")) {
    parts.push(" Few results held every word, so results with any of them follow.");
  }
  return parts.join("");
}

export function formatBrainSearch(view: BrainSearchView): string {
  const how = view.mode === "hybrid" ? "best first (words and meaning)" : "best first";
  const tail = `${noticeClause(view)}${freshnessClause(view.freshness)}`;
  return composeAnswer({
    maxChars: BRAIN_AGENT_TEXT_MAX_CHARS.brain_search,
    header: (shown) => `Search "${oneLine(view.q, 500)}": ${shown} ${shown === 1 ? "result" : "results"}, ${how}.${tail}`,
    blocks: view.items.map((hit, index) => hitBlock(hit, index + 1)),
    more: moreLine("brain_search", view.nextCursor),
    leftOut: pagedLeftOut("result", "results"),
  });
}

export function renderBrainSearch(view: BrainSearchView): BrainReadAnswer {
  if (view.items.length > 0) return { text: formatBrainSearch(view), external: true };
  if (view.notices.includes("query_empty_after_parse")) {
    return {
      text: "That query has no searchable words. Use letters or digits, quote a phrase, or end a word with * for a prefix.",
      external: false,
    };
  }
  return { text: `No Company Brain results for "${oneLine(view.q, 500)}".${freshnessClause(view.freshness)}`, external: false };
}

export const BRAIN_SEARCH_MESSAGES = {
  notFound: "That project was not found.",
  invalid: "That search is not valid. Check the dates, path and kinds, and pass only a cursor from a previous brain_search answer.",
  notConfigured: "Meaning search is not available for this project; plain word search still works.",
} as const;
