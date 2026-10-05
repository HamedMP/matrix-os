import { z } from "zod/v4";
import { openVikingPreview } from "./openviking-preview.js";
import {
  assertOpenVikingDeletion,
  assertOpenVikingIngestion,
} from "./openviking-outcome.js";
import type { MemoryEngine, MemorySource } from "@matrix-os/contracts";
import {
  createEngineHttp,
  ownerNamespace,
  MemoryEngineError,
  type EngineFetch,
} from "./http.js";
export interface EngineHit {
  sourceId: string;
  revision: number;
  text: string;
  score?: number;
  provenance: "document" | "summary";
}
export interface MemoryEngineAdapter {
  id: MemoryEngine;
  upsert(
    owner: string,
    source: MemorySource,
    signal: AbortSignal,
  ): Promise<void>;
  delete(
    owner: string,
    sourceId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<void>;
  search(
    owner: string,
    query: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<EngineHit[]>;
}
export type MemoryEngines = Partial<Record<MemoryEngine, MemoryEngineAdapter>>;
const uuid = z.uuid();
const hindsightRecall = z.object({
  results: z
    .array(
      z.object({
        document_id: z.string().max(100).nullish(),
        text: z.string().max(200000),
        metadata: z.record(z.string(), z.string()).nullish(),
        scores: z.object({ final: z.number().finite().nullish() }).nullish(),
      }),
    )
    .max(1000),
});
const vikingEnvelope = z.object({
  status: z.literal("ok"),
  result: z.unknown(),
});
const vikingHits = z.object({
  resources: z
    .array(
      z.object({
        uri: z.string().max(2000),
        abstract: z.string().max(200000).nullish(),
        content: z.string().max(200000).nullish(),
        score: z.number().finite().optional(),
      }),
    )
    .max(1000)
    .default([]),
});
const json = (value: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MemoryEngineError();
  return result.data;
}
export function createMemoryEngines(
  env: NodeJS.ProcessEnv = process.env,
  fetcher?: EngineFetch,
): MemoryEngines {
  const engines: MemoryEngines = {};
  if (env.MEMORY_HINDSIGHT_URL) {
    const request = createEngineHttp(
      env.MEMORY_HINDSIGHT_URL,
      env.MEMORY_HINDSIGHT_API_KEY,
      fetcher,
    );
    const bank = (owner: string) =>
      `/v1/default/banks/matrix-${ownerNamespace(owner)}`;
    engines.hindsight = {
      id: "hindsight",
      async upsert(owner, source, signal) {
        const result = await request(
          `${bank(owner)}/memories`,
          json({
            async: false,
            items: [
              {
                content: source.content,
                document_id: `${source.id}:r${source.revision}`,
                context: `${source.kind}: ${source.collection}`,
                timestamp: source.occurredAt ?? "unset",
                metadata: {
                  matrix_source_id: source.id,
                  matrix_revision: String(source.revision),
                  title: source.title,
                },
              },
            ],
          }),
          signal,
        );
        parse(
          z.object({ success: z.literal(true), async: z.literal(false) }),
          result,
        );
      },
      async delete(owner, id, revision, signal) {
        await request(
          `${bank(owner)}/documents/${encodeURIComponent(`${id}:r${revision}`)}`,
          { method: "DELETE" },
          signal,
          true,
        );
        // Installed trial sources used the bare UUID. New writes never use this ID.
        await request(
          `${bank(owner)}/documents/${encodeURIComponent(id)}`,
          { method: "DELETE" },
          signal,
          true,
        );
      },
      async search(owner, query, limit, signal) {
        const response = parse(
          hindsightRecall,
          await request(
            `${bank(owner)}/memories/recall`,
            json({
              query,
              types: ["world", "experience"],
              budget: "mid",
              max_tokens: 4000,
            }),
            signal,
          ),
        );
        return response.results
          .flatMap((r) => {
            const revision = Number(r.metadata?.matrix_revision);
            const match = r.document_id?.match(
              /^([0-9a-f-]{36})(?::r([1-9][0-9]*))?$/i,
            );
            if (
              !match ||
              !uuid.safeParse(match[1]).success ||
              !Number.isSafeInteger(revision) ||
              revision < 1
            )
              return [];
            if (match[2] && Number(match[2]) !== revision) return [];
            if (
              r.metadata?.matrix_source_id &&
              r.metadata.matrix_source_id !== match[1]
            )
              return [];
            return [
              {
                sourceId: match[1],
                revision,
                text: r.text.slice(0, 8000),
                ...(r.scores?.final != null ? { score: r.scores.final } : {}),
                provenance: "summary" as const,
              },
            ];
          })
          .slice(0, limit);
      },
    };
  }
  if (env.MEMORY_OPENVIKING_URL) {
    const request = createEngineHttp(
      env.MEMORY_OPENVIKING_URL,
      env.MEMORY_OPENVIKING_API_KEY,
      fetcher,
    );
    const root = (owner: string) =>
      `viking://resources/matrix/${ownerNamespace(owner)}`;
    async function remove(
      owner: string,
      id: string,
      revision: number,
      signal: AbortSignal,
    ) {
      const deleted = await request(
        `/api/v1/fs?${new URLSearchParams({ uri: `${root(owner)}/${id}/r${revision}`, recursive: "true", wait: "true", timeout: "90" })}`,
        { method: "DELETE" },
        signal,
        true,
      );
      if (deleted !== null)
        assertOpenVikingDeletion(parse(vikingEnvelope, deleted).result);
    }
    engines.openviking = {
      id: "openviking",
      async upsert(owner, source, signal) {
        await remove(owner, source.id, source.revision, signal);
        const form = new FormData();
        form.set(
          "file",
          new Blob([`# ${source.title}\n\n${source.content}`], {
            type: "text/markdown",
          }),
          "note.md",
        );
        form.set("upload_mode", "local");
        const uploaded = parse(
          vikingEnvelope,
          await request(
            "/api/v1/resources/temp_upload",
            { method: "POST", body: form },
            signal,
          ),
        );
        const { temp_file_id } = parse(
          z.object({ temp_file_id: z.string().min(1).max(500) }),
          uploaded.result,
        );
        const ingested = parse(
          vikingEnvelope,
          await request(
            "/api/v1/resources",
            json({
              temp_file_id,
              to: `${root(owner)}/${source.id}/r${source.revision}`,
              create_parent: true,
              wait: true,
              timeout: 90,
              reason: "Owner selected Matrix memory source",
              tags: [
                `matrix-source:${source.id}`,
                `matrix-revision:${source.revision}`,
              ],
            }),
            signal,
          ),
        );
        assertOpenVikingIngestion(
          ingested.result,
          `${root(owner)}/${source.id}/r${source.revision}`,
        );
      },
      delete: remove,
      async search(owner, query, limit, signal) {
        const envelope = parse(
          vikingEnvelope,
          await request(
            "/api/v1/search/find",
            json({
              query,
              target_uri: root(owner),
              context_type: "resource",
              limit,
              read_content: true,
            }),
            signal,
          ),
        );
        const response = parse(vikingHits, envelope.result);
        return response.resources
          .flatMap((r) => {
            const match = r.uri.match(
              /\/([0-9a-f-]{36})\/r([1-9][0-9]*)(?:\/|$)/i,
            );
            if (!match || !uuid.safeParse(match[1]).success) return [];
            return [
              {
                sourceId: match[1],
                revision: Number(match[2]),
                ...openVikingPreview(r),
                ...(r.score !== undefined ? { score: r.score } : {}),
              },
            ];
          })
          .slice(0, limit);
      },
    };
  }
  return engines;
}
