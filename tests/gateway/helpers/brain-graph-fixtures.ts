/**
 * Fixtures for the Company Brain graph tests: a PGlite store with the graph tables, a fake project resolver, a small
 * synthetic project (git, github and linear documents) and helpers to sync, tombstone and add decision claims.
 */
import { expect } from "vitest";
import { BrainApiError, brainProjectScope } from "../../../packages/gateway/src/brain/api/types.js";
import { computeBrainClaimId } from "../../../packages/gateway/src/brain/claims/types.js";
import { commitDocumentId } from "../../../packages/gateway/src/brain/git/documents.js";
import { BrainFeatureError, type BrainGraphFeature, type BrainProjectResolver } from "../../../packages/gateway/src/brain/contracts.js";
import { bootstrapBrainGraphDatabase, createBrainGraph } from "../../../packages/gateway/src/brain/graph/index.js";
import type { BrainScopeKey, BrainSyncUpsertInput } from "../../../packages/gateway/src/brain/index.js";
import { brainDocumentId, createBrainHarness, type BrainHarness } from "./brain-store-helpers.js";

export const PROJECT = "proj_widgets";
export const OWNER = "owner_a";
export const SCOPE: BrainScopeKey = brainProjectScope(OWNER, PROJECT);
export const GIT_IDENTITY = "https://github.com/acme/widgets";
export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

export const resolver: BrainProjectResolver = {
  homePath: "/home/test",
  async resolve(ownerId, projectRef) {
    if (ownerId !== OWNER || (projectRef !== PROJECT && projectRef !== "widgets")) {
      throw new BrainApiError("project_not_found");
    }
    return { projectId: PROJECT, slug: "widgets", name: "Widgets", scope: SCOPE };
  },
  async checkoutPath() {
    return null;
  },
};

export async function rejectsWith(promise: Promise<unknown>, type: typeof BrainApiError | typeof BrainFeatureError, code: string) {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(type);
  expect((error as { code: string }).code).toBe(code);
}

export interface GraphHarness extends BrainHarness {
  readonly graph: BrainGraphFeature;
  readonly sources: Record<"git" | "github" | "linear", string>;
  sync(kind: "git" | "github" | "linear", upserts: readonly BrainSyncUpsertInput[], deletions?: readonly string[]): Promise<void>;
  decide(documentId: string, quote: string): Promise<void>;
  refresh(): Promise<{ processed: number; removed: number; caughtUp: boolean }>;
}

/** Over `base` when given (a PostgreSQL store), else a fresh PGlite store. */
export async function createGraphHarness(base?: BrainHarness): Promise<GraphHarness> {
  const harness = base ?? await createBrainHarness();
  await bootstrapBrainGraphDatabase(harness.db);
  const graph = createBrainGraph({ repository: harness.repository, resolver, now: harness.now });
  const sources = {} as Record<"git" | "github" | "linear", string>;
  const cursors = new Map<string, string | null>();
  for (const [kind, ref] of [["git", GIT_IDENTITY], ["github", "acme/widgets"], ["linear", "ENG"]] as const) {
    sources[kind] = (await harness.repository.createSource(SCOPE, { kind, externalRef: ref, label: kind })).source.sourceId;
  }
  let runs = 0;
  return {
    ...harness, graph, sources,
    async sync(kind, upserts, deletions = []) {
      const sourceId = sources[kind];
      const next = `c${(runs += 1)}`;
      await harness.repository.applySyncBatch(SCOPE, {
        sourceId, expectedCursor: cursors.get(sourceId) ?? null, nextCursor: next, upserts, deletions,
      });
      cursors.set(sourceId, next);
      harness.tick();
    },
    async decide(documentId, quote) {
      const document = (await harness.repository.getDocument(SCOPE, documentId))!;
      const spanStart = document.body.indexOf(quote);
      const run = await harness.repository.openExtractionRun(SCOPE, { extractor: "rules/v1" });
      await harness.repository.applyDocumentExtraction(SCOPE, {
        runId: run.runId, documentId, incarnation: document.incarnation, revision: document.revision,
        extractor: "rules/v1", outcome: { status: "done", claims: [{
          claimId: computeBrainClaimId(documentId, "decision", null, quote), kind: "decision", label: null,
          statement: quote, quote, spanStart, spanEnd: spanStart + quote.length, fields: {}, confidence: "high",
        }] },
      });
      await harness.repository.closeExtractionRun(SCOPE, {
        runId: run.runId, status: "succeeded", nextAction: "", errorCode: null,
        counts: { documentsProcessed: 1, documentsFailed: 0, claimsWritten: 1, claimsRemoved: 0, claimsRejected: 0,
          quotesRejected: 0 },
        usage: { inputTokens: 0, outputTokens: 0, costMicroUsd: 0 },
      });
    },
    refresh: () => graph.index.refresh(SCOPE, {}, new AbortController().signal),
  };
}

