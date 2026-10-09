import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrainGithubSourceConfig } from "../../packages/gateway/src/brain/contracts.js";
import {
  bootstrapBrainGithubDatabase, createGithubAdapter, githubDocumentId, type BrainGithubConditionalStore,
  type BrainGithubFetchResult, type BrainGithubResource,
} from "../../packages/gateway/src/brain/sources/github/index.js";
import { decodeGithubCursor, encodeGithubCursor } from "../../packages/gateway/src/brain/sources/github/cursor.js";
import { createBrainHarness, scopeA, type BrainHarness } from "./helpers/brain-store-helpers.js";
import {
  fakeGithubClient, fixtureResponder, githubConfig, githubFixture, ok, runGithubPages, type FakeResponder,
} from "./helpers/brain-source-github-fakes.js";

const externalRef = "https://github.com/acme/widgets";
const fixtureIssues = githubFixture<Record<string, unknown>[]>("issues-page");
const prId = githubDocumentId(externalRef, "pr", 12);
const KEY = "c".repeat(64);
const commentId = (id: number) => githubDocumentId(externalRef, "review_comment", id);
const refsOfDoc = (refs: readonly { kind: string; value: string }[], kind: string) => refs.filter((ref) => ref.kind === kind).map((ref) => ref.value);

let harness: BrainHarness;
let sourceId: string;

beforeEach(async () => {
  harness = await createBrainHarness();
  await bootstrapBrainGithubDatabase(harness.db);
  sourceId = (await harness.repository.createSource(scopeA, { kind: "github", externalRef, label: "GitHub acme/widgets" })).source.sourceId;
});
afterEach(async () => harness.destroy());

/** A listing server over `items`: updated at or after `since`, oldest update first, paged. */
function listing(items: () => Record<string, unknown>[]) {
  return (resource: Extract<BrainGithubResource, { kind: "issues" }>) => items()
    .filter((item) => String(item.updated_at) >= resource.since)
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
    .slice((resource.page - 1) * resource.perPage, resource.page * resource.perPage);
}

function issue(number: number, updatedAt: string): Record<string, unknown> {
  return { number, title: `Issue ${number}`, body: "", state: "open", user: { login: "zed" }, updated_at: updatedAt };
}

function adapterFor(responder: FakeResponder, mode: "integration" | "token" = "integration") {
  let conditional: BrainGithubConditionalStore | null = null;
  const client = fakeGithubClient(responder, mode);
  const adapter = createGithubAdapter({ kysely: harness.db, createClient: (store) => { conditional = store; return client; } });
  return { adapter, client, conditional: () => conditional! };
}

const run = (adapter: ReturnType<typeof adapterFor>["adapter"], extra: Partial<Parameters<typeof runGithubPages>[0]> = {}) =>
  runGithubPages({ repository: harness.repository, scope: scopeA, sourceId, externalRef, adapter, ...extra });

