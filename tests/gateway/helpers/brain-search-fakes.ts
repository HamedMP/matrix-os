/** Search fixtures: PGlite harness (optionally with pgvector), resolver, fake provider and vector store, seeding. */
import { createHash } from "node:crypto";
import { vector as pgvector } from "@electric-sql/pglite/vector";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { BrainApiError } from "../../../packages/gateway/src/brain/api/types.js";
import { computeBrainClaimId, type BrainClaimKind } from "../../../packages/gateway/src/brain/claims/types.js";
import {
  BRAIN_PROVENANCES, type BrainEmbeddingsProvider, type BrainProjectResolver, type BrainSearchCapabilityView,
  type BrainVectorMatch, type BrainVectorStore,
} from "../../../packages/gateway/src/brain/contracts.js";
import {
  BrainRepository, type BrainDocumentRef, type BrainScopeKey, type BrainSyncUpsertInput,
} from "../../../packages/gateway/src/brain/index.js";
import { bootstrapBrainSearchDatabase } from "../../../packages/gateway/src/brain/search/index.js";
import { BRAIN_CLOCK_START, brainDocumentId, createBrainHarness, type BrainHarness } from "./brain-store-helpers.js";

export const OWNER = "owner_a";
export const PROJECT_ID = "proj_widgets";
export const SCOPE: BrainScopeKey = { ownerId: OWNER, scopeId: `personal:project:${PROJECT_ID}` };

export interface SearchHarness extends BrainHarness { readonly capability: BrainSearchCapabilityView }

/** createBrainHarness, or the same over a PGlite with pgvector loaded (and every statement's SQL pushed to `trace`). */
export async function createSearchHarness(
  options: { readonly vector?: boolean; readonly trace?: string[] } = {},
): Promise<SearchHarness> {
  let harness: BrainHarness;
  if (options.vector === true) {
    const pglite = await KyselyPGlite.create({ extensions: { vector: pgvector } });
    const client = pglite.client as unknown as { query: (text: string, ...rest: unknown[]) => Promise<unknown> };
    const query = client.query.bind(client);
    client.query = (text, ...rest) => { options.trace?.push(text); return query(text, ...rest); };
    let clock = new Date(BRAIN_CLOCK_START);
    const repository = new BrainRepository(pglite.dialect, { now: () => clock });
    await repository.bootstrap();
    harness = {
      repository, db: repository.kysely, now: () => clock, iso: () => clock.toISOString(),
      tick(ms = 1_000) { clock = new Date(clock.getTime() + ms); }, destroy: () => repository.destroy(),
    };
  } else {
    harness = await createBrainHarness();
  }
  return { ...harness, capability: await bootstrapBrainSearchDatabase(harness.db) };
}

export const resolver: BrainProjectResolver = {
  homePath: "/tmp",
  async resolve(ownerId, projectRef) {
    if (ownerId !== OWNER || (projectRef !== PROJECT_ID && projectRef !== "widgets")) {
      throw new BrainApiError("project_not_found");
    }
    return { projectId: PROJECT_ID, slug: "widgets", name: "Widgets", scope: SCOPE };
  },
  checkoutPath: async () => null,
};

/** Bag-of-words vectors: each lowercase word adds 1 to a hashed dimension; normalized. */
export function fakeVector(text: string, dimensions = 16): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    vector[createHash("sha256").update(word).digest()[0]! % dimensions]! += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
}

/** The fixtures' own "manual" provenance plus every adapter's: the fake may receive any seeded document. */
export const EVERY_PROVENANCE: readonly string[] = ["manual", ...Object.values(BRAIN_PROVENANCES)];

export interface FakeProvider extends BrainEmbeddingsProvider {
  calls: string[][];
  fail: boolean | ((texts: readonly string[]) => unknown);
  /** The owner's allow-list; undefined leaves the git default. */
  provenances?: readonly string[];
  /** The owner's list as read now (the settings re-read); absent: the list above. */
  currentProvenances?: () => Promise<readonly string[]>;
}

export function fakeProvider(overrides: Partial<FakeProvider> = {}): FakeProvider {
  const provider: FakeProvider = {
    providerId: "fake-embed", dimensions: 16, maxBatch: 4, maxInputChars: 4_000, calls: [], fail: false,
    provenances: EVERY_PROVENANCE,
    async embed(texts, signal) {
      provider.calls.push([...texts]);
      if (signal.aborted) throw signal.reason;
      if (provider.fail === true) throw new Error("provider down");
      if (typeof provider.fail === "function") return provider.fail(texts) as number[][];
      return texts.map((text) => fakeVector(text, provider.dimensions));
    },
    ...overrides,
  };
  return provider;
}

