/**
 * Store-side helpers for the syncGitSource suites: the document id recipe,
 * a spying repository, snapshots of a source's documents and refs, and
 * useGitSyncHarness(), which gives each test a fresh PGlite harness and a
 * fresh fixture repository and tears both down afterwards.
 */
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, vi, type MockInstance } from "vitest";
import {
  syncGitSource, type GitSyncOptions, type GitSyncResult,
} from "../../../packages/gateway/src/brain/git/index.js";
import {
  BrainRepository,
  type BrainDatabase,
  type BrainScopeKey,
  type BrainSyncBatchInput,
  type BrainSyncBatchResult,
} from "../../../packages/gateway/src/brain/index.js";
import { FIXTURE_WEB_BASE, createBrainGitFixture, type BrainGitFixture } from "./brain-git-fixture.js";
import { createBrainHarness, scopeA, type BrainHarness } from "./brain-store-helpers.js";

export interface FixtureRef { readonly kind: string; readonly value: string }

/** The adapter's id recipe, recomputed by hand: sha256 of ["brain_git_v1", identity, ...tail]. */
export function gitDocumentId(identity: string, ...tail: ReadonlyArray<string | number>): string {
  return createHash("sha256").update(JSON.stringify(["brain_git_v1", identity, ...tail])).digest("hex");
}

/** A document id of a source whose identity is FIXTURE_WEB_BASE. */
export function fixtureDocumentId(...tail: ReadonlyArray<string | number>): string {
  return gitDocumentId(FIXTURE_WEB_BASE, ...tail);
}

/** listDocumentRefs order: kind, then value (COLLATE "C"). */
export function sortRefs(refs: readonly FixtureRef[]): FixtureRef[] {
  const key = (ref: FixtureRef) => Buffer.from(`${ref.kind}\u0000${ref.value}`, "utf8");
  return [...refs].sort((a, b) => Buffer.compare(key(a), key(b)));
}

export async function createGitSource(
  repository: BrainRepository, scope: BrainScopeKey, externalRef = FIXTURE_WEB_BASE,
): Promise<string> {
  const { source } = await repository.createSource(scope, { kind: "git", externalRef, label: "widgets" });
  return source.sourceId;
}

/** Shares the harness connection and clock; records (and can fail) every applySyncBatch call. */
export class SpyRepository extends BrainRepository {
  readonly calls: BrainSyncBatchInput[] = [];
  onApply: ((input: BrainSyncBatchInput, call: number) => void | Promise<void>) | null = null;

  constructor(db: Kysely<BrainDatabase>, now: () => Date) {
    super(db, { now });
  }

  override async applySyncBatch(scope: BrainScopeKey, input: BrainSyncBatchInput): Promise<BrainSyncBatchResult> {
    this.calls.push(input);
    if (this.onApply) await this.onApply(input, this.calls.length);
    return super.applySyncBatch(scope, input);
  }
}

export interface DocumentState {
  readonly title: string;
  readonly contentHash: string;
  readonly permalink: string;
  readonly sourceUpdatedAt: string;
  readonly revision: number;
  readonly refs: readonly FixtureRef[];
}

/** Every live document of the source with its refs, keyed by id. */
export async function sourceState(
  repository: BrainRepository, scope: BrainScopeKey, sourceId: string,
): Promise<Map<string, DocumentState>> {
  const state = new Map<string, DocumentState>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await repository.listDocuments(scope, { sourceId, limit: 100, cursor });
    for (const item of result.items) {
      state.set(item.documentId, {
        title: item.title, contentHash: item.contentHash, permalink: item.permalink,
        sourceUpdatedAt: item.sourceUpdatedAt, revision: item.revision,
        refs: await repository.listDocumentRefs(scope, item.documentId),
      });
    }
    cursor = result.nextCursor;
    if (cursor === null) return state;
  }
  throw new Error("sourceState: too many documents");
}

/** For comparing two syncs whose revision histories differ (multi-run vs single run). */
export function withoutRevisions(state: Map<string, DocumentState>): Map<string, Omit<DocumentState, "revision">> {
  return new Map([...state].map(([documentId, d]) => [documentId, {
    title: d.title, contentHash: d.contentHash, permalink: d.permalink, sourceUpdatedAt: d.sourceUpdatedAt, refs: d.refs,
  }]));
}

/** Raw row, tombstones included (getDocument hides them). */
export async function documentRow(
  db: Kysely<BrainDatabase>, scope: BrainScopeKey, documentId: string,
): Promise<{ revision: number; deleted: boolean } | null> {
  const row = await db.selectFrom("brain_documents").select(["revision", "deleted_at"])
    .where("owner_id", "=", scope.ownerId)
    .where("scope_id", "=", scope.scopeId)
    .where("document_id", "=", documentId)
    .executeTakeFirst();
  return row ? { revision: row.revision, deleted: row.deleted_at !== null } : null;
}

export interface GitSyncHarness {
  readonly harness: BrainHarness;
  readonly f: BrainGitFixture;
  /** A spy on console.warn, muted when the suite asked for it. */
  readonly warn: MockInstance<typeof console.warn>;
  /** syncGitSource for the fixture repo into scopeA unless options say otherwise. */
  sync(sourceId: string, options?: Partial<GitSyncOptions>): Promise<GitSyncResult>;
  /** A SpyRepository on the harness connection and clock. */
  spy(): SpyRepository;
}

/** Registers beforeEach / afterEach in the calling describe block: a fresh harness and fixture per test. */
export function useGitSyncHarness(options: { readonly muteWarnings?: boolean } = {}): GitSyncHarness {
  let harness: BrainHarness | null = null;
  let f: BrainGitFixture | null = null;
  let warn: MockInstance<typeof console.warn> | null = null;

  beforeEach(async () => {
    harness = await createBrainHarness();
    f = await createBrainGitFixture();
    warn = vi.spyOn(console, "warn");
    if (options.muteWarnings === true) warn.mockImplementation(() => undefined);
  });

  afterEach(async () => {
    warn?.mockRestore();
    await f?.destroy();
    await harness?.destroy();
    harness = null;
    f = null;
    warn = null;
  });

  const live = <T>(value: T | null): T => {
    if (value === null) throw new Error("useGitSyncHarness: used outside a test");
    return value;
  };
  return {
    get harness() { return live(harness); },
    get f() { return live(f); },
    get warn() { return live(warn); },
    sync: (sourceId, overrides = {}) => syncGitSource({
      repository: live(harness).repository, scope: scopeA, sourceId,
      repoPath: live(f).repoPath, homePath: live(f).homePath, ...overrides,
    }),
    spy: () => new SpyRepository(live(harness).db, () => live(harness).now()),
  };
}
