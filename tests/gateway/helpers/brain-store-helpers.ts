/**
 * Fixtures for the Company Brain store tests: a PGlite-backed repository with
 * a controllable clock, scope keys, document builders, and scoped row counters.
 */
import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { expect } from "vitest";
import {
  BrainRepository,
  BrainStoreError,
  type BrainDatabase,
  type BrainDocumentContentInput,
  type BrainRepositoryOptions,
  type BrainScopeKey,
  type BrainStoreErrorCode,
  type BrainSyncCounts,
  type BrainUpsertDocumentInput,
} from "../../../packages/gateway/src/brain/index.js";

export const BRAIN_CLOCK_START = "2026-10-01T10:00:00.000Z";
export const BRAIN_TABLES = [
  "brain_sources",
  "brain_documents",
  "brain_document_revisions",
  "brain_document_refs",
  "brain_sync_cursors",
  "brain_sync_receipts",
] as const;
export type BrainTable = (typeof BRAIN_TABLES)[number];
export const BRAIN_CLAIM_TABLES = ["brain_claims", "brain_extraction_runs", "brain_extraction_state"] as const;
export type BrainClaimTable = (typeof BRAIN_CLAIM_TABLES)[number];

export const scopeA: BrainScopeKey = { ownerId: "owner_a", scopeId: "scope_a" };
export const scopeB: BrainScopeKey = { ownerId: "owner_a", scopeId: "scope_b" };
export const scopeOtherOwner: BrainScopeKey = { ownerId: "owner_b", scopeId: "scope_a" };
export const zeroCounts: BrainSyncCounts = { read: 0, written: 0, unchanged: 0, deleted: 0, failed: 0 };

export type BrainHarnessOptions = Omit<BrainRepositoryOptions, "now">;

export interface BrainHarness {
  readonly repository: BrainRepository;
  readonly db: Kysely<BrainDatabase>;
  now(): Date;
  iso(): string;
  tick(ms?: number): void;
  destroy(): Promise<void>;
}

/** A PGlite brain; with `trace`, every statement's SQL is pushed to it (BEGIN and COMMIT included). */
export async function createBrainHarness(options: BrainHarnessOptions = {}, trace?: string[]): Promise<BrainHarness> {
  const pglite = await KyselyPGlite.create();
  if (trace !== undefined) {
    const client = pglite.client as unknown as { query: (text: string, ...rest: unknown[]) => Promise<unknown> };
    const query = client.query.bind(client);
    client.query = (text, ...rest) => { trace.push(text); return query(text, ...rest); };
  }
  let clock = new Date(BRAIN_CLOCK_START);
  const repository = new BrainRepository(pglite.dialect, { ...options, now: () => clock });
  await repository.bootstrap();
  return {
    repository,
    db: repository.kysely,
    now: () => clock,
    iso: () => clock.toISOString(),
    tick(ms = 1_000) {
      clock = new Date(clock.getTime() + ms);
    },
    destroy: () => repository.destroy(),
  };
}

/** Stable external-identity id, never a content hash. */
export function brainDocumentId(seed: string): string {
  return createHash("sha256").update(JSON.stringify(["test", seed])).digest("hex");
}

export function brainContent(
  seed: string,
  overrides: Partial<BrainDocumentContentInput> = {},
): BrainDocumentContentInput {
  return {
    documentId: brainDocumentId(seed),
    title: `Title ${seed}`,
    body: `Body for ${seed}`,
    permalink: "",
    sourceUpdatedAt: BRAIN_CLOCK_START,
    provenance: "manual",
    ...overrides,
  };
}

export function manualDocument(
  seed: string,
  overrides: Partial<BrainDocumentContentInput> = {},
): BrainUpsertDocumentInput {
  return { ...brainContent(seed, overrides), sourceId: null };
}

export async function expectBrainError(promise: Promise<unknown>, code: BrainStoreErrorCode): Promise<void> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(BrainStoreError);
  const brainError = error as BrainStoreError;
  expect([brainError.name, brainError.code, brainError.message])
    .toEqual(["BrainStoreError", code, "Brain store request failed"]);
}

export async function countBrainRows(
  db: Kysely<BrainDatabase>,
  table: BrainTable | BrainClaimTable,
  scope: BrainScopeKey,
): Promise<number> {
  const result = await sql<{ count: number }>`
    SELECT count(*)::int AS count FROM ${sql.table(table)}
    WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId}`.execute(db);
  return Number(result.rows[0]?.count ?? 0);
}

/** One row in every brain table for the scope: source, document, revision, ref, cursor, receipt. */
export async function seedBrainScope(harness: BrainHarness, scope: BrainScopeKey): Promise<string> {
  const { source } = await harness.repository.createSource(scope, {
    kind: "slack", externalRef: "T/C", label: "Seed",
  });
  const document = brainContent("seed");
  await harness.repository.applySyncBatch(scope, {
    sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", upserts: [document], deletions: [],
  });
  await harness.repository.applySyncBatch(scope, {
    sourceId: source.sourceId, expectedCursor: "c1", nextCursor: "c2",
    upserts: [{ ...document, body: "seed v2", refs: [{ kind: "path", value: "seed.md" }] }], deletions: [],
  });
  await harness.repository.openSyncReceipt(scope, { sourceId: source.sourceId });
  return source.sourceId;
}
