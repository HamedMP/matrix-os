import {
  citeText, composeAnswer, cursorInput, limitInput, moreLine, oneLine, pagedLeftOut, permalinkLines,
  PROJECT_REF_INPUT, type BrainReadAnswer,
} from "./brain-read-format.js";
import {
  BRAIN_AGENT_TEXT_MAX_CHARS, BRAIN_AGENT_TOOL_LIMITS, type BrainConflictSideView, type BrainConflictsView,
  type BrainConflictView,
} from "./brain-read-types.js";

const LIMITS = BRAIN_AGENT_TOOL_LIMITS.conflicts;
const QUOTE_MAX_CHARS = 300;

export const BRAIN_CONFLICTS_DESCRIPTION =
  "List contradictions the Company Brain found in a Matrix project: decisions or invariants with the same label " +
  "that disagree, specs still marked Draft after a merged pull request shipped them, and commitments marked done in " +
  "one place and deferred in another. Each side cites its document with a verbatim quote and a permalink. Read-only.";

export const BRAIN_CONFLICTS_INPUT_SHAPE = {
  project: PROJECT_REF_INPUT,
  limit: limitInput(LIMITS.max, LIMITS.default, "Conflicts").optional(),
  cursor: cursorInput("brain_conflicts", 512).optional(),
};

const RULE_WORDS: Readonly<Record<string, string>> = {
  label_disagreement: "Statements disagree",
  draft_spec_shipped: "Draft spec already shipped",
  commitment_reversed: "Commitment reversed",
};

function sideLines(side: BrainConflictSideView, letter: string): string[] {
  return [
    `   ${letter}) ${citeText(side.cite)}`,
    ...permalinkLines(side.cite, "      "),
    `      "${oneLine(side.quote, QUOTE_MAX_CHARS)}"`,
  ];
}

function conflictBlock(conflict: BrainConflictView, position: number): string {
  const rule = RULE_WORDS[conflict.rule] ?? "Conflict";
  return [
    `${position}. ${rule}: ${oneLine(conflict.summary)}`,
    ...sideLines(conflict.sides[0], "a"),
    ...sideLines(conflict.sides[1], "b"),
  ].join("\n");
}

export function formatBrainConflicts(view: BrainConflictsView): string {
  return composeAnswer({
    maxChars: BRAIN_AGENT_TEXT_MAX_CHARS.brain_conflicts,
    header: (shown) => `Conflicts: ${shown} found, newest first.`,
    blocks: view.items.map((conflict, index) => conflictBlock(conflict, index + 1)),
    more: moreLine("brain_conflicts", view.nextCursor),
    leftOut: pagedLeftOut("conflict", "conflicts"),
  });
}

export function renderBrainConflicts(view: BrainConflictsView): BrainReadAnswer {
  if (view.items.length > 0) return { text: formatBrainConflicts(view), external: true };
  return { text: "No conflicts found in this project's current claims and specs.", external: false };
}

export const BRAIN_CONFLICTS_MESSAGES = {
  notFound: "That project was not found.",
  invalid: "That cursor is not valid. Pass only a cursor from a previous brain_conflicts answer.",
} as const;
