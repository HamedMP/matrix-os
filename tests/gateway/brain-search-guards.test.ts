/** Search index guards over PGlite: embedding writes and marks fenced by the claims set they were embedded for. */
import { vector as pgvector } from "@electric-sql/pglite/vector";
import { sql, type Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_RULES_EXTRACTOR_ID, computeBrainClaimId, type BrainClaimKind,
} from "../../packages/gateway/src/brain/claims/types.js";
import { BrainRepository, type BrainDatabase, type BrainScopeKey } from "../../packages/gateway/src/brain/index.js";
import { bootstrapBrainSearchDatabase } from "../../packages/gateway/src/brain/search/database.js";
import { runBrainEmbedPass, type BrainEmbedPassContext } from "../../packages/gateway/src/brain/search/embed-pass.js";
import {
  isLiveAt, markEmbedding, rebuildDocuments, selectEmbedPending, withSearchScopeWrite,
} from "../../packages/gateway/src/brain/search/index-sql.js";
import type { BrainEmbeddingsUsage, BrainSearchVectorStore } from "../../packages/gateway/src/brain/search/types.js";
import { BRAIN_CLOCK_START, brainDocumentId } from "./helpers/brain-store-helpers.js";

const SCOPE: BrainScopeKey = { ownerId: "owner_a", scopeId: "personal:project:proj_guards" };
const TARGET = { marker: "array:fake-embed", provenances: ["manual"] } as const;
const now = () => new Date(BRAIN_CLOCK_START);
const signal = () => new AbortController().signal;

type SeedClaim = { readonly kind: BrainClaimKind; readonly statement: string; readonly quote: string };

