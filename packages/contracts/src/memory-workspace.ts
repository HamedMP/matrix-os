import { z } from "zod/v4";
export const MEMORY_ENGINES = ["hindsight", "openviking"] as const;
export const MemoryEngineSchema = z.enum(MEMORY_ENGINES);
export type MemoryEngine = z.infer<typeof MemoryEngineSchema>;
export const MemorySourceKindSchema = z.enum([
  "note",
  "email",
  "calendar",
  "document",
]);
const text = (max: number) => z.string().trim().min(1).max(max);
export const MemorySourceInputSchema = z
  .object({
    externalId: text(512),
    title: text(300),
    content: text(200000),
    kind: MemorySourceKindSchema,
    collection: text(200),
    // Selected imports preserve tombstones unless the owner explicitly restores them.
    restoreDeleted: z.boolean().optional(),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    metadata: z
      .record(z.string().max(80), z.string().max(2000))
      .refine((value) => Object.keys(value).length <= 20)
      .optional(),
  })
  .strict();
export const MemoryImportRequestSchema = z
  .object({
    clientRequestId: text(128),
    sources: z.array(MemorySourceInputSchema).min(1).max(100),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.sources.map((s) => s.externalId)).size ===
      value.sources.length,
    "Duplicate source IDs",
  )
  .refine(
    (value) =>
      value.sources.reduce((n, s) => n + s.content.length, 0) <= 1000000,
    "Import too large",
  );
export const MemorySourcePatchSchema = z
  .object({
    baseRevision: z.number().int().positive(),
    title: text(300).optional(),
    content: text(200000).optional(),
    collection: text(200).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.content !== undefined ||
      value.collection !== undefined,
    "Empty update",
  );
export const MemorySearchRequestSchema = z
  .object({
    query: text(2000),
    engine: MemoryEngineSchema,
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();
export const MemoryCompareRequestSchema = z
  .object({
    query: text(2000),
    limit: z.number().int().min(1).max(20).default(8),
  })
  .strict();
export const MemoryContextRequestSchema = z
  .object({ sourceIds: z.array(z.uuid()).min(1).max(30) })
  .strict()
  .refine((v) => new Set(v.sourceIds).size === v.sourceIds.length);
export type MemorySourceInput = z.infer<typeof MemorySourceInputSchema>;
export type MemoryImportRequest = z.infer<typeof MemoryImportRequestSchema>;
export type MemorySourcePatch = z.infer<typeof MemorySourcePatchSchema>;
export type MemoryIngestionStatus =
  "pending" | "processing" | "ready" | "failed" | "cancelled" | "not_configured";
export interface MemorySource {
  id: string;
  title: string;
  content: string;
  preview: string;
  contentTruncated?: boolean;
  kind: z.infer<typeof MemorySourceKindSchema>;
  collection: string;
  revision: number;
  occurredAt: string | null;
  updatedAt: string;
  ingestion: Record<MemoryEngine, MemoryIngestionStatus>;
}
export interface MemoryJob {
  id: string;
  sourceId: string;
  engine: MemoryEngine;
  revision: number;
  operation: "upsert" | "delete";
  status: "pending" | "processing" | "ready" | "failed" | "cancelled";
  attempts: number;
  updatedAt: string;
}
export interface MemoryWorkspaceSnapshot {
  collections: Array<{
    name: string;
    count: number;
  }>;
  collectionsTruncated: boolean;
  totalSources: number;
  filteredSources: number;
  hasMore: boolean;
  nextCursor: string | null;
  sources: MemorySource[];
  engines: Array<{
    id: MemoryEngine;
    status: "configured" | "not_configured";
  }>;
  jobs: MemoryJob[];
}
export interface MemoryCitation {
  sourceId: string;
  revision: number;
  label: string;
}
export interface MemorySearchHit {
  sourceId: string;
  title: string;
  text: string;
  score?: number;
  citation: MemoryCitation;
  provenance: "document" | "summary";
}
export interface MemorySearchResult {
  engine: MemoryEngine;
  status: "ready" | "unavailable" | "not_configured";
  hits: MemorySearchHit[];
  latencyMs: number;
}
export interface MemoryCompareResult {
  query: string;
  results: MemorySearchResult[];
}
export interface MemoryContextResult {
  text: string;
  sources: Array<{
    sourceId: string;
    revision: number;
    title: string;
    truncated?: boolean;
  }>;
  estimatedTokens: number;
}
export interface MemoryImportResult {
  sources: MemorySource[];
  receipt: {
    clientRequestId: string;
    sourceIds: string[];
  };
}
export const MemoryLibraryRequestSchema = z
  .object({
    cursor: z.coerce.number().int().min(0).max(100000).default(0),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    q: z.string().trim().max(200).default(""),
    kind: MemorySourceKindSchema.optional(),
    collection: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type MemoryLibraryRequest = z.infer<typeof MemoryLibraryRequestSchema>;
