/**
 * Impact brief as a GitHub pull request comment body. Pure; nothing here posts anything. Every piece of document
 * text is single-lined, cut, stripped of control and format characters (bidi overrides, zero-width marks) and
 * Markdown-escaped ("&" too, so no entity can spell "@" or "#"). A zero-width space then goes after "@" and "#" and
 * inside "GH-1", "://" and "www." so the text cannot mention people, reference issues or become a link. Paths go in
 * one-line code spans (control and format characters become "?"). The only links are https cite permalinks.
 * The whole body stays under BRAIN_IMPACT_LIMITS.commentMaxChars; a cut is marked and reported as truncated.
 */
import {
  BRAIN_IMPACT_LIMITS, type BrainCiteView, type BrainImpactClaim, type BrainImpactCommentFormatter,
  type BrainImpactDependentTotals, type BrainImpactNotice, type BrainImpactView,
} from "../contracts.js";

const TITLE_MAX_CHARS = 200;
const STATEMENT_MAX_CHARS = 500;
const QUOTE_MAX_CHARS = 300;
const URL_MAX_CHARS = 2_048;
const SAFE_URL = /^https:\/\/[^\s<>()"'`\\]+$/;
const MARKDOWN_SPECIAL = /[\\`*_[\]<>|~!&]/g;
/** Where GitHub would start a mention, an issue reference ("#1", "GH-1") or a link ("x://", "www."). */
const LINK_POINTS = /(?<=[@#])|(?<=GH)(?=-\d)|(?<=:)(?=\/\/)|(?<=www)(?=\.)/gi;
const ZERO_WIDTH_SPACE = "\u200b";
const CUT_LINE = "_Cut to fit the comment size limit._";
/** Dependents listed in the comment; the view keeps all of them. */
export const COMMENT_DEPENDENTS_MAX = 30;
const FOOTER = "_From the Matrix OS Company Brain. Importing files come from a static scan and test coverage from file"
  + " names and imports, so both are approximate._";

const NOTICE_TEXT: Readonly<Record<BrainImpactNotice, string>> = {
  changed_files_capped: "Only the first changed files are listed.",
  dependents_capped: "More files import the changed files than are listed.",
  scan_capped: "The import scan covered only part of the repository.",
  read_budget_exhausted: "The import scan stopped at its read limit.",
  run_budget_exhausted: "The import scan stopped at its time limit.",
  prior_capped: "Earlier pull requests are listed for only some of the changed files.",
  claims_capped: "More invariants or decisions apply, or name more changed files, than are listed.",
  untested_capped: "More changed code lacks a matching test change than is listed.",
  specs_capped: "More specs, or more changed files in a spec, were touched than are listed.",
  no_git_source: "This project has no git source in the brain, so its history is missing.",
  brain_behind_head: "The brain has not synced the merge base yet, so recent work may be missing.",
};

function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]!) ? max - 1 : max;
  return `${text.slice(0, end).trimEnd()}...`;
}

/** One line of escaped text that cannot mention, reference or link. */
export function plainText(text: string, max: number): string {
  const line = cut(text.replace(/\p{Cf}+/gu, "").replace(/\p{Cc}+/gu, " ").replace(/\s+/gu, " ").trim(), max);
  return line.replace(MARKDOWN_SPECIAL, "\\$&").replace(LINK_POINTS, ZERO_WIDTH_SPACE);
}

/** A one-line code span (control and format characters become "?") long enough for any backtick run inside. */
export function code(text: string): string {
  const safe = text.replace(/[\p{Cc}\p{Cf}]/gu, "?");
  const longest = Math.max(0, ...(safe.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = safe.startsWith("`") || safe.endsWith("`") ? " " : "";
  return `${fence}${pad}${safe}${pad}${fence}`;
}

function cite(item: BrainCiteView): string {
  const label = plainText(item.label, TITLE_MAX_CHARS);
  const url = item.permalink;
  return url.length <= URL_MAX_CHARS && SAFE_URL.test(url) ? `[${label}](${url})` : label;
}

function claimLines(claim: BrainImpactClaim): string[] {
  const label = claim.label === null ? "" : `**${plainText(claim.label, TITLE_MAX_CHARS)}:** `;
  return [
    `- ${label}${plainText(claim.statement, STATEMENT_MAX_CHARS)} (${cite(claim.cite)})`,
    `  > ${plainText(claim.quote, QUOTE_MAX_CHARS)}`,
  ];
}

function changeLine(file: BrainImpactView["changedFiles"][number]): string {
  const from = file.previousPath === null ? "" : ` from ${code(file.previousPath)}`;
  return `- ${code(file.path)} ${file.status.replace("_", " ")}${from}${file.isTest ? " (test)" : ""}`;
}

/** At most `max` lines, then one "and N more" line; `total` also counts items that have no line. */
function capped(lines: readonly string[], max: number, total = lines.length): string[] {
  const shown = lines.slice(0, max);
  return total <= shown.length ? shown : [...shown, `- and ${total - shown.length} more`];
}

/** "1,204 direct, 3,310 through one more file" for the dependents heading. */
function totalsText(totals: BrainImpactDependentTotals): string {
  const deeper = totals.depth2 === null ? "" : `, ${totals.depth2.toLocaleString("en-US")} through one more file`;
  return `: ${totals.depth1.toLocaleString("en-US")} direct${deeper}`;
}

/** Warnings first and the long approximate dependents last, so a cut never hides the notes or the claims. */
function sections(view: BrainImpactView): Array<{ readonly heading: string; readonly lines: readonly string[] }> {
  return [
    { heading: "Notes", lines: view.notices.map((notice) => `- ${NOTICE_TEXT[notice]}`) },
    { heading: `Changed files (${view.changedTotal})`, lines: view.changedFiles.map(changeLine) },
    { heading: "Invariants to keep", lines: view.invariants.flatMap(claimLines) },
    { heading: "Decisions", lines: view.decisions.flatMap(claimLines) },
    {
      heading: "Specs touched",
      lines: view.specs.map((item) => `- ${item.cite === null ? code(item.spec) : cite(item.cite)}: `
        + item.changedPaths.map(code).join(", ")),
    },
    {
      heading: "Changed code without a matching test change (approximate)",
      lines: view.untested.map((item) => `- ${code(item.path)}`),
    },
    {
      heading: "Earlier pull requests",
      lines: view.prior.map((item) => `- ${code(item.path)}: ${item.items.map(cite).join(", ")}`),
    },
    {
      heading: `Files that import the changed files (approximate)${totalsText(view.dependentTotals)}`,
      lines: capped(view.dependents.map((item) =>
        `- ${code(item.path)} imports ${code(item.via)} (depth ${item.depth})`), COMMENT_DEPENDENTS_MAX,
      Math.max(view.dependents.length, view.dependentTotals.depth1 + (view.dependentTotals.depth2 ?? 0))),
    },
  ];
}

export const formatBrainImpactComment: BrainImpactCommentFormatter = (view: BrainImpactView) => {
  const budget = BRAIN_IMPACT_LIMITS.commentMaxChars - CUT_LINE.length - FOOTER.length - 4;
  const out: string[] = [
    `### Impact brief: ${code(view.head.ref)} against ${code(view.base.ref)}`,
    "",
    `Merge base ${code(view.mergeBase.slice(0, 12))}, head ${code(view.head.sha.slice(0, 12))}.`,
  ];
  let size = out.join("\n").length;
  let truncated = false;
  const push = (line: string): boolean => {
    if (truncated || size + line.length + 1 > budget) {
      truncated = true;
      return false;
    }
    out.push(line);
    size += line.length + 1;
    return true;
  };
  for (const section of sections(view)) {
    if (section.lines.length === 0) continue;
    if (!push(`\n#### ${section.heading}`)) break;
    if (!section.lines.every(push)) break;
  }
  if (truncated) out.push("", CUT_LINE);
  out.push("", FOOTER);
  return { markdown: out.join("\n"), truncated };
};