async function createHarness(options: { readonly vector?: boolean } = {}) {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const pglite = await KyselyPGlite.create(options.vector === true ? { extensions: { vector: pgvector } } : {});
  const repository = new BrainRepository(pglite.dialect, { now });
  await repository.bootstrap();
  const db: Kysely<BrainDatabase> = repository.kysely;
  const capability = await bootstrapBrainSearchDatabase(db);
  const { source } = await repository.createSource(SCOPE, { kind: "slack", externalRef: "T/C", label: "Guards" });
  let cursor: string | null = null;
  let step = 0;
  return {
    db, capability, destroy: () => repository.destroy(),
    async sync(upserts: readonly { readonly seed: string; readonly body?: string }[], deletions: string[] = []) {
      step += 1;
      await repository.applySyncBatch(SCOPE, {
        sourceId: source.sourceId, expectedCursor: cursor, nextCursor: `c${step}`,
        deletions: deletions.map(brainDocumentId),
        upserts: upserts.map(({ seed, body }) => ({ documentId: brainDocumentId(seed), title: `Title ${seed}`,
          body: body ?? `Body for ${seed}`, permalink: "", sourceUpdatedAt: BRAIN_CLOCK_START, provenance: "manual" })),
      });
      cursor = `c${step}`;
    },
    /** One rules run replacing the document's claims; each quote must occur in the body. */
    async claims(seed: string, claims: readonly SeedClaim[]) {
      const documentId = brainDocumentId(seed);
      const document = (await repository.getDocument(SCOPE, documentId))!;
      const run = await repository.openExtractionRun(SCOPE, { extractor: BRAIN_RULES_EXTRACTOR_ID });
      await repository.applyDocumentExtraction(SCOPE, {
        runId: run.runId, documentId, incarnation: document.incarnation, revision: document.revision,
        extractor: BRAIN_RULES_EXTRACTOR_ID, outcome: { status: "done", claims: claims.map((claim) => {
          const spanStart = document.body.indexOf(claim.quote);
          return { claimId: computeBrainClaimId(documentId, claim.kind, null, claim.statement), kind: claim.kind,
            label: null, statement: claim.statement, quote: claim.quote, spanStart,
            spanEnd: spanStart + claim.quote.length, fields: {}, confidence: "high" as const };
        }) },
      });
      await repository.closeExtractionRun(SCOPE, { runId: run.runId, status: "succeeded", errorCode: null,
        nextAction: "", counts: { documentsProcessed: 1, documentsFailed: 0, claimsWritten: claims.length,
          claimsRemoved: 0, claimsRejected: 0, quotesRejected: 0 },
        usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 } });
    },
    rebuild: (seeds: readonly string[]) => withSearchScopeWrite(db, SCOPE,
      (trx) => rebuildDocuments(trx, SCOPE, seeds.map(brainDocumentId), now())),
    pending: async () => selectEmbedPending(db, SCOPE, TARGET, null, 10),
    document: async (seed: string) => (await repository.getDocument(SCOPE, brainDocumentId(seed)))!,
    row: async (seed: string) => (await sql<{ embedded_provider: string | null; embed_failed_at: Date | null }>`
      SELECT embedded_provider, embed_failed_at FROM brain_search_documents
      WHERE owner_id = ${SCOPE.ownerId} AND scope_id = ${SCOPE.scopeId} AND document_id = ${brainDocumentId(seed)}`
      .execute(db)).rows[0],
    count: async (table: string) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n
      FROM ${sql.table(table)} WHERE owner_id = ${SCOPE.ownerId}`.execute(db)).rows[0]!.n),
  };
}
type Harness = Awaited<ReturnType<typeof createHarness>>;

/** A store that, like the search stores, writes only while isLiveAt holds in its transaction. */
function guardedStore(db: Kysely<BrainDatabase>) {
  const writes: string[] = [];
  const store: BrainSearchVectorStore = {
    async replaceChunks(scope, input) {
      await withSearchScopeWrite(db, scope, async (trx) => {
        if (input.chunks.length > 0 && !await isLiveAt(trx, scope, input)) return;
        writes.push(`${input.documentId.slice(0, 8)}:${input.chunks.length}`);
      });
    },
    nearest: async () => [],
  };
  return { store, writes };
}

/** A metered provider of two texts per call; each call's usage (or failure) comes from `script`. */
function meteredProvider(script: (call: number) => BrainEmbeddingsUsage | Error) {
  const calls: number[] = [];
  const provider = {
    providerId: "fake-embed", dimensions: 4, maxBatch: 2, maxInputChars: 4_000, provenances: ["manual"],
    embed: async () => { throw new Error("use embedMetered"); },
    async embedMetered(texts: readonly string[]) {
      calls.push(texts.length);
      const outcome = script(calls.length);
      if (outcome instanceof Error) throw outcome;
      return { vectors: texts.map(() => [1, 0, 0, 0]), usage: outcome };
    },
  };
  return { provider, calls };
}

function passContext(
  h: Harness, provider: ReturnType<typeof meteredProvider>["provider"], store: BrainSearchVectorStore,
  halted: () => boolean = () => false,
): BrainEmbedPassContext {
  return { db: h.db, scope: SCOPE, meaning: { provider, vectors: store, store: "array" }, target: TARGET, now,
    signal: signal(), halted, touched: new Set() };
}

describe("brain search guards", { timeout: 60_000 }, () => {
  let h: Harness | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    await h?.destroy();
    h = null;
  });

  it("never stores or marks vectors embedded for a claims set the row no longer holds", async () => {
    h = await createHarness();
    await h.sync([{ seed: "a", body: "Keep one transaction per document. Retry on conflict." }]);
    await h.claims("a", [{ kind: "invariant", statement: "one transaction per document",
      quote: "Keep one transaction per document." }]);
    await h.rebuild(["a"]);
    const [old] = await h.pending();
    expect(old!.claimsKey).toMatch(/^[a-f0-9]{32}$/);

    // The claims change at the same revision, and another refresh rebuilds the row while the first still embeds.
    await h.claims("a", [{ kind: "decision", statement: "retry on conflict", quote: "Retry on conflict." }]);
    await h.rebuild(["a"]);
    const [fresh] = await h.pending();
    const { documentId, incarnation, revision } = old!;
    expect(fresh).toMatchObject({ documentId, incarnation, revision });
    expect(fresh!.claimsKey).not.toBe(old!.claimsKey);
    expect(await isLiveAt(h.db, SCOPE, old!)).toBe(false);
    expect(await isLiveAt(h.db, SCOPE, fresh!)).toBe(true);
    expect(await isLiveAt(h.db, SCOPE, { documentId, incarnation, revision })).toBe(true);

    // The slower pass for the old claims set pays for its call, then neither writes nor marks the newer row.
    const { provider, calls } = meteredProvider(() => ({ tokens: 0, costMicroUsd: 0 }));
    const { store, writes } = guardedStore(h.db);
    expect((await runBrainEmbedPass(passContext(h, provider, store), [old!])).stopped).toBe(false);
    expect(calls).toEqual([2]);
    expect(writes).toEqual([]);
    expect(await h.row("a")).toEqual({ embedded_provider: null, embed_failed_at: null });
    await withSearchScopeWrite(h.db, SCOPE, (trx) => markEmbedding(trx, SCOPE, old!, null, now()));
    expect(await h.row("a")).toEqual({ embedded_provider: null, embed_failed_at: null });

    // The pass for the row's own claims set stores and marks it.
    await runBrainEmbedPass(passContext(h, provider, store), [fresh!]);
    expect(writes).toEqual([`${fresh!.documentId.slice(0, 8)}:2`]);
    expect((await h.row("a"))!.embedded_provider).toBe(TARGET.marker);
    expect(await h.pending()).toEqual([]);
  });
});
