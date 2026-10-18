import { z } from "zod/v4";
import {
  citeShort, citeText, composeAnswer, linesLeftOut, oneLine, permalinkLines, plural, PROJECT_REF_INPUT,
  type BrainReadAnswer,
} from "./brain-read-format.js";
import { BRAIN_AGENT_TEXT_MAX_CHARS, type BrainImpactClaim, type BrainImpactView } from "./brain-read-types.js";

/** A short branch name or a commit sha, as the gateway's GIT_BRANCH_NAME_PATTERN (never HEAD or refs/...). */
const REV_INPUT = z.string().max(200)
  .regex(/^(?![-/.])(?!HEAD$)(?!refs\/)(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*@\{)(?!.*\.lock(?:\/|$))[A-Za-z0-9._/-]{1,200}(?<![/.])$/);

export const BRAIN_IMPACT_DESCRIPTION =
  "Show what a branch or commit range changes in a Matrix project before review: changed files, the files that " +
  "import them (approximate), earlier pull requests on those files, the invariants and decisions that apply, specs " +
  "touched, and changed sources without a changed test. Read-only; reads local git objects of the project checkout " +
  "and never fetches. Pass head (a branch or commit) and optionally base (default: the default branch).";

export const BRAIN_IMPACT_INPUT_SHAPE = {
  project: PROJECT_REF_INPUT,
  head: REV_INPUT.describe("Branch name or commit sha to review"),
  base: REV_INPUT.optional().describe("Branch or commit to compare against (default: the default branch)"),
  depth: z.union([z.literal(1), z.literal(2)]).optional()
    .describe("Importer depth: 1 or 2 (default 2; depth-2 files fill the slots depth-1 files leave)"),
};

const STATUS_LETTERS: Readonly<Record<string, string>> = {
  added: "A", modified: "M", deleted: "D", renamed: "R", type_changed: "T",
};
const NOTICE_WORDS: Readonly<Record<string, string>> = {
  changed_files_capped: "only the first 500 changed files were read",
  dependents_capped: "the importer list was capped",
  scan_capped: "the import scan stopped at its file cap",
  read_budget_exhausted: "the import scan stopped at its read budget",
  run_budget_exhausted: "the run stopped at its time budget",
  prior_capped: "earlier pull requests are listed for only some changed files",
  claims_capped: "more invariants or decisions apply, or name more changed files, than are listed",
  untested_capped: "more changed sources lack a changed test than are listed",
  specs_capped: "more specs, or more changed files in a spec, were touched than are listed",
  no_git_source: "the project has no git source, so there is no history",
  brain_behind_head: "the brain has not synced the newest commits yet",
};

function claimBlock(claim: BrainImpactClaim, position: number): string {
  const label = claim.label ? `${oneLine(claim.label, 80)}: ` : "";
  const paths = claim.paths.length > 0 ? [`   Paths: ${claim.paths.map((path) => oneLine(path, 300)).join(", ")}`] : [];
  return [
    `${position}. ${label}${oneLine(claim.statement)} - ${citeShort(claim.cite)}`,
    ...permalinkLines(claim.cite),
    ...paths,
  ].join("\n");
}

/** Sections in order of review value; the budget cuts from the end. */
function impactBlocks(view: BrainImpactView): string[] {
  const blocks: string[] = [];
  const section = (title: string, items: readonly string[]) => {
    items.forEach((item, index) => blocks.push(index === 0 ? `${title}:\n${item}` : item));
  };
  let position = 0;
  section("Invariants to keep", view.invariants.map((claim) => claimBlock(claim, ++position)));
  section("Decisions that apply", view.decisions.map((claim) => claimBlock(claim, ++position)));
  section("Specs touched", view.specs.map((spec) => [
    `- ${oneLine(spec.spec, 300)} (${plural(spec.changedPaths.length, "changed file")})` +
      (spec.cite ? `: ${citeText(spec.cite)}` : ""),
    ...(spec.cite ? permalinkLines(spec.cite) : []),
  ].join("\n")));
  section("Changed sources without a changed test", view.untested.map((file) => `- ${oneLine(file.path, 1024)}`));
  section("Earlier pull requests", view.prior.map((prior) =>
    `- ${oneLine(prior.path, 1024)}: ${prior.items.map((cite) =>
      `${citeShort(cite)}${cite.permalink ? ` ${oneLine(cite.permalink, 600)}` : ""}`).join("; ")}`));
  section("Changed files", view.changedFiles.map((file) => {
    const from = file.previousPath ? ` (from ${oneLine(file.previousPath, 1024)})` : "";
    return `- ${STATUS_LETTERS[file.status] ?? "?"} ${oneLine(file.path, 1024)}${from}${file.isTest ? " [test]" : ""}`;
  }));
  section("Importers (approximate)", view.dependents.map((dependent) =>
    `- ${oneLine(dependent.path, 1024)} imports ${oneLine(dependent.via, 1024)}` +
      (dependent.depth === 2 ? " (second hop)" : "")));
  return blocks;
}

function refText(side: { readonly ref: string; readonly sha: string }): string {
  return `${oneLine(side.ref, 200)} (${oneLine(side.sha.slice(0, 12), 12)})`;
}

export function formatBrainImpact(view: BrainImpactView): string {
  const counts = [
    plural(view.changedTotal, "changed file"), `${plural(view.dependents.length, "importer")} (approximate)`,
    plural(view.invariants.length, "invariant"), plural(view.decisions.length, "decision"),
    plural(view.specs.length, "spec"), `${view.untested.length} without a changed test`,
  ].join(", ");
  const notices = view.notices.map((notice) => NOTICE_WORDS[notice] ?? oneLine(notice, 40));
  return composeAnswer({
    maxChars: BRAIN_AGENT_TEXT_MAX_CHARS.brain_impact,
    header: () => `Impact of ${refText(view.head)} against ${refText(view.base)}: ${counts}.`,
    preface: notices.length > 0 ? [`Notes: ${notices.join("; ")}.`] : [],
    blocks: impactBlocks(view),
    more: null,
    leftOut: linesLeftOut,
  });
}

export function renderBrainImpact(view: BrainImpactView): BrainReadAnswer {
  if (view.changedTotal === 0) {
    return { text: `No changes between ${refText(view.base)} and ${refText(view.head)}.`, external: true };
  }
  return { text: formatBrainImpact(view), external: true };
}

export const BRAIN_IMPACT_MESSAGES = {
  notFound: "That project, branch or commit was not found in the project checkout.",
  invalid: "That branch or commit is not valid. Pass a short branch name (main, feature/x) or a commit sha.",
} as const;