describe("github adapter", () => {
  it("syncs issues, pull requests, reviews and review comments, then is caught up", async () => {
    const { adapter, client } = adapterFor(fixtureResponder(listing(() => fixtureIssues)));
    const first = await run(adapter);
    expect(first).toMatchObject({ status: "succeeded", pages: 1, caughtUp: true, written: 5 });
    expect(client.calls.map((call) => call.kind)).toEqual(["issues", "pull", "pull_commits", "pull_reviews", "pull_review_comments"]);
    expect(client.calls[0]).toMatchObject({ since: "2026-01-01T00:00:00Z", page: 1, perPage: 50 });
    const refs = await harness.repository.listDocumentRefs(scopeA, prId);
    expect(refs.filter((ref) => ref.kind === "commit").map((ref) => ref.value))
      .toEqual(["1".repeat(40), "3".repeat(40), "a".repeat(40)]);
    expect((await harness.repository.getDocument(scopeA, commentId(902)))?.provenance).toBe("github_review_comment");
    const cursor = decodeGithubCursor((await harness.repository.getSyncCursor(scopeA, sourceId))!.cursor);
    expect(cursor).toEqual({ since: "2026-03-03T12:00:00Z", page: 1, done: [12] });

    const again = await run(adapter);
    expect(again).toMatchObject({ status: "succeeded", pages: 1, written: 0 });
    expect(client.calls).toHaveLength(6);
  });

  it("deletes review comments GitHub no longer lists when the pull request changes", async () => {
    let items = fixtureIssues;
    let comments = githubFixture<unknown[]>("pull-12-comments");
    const base = fixtureResponder(listing(() => items));
    const { adapter } = adapterFor((resource, call) => resource.kind === "pull_review_comments" ? ok(comments) : base(resource, call));
    await run(adapter);
    items = [fixtureIssues[0]!, { ...fixtureIssues[1]!, updated_at: "2026-03-04T00:00:00Z" }];
    comments = comments.slice(0, 1);
    const capped = await run(adapter, { limits: { maxUpserts: 100, maxDeletions: 0, maxRefs: 5_000 } });
    expect(capped).toMatchObject({ deleted: 0, written: 0 });
    expect(capped.notices).toContain("items_truncated");
    items = [fixtureIssues[0]!, { ...fixtureIssues[1]!, updated_at: "2026-03-05T00:00:00Z" }];
    expect(await run(adapter)).toMatchObject({ deleted: 1 });
    expect(await harness.repository.getDocument(scopeA, commentId(902))).toBeNull();
    expect(await harness.repository.getDocument(scopeA, commentId(901))).not.toBeNull();
  });

  it("keeps children when a child list is truncated", async () => {
    const base = fixtureResponder(listing(() => fixtureIssues));
    const truncated = adapterFor((resource, call) => resource.kind === "pull_reviews" || resource.kind === "pull_commits"
      ? ok(githubFixture(resource.kind === "pull_reviews" ? "pull-12-reviews" : "pull-12-commits"), true) : base(resource, call));
    const result = await run(truncated.adapter);
    expect(result).toMatchObject({ written: 5, deleted: 0 });
    expect(result.notices).toContain("items_truncated");
  });

  it("honours the include switches", async () => {
    const config: BrainGithubSourceConfig = { ...githubConfig, include: { pullRequests: true, reviews: false, issues: false } };
    const narrow = adapterFor(fixtureResponder(listing(() => fixtureIssues)));
    expect(await run(narrow.adapter, { config })).toMatchObject({ caughtUp: true, written: 1 });
    expect(narrow.client.calls.map((call) => call.kind)).toEqual(["issues", "pull", "pull_commits"]);
  });

  it("returns the items read before a provider failure, then the failure as retry_later", async () => {
    const base = fixtureResponder(listing(() => fixtureIssues));
    const { adapter } = adapterFor((resource, call) => resource.kind === "pull"
      ? { ok: false, code: "rate_limited", retryAfterSeconds: 30 } : base(resource, call));
    const result = await run(adapter);
    expect(result).toMatchObject({
      status: "partial", pages: 1, written: 1, errorCode: "rate_limited", nextAction: "retry_later", retryAfterSeconds: 30,
    });
    const receipts = await harness.repository.listSyncReceipts(scopeA, sourceId);
    expect(receipts[0]).toMatchObject({ status: "partial", errorCode: "rate_limited", nextAction: "retry_later" });
  });

  it("returns a failure held from the last page before calling GitHub again, even when a retry would succeed", async () => {
    const base = fixtureResponder(listing(() => fixtureIssues));
    let limited = true;
    const { adapter, client } = adapterFor((resource, call) => {
      if (resource.kind !== "pull" || !limited) return base(resource, call);
      limited = false;
      return { ok: false, code: "rate_limited", retryAfterSeconds: 30 };
    });
    expect(await run(adapter)).toMatchObject({
      status: "partial", pages: 1, written: 1, errorCode: "rate_limited", retryAfterSeconds: 30,
    });
    expect(client.calls.map((call) => call.kind)).toEqual(["issues", "pull"]);
    // The failure is returned once; the next run continues from the committed cursor.
    expect(await run(adapter)).toMatchObject({ status: "succeeded", caughtUp: true, written: 4 });
  });

  it("drops a held failure when the next call does not continue from the page that held it", async () => {
    const base = fixtureResponder(listing(() => fixtureIssues));
    let limited = true;
    const { adapter } = adapterFor((resource, call) => {
      if (resource.kind !== "pull" || !limited) return base(resource, call);
      limited = false;
      return { ok: false, code: "provider_timeout" };
    });
    const read = (cursor: string | null) => adapter.readPage({
      scope: scopeA, sourceId, externalRef, config: githubConfig, cursor, limits: { maxUpserts: 100, maxDeletions: 200, maxRefs: 5_000 },
      signal: new AbortController().signal, documents: harness.repository, now: () => new Date("2026-06-01T00:00:00Z"),
    });
    const first = await read(null);
    expect(first).toMatchObject({ ok: true, page: { caughtUp: false } });
    // The page's batch never committed: the runner reads from the old cursor again, so GitHub is asked again.
    const again = await read(null);
    expect(again).toMatchObject({ ok: true, page: { caughtUp: true } });
  });

  it("fails the run on listing errors and unreadable cursors or output", async () => {
    const down = adapterFor(() => ({ ok: false, code: "provider_unavailable" }));
    expect(await run(down.adapter)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    const garbage = adapterFor(() => ok([{ number: "x" }]));
    expect(await run(garbage.adapter)).toMatchObject({ errorCode: "provider_output_invalid" });
    const base = fixtureResponder(listing(() => fixtureIssues));
    const badPull = adapterFor((resource, call) => resource.kind === "pull" ? ok({ number: 0 }) : base(resource, call));
    expect(await run(badPull.adapter, { config: { ...githubConfig, include: { ...githubConfig.include, issues: false } } }))
      .toMatchObject({ status: "failed", errorCode: "provider_output_invalid" });
    const cached = adapterFor((resource, call) => resource.kind === "pull_commits" ? { ok: true, notModified: true } : base(resource, call));
    expect(await run(cached.adapter, { config: { ...githubConfig, include: { ...githubConfig.include, issues: false } } }))
      .toMatchObject({ errorCode: "provider_output_invalid" });
    const result = await down.adapter.readPage({
      scope: scopeA, sourceId, externalRef, config: githubConfig, cursor: "gh1:!!", limits: { maxUpserts: 1, maxDeletions: 1, maxRefs: 1 },
      signal: new AbortController().signal, documents: harness.repository, now: () => new Date(),
    });
    expect(result).toEqual({ ok: false, code: "cursor_invalid" });
  });

  it("writes ids under the source's stored ref and refuses a config for another repository", async () => {
    const moved = adapterFor(fixtureResponder(listing(() => fixtureIssues)));
    const old = (await harness.repository.createSource(scopeA, { kind: "github", externalRef: "https://github.com/acme/old", label: "o" })).source;
    const refused = await runGithubPages({ repository: harness.repository, scope: scopeA, sourceId: old.sourceId,
      externalRef: "https://github.com/acme/old", adapter: moved.adapter });
    expect(refused).toMatchObject({ status: "failed", errorCode: "config_invalid", written: 0 });
    expect(moved.client.calls).toEqual([]);
    expect(await harness.repository.getDocument(scopeA, githubDocumentId(externalRef, "issue", 7))).toBeNull();
    const cased = adapterFor(fixtureResponder(listing(() => fixtureIssues)));
    expect(await run(cased.adapter, { config: { ...githubConfig, repo: "Acme/Widgets" } })).toMatchObject({ status: "succeeded", written: 5 });
    expect((await harness.repository.getDocument(scopeA, githubDocumentId(externalRef, "issue", 7)))?.permalink)
      .toBe("https://github.com/Acme/Widgets/issues/7");
  });

  it("passes over a pull request that vanished between the listing and its reads", async () => {
    const base = fixtureResponder(listing(() => fixtureIssues));
    const { adapter } = adapterFor((resource, call) => resource.kind === "pull" ? { ok: false, code: "remote_not_found" } : base(resource, call));
    expect(await run(adapter)).toMatchObject({ status: "succeeded", written: 1 });
  });

  it("keeps a pull request too big for one page open until all its children are written", async () => {
    const reviews = Array.from({ length: 100 }, (_, i) => ({
      id: 1000 + i, user: { login: "bob" }, body: `Review ${i}`, state: "APPROVED", submitted_at: "2026-03-03T11:00:00Z",
    }));
    let comments = Array.from({ length: 50 }, (_, i) => ({
      id: 2000 + i, user: { login: "erin" }, body: `Comment ${i}`, path: "src/a.ts", line: 1,
      created_at: "2026-03-03T11:00:00Z", updated_at: "2026-03-03T11:00:00Z",
    }));
    let items = [issue(1, "2026-02-01T00:00:00Z"), { ...fixtureIssues[1]!, number: 30, updated_at: "2026-03-03T12:00:00Z" }];
    const base = fixtureResponder(listing(() => items));
    const { adapter } = adapterFor((resource, call) => {
      if (resource.kind === "pull_reviews") return ok(reviews);
      return resource.kind === "pull_review_comments" ? ok(comments) : base(resource, call);
    });
    const limits = { maxUpserts: 100, maxDeletions: 200, maxRefs: 5_000 };
    const cursorNow = async () => decodeGithubCursor((await harness.repository.getSyncCursor(scopeA, sourceId))!.cursor);
    const doc = (kind: string, id: number) => harness.repository.getDocument(scopeA, githubDocumentId(externalRef, kind, id));

    // Issue 1 alone (the pull request does not fit beside it), then the pull request with its first 99 children.
    expect(await run(adapter, { limits, maxPages: 2 })).toMatchObject({ pages: 2, caughtUp: false, written: 101, notices: [] });
    const open = { number: 30, updatedAt: "2026-03-03T12:00:00Z", written: 99 };
    expect(await cursorNow()).toEqual({ since: "2026-02-01T00:00:00Z", page: 1, done: [1], open });
    expect(await doc("review_comment", 2000)).toBeNull();
    expect(await run(adapter, { limits })).toMatchObject({ status: "succeeded", pages: 1, written: 51 });
    expect(await cursorNow()).toEqual({ since: "2026-03-03T12:00:00Z", page: 1, done: [30] });
    expect(await doc("review", 1099)).not.toBeNull();
    expect(await doc("review_comment", 2049)).not.toBeNull();

    // Forty comments go: nothing is deleted while the pull request is still open.
    comments = comments.slice(0, 10);
    items = [items[0]!, { ...items[1]!, updated_at: "2026-03-04T00:00:00Z" }];
    expect(await run(adapter, { limits, maxPages: 1 })).toMatchObject({ caughtUp: false, deleted: 0 });
    // It changes again while open: its children start over instead of skipping on from 99.
    items = [items[0]!, { ...items[1]!, updated_at: "2026-03-05T00:00:00Z" }];
    expect(await run(adapter, { limits, maxPages: 1 })).toMatchObject({ caughtUp: false, deleted: 0 });
    expect((await cursorNow())?.open).toEqual({ number: 30, updatedAt: "2026-03-05T00:00:00Z", written: 99 });
    // Another item comes first: the open pull request starts over after it, and the sweep runs on its last page.
    items = [...items, issue(2, "2026-03-04T12:00:00Z")];
    expect(await run(adapter, { limits })).toMatchObject({ status: "succeeded", pages: 3, written: 1, deleted: 40 });
    expect(await doc("review_comment", 2049)).toBeNull();
    expect(await doc("review_comment", 2009)).not.toBeNull();
    const raw = (c: unknown) => `gh1:${Buffer.from(JSON.stringify({ v: 1, s: "2026-03-05T00:00:00Z", p: 1, d: [], c })).toString("base64url")}`;
    const time = "2026-03-05T00:00:00Z";
    expect([{ n: 30, u: "x", o: 1 }, { n: 30, u: time, o: 0 }, { n: 30, u: time, o: 201 }, { n: 30, u: time, o: 1, x: 1 }]
      .map((c) => decodeGithubCursor(raw(c)))).toEqual([null, null, null, null]);
  });

  it("walks ties at one timestamp across pages and moves on past more than the remembered ties", async () => {
    const tied = Array.from({ length: 120 }, (_, i) => issue(i + 1, "2026-02-01T00:00:00Z"));
    const { adapter, client } = adapterFor((resource) => resource.kind === "issues" ? ok(listing(() => tied)(resource)) : ok([]));
    const result = await run(adapter, { maxPages: 20 });
    expect(result).toMatchObject({ status: "succeeded", caughtUp: true, written: 101 });
    expect(result.notices).toContain("items_truncated");
    expect(client.calls.filter((call) => call.kind === "issues").map((call) => "page" in call ? call.page : 0)).toContain(3);
    const cursor = decodeGithubCursor((await harness.repository.getSyncCursor(scopeA, sourceId))!.cursor);
    expect(cursor).toEqual({ since: "2026-02-01T00:00:01Z", page: 1, done: [] });
  });

  it("walks the tie pages again before moving on when a tied item changes between pages", async () => {
    const tied = Array.from({ length: 60 }, (_, i) => issue(i + 1, "2026-02-01T00:00:00Z"));
    let changed = false;
    const { adapter, client } = adapterFor((resource) => {
      if (resource.kind !== "issues") return ok([]);
      // Issue 5 changes just before page 2 is read: issue 51 slides back onto page 1.
      if (resource.page === 2 && !changed) [changed, tied[4]] = [true, issue(5, "2026-02-02T00:00:00Z")];
      return ok(listing(() => tied)(resource));
    });
    expect(await run(adapter, { maxPages: 20 })).toMatchObject({ status: "succeeded", caughtUp: true });
    expect(await harness.repository.getDocument(scopeA, githubDocumentId(externalRef, "issue", 51))).not.toBeNull();
    expect(client.calls.map((call) => "page" in call ? call.page : 0)).toEqual([1, 1, 1, 2, 1, 1, 2, 1, 2]);
    const cursor = decodeGithubCursor((await harness.repository.getSyncCursor(scopeA, sourceId))!.cursor);
    expect(cursor).toEqual({ since: "2026-02-02T00:00:00Z", page: 1, done: [5] });
    const recheck = { since: "2026-02-01T00:00:00Z", page: 2, done: [1], recheck: true as const };
    expect(decodeGithubCursor(encodeGithubCursor(recheck))).toEqual(recheck);
    const raw = `gh1:${Buffer.from(JSON.stringify({ v: 1, s: recheck.since, p: 1, d: [], r: 2 })).toString("base64url")}`;
    expect(decodeGithubCursor(raw)).toBeNull();
  });

  it("stops a page at its document, time and abort limits", async () => {
    const base = fixtureResponder(listing(() => fixtureIssues));
    const small = adapterFor(base);
    // Issue 7; then pull request 12 alone with its first two children; then its last child.
    const limited = await run(small.adapter, { limits: { maxUpserts: 3, maxDeletions: 10, maxRefs: 5_000 } });
    expect(limited).toMatchObject({ status: "succeeded", pages: 3, written: 5 });
    expect(limited.notices).not.toContain("items_truncated");
    // Room for the pull request document only: no child fits, so it is cut and passed.
    const tiny = (await harness.repository.createSource(scopeA, { kind: "github", externalRef: "c", label: "c" })).source.sourceId;
    const lone = adapterFor(fixtureResponder(listing(() => [{ ...fixtureIssues[1]!, number: 40 }])));
    const cut = await runGithubPages({
      repository: harness.repository, scope: scopeA, sourceId: tiny, externalRef, adapter: lone.adapter,
      limits: { maxUpserts: 1, maxDeletions: 10, maxRefs: 5_000 },
    });
    expect(cut).toMatchObject({ status: "succeeded", pages: 1, written: 1 });
    expect(cut.notices).toContain("items_truncated");

    let clock = Date.parse("2026-06-01T00:00:00Z");
    const slow = adapterFor(fixtureResponder(listing(() => [issue(1, "2026-02-01T00:00:00Z"), issue(2, "2026-02-02T00:00:00Z")])));
    const timed = await runGithubPages({
      repository: harness.repository, scope: scopeA, sourceId: (await harness.repository.createSource(scopeA, { kind: "github", externalRef: "a", label: "a" })).source.sourceId,
      externalRef, adapter: slow.adapter, now: () => new Date((clock += 5_000)),
    });
    expect(timed).toMatchObject({ pages: 2, written: 2 });

    const controller = new AbortController();
    controller.abort();
    const aborted = adapterFor(base);
    const fresh = (await harness.repository.createSource(scopeA, { kind: "github", externalRef: "b", label: "b" })).source.sourceId;
    expect(await runGithubPages({
      repository: harness.repository, scope: scopeA, sourceId: fresh, externalRef, adapter: aborted.adapter,
      signal: controller.signal, maxPages: 1,
    })).toMatchObject({ pages: 1, caughtUp: false, written: 0 });
  });

  it("uses listing validators only after the cursor they were written with has committed", async () => {
    let items = [issue(1, "2026-02-01T00:00:00Z")];
    let validator = '"v1"';
    const { adapter, conditional } = adapterFor(async (resource): Promise<BrainGithubFetchResult> => {
      if (resource.kind !== "issues") return ok([]);
      const stored = await conditional().lookup(KEY);
      if (stored?.etag === validator) return { ok: true, notModified: true };
      conditional().remember(KEY, { etag: validator, lastModified: null });
      return ok(listing(() => items)(resource));
    }, "token");
    const rows = () => harness.db.selectFrom("brain_github_conditional" as never).selectAll().execute() as Promise<{ confirmed: boolean }[]>;
    await run(adapter);
    expect(await rows()).toEqual([]);
    await run(adapter);
    expect((await rows()).map((row) => row.confirmed)).toEqual([true]);
    const quiet = await run(adapter);
    expect(quiet.notices).toEqual(["not_modified"]);

    items = [...items, issue(2, "2026-02-01T00:00:00Z")];
    validator = '"v2"';
    expect(await run(adapter)).toMatchObject({ written: 1 });
    expect((await rows()).map((row) => row.confirmed)).toEqual([false]);
    expect((await run(adapter)).notices).toEqual(["not_modified"]);
    expect((await rows()).map((row) => row.confirmed)).toEqual([true]);
  });

  it("starts from the configured day and answers not_modified on a first run", async () => {
    const { adapter } = adapterFor(() => ({ ok: true, notModified: true }));
    expect(await run(adapter, { config: { ...githubConfig, since: undefined } })).toMatchObject({ caughtUp: true, notices: ["not_modified"] });
    const cursor = decodeGithubCursor((await harness.repository.getSyncCursor(scopeA, sourceId))!.cursor);
    expect(cursor?.since).toBe("2025-06-01T00:00:00Z");
  });

  it("returns child read failures and keeps long text within the store limit", async () => {
    const base = fixtureResponder(listing(() => fixtureIssues));
    const prOnly = { ...githubConfig, include: { ...githubConfig.include, issues: false } };
    for (const failing of ["pull_reviews", "pull_review_comments"] as const) {
      const { adapter } = adapterFor((resource, call) => resource.kind === failing ? { ok: false, code: "provider_timeout" } : base(resource, call));
      expect(await run(adapter, { config: prOnly })).toMatchObject({ status: "failed", errorCode: "provider_timeout" });
    }
    const long = "x".repeat(70_000);
    const { adapter } = adapterFor((resource, call) => {
      if (resource.kind === "issues") return ok(fixtureIssues.map((item) => ({ ...item, body: long })));
      if (resource.kind === "pull_reviews") return ok([{ id: 7, user: null, body: long, state: "CHANGES_REQUESTED", submitted_at: null }]);
      if (resource.kind === "pull_review_comments") return ok([{ ...githubFixture<Record<string, unknown>[]>("pull-12-comments")[0], body: long }]);
      return base(resource, call);
    });
    const result = await run(adapter);
    expect(result).toMatchObject({ status: "succeeded", written: 4 });
    expect(result.notices).toContain("body_truncated");
    expect(refsOfDoc(await harness.repository.listDocumentRefs(scopeA, prId), "reviewer")).toEqual(["github:erin"]);
  });

  it("links a submitted reviewer with no review text and no request, but not a pending one", async () => {
    const base = fixtureResponder(listing(() => fixtureIssues));
    const { adapter } = adapterFor((resource, call) => {
      if (resource.kind === "pull") return ok({ ...githubFixture<Record<string, unknown>>("pull-12"), requested_reviewers: [] });
      if (resource.kind === "pull_reviews") {
        return ok([...githubFixture<Record<string, unknown>[]>("pull-12-reviews"), { id: 504, user: { login: "frank" }, body: "", state: "PENDING" }]);
      }
      return base(resource, call);
    });
    expect(await run(adapter)).toMatchObject({ status: "succeeded", written: 5 });
    expect(refsOfDoc(await harness.repository.listDocumentRefs(scopeA, prId), "reviewer")).toEqual(["github:bob", "github:erin"]);
  });

  it("moves past a listing that keeps returning items older than the watermark", async () => {
    const stale = Array.from({ length: 50 }, (_, i) => issue(i + 1, "2025-01-01T00:00:00Z"));
    const { adapter, client } = adapterFor((resource) => ok(resource.kind === "issues" ? stale : []));
    const result = await run(adapter);
    expect(result).toMatchObject({ caughtUp: false, written: 0 });
    expect(result.notices).toContain("items_truncated");
    expect(client.calls.map((call) => "page" in call ? call.page : 0).slice(0, 4)).toEqual([1, 2, 3, 1]);
  });

  it("answers lookups before any page and remembers a bounded number of validators", async () => {
    const keys = Array.from({ length: 10 }, (_, i) => i.toString(16).padStart(64, "0"));
    const { adapter, conditional } = adapterFor((resource) => {
      if (resource.kind === "issues") for (const key of keys) conditional().remember(key, { etag: '"e"', lastModified: null });
      return ok([]);
    }, "token");
    expect(await conditional().lookup(KEY)).toBeNull();
    await run(adapter);
    const stored = await harness.db.selectFrom("brain_github_conditional" as never).selectAll().execute();
    expect(stored).toHaveLength(8);
  });
});
