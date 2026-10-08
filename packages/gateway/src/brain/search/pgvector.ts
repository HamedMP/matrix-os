/**
 * BrainVectorStore over brain_search_chunks (pgvector). Use only when bootstrapBrainSearchDatabase found the
 * extension. Exact cosine-distance scan per scope and provider, under the search statement deadline; an approximate
 * index is later work. A write is skipped unless the document is live at its (incarnation, revision), and a removal
 * (no chunks) while the document is live at another one; stored vectors can be read back by text key, so an unchanged
 * chunk is never embedded twice.
 */
import { sql, type Kysely } from "kysely";
import { z } from "zod/v4";
import {
  BRAIN_EMBEDDINGS_DIMENSIONS_MAX, BRAIN_SEARCH_CANDIDATES_MAX, BRAIN_SEARCH_CHUNK, type BrainVectorMatch,
} from "../contracts.js";
import { BrainDocumentIdSchema, BrainScopeKeySchema, parseBrainInput } from "../schemas.js";
import { BRAIN_MAX_REVISION, BRAIN_UUID_PATTERN, type BrainDatabase, type BrainScopeKey } from "../types.js";
import { mayReplaceVectors, withSearchRead, withSearchScopeWrite } from "./index-sql.js";
import {
  BRAIN_SEARCH_EMBED_BATCH_MAX, BRAIN_SEARCH_PROVIDER_ID_PATTERN, BRAIN_SEARCH_TEXT_KEY_PATTERN, isBrainVectorValue,
  type BrainSearchTables, type BrainSearchVectorStore,
} from "./types.js";

const VectorSchema = z.array(z.number().refine(isBrainVectorValue)).min(1).max(BRAIN_EMBEDDINGS_DIMENSIONS_MAX);
const ProviderIdSchema = z.string().regex(BRAIN_SEARCH_PROVIDER_ID_PATTERN);

/** replaceChunks input, shared with the array store. */
export const BrainVectorReplaceSchema = z.object({
  documentId: BrainDocumentIdSchema,
  incarnation: z.string().regex(BRAIN_UUID_PATTERN),
  revision: z.number().int().min(1).max(BRAIN_MAX_REVISION),
  providerId: ProviderIdSchema,
  chunks: z.array(z.object({
    spanStart: z.number().int().min(0), spanEnd: z.number().int().max(65_536), vector: VectorSchema,
    textKey: z.string().regex(BRAIN_SEARCH_TEXT_KEY_PATTERN).optional(),
  }).strict().refine((chunk) => chunk.spanEnd > chunk.spanStart)).max(BRAIN_SEARCH_CHUNK.perDocumentMax)
    .refine((chunks) => chunks.every((chunk) => chunk.vector.length === chunks[0]!.vector.length)),
}).strict();

/** nearest input, shared with the array store. */
export const BrainVectorNearestSchema = z.object({
  vector: VectorSchema, limit: z.number().int().min(1).max(BRAIN_SEARCH_CANDIDATES_MAX), providerId: ProviderIdSchema,
}).strict();

/** storedVectors input, shared with the array store: one embedding pass batch at most. */
export const BrainVectorStoredSchema = z.object({
  providerId: ProviderIdSchema, dimensions: z.number().int().min(1).max(BRAIN_EMBEDDINGS_DIMENSIONS_MAX),
  documentIds: z.array(BrainDocumentIdSchema).max(BRAIN_SEARCH_EMBED_BATCH_MAX),
  textKeys: z.array(z.string().regex(BRAIN_SEARCH_TEXT_KEY_PATTERN))
    .max(BRAIN_SEARCH_EMBED_BATCH_MAX * BRAIN_SEARCH_CHUNK.perDocumentMax),
}).strict();

