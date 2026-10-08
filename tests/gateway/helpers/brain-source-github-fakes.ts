/**
 * Fakes for the GitHub source tests: recorded-shape fixtures, a scriptable BrainGithubClient, a small page loop
 * that plays the sources runner's part (receipt, pages, applySyncBatch with expectedCursor), and the fake fetch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BRAIN_SOURCE_NEXT_ACTIONS, type BrainGithubSourceConfig, type BrainSourceAdapter, type BrainSourceErrorCode,
  type BrainSourceNotice,
} from "../../../packages/gateway/src/brain/contracts.js";
import type { BrainRepository, BrainScopeKey } from "../../../packages/gateway/src/brain/index.js";
import type {
  BrainGithubClient, BrainGithubFetchResult, BrainGithubResource,
} from "../../../packages/gateway/src/brain/sources/github/index.js";

export { fakeFetch, jsonResponse, type FakeFetchCall } from "./brain-integration-fetch.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "brain-github");

export function githubFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as T;
}

export const githubConfig: BrainGithubSourceConfig = {
  repo: "acme/widgets", mode: "integration", include: { pullRequests: true, reviews: true, issues: true },
  since: "2026-01-01",
};

export type FakeResponder = (resource: BrainGithubResource, call: number) => BrainGithubFetchResult | Promise<BrainGithubFetchResult>;

export interface FakeGithubClient extends BrainGithubClient {
  readonly calls: BrainGithubResource[];
}

export function ok(data: unknown, hasMore = false): BrainGithubFetchResult {
  return { ok: true, data, hasMore };
}

/** Serves the recorded fixtures for PR 12; listing pages come from `issues`. */
export function fixtureResponder(issues: (resource: Extract<BrainGithubResource, { kind: "issues" }>) => unknown[]): FakeResponder {
  return (resource) => {
    switch (resource.kind) {
      case "issues": return ok(issues(resource));
      case "pull": return ok({ ...githubFixture<Record<string, unknown>>("pull-12"), number: resource.number });
      case "pull_commits": return ok(githubFixture("pull-12-commits"));
      case "pull_reviews": return ok(githubFixture("pull-12-reviews"));
      case "pull_review_comments": return ok(githubFixture("pull-12-comments"));
    }
  };
}

export function fakeGithubClient(responder: FakeResponder, mode: "integration" | "token" = "integration"): FakeGithubClient {
  const calls: BrainGithubResource[] = [];
  return {
    mode, calls,
    async read(resource) {
      calls.push(resource);
      return responder(resource, calls.length);
    },
  };
}

/** What sources/core's runner does, reduced: one receipt, pages until caught up or the cap, one batch per page. */
export async function runGithubPages(input: {
  repository: BrainRepository; scope: BrainScopeKey; sourceId: string; externalRef: string;
  adapter: BrainSourceAdapter<BrainGithubSourceConfig>; config?: BrainGithubSourceConfig; maxPages?: number;
  limits?: { maxUpserts: number; maxDeletions: number; maxRefs: number }; now?: () => Date; signal?: AbortSignal;
}) {
  const { repository, scope, sourceId } = input;
  const receipt = await repository.openSyncReceipt(scope, { sourceId });
  let [pages, written, deleted, caughtUp] = [0, 0, 0, false];
  let errorCode: BrainSourceErrorCode | null = null;
  let retryAfterSeconds: number | null = null;
  const notices: BrainSourceNotice[] = [];
  while (pages < (input.maxPages ?? 20) && !caughtUp) {
    const cursor = (await repository.getSyncCursor(scope, sourceId))?.cursor ?? null;
    const result = await input.adapter.readPage({
      scope, sourceId, externalRef: input.externalRef, config: input.config ?? githubConfig, cursor,
      limits: input.limits ?? { maxUpserts: 100, maxDeletions: 200, maxRefs: 5_000 },
      signal: input.signal ?? new AbortController().signal, documents: repository,
      now: input.now ?? (() => new Date("2026-06-01T00:00:00Z")),
    });
    if (!result.ok) {
      errorCode = result.code;
      retryAfterSeconds = result.retryAfterSeconds ?? null;
      break;
    }
    const batch = await repository.applySyncBatch(scope, {
      sourceId, expectedCursor: cursor, nextCursor: result.page.nextCursor,
      upserts: result.page.upserts, deletions: result.page.deletions,
    });
    pages += 1;
    written += batch.created + batch.updated;
    deleted += batch.deleted;
    caughtUp = result.page.caughtUp;
    for (const notice of result.page.notices) if (!notices.includes(notice)) notices.push(notice);
  }
  const status: "succeeded" | "partial" | "failed" = errorCode === null ? (caughtUp ? "succeeded" : "partial") : pages > 0 ? "partial" : "failed";
  const nextAction = errorCode === null ? (caughtUp ? "" : "run_again") : BRAIN_SOURCE_NEXT_ACTIONS[errorCode];
  await repository.closeSyncReceipt(scope, {
    sourceId, receiptId: receipt.receiptId, status, nextAction, errorCode,
    counts: { read: written + deleted, written, unchanged: 0, deleted, failed: 0 },
  });
  return { status, errorCode, nextAction, pages, caughtUp, written, deleted, notices, retryAfterSeconds };
}