/** BrainVectorStore over a plain table (no pgvector): cosine distance computed here. */
export async function fakeVectorStore(harness: BrainHarness): Promise<BrainVectorStore & { replaced: string[] }> {
  await sql`CREATE TABLE IF NOT EXISTS test_search_vectors (owner_id TEXT, scope_id TEXT, document_id TEXT,
    chunk_index INT, incarnation UUID, revision INT, provider_id TEXT, embedding FLOAT8[])`.execute(harness.db);
  const replaced: string[] = [];
  return {
    replaced,
    async replaceChunks(scope, input) {
      replaced.push(`${input.documentId}:${input.chunks.length}`);
      await sql`DELETE FROM test_search_vectors WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}
        AND document_id = ${input.documentId}`.execute(harness.db);
      for (const [index, chunk] of input.chunks.entries()) {
        await sql`INSERT INTO test_search_vectors VALUES (${scope.ownerId}, ${scope.scopeId}, ${input.documentId},
          ${index}, ${input.incarnation}, ${input.revision}, ${input.providerId},
          ${`{${chunk.vector.join(",")}}`}::float8[])`.execute(harness.db);
      }
    },
    async nearest(scope, vector, limit, providerId): Promise<readonly BrainVectorMatch[]> {
      const rows = await sql<{
        document_id: string; incarnation: string; revision: number; chunk_index: number; embedding: number[];
      }>`
        SELECT v.document_id, v.incarnation, v.revision, v.chunk_index, v.embedding FROM test_search_vectors v
        JOIN brain_documents d ON d.owner_id = v.owner_id AND d.scope_id = v.scope_id
          AND d.document_id = v.document_id AND d.deleted_at IS NULL AND d.incarnation = v.incarnation
          AND d.revision = v.revision
        WHERE v.owner_id = ${scope.ownerId} AND v.scope_id = ${scope.scopeId} AND v.provider_id = ${providerId}`
        .execute(harness.db);
      return rows.rows.map((row) => ({
        documentId: row.document_id, incarnation: row.incarnation, revision: row.revision, chunkIndex: row.chunk_index,
        distance: 1 - row.embedding.reduce((sum, value, index) => sum + value * vector[index]!, 0),
      })).sort((a, b) => a.distance - b.distance || (a.documentId < b.documentId ? -1 : 1)).slice(0, limit);
    },
  };
}

// Seeding.

export interface SeedDocument extends Partial<BrainSyncUpsertInput> {
  readonly seed: string;
  readonly refs?: readonly BrainDocumentRef[];
}

/** A source plus one sync batch per call; returns the source id. */
export async function createSeeder(harness: BrainHarness, scope: BrainScopeKey = SCOPE) {
  const { source } = await harness.repository.createSource(scope, { kind: "git", externalRef: "https://github.com/acme/widgets", label: "Widgets" });
  let cursor: string | null = null;
  let step = 0;
  return {
    sourceId: source.sourceId,
    async sync(upserts: readonly SeedDocument[], deletions: readonly string[] = []) {
      step += 1;
      const next = `c${step}`;
      await harness.repository.applySyncBatch(scope, {
        sourceId: source.sourceId, expectedCursor: cursor, nextCursor: next, deletions: deletions.map(brainDocumentId),
        upserts: upserts.map(({ seed, ...overrides }) => ({ documentId: brainDocumentId(seed), title: `Title ${seed}`,
          body: `Body for ${seed}`, permalink: "", sourceUpdatedAt: BRAIN_CLOCK_START, provenance: "manual", ...overrides })),
      });
      cursor = next;
    },
  };
}

type SeedClaim = { readonly kind: BrainClaimKind; readonly label?: string | null; readonly statement: string; readonly quote: string };
/** One run of `extractor` replacing the document's claims; quotes must occur in the body. */
export async function seedClaims(
  harness: BrainHarness, seed: string, claims: readonly SeedClaim[], extractor = "rules/v1", scope = SCOPE,
): Promise<void> {
  const documentId = brainDocumentId(seed);
  const document = (await harness.repository.getDocument(scope, documentId))!;
  const run = await harness.repository.openExtractionRun(scope, { extractor });
  await harness.repository.applyDocumentExtraction(scope, {
    runId: run.runId, documentId, incarnation: document.incarnation, revision: document.revision, extractor,
    outcome: { status: "done", claims: claims.map((claim) => {
      const spanStart = document.body.indexOf(claim.quote);
      const label = claim.label ?? null;
      return { claimId: computeBrainClaimId(documentId, claim.kind, label, claim.statement), kind: claim.kind, label,
        statement: claim.statement, quote: claim.quote, spanStart, spanEnd: spanStart + claim.quote.length,
        fields: {}, confidence: "high" as const };
    }) },
  });
  await harness.repository.closeExtractionRun(scope, { runId: run.runId, status: "succeeded", errorCode: null,
    nextAction: "", counts: { documentsProcessed: 1, documentsFailed: 0, claimsWritten: claims.length, claimsRemoved: 0,
      claimsRejected: 0, quotesRejected: 0 }, usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } });
}
