import {
  MemoryImportRequestSchema,
  MemorySourceInputSchema,
  type MemoryEngine,
  type MemorySource,
  type MemorySourceInput,
  type MemoryJob,
  type MemoryWorkspaceSnapshot,
  type MemorySearchResult,
} from "@matrix-os/contracts";
export type { MemoryEngine, MemorySource, MemoryJob, MemorySearchResult };
export type MemorySourceKind = MemorySource["kind"];
export type MemoryImportSource = MemorySourceInput;
export type MemorySnapshot = MemoryWorkspaceSnapshot;
export interface MemoryWorkspaceClient {
  snapshot(options?: {
    cursor?: string;
    limit?: number;
    q?: string;
    kind?: MemorySourceKind;
    collection?: string;
  }): Promise<MemorySnapshot>;
  getSource(id: string): Promise<MemorySource>;
  importSources(
    sources: MemoryImportSource[],
    clientRequestId: string,
  ): Promise<{ sources: MemorySource[] }>;
  updateSource(
    id: string,
    changes: {
      baseRevision: number;
      title: string;
      content: string;
      collection: string;
    },
  ): Promise<MemorySource>;
  deleteSource(id: string): Promise<void>;
  search(query: string, engine: MemoryEngine): Promise<MemorySearchResult>;
  compare(
    query: string,
  ): Promise<{ query: string; results: MemorySearchResult[] }>;
  actJob?(id: string, action: "retry" | "cancel"): Promise<void>;
}
export function parseMemoryImport(
  name: string,
  text: string,
): MemoryImportSource[] {
  if (new TextEncoder().encode(text).length > 1_000_000)
    throw new Error("import_too_large");
  if (name.toLowerCase().endsWith(".json"))
    return MemoryImportRequestSchema.parse({
      clientRequestId: "export-preview",
      sources: JSON.parse(text),
    }).sources;
  if (!/\.(md|txt)$/i.test(name)) throw new Error("unsupported_import");
  return [
    MemorySourceInputSchema.parse({
      externalId: `file:${crypto.randomUUID()}`,
      title: name.replace(/\.(md|txt)$/i, ""),
      content: text,
      kind: /\.md$/i.test(name) ? "note" : "document",
      collection: "Imported",
    }),
  ];
}
export function filterMemorySources(
  sources: readonly MemorySource[],
  kind: MemorySourceKind | "all",
  collection: string | null,
  query: string,
): MemorySource[] {
  const needle = query.trim().toLocaleLowerCase().slice(0, 500);
  return sources
    .filter(
      (s) =>
        (kind === "all" || s.kind === kind) &&
        (!collection || s.collection === collection) &&
        (!needle ||
          `${s.title}\n${s.preview}\n${s.collection}`
            .toLocaleLowerCase()
            .includes(needle)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function memoryCollections(
  sources: readonly MemorySource[],
): { name: string; count: number }[] {
  const counts: Record<string, number> = Object.create(null);
  for (const source of sources)
    counts[source.collection] = (counts[source.collection] ?? 0) + 1;
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => ({ name, count }));
}
export function safeMemoryMessage(error: unknown): string {
  if (error instanceof Error && error.message === "import_too_large")
    return "Choose an export up to 1 MB.";
  if (error instanceof Error && error.message === "unsupported_import")
    return "Choose a Markdown, plain text or JSON source export.";
  if (error instanceof Error && error.message === "conflict")
    return "This source changed elsewhere. Your edits are preserved. Reopen the source to review the latest version.";
  return "Something went wrong. Please try again.";
}
export const memoryStatusLabel = {
  pending: "Waiting",
  processing: "Learning",
  ready: "Ready",
  failed: "Needs attention",
  not_configured: "Not configured",
  cancelled: "Cancelled",
} as const;
