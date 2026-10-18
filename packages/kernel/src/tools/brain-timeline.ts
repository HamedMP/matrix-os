import { z } from "zod/v4";
import {
  citeText, composeAnswer, cursorInput, freshnessClause, limitInput, moreLine, oneLine, pagedLeftOut, permalinkLines,
  PROJECT_REF_INPUT, type BrainReadAnswer,
} from "./brain-read-format.js";
import {
  BRAIN_AGENT_TEXT_MAX_CHARS, BRAIN_AGENT_TOOL_LIMITS, type BrainTimelineItemView, type BrainTimelineView,
} from "./brain-read-types.js";

const LIMITS = BRAIN_AGENT_TOOL_LIMITS.timeline;

export const BRAIN_TIMELINE_DESCRIPTION =
  "List what happened to one thing in a Matrix project, newest first: the pull requests, commits, specs, reviews, " +
  "issues and notes that touch a file, folder, person, pull request, issue or spec, how each one is linked, and " +
  "permalinks. Read-only. Name the entity as kind:key, for example file:packages/gateway/src/server.ts, " +
  "folder:packages/gateway/src/brain, person:email:ana@example.com, pull_request:2078, issue:ENG-42 or " +
  "spec:specs/551-company-brain-store.";

export const BRAIN_TIMELINE_INPUT_SHAPE = {
  project: PROJECT_REF_INPUT,
  entity: z.string().min(1).max(600).regex(/^[^\p{Cc}]+$/u)
    .describe("Entity ref kind:key (file, folder, person, pull_request, issue, spec, document) or an ent_ id"),
  limit: limitInput(LIMITS.max, LIMITS.default, "Items").optional(),
  cursor: cursorInput("brain_timeline", 512).optional(),
};

function itemBlock(item: BrainTimelineItemView, position: number): string {
  const inferred = item.mode === "inferred" ? " [inferred]" : "";
  const how = item.linkTypes.map((type) => oneLine(type, 40).replaceAll("_", " ")).join(", ");
  const paths = item.matchedPaths.length > 0 ? `; paths: ${item.matchedPaths.map((path) => oneLine(path, 300)).join(", ")}` : "";
  return [
    `${position}. ${citeText(item.cite)}${inferred}`,
    ...permalinkLines(item.cite),
    ...(how || paths ? [`   Linked: ${how || "related"}${paths}`] : []),
  ].join("\n");
}

function entityText(view: BrainTimelineView): string {
  const name = oneLine(view.entity.displayName || view.entity.key, 200);
  return `${oneLine(view.entity.kind, 40).replaceAll("_", " ")} ${name}`;
}

export function formatBrainTimeline(view: BrainTimelineView): string {
  return composeAnswer({
    maxChars: BRAIN_AGENT_TEXT_MAX_CHARS.brain_timeline,
    header: (shown) =>
      `Timeline of ${entityText(view)}: ${shown} ${shown === 1 ? "item" : "items"}, newest first.` +
      freshnessClause(view.freshness),
    blocks: view.items.map((item, index) => itemBlock(item, index + 1)),
    more: moreLine("brain_timeline", view.nextCursor),
    leftOut: pagedLeftOut("item", "items"),
  });
}

export function renderBrainTimeline(view: BrainTimelineView): BrainReadAnswer {
  if (view.items.length > 0) return { text: formatBrainTimeline(view), external: true };
  return {
    text: `Nothing in the Company Brain touches ${entityText(view)} yet.${freshnessClause(view.freshness)}`,
    external: true,
  };
}

export const BRAIN_TIMELINE_MESSAGES = {
  notFound: "That project or entity was not found. Name the entity as kind:key, for example file:src/index.ts.",
  invalid:
    "That entity or cursor is not valid. Name the entity as kind:key (file, folder, person, pull_request, issue, " +
    "spec) and pass only a cursor from a previous brain_timeline answer.",
} as const;
