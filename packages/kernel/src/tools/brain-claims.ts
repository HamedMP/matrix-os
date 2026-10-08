import { z } from "zod/v4";
import {
  citeText, composeAnswer, cursorInput, limitInput, moreLine, oneLine, pagedLeftOut, permalinkLines,
  PROJECT_REF_INPUT, REPO_PATH_INPUT, type BrainReadAnswer,
} from "./brain-read-format.js";
import {
  BRAIN_AGENT_TEXT_MAX_CHARS, BRAIN_AGENT_TOOL_LIMITS, BRAIN_CLAIM_KINDS, type BrainClaimsView, type BrainClaimView,
} from "./brain-read-types.js";

const LIMITS = BRAIN_AGENT_TOOL_LIMITS.claims;

export const BRAIN_CLAIMS_DESCRIPTION =
  "List the invariants, decisions, commitments and risks found in a Matrix project's pull requests, commits and " +
  "specs, newest document first, each with the document it was read from and a permalink. Read-only; answers from " +
  "the last claims extraction. Filter by kind and by a repo-relative file or folder.";

export const BRAIN_CLAIMS_INPUT_SHAPE = {
  project: PROJECT_REF_INPUT,
  kind: z.enum(BRAIN_CLAIM_KINDS).optional().describe("invariant, decision, commitment or risk (default all)"),
  path: REPO_PATH_INPUT.optional(),
  limit: limitInput(LIMITS.max, LIMITS.default, "Claims").optional(),
  cursor: cursorInput("brain_claims", 640).optional(),
};

const KIND_WORDS = {
  invariant: ["Invariant", "Invariants"], decision: ["Decision", "Decisions"],
  commitment: ["Commitment", "Commitments"], risk: ["Risk", "Risks"],
} as const;

function fieldsText(claim: BrainClaimView): string {
  const parts: string[] = [];
  if (claim.fields.due) parts.push(`due ${oneLine(claim.fields.due, 10)}`);
  if (claim.fields.assignee) parts.push(`assignee ${oneLine(claim.fields.assignee, 120)}`);
  if (claim.fields.severity) parts.push(`severity ${oneLine(claim.fields.severity, 10)}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function claimBlock(claim: BrainClaimView, position: number): string {
  const stale = claim.stale ? " [stale]" : "";
  const label = claim.label ? `${oneLine(claim.label, 80)}: ` : "";
  return [
    `${position}. ${KIND_WORDS[claim.kind]?.[0] ?? "Claim"} in ${citeText(claim.document)}${stale}`,
    ...permalinkLines(claim.document),
    `   ${label}${oneLine(claim.statement)}${fieldsText(claim)}`,
  ].join("\n");
}

function filterText(view: BrainClaimsView): string {
  const what = view.kind ? KIND_WORDS[view.kind]?.[1] ?? "Claims" : "Claims";
  if (view.path === null) return what;
  return `${what} for ${oneLine(view.path, 1024)}${view.match === "folder" ? "/" : ""}`;
}

export function formatBrainClaims(view: BrainClaimsView): string {
  return composeAnswer({
    maxChars: BRAIN_AGENT_TEXT_MAX_CHARS.brain_claims,
    header: (shown) => `${filterText(view)}: ${shown} ${shown === 1 ? "claim" : "claims"}, newest document first.`,
    blocks: view.items.map((claim, index) => claimBlock(claim, index + 1)),
    more: moreLine("brain_claims", view.nextCursor),
    leftOut: pagedLeftOut("claim", "claims"),
  });
}

export function renderBrainClaims(view: BrainClaimsView): BrainReadAnswer {
  if (view.items.length > 0) return { text: formatBrainClaims(view), external: true };
  return {
    text: `${filterText(view)}: none found. Claims come from the last extraction; newer documents appear after the ` +
      "next extraction run.",
    external: false,
  };
}

export const BRAIN_CLAIMS_MESSAGES = {
  notFound: "That project was not found.",
  invalid:
    "That path or cursor is not valid. Pass a repo-relative path such as packages/gateway/src/ and only a cursor " +
    "from a previous brain_claims answer.",
} as const;
