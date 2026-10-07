import type { EditionMessage, EditionScope, EditionView } from "./types";
export function filterEditions(
  messages: readonly EditionMessage[],
  sources: readonly { id: string; scope: "personal" | "work" }[],
  filter: {
    view: EditionView;
    scope: EditionScope;
    query: string;
    sourceId?: string;
  },
) {
  const query = filter.query.trim().toLocaleLowerCase();
  return messages.filter((m) => {
    const source = sources.find((s) => s.id === m.sourceId);
    if (
      !source ||
      (filter.scope !== "all" && source.scope !== filter.scope) ||
      (filter.sourceId && source.id !== filter.sourceId)
    )
      return false;
    if (
      filter.view === "review"
        ? m.classification !== "review"
        : m.classification !== "newsletter"
    )
      return false;
    if (
      (filter.view === "unread" && m.read) ||
      (filter.view === "saved" && !m.saved)
    )
      return false;
    return (
      !query ||
      [m.subject, m.sender, m.publication, m.excerpt]
        .join(" ")
        .toLocaleLowerCase()
        .includes(query)
    );
  });
}
export function publicationGroups(messages: readonly EditionMessage[]) {
  const groups: {
    name: string;
    count: number;
    unread: number;
    latest: EditionMessage;
  }[] = [];
  for (const message of messages) {
    const existing = groups.find((g) => g.name === message.publication);
    if (existing) {
      existing.count++;
      if (!message.read) existing.unread++;
    } else
      groups.push({
        name: message.publication,
        count: 1,
        unread: message.read ? 0 : 1,
        latest: message,
      });
  }
  return groups;
}
export function publicationTone(name: string): number {
  return [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 5;
}
export function readingMinutes(text: string): number {
  return Math.max(1, Math.ceil(text.split(/\s+/).length / 220));
}
export function editionDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "Date unavailable";
}
