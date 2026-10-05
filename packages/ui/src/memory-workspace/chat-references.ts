import type { CanonicalChatResourceReference, MemoryContextResult } from "@matrix-os/contracts";

/** Shared selection, label and revision receipts; surface adapters only route the private draft. */
export function memoryContextChatReferences(
  context: Pick<MemoryContextResult, "sources">,
): CanonicalChatResourceReference[] {
  const references: CanonicalChatResourceReference[] = context.sources.slice(0, 8).map(source => ({
    kind: "memory_source",
    id: source.sourceId,
    label: source.title.slice(0, 280),
    revision: String(source.revision),
  }));
  if (!references.length) throw new Error("context_unavailable");
  return references;
}
