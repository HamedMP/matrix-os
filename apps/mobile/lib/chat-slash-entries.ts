import type { CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";

/** A skill or command the selected model can be asked to run by name. */
export interface ChatSlashEntry {
  id: string;
  kind: "skill" | "command";
  name: string;
  description: string;
  /** What is written in a message to ask for it, such as "/review". */
  invocation: string;
}

const NO_ENTRIES: readonly ChatSlashEntry[] = [];

/**
 * The skills and commands of the selected model's engine, skills first, as
 * web and desktop list them. Another engine's are not offered in their place:
 * the selected one would not know them.
 */
export function chatSlashEntries(
  catalog: CanonicalProviderCatalog | null,
  selection: CanonicalChatModelSelection | null,
): readonly ChatSlashEntry[] {
  if (!catalog || !selection) return NO_ENTRIES;
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
  if (instance?.availability !== "available") return NO_ENTRIES;
  const entries = [
    ...instance.skills.map((entry) => ({ entry, kind: "skill" as const })),
    ...instance.commands.map((entry) => ({ entry, kind: "command" as const })),
  ].map(({ entry, kind }): ChatSlashEntry => ({
    id: `${kind}:${entry.id}`,
    kind,
    name: entry.displayName,
    description: entry.description,
    invocation: entry.invocation,
  }));
  return entries.length > 0 ? entries : NO_ENTRIES;
}

/**
 * The draft with the skill or command put first, where an engine looks for
 * one. One of `known` that the draft already starts with is replaced, not
 * stacked. Any other first word stays, even one that begins with a slash: it
 * may be a path the person is writing about.
 */
export function draftWithInvocation(draft: string, invocation: string, known: readonly string[]): string {
  const text = draft.trimStart();
  const firstWord = /^\S+/.exec(text)?.[0] ?? "";
  const rest = known.includes(firstWord) ? text.slice(firstWord.length).trimStart() : text;
  return `${invocation} ${rest}`;
}