/** A git adapter body: message, blank line, footer. */
export function gitBody(message: string, footer: { sha: string; author: string; pr?: string; merged?: string }): string {
  return [
    ...(message === "" ? [] : [message, ""]), `Commit: ${footer.sha}`, `Author: ${footer.author}`,
    "Committed: 2026-10-01T10:00:00.000Z", ...(footer.pr === undefined ? [] : [`Pull request: ${footer.pr}`]),
    ...(footer.merged === undefined ? [] : [`Merged branch: ${footer.merged}`]), "Changed paths: 2",
  ].join("\n");
}

/** Document ids by fixture seed; the commit uses the git adapter's id so a github_pr can nudge it. */
export const id = (seed: string): string => seed === "commitB" ? commitDocumentId(GIT_IDENTITY, SHA_B) : brainDocumentId(seed);

type Doc = Omit<BrainSyncUpsertInput, "documentId" | "permalink" | "sourceUpdatedAt"> & { at: string };
const doc = (seed: string, input: Doc): BrainSyncUpsertInput => {
  const { at, ...rest } = input;
  return { documentId: id(seed), permalink: `https://example.test/${seed}`, sourceUpdatedAt: at, ...rest };
};
const refs = (...pairs: [string, string][]) => pairs.map(([kind, value]) => ({ kind, value }));

/** The project: a squash PR, a direct commit, a spec, a GitHub PR with a review, a Linear issue and a comment. */
export const FIXTURE = {
  pr12: doc("pr12", {
    at: "2026-09-01T10:00:00.000Z", provenance: "git_pr", title: "feat: alpha",
    body: gitBody("Adds alpha after #7.\n\nFixes #9\n\nCo-authored-by: Alice Smith <alice@acme.dev>",
      { sha: SHA_A, author: "Bob Jones", pr: "#12" }),
    refs: refs(["pr", "12"], ["pr", "7"], ["spec", "specs/001-alpha"], ["path", "src/alpha.ts"],
      ["path", "specs/001-alpha/spec.md"]),
  }),
  commitB: doc("commitB", {
    at: "2026-09-02T10:00:00.000Z", provenance: "git_commit", title: "fix: tweak alpha",
    body: gitBody("fix: tweak alpha\n\nSigned-off-by: Alice Smith <alice@acme.dev>", { sha: SHA_B, author: "Alice Smith" }),
    refs: refs(["path", "src/alpha.ts"]),
  }),
  spec: doc("spec", {
    at: "2026-09-03T10:00:00.000Z", provenance: "git_spec", title: "Alpha",
    body: "# Alpha\n\n## Decisions\n\n- Keep alpha in src/alpha.ts as #12 shipped it, see specs/002-beta.",
    refs: refs(["path", "specs/001-alpha/spec.md"], ["spec", "specs/001-alpha"]),
  }),
  githubPr: doc("githubPr", {
    at: "2026-09-04T10:00:00.000Z", provenance: "github_pr", title: "feat: alpha", body: "Adds alpha.",
    refs: refs(["pr", "12"], ["handle", "#12"], ["commit", SHA_B], ["author", "github:alice"],
      ["reviewer", "github:carol"], ["issue", "ENG-42"]),
  }),
  review: doc("review", {
    at: "2026-09-05T10:00:00.000Z", provenance: "github_review", title: "Review of #12", body: "Looks good.",
    refs: refs(["pr", "12"], ["parent", id("githubPr")], ["author", "github:carol"]),
  }),
  issue: doc("issue", {
    at: "2026-09-06T10:00:00.000Z", provenance: "linear_issue", title: "Ship alpha", body: "Track alpha.",
    refs: refs(["handle", "ENG-42"], ["assignee", "email:alice@acme.dev"], ["status", "open"]),
  }),
  comment: doc("comment", {
    at: "2026-09-07T10:00:00.000Z", provenance: "linear_comment", title: "Comment on ENG-42", body: "Done soon.",
    refs: refs(["parent", id("issue")], ["author", "email:dana@acme.dev"]),
  }),
} as const;

export const SPEC_DECISION = "Keep alpha in src/alpha.ts as #12 shipped it, see specs/002-beta.";

/** Syncs every fixture document and derives the graph. */
export async function seedProject(harness: GraphHarness): Promise<void> {
  await harness.sync("git", [FIXTURE.pr12, FIXTURE.commitB, FIXTURE.spec]);
  await harness.sync("github", [FIXTURE.githubPr, FIXTURE.review]);
  await harness.sync("linear", [FIXTURE.issue, FIXTURE.comment]);
  await harness.decide(id("spec"), SPEC_DECISION);
  await harness.refresh();
}
