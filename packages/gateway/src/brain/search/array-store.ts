/**
 * BrainVectorStore over brain_search_vectors: plain real[] columns, so meaning search works on any Postgres without
 * the pgvector extension. Vectors are scaled to unit length on write (a zero vector has no direction and is not
 * stored), so cosine similarity is a dot product. nearest scores every row of the scope, provider and size in one
 * statement (a scalar unnest subquery with JIT off, about 15 us a row on Postgres 16) under the search statement
 * deadline, joined to live documents at the indexed revision. A scope holds at most maxPerScope rows: a write past it
 * is refused (BrainSearchVectorCapError), and remaining() lets the indexer stop before it pays for vectors. A write is
 * skipped unless the document is live at its (incarnation, revision); a removal (no chunks) while the document is live
 * at another one.
 */
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";
import { z } from "zod/v4";
import type { BrainVectorMatch } from "../contracts.js";
import { BrainDocumentIdSchema, BrainScopeKeySchema, parseBrainInput } from "../schemas.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { mayReplaceVectors, withSearchRead, withSearchScopeWrite } from "./index-sql.js";
import {
  BrainVectorNearestSchema, BrainVectorReplaceSchema, BrainVectorStoredSchema, selectStoredVectors,
} from "./pgvector.js";
import {
  BRAIN_SEARCH_EMBED_BATCH_MAX, BRAIN_SEARCH_VECTORS_PER_SCOPE_MAX, BrainSearchVectorCapError, type BrainSearchTables,
  type BrainSearchVectorStore,
} from "./types.js";

const ExcludedSchema = z.array(BrainDocumentIdSchema).max(BRAIN_SEARCH_EMBED_BATCH_MAX);

/** The smallest normal float4; a smaller magnitude is stored as 0 (Postgres refuses a real that underflows). */
const FLOAT4_MIN_NORMAL = 1.1754943508222875e-38;

/** The vector scaled to unit length and rounded to float4, or null for a zero vector. Values are checked numbers. */
export function brainUnitVector(vector: readonly number[]): number[] | null {
  const norm = Math.hypot(...vector);
  if (norm === 0) return null;
  return vector.map((value) => {
    const unit = Math.fround(value / norm);
    return Math.abs(unit) < FLOAT4_MIN_NORMAL ? 0 : unit;
  });
}

/** Postgres array text; every value is a finite number, so the text is only digits, signs, dots and exponents. */
const arrayText = (vector: readonly number[]) => `{${vector.join(",")}}`;

export function createBrainArrayVectorStore(
  db: Kysely<BrainDatabase>, options: { readonly maxPerScope?: number } = {},
): BrainSearchVectorStore {
  const kysely = db.withTables<BrainSearchTables>();
  const cap = options.maxPerScope ?? BRAIN_SEARCH_VECTORS_PER_SCOPE_MAX;
  /** The scope's rows outside the excluded documents, counted up to the cap. */
  const used = async (
    trx: QueryExecutorProvider, key: BrainScopeKey, excluded: readonly string[] = [],
  ): Promise<number> => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM (SELECT 1
    FROM brain_search_vectors WHERE owner_id = ${key.ownerId} AND scope_id = ${key.scopeId}
      ${excluded.length === 0 ? sql`` : sql`AND document_id NOT IN (${sql.join([...excluded])})`}
    LIMIT ${cap}) v`.execute(trx)).rows[0]!.n);

  return {
    async replaceChunks(scope, input) {
      const key = parseBrainInput(BrainScopeKeySchema, scope);
      const replace = parseBrainInput(BrainVectorReplaceSchema, input);
      const rows = replace.chunks.flatMap((chunk, index) => {
        const unit = brainUnitVector(chunk.vector);
        return unit === null ? [] : [{ index, unit, textKey: chunk.textKey ?? null }];
      });
      await withSearchScopeWrite(kysely, key, async (trx) => {
        if (!await mayReplaceVectors(trx, key, replace, replace.chunks.length === 0)) return;
        await trx.deleteFrom("brain_search_vectors").where("owner_id", "=", key.ownerId)
          .where("scope_id", "=", key.scopeId).where("document_id", "=", replace.documentId).execute();
        if (rows.length === 0) return;
        if (await used(trx, key) + rows.length > cap) throw new BrainSearchVectorCapError();
        await trx.insertInto("brain_search_vectors").values(rows.map(({ index, unit, textKey }) => ({
          owner_id: key.ownerId, scope_id: key.scopeId, document_id: replace.documentId, chunk_index: index,
          incarnation: replace.incarnation, revision: replace.revision, provider_id: replace.providerId,
          dimensions: unit.length, text_key: textKey, embedding: sql`${arrayText(unit)}::real[]` as never,
        }))).execute();
      });
    },

    async nearest(scope, vector, limit, providerId): Promise<readonly BrainVectorMatch[]> {
      const key = parseBrainInput(BrainScopeKeySchema, scope);
      const query = parseBrainInput(BrainVectorNearestSchema, { vector: [...vector], limit, providerId });
      const unit = brainUnitVector(query.vector);
      if (unit === null) return [];
      type Row = { document_id: string; incarnation: string; revision: number; chunk_index: number; distance: number };
      const rows = await withSearchRead(db, async (trx) => {
        await sql`SET LOCAL jit = off`.execute(trx);
        return sql<Row>`
          SELECT v.document_id, v.incarnation, v.revision, v.chunk_index,
            1 - (SELECT sum(a * b) FROM unnest(v.embedding, ${arrayText(unit)}::float8[]) t(a, b)) AS distance
          FROM brain_search_vectors v
          JOIN brain_documents d ON d.owner_id = v.owner_id AND d.scope_id = v.scope_id
            AND d.document_id = v.document_id AND d.deleted_at IS NULL
            AND d.incarnation = v.incarnation AND d.revision = v.revision
          WHERE v.owner_id = ${key.ownerId} AND v.scope_id = ${key.scopeId}
            AND v.provider_id = ${query.providerId} AND v.dimensions = ${unit.length}
          ORDER BY distance ASC, v.document_id ASC, v.chunk_index ASC
          LIMIT ${query.limit}`.execute(trx);
      });
      return rows.rows.map((row) => ({
        documentId: row.document_id, incarnation: row.incarnation, revision: row.revision, chunkIndex: row.chunk_index,
        distance: Number(row.distance),
      }));
    },

    async remaining(scope, documentIds = []) {
      const key = parseBrainInput(BrainScopeKeySchema, scope);
      const excluded = parseBrainInput(ExcludedSchema, [...documentIds]);
      return cap - await withSearchRead(db, (trx) => used(trx, key, excluded));
    },

    storedVectors: async (scope, input) => selectStoredVectors(db, "brain_search_vectors",
      parseBrainInput(BrainScopeKeySchema, scope), parseBrainInput(BrainVectorStoredSchema, input)),
  };
}
