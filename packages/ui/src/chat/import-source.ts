import type { CanonicalChatImportSource } from "@matrix-os/contracts";

export type ChatImportSourceFilterValue = "all" | "imported" | "claude" | "codex";
export const SOURCE_OPTIONS = [
  { value: "all", label: "All" }, { value: "imported", label: "Imported" },
  { value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" },
] as const;

/** Share source semantics across records and legacy display adapters. Search composes independently. */
export function filterChatsByImportSource<T>(items: readonly T[], filter: ChatImportSourceFilterValue,
  source: (item: T) => CanonicalChatImportSource | undefined): T[] {
  return items.filter(item => filter === "all" || (filter === "imported" ? Boolean(source(item)) : source(item)?.harness === filter));
}
