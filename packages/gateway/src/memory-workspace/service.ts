import {
  MEMORY_ENGINES,
  type MemorySource,
  type MemoryImportRequest,
  type MemoryImportResult,
  type MemorySourcePatch,
  type MemoryJob,
  type MemoryEngine,
  type MemoryWorkspaceSnapshot,
  type MemorySearchResult,
  type MemoryContextResult,
  type MemoryLibraryRequest,
} from "@matrix-os/contracts";
import { MemoryNotFoundError, MemoryConflictError } from "./repository.js";
import type { MemoryEngines } from "./engines/index.js";
export interface MemoryServiceRepository {
  listSources(
    owner: string,
    options?: Partial<MemoryLibraryRequest>,
  ): Promise<MemorySource[]>;
  countSources?(
    owner: string,
    options?: Partial<MemoryLibraryRequest>,
  ): Promise<{
    totalSources: number;
    filteredSources: number;
  }>;
  collections?(owner: string): Promise<{
    collections: Array<{
      name: string;
      count: number;
    }>;
    collectionsTruncated: boolean;
  }>;
  getSource(owner: string, id: string): Promise<MemorySource | null>;
  listJobs(owner: string): Promise<MemoryJob[]>;
  importSources?(
    owner: string,
    input: MemoryImportRequest,
  ): Promise<MemoryImportResult>;
  patchSource?(
    owner: string,
    id: string,
    input: MemorySourcePatch,
  ): Promise<MemorySource>;
  deleteSource?(owner: string, id: string): Promise<boolean>;
  jobAction?(
    owner: string,
    id: string,
    action: "retry" | "cancel",
  ): Promise<boolean>;
  recordComparison?(
    owner: string,
    query: string,
    results: MemorySearchResult[],
  ): Promise<MemorySearchResult[] | void>;
}
export interface ChatMemorySnapshot {
  sourceId: string;
  revision: number;
  title: string;
  text: string;
  truncated: boolean;
}
/** UTF-8 budgets bound evidence equally across harnesses, without splitting multibyte characters. */
export function truncateMemoryText(text: string, bytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  let end = Math.max(0, bytes);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
export class MemoryWorkspaceService {
  constructor(
    readonly repository: MemoryServiceRepository,
    readonly engines: MemoryEngines,
  ) {}
  async snapshot(
    owner: string,
    options: MemoryLibraryRequest = { cursor: 0, limit: 100, q: "" },
  ): Promise<MemoryWorkspaceSnapshot> {
    const [sources, jobs, count, collectionData] = await Promise.all([
      this.repository.listSources(owner, options),
      this.repository.listJobs(owner),
      this.repository.countSources?.(owner, options),
      this.repository.collections?.(owner),
    ]);
    const totalSources = count?.totalSources ?? sources.length;
    const filteredSources = count?.filteredSources ?? sources.length;
    const next = options.cursor + sources.length;
    return {
      collections: collectionData?.collections ?? [],
      collectionsTruncated: collectionData?.collectionsTruncated ?? false,
      totalSources,
      filteredSources,
      hasMore: next < filteredSources,
      nextCursor: next < filteredSources ? String(next) : null,
      sources: sources.map((s) => ({
        ...s,
        ingestion: {
          ...s.ingestion,
          ...Object.fromEntries(
            MEMORY_ENGINES.filter((e) => !this.engines[e]).map((e) => [
              e,
              "not_configured",
            ]),
          ),
        },
      })),
      engines: MEMORY_ENGINES.map((id) => ({
        id,
        status: this.engines[id] ? "configured" : "not_configured",
      })),
      jobs,
    };
  }
  private projectSource(source: MemorySource): MemorySource {
    return {
      ...source,
      ingestion: {
        ...source.ingestion,
        ...Object.fromEntries(
          MEMORY_ENGINES.filter((engine) => !this.engines[engine]).map(
            (engine) => [engine, "not_configured"],
          ),
        ),
      },
    };
  }
  async getSource(owner: string, id: string) {
    const source = await this.repository.getSource(owner, id);
    if (!source) throw new MemoryNotFoundError();
    return this.projectSource(source);
  }
  async importSources(owner: string, input: MemoryImportRequest) {
    if (!this.repository.importSources)
      throw new Error("Memory repository unavailable");
    const result = await this.repository.importSources(owner, input);
    return {
      ...result,
      sources: result.sources.map((source) => this.projectSource(source)),
    };
  }
  async patchSource(owner: string, id: string, input: MemorySourcePatch) {
    if (!this.repository.patchSource)
      throw new Error("Memory repository unavailable");
    return this.projectSource(
      await this.repository.patchSource(owner, id, input),
    );
  }
  async deleteSource(owner: string, id: string) {
    if (!this.repository.deleteSource)
      throw new Error("Memory repository unavailable");
    return this.repository.deleteSource(owner, id);
  }
  async jobAction(owner: string, id: string, action: "retry" | "cancel") {
    if (!this.repository.jobAction)
      throw new Error("Memory repository unavailable");
    return this.repository.jobAction(owner, id, action);
  }
  async search(
    owner: string,
    query: string,
    engine: MemoryEngine,
    limit: number,
  ): Promise<MemorySearchResult> {
    const started = performance.now();
    const adapter = this.engines[engine];
    if (!adapter)
      return { engine, status: "not_configured", hits: [], latencyMs: 0 };
    try {
      const results = await adapter.search(
        owner,
        query,
        limit,
        AbortSignal.timeout(20000),
      );
      const hits: MemorySearchResult["hits"] = [];
      let bytes = 0;
      for (const result of results.slice(0, 20)) {
        const source = await this.repository.getSource(owner, result.sourceId);
        if (
          !source ||
          source.revision !== result.revision ||
          source.ingestion[engine] !== "ready"
        )
          continue;
        const text = truncateMemoryText(
          result.text,
          Math.min(8000, 24000 - bytes),
        );
        if (!text.trim()) continue;
        bytes += Buffer.byteLength(text);
        hits.push({
          sourceId: source.id,
          title: source.title,
          text,
          ...(result.score !== undefined ? { score: result.score } : {}),
          citation: {
            sourceId: source.id,
            revision: source.revision,
            label: `${source.title} · revision ${source.revision}`,
          },
          provenance: result.provenance,
        });
        if (hits.length >= limit || bytes >= 24000) break;
      }
      return {
        engine,
        status: "ready",
        hits,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      console.warn(
        "[memory-workspace] Retrieval failed",
        engine,
        error instanceof Error ? error.name : "UnknownError",
      );
      return {
        engine,
        status: "unavailable",
        hits: [],
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }
  async compare(owner: string, query: string, limit: number) {
    const results = await Promise.all(
      MEMORY_ENGINES.map((engine) => this.search(owner, query, engine, limit)),
    );
    const validated = await this.repository.recordComparison?.(
      owner,
      query,
      results,
    );
    return { query, results: validated ?? results };
  }
  async resolveChat(
    owner: string,
    refs: Array<{
      id: string;
      revision?: number;
    }>,
  ): Promise<ChatMemorySnapshot[]> {
    if (
      refs.length === 0 ||
      refs.length > 8 ||
      new Set(refs.map((r) => r.id)).size !== refs.length
    )
      throw new MemoryConflictError();
    const snapshots: ChatMemorySnapshot[] = [];
    let bytes = 0;
    // All references are authorized, even after the budget has been consumed.
    for (const ref of refs) {
      const source = await this.getSource(owner, ref.id);
      if (ref.revision !== undefined && ref.revision !== source.revision)
        throw new MemoryConflictError();
      const text = truncateMemoryText(
        source.content,
        Math.min(8000, 24000 - bytes),
      );
      bytes += Buffer.byteLength(text);
      if (text.trim())
        snapshots.push({
          sourceId: source.id,
          revision: source.revision,
          title: source.title,
          text,
          truncated: text !== source.content,
        });
    }
    return snapshots;
  }
  async revalidateChat(
    owner: string,
    snapshots: ChatMemorySnapshot[],
  ): Promise<void> {
    for (const snapshot of snapshots) {
      const source = await this.getSource(owner, snapshot.sourceId);
      if (source.revision !== snapshot.revision)
        throw new MemoryConflictError();
    }
  }
  async context(
    owner: string,
    sourceIds: string[],
  ): Promise<MemoryContextResult> {
    if (sourceIds.length > 30) throw new MemoryConflictError();
    let text = "";
    const sources: MemoryContextResult["sources"] = [];
    for (const id of sourceIds) {
      const source = await this.getSource(owner, id);
      const header = `\n[Source ${source.id}, revision ${source.revision}] ${source.title}\n`;
      const remaining =
        24000 - Buffer.byteLength(text) - Buffer.byteLength(header);
      if (remaining <= 0) continue;
      text +=
        header + truncateMemoryText(source.content, Math.min(8000, remaining));
      sources.push({
        sourceId: source.id,
        revision: source.revision,
        title: source.title,
      });
    }
    return {
      text,
      sources,
      estimatedTokens: Math.ceil(Buffer.byteLength(text) / 4),
    };
  }
}
