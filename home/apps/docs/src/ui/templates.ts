/**
 * Starting points on the start screen. Each one is Markdown that the engine's
 * `createDocxFromMarkdown` turns into a real Word document, so it opens,
 * edits, saves and reopens like any other.
 */

export type DocsTemplateId = "blank" | "memo" | "meeting-notes";

export interface DocsTemplateInfo {
  id: DocsTemplateId;
  label: string;
  description: string;
  /** Name of the new document. */
  name: string;
}

export const DOCS_TEMPLATES: readonly DocsTemplateInfo[] = [
  { id: "blank", label: "Blank document", description: "An empty page", name: "Untitled" },
  { id: "memo", label: "Memo", description: "To, from, subject and summary", name: "Memo" },
  { id: "meeting-notes", label: "Meeting notes", description: "Agenda, decisions and actions", name: "Meeting notes" },
];

export function isDocsTemplateId(value: string): value is DocsTemplateId {
  return DOCS_TEMPLATES.some((template) => template.id === value);
}

export interface TemplateContext {
  /** The owner's name, used as the author. */
  author: string;
  date: Date;
  locale?: string;
}

function longDate(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
}

/** Markdown of a template; null for the blank document, which the session creates itself. */
export function templateMarkdown(id: DocsTemplateId, context: TemplateContext): string | null {
  // The name lands inside Markdown: characters that would start markup or end a table cell become spaces.
  const author = context.author.replace(/[|*_`#[\]<>\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Me";
  const today = longDate(context.date, context.locale);
  if (id === "memo") {
    return [
      "# Memo",
      "",
      "**To:** Recipients",
      "",
      `**From:** ${author}`,
      "",
      `**Date:** ${today}`,
      "",
      "**Subject:** What this memo is about",
      "",
      "## Summary",
      "",
      "State the main point in one or two sentences.",
      "",
      "## Background",
      "",
      "Give the facts the reader needs to follow your reasoning.",
      "",
      "## Next steps",
      "",
      "- What happens next, and who does it",
      "- When it should be done",
      "",
    ].join("\n");
  }
  if (id === "meeting-notes") {
    return [
      "# Meeting notes",
      "",
      `**Date:** ${today}`,
      "",
      `**Attendees:** ${author}`,
      "",
      "## Agenda",
      "",
      "1. First topic",
      "2. Second topic",
      "",
      "## Notes",
      "",
      "What was discussed, topic by topic.",
      "",
      "## Decisions",
      "",
      "- What was decided, and why",
      "",
      "## Action items",
      "",
      "| Action | Owner | Due |",
      "| --- | --- | --- |",
      `| Follow up on the first topic | ${author} | ${today} |`,
      "",
    ].join("\n");
  }
  return null;
}
