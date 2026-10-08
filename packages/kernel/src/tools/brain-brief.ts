import { z } from "zod/v4";
import {
  citeShort, composeAnswer, linesLeftOut, oneLine, permalinkLines, plural, PROJECT_REF_INPUT, type BrainReadAnswer,
} from "./brain-read-format.js";
import {
  BRAIN_AGENT_TEXT_MAX_CHARS, type BrainBriefChangeGroup, type BrainBriefLine, type BrainBriefView,
} from "./brain-read-types.js";

export const BRAIN_BRIEF_DESCRIPTION =
  "Read the Company Brain brief of a Matrix project: what needs attention, new decisions, open commitments, new " +
  "risks and what changed, each line citing its source with a permalink. Read-only. Pass a date (YYYY-MM-DD, " +
  "default today UTC) and a window: day (default) or week (the seven days ending on the date).";

export const BRAIN_BRIEF_INPUT_SHAPE = {
  project: PROJECT_REF_INPUT,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Day of the brief, YYYY-MM-DD (default today UTC)"),
  window: z.enum(["day", "week"]).optional().describe("day (default) or week"),
};

const SUMMARY_MAX_CHARS = 1_200;
const GROUP_ITEMS_MAX = 10;

function lineExtras(line: BrainBriefLine): string {
  const parts: string[] = [];
  if (line.due) parts.push(`due ${oneLine(line.due, 10)}`);
  if (line.assignee) parts.push(`assignee ${oneLine(line.assignee, 120)}`);
  if (line.severity) parts.push(`severity ${oneLine(line.severity, 10)}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function lineBlock(line: BrainBriefLine, position: number): string {
  const [primary, ...others] = line.cites;
  const source = primary ? ` - ${citeShort(primary)}` : "";
  const also = others.length > 0 ? [`   Also: ${others.map(citeShort).join(", ")}`] : [];
  return [
    `${position}. ${oneLine(line.text)}${lineExtras(line)}${source}`,
    ...(primary ? permalinkLines(primary) : []),
    ...also,
  ].join("\n");
}

function groupBlock(group: BrainBriefChangeGroup, position: number): string {
  const items = group.items.slice(0, GROUP_ITEMS_MAX).map((line) => {
    const cite = line.cites[0];
    const link = cite?.permalink ? ` ${oneLine(cite.permalink, 600)}` : "";
    return `   - ${oneLine(line.text)}${cite ? ` - ${citeShort(cite)}` : ""}${link}`;
  });
  const rest = group.items.length - items.length;
  if (rest > 0) items.push(`   (+${rest} more)`);
  return [`${position}. ${oneLine(group.label, 200)}: ${group.created} new, ${group.revised} revised`, ...items].join("\n");
}

const SECTIONS = [
  ["attention", "Needs attention"], ["decisions", "Decisions"], ["commitments", "Open commitments"],
  ["risks", "Risks"],
] as const;

function briefBlocks(view: BrainBriefView): string[] {
  const blocks: string[] = [];
  for (const [key, title] of SECTIONS) {
    view.sections[key].forEach((line, index) => {
      const block = lineBlock(line, blocks.length + 1);
      blocks.push(index === 0 ? `${title}:\n${block}` : block);
    });
  }
  view.sections.changes.forEach((group, index) => {
    const block = groupBlock(group, blocks.length + 1);
    blocks.push(index === 0 ? `Changes:\n${block}` : block);
  });
  return blocks;
}

function headerText(view: BrainBriefView): string {
  const s = view.sections;
  const counts = [
    plural(s.attention.length, "attention item"), plural(s.decisions.length, "decision"),
    plural(s.commitments.length, "open commitment"), plural(s.risks.length, "risk"),
    plural(s.changes.length, "changed source"),
  ].join(", ");
  const cut = view.truncated ? " Some sections were cut at their caps." : "";
  return `Brief for ${oneLine(view.date, 10)} (${view.window === "week" ? "week" : "day"}): ${counts}.${cut}`;
}

export function formatBrainBrief(view: BrainBriefView): string {
  return composeAnswer({
    maxChars: BRAIN_AGENT_TEXT_MAX_CHARS.brain_brief,
    header: () => headerText(view),
    preface: view.summary ? [`Summary: ${oneLine(view.summary.text, SUMMARY_MAX_CHARS)}`] : [],
    blocks: briefBlocks(view),
    more: null,
    leftOut: linesLeftOut,
  });
}

export function renderBrainBrief(view: BrainBriefView): BrainReadAnswer {
  const s = view.sections;
  const empty = [s.attention, s.decisions, s.commitments, s.risks, s.changes].every((list) => list.length === 0);
  if (empty && !view.summary) {
    return { text: `Nothing to report for ${oneLine(view.date, 10)} (${view.window === "week" ? "week" : "day"}).`, external: false };
  }
  return { text: formatBrainBrief(view), external: true };
}

export const BRAIN_BRIEF_MESSAGES = {
  notFound: "That project was not found.",
  invalid: "That date is not valid. Pass YYYY-MM-DD within the last year and not after today (UTC).",
} as const;
