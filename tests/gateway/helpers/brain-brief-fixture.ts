/**
 * Fixtures for the brief tests: a PGlite brain with the brief table, a project resolver fake, sources, documents
 * with refs, claims written through a real extraction run, and receipts.
 */
import { BrainApiError } from "../../../packages/gateway/src/brain/api/types.js";
import { createBrainBrief, bootstrapBrainBriefDatabase } from "../../../packages/gateway/src/brain/brief/index.js";
import {
  computeBrainClaimId, type BrainClaimFields, type BrainClaimKind,
} from "../../../packages/gateway/src/brain/claims/types.js";
import type {
  BrainBriefFeature, BrainBriefSummaryProvider, BrainProjectResolver,
} from "../../../packages/gateway/src/brain/contracts.js";
import type { BrainDocumentRef, BrainScopeKey } from "../../../packages/gateway/src/brain/index.js";
import { brainDocumentId, createBrainHarness, type BrainHarness } from "./brain-store-helpers.js";

export const BRIEF_OWNER = "owner_a";
export const BRIEF_SCOPE: BrainScopeKey = { ownerId: BRIEF_OWNER, scopeId: "personal:project:proj_a" };
export const SHA = "a".repeat(40);

export interface DocSpec {
  readonly seed: string; readonly title?: string; readonly body?: string; readonly provenance?: string;
  readonly at?: string; readonly refs?: readonly BrainDocumentRef[]; readonly permalink?: string;
}
export interface ClaimSpec {
  readonly kind: BrainClaimKind; readonly label?: string | null; readonly statement: string;
  readonly quote?: string; readonly fields?: BrainClaimFields;
}

export interface BriefFixture {
  readonly harness: BrainHarness; readonly feature: BrainBriefFeature; readonly resolver: BrainProjectResolver;
  source(kind?: string, label?: string, scope?: BrainScopeKey): Promise<string>;
  sync(sourceId: string, docs: readonly DocSpec[], scope?: BrainScopeKey): Promise<void>;
  extract(seed: string, claims: readonly ClaimSpec[], scope?: BrainScopeKey, extractor?: string): Promise<void>;
  receipt(sourceId: string, status: "succeeded" | "failed", errorCode?: string): Promise<void>;
  rebuild(summaries?: BrainBriefSummaryProvider): BrainBriefFeature;
  destroy(): Promise<void>;
}

/** A git PR body with the adapter footer, so the cite label reads "#<number>". */
export function prBody(text: string, number: number): string {
  return `${text}\n\nCommit: ${SHA}\nAuthor: Ada\nCommitted: 2026-10-01T08:00:00Z\nPull request: #${number}\nChanged paths: 1`;
}

export async function createBriefFixture(): Promise<BriefFixture> {
  const harness = await createBrainHarness();
  await bootstrapBrainBriefDatabase(harness.db);
  const resolver: BrainProjectResolver = {
    homePath: "/home",
    async resolve(ownerId, projectRef) {
      if (ownerId === BRIEF_OWNER && projectRef === "proj_b") {
        return { projectId: "proj_b", slug: "beta", name: "Beta", scope: { ownerId, scopeId: "personal:project:proj_b" } };
      }
      if (ownerId !== BRIEF_OWNER || (projectRef !== "proj_a" && projectRef !== "alpha")) {
        throw new BrainApiError("project_not_found");
      }
      return { projectId: "proj_a", slug: "alpha", name: "Alpha", scope: BRIEF_SCOPE };
    },
    checkoutPath: async () => null,
  };
  const cursors = new Map<string, string | null>();
  const make = (summaries?: BrainBriefSummaryProvider) =>
    createBrainBrief({ repository: harness.repository, resolver, now: harness.now, summaries });
  return {
    harness, resolver, feature: make(),
    rebuild: make,
    async source(kind = "git", label = "matrix-os", scope = BRIEF_SCOPE) {
      const { source } = await harness.repository.createSource(scope, { kind, externalRef: `ref:${kind}:${label}`, label });
      return source.sourceId;
    },
    async sync(sourceId, docs, scope = BRIEF_SCOPE) {
      const expected = cursors.get(sourceId) ?? null;
      const next = `c${Number((expected ?? "c0").slice(1)) + 1}`;
      await harness.repository.applySyncBatch(scope, {
        sourceId, expectedCursor: expected, nextCursor: next, deletions: [],
        upserts: docs.map((doc) => ({
          documentId: brainDocumentId(doc.seed), title: doc.title ?? `Title ${doc.seed}`,
          body: doc.body ?? `Body for ${doc.seed}`, permalink: doc.permalink ?? "",
          sourceUpdatedAt: doc.at ?? "2026-10-01T08:00:00.000Z", provenance: doc.provenance ?? "linear_issue",
          refs: doc.refs ?? [],
        })),
      });
      cursors.set(sourceId, next);
    },
    async extract(seed, claims, scope = BRIEF_SCOPE, extractor = "rules/v1") {
      const repository = harness.repository;
      const documentId = brainDocumentId(seed);
      const document = (await repository.getDocument(scope, documentId))!;
      const run = await repository.openExtractionRun(scope, { extractor });
      await repository.applyDocumentExtraction(scope, {
        runId: run.runId, documentId, incarnation: document.incarnation, revision: document.revision,
        extractor, outcome: {
          status: "done", claims: claims.map((claim) => {
            const quote = claim.quote ?? claim.statement;
            const spanStart = document.body.indexOf(quote);
            if (spanStart < 0) throw new Error(`quote not in body: ${quote}`);
            return {
              claimId: computeBrainClaimId(documentId, claim.kind, claim.label ?? null, claim.statement),
              kind: claim.kind, label: claim.label ?? null, statement: claim.statement, quote, spanStart,
              spanEnd: spanStart + quote.length, fields: claim.fields ?? {}, confidence: "high" as const,
            };
          }),
        },
      });
      await repository.closeExtractionRun(scope, {
        runId: run.runId, status: "succeeded", nextAction: "", errorCode: null,
        counts: { documentsProcessed: 1, documentsFailed: 0, claimsWritten: claims.length, claimsRemoved: 0,
          claimsRejected: 0, quotesRejected: 0 },
        usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
      });
    },
    async receipt(sourceId, status, errorCode) {
      const receipt = await harness.repository.openSyncReceipt(BRIEF_SCOPE, { sourceId });
      await harness.repository.closeSyncReceipt(BRIEF_SCOPE, {
        sourceId, receiptId: receipt.receiptId, status, errorCode: errorCode ?? null,
        counts: { read: 0, written: 0, unchanged: 0, deleted: 0, failed: 0 },
      });
    },
    destroy: () => harness.destroy(),
  };
}