/** Rows of `table` for the stored-vectors input, one per text key, as float8 arrays. */
export async function selectStoredVectors(
  db: Kysely<BrainDatabase>, table: "brain_search_chunks" | "brain_search_vectors", scope: BrainScopeKey,
  input: z.infer<typeof BrainVectorStoredSchema>,
): Promise<ReadonlyMap<string, readonly number[]>> {
  if (input.documentIds.length === 0 || input.textKeys.length === 0) return new Map();
  const embedding = table === "brain_search_chunks" ? sql`embedding::real[]::float8[]` : sql`embedding::float8[]`;
  const rows = await withSearchRead(db, (trx) => sql<{ text_key: string; embedding: number[] }>`
    SELECT DISTINCT ON (text_key) text_key, ${embedding} AS embedding FROM ${sql.table(table)}
    WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}
      AND document_id IN (${sql.join(input.documentIds)}) AND provider_id = ${input.providerId}
      AND dimensions = ${input.dimensions} AND text_key IN (${sql.join(input.textKeys)})
    ORDER BY text_key`.execute(trx));
  return new Map(rows.rows.map((row) => [row.text_key, row.embedding.map(Number)]));
}

/** pgvector's text form; values were checked to be float4 numbers, so JSON is exactly "[x,y,...]". */
const asVector = (vector: readonly number[]) => sql`${JSON.stringify(vector)}::vector`;

export function createBrainPgVectorStore(db: Kysely<BrainDatabase>): BrainSearchVectorStore {
  const kysely = db.withTables<BrainSearchTables>();
  return {
    async replaceChunks(scope, input) {
      const key = parseBrainInput(BrainScopeKeySchema, scope);
      const replace = parseBrainInput(BrainVectorReplaceSchema, input);
      await withSearchScopeWrite(kysely, key, async (trx) => {
        if (!await mayReplaceVectors(trx, key, replace, replace.chunks.length === 0)) return;
        await trx.deleteFrom("brain_search_chunks").where("owner_id", "=", key.ownerId)
          .where("scope_id", "=", key.scopeId).where("document_id", "=", replace.documentId).execute();
        if (replace.chunks.length === 0) return;
        await trx.insertInto("brain_search_chunks").values(replace.chunks.map((chunk, index) => ({
          owner_id: key.ownerId, scope_id: key.scopeId, document_id: replace.documentId, chunk_index: index,
          incarnation: replace.incarnation, revision: replace.revision, provider_id: replace.providerId,
          span_start: chunk.spanStart, span_end: chunk.spanEnd, dimensions: chunk.vector.length,
          text_key: chunk.textKey ?? null, embedding: asVector(chunk.vector) as never,
        }))).execute();
      });
    },

    async nearest(scope, vector, limit, providerId): Promise<readonly BrainVectorMatch[]> {
      const key = parseBrainInput(BrainScopeKeySchema, scope);
      const query = parseBrainInput(BrainVectorNearestSchema, { vector: [...vector], limit, providerId });
      type Row = { document_id: string; chunk_index: number; distance: number };
      const rows = await withSearchRead(db, (trx) => sql<Row>`
        SELECT c.document_id, c.chunk_index, (c.embedding <=> ${asVector(query.vector)})::float8 AS distance
        FROM brain_search_chunks c
        JOIN brain_documents d ON d.owner_id = c.owner_id AND d.scope_id = c.scope_id
          AND d.document_id = c.document_id AND d.deleted_at IS NULL
          AND d.incarnation = c.incarnation AND d.revision = c.revision
        WHERE c.owner_id = ${key.ownerId} AND c.scope_id = ${key.scopeId}
          AND c.provider_id = ${query.providerId} AND c.dimensions = ${query.vector.length}
        ORDER BY distance ASC, c.document_id ASC, c.chunk_index ASC
        LIMIT ${query.limit}
      `.execute(trx));
      return rows.rows.filter((row) => Number.isFinite(Number(row.distance))).map((row) => ({
        documentId: row.document_id, chunkIndex: row.chunk_index, distance: Number(row.distance),
      }));
    },

    storedVectors: async (scope, input) => selectStoredVectors(db, "brain_search_chunks",
      parseBrainInput(BrainScopeKeySchema, scope), parseBrainInput(BrainVectorStoredSchema, input)),
  };
}
