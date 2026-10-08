/** brain_why: listDocumentsByRef, brainWhy on a synced fixture repository, and the pure helpers. PGlite-backed. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_TRUNCATION_MARKER } from "../../packages/gateway/src/brain/git/index.js";
import { type BrainDocumentRef, type BrainRefMatchQuery } from "../../packages/gateway/src/brain/index.js";
import { encodeRefMatchCursor, selectDocumentsByRef } from "../../packages/gateway/src/brain/refs-reads.js";
import {
  brainWhy, extractBrainWhySections, normalizeBrainWhyPath, parseBrainGitFooter,
} from "../../packages/gateway/src/brain/why.js";
import { FIXTURE_WEB_BASE as WEB, SPECIAL_PATH, buildBaseHistory } from "./helpers/brain-git-fixture.js";
import { createGitSource, useGitSyncHarness } from "./helpers/brain-git-harness.js";
import {
  brainContent, brainDocumentId, createBrainHarness, expectBrainError, scopeA, scopeB, scopeOtherOwner,
  type BrainHarness,
} from "./helpers/brain-store-helpers.js";

const path = (value: string): BrainDocumentRef => ({ kind: "path", value });
const spec = (value: string): BrainDocumentRef => ({ kind: "spec", value });
const GIT = ["git_pr", "git_commit", "git_spec"];
const query = (overrides: Partial<BrainRefMatchQuery> = {}): BrainRefMatchQuery => ({
  kind: "path", value: "src/a", mode: "exact_or_under", provenances: GIT, ...overrides,
});
interface Seed {
  readonly seed: string; readonly refs: readonly BrainDocumentRef[]; readonly at?: string; readonly provenance?: string;
  readonly body?: string;
}
const SHA = "a".repeat(40);
const footer = (extra: readonly string[] = [], sha = SHA) =>
  [`Commit: ${sha}`, "Author: A", "Committed: 2026-09-01T00:00:00Z", ...extra, "Changed paths: 1"].join("\n");

describe("listDocumentsByRef", () => {
  let harness: BrainHarness;
  beforeEach(async () => { harness = await createBrainHarness(); });
  afterEach(() => harness.destroy());

  async function seed(docs: readonly Seed[], scope = scopeA): Promise<string> {
    const { source } = await harness.repository.createSource(scope, { kind: "git", externalRef: "R", label: "R" });
    await harness.repository.applySyncBatch(scope, {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [],
      upserts: docs.map((d) => ({
        ...brainContent(d.seed, { provenance: d.provenance ?? "git_commit", sourceUpdatedAt: d.at ?? "2026-09-01T00:00:00Z" }),
        ...(d.body === undefined ? {} : { body: d.body }),
        refs: [...d.refs],
      })),
    });
    return source.sourceId;
  }
  const ids = (page: { items: readonly { document: { documentId: string } }[] }) =>
    page.items.map((item) => item.document.documentId);
  const idsOf = (...seeds: string[]) => seeds.map(brainDocumentId);

  it("matches a file exactly and a folder by bytewise prefix", async () => {
    await seed([
      { seed: "file", refs: [path("src/a")], at: "2026-09-08T00:00:00Z" },
      { seed: "under", refs: [path("src/a/b.ts"), path("other.ts")], at: "2026-09-07T00:00:00Z" },
      { seed: "deep", refs: [path("src/a/c/d.ts")], at: "2026-09-06T00:00:00Z" },
      ...["src/a-b", "src/a.b", "src/a0", "src/ab/x.ts", "src/a.ts", "src", "a/src/a/x"].map((value, n) => ({
        seed: `near${n}`, refs: [path(value)],
      })),
      { seed: "spec-only", refs: [spec("src/a/x")] },
    ]);
    const { repository } = harness;
    const both = await repository.listDocumentsByRef(scopeA, query());
    expect(ids(both)).toEqual(idsOf("file", "under", "deep"));
    expect(both).toMatchObject({ total: 3, totalCapped: false, nextCursor: null });
    expect(both.items[1]?.refs).toEqual([path("src/a/b.ts")]);
    expect(ids(await repository.listDocumentsByRef(scopeA, query({ mode: "under" })))).toEqual(idsOf("under", "deep"));
    expect(ids(await repository.listDocumentsByRef(scopeA, query({ value: "src/a.ts" })))).toEqual(idsOf("near4"));
    expect(ids(await repository.listDocumentsByRef(scopeA, query({ value: "src/a/c", mode: "under" })))).toEqual(idsOf("deep"));
    expect((await repository.listDocumentsByRef(scopeA, query({ value: "nope" }))).items).toEqual([]);
  });

  it("returns only live documents of the scope and provenances, with extra ref kinds", async () => {
    const sourceId = await seed([
      { seed: "pr", provenance: "git_pr", refs: [spec("specs/2"), path("src/a/x.ts"), { kind: "pr", value: "7" }, spec("specs/1")] },
      { seed: "slack", provenance: "slack_message", refs: [path("src/a/x.ts")] },
      { seed: "gone", refs: [path("src/a/y.ts")] },
    ]);
    await harness.repository.applySyncBatch(scopeA, {
      sourceId, expectedCursor: "c1", nextCursor: "c2", upserts: [], deletions: [brainDocumentId("gone")],
    });
    await seed([{ seed: "b", refs: [path("src/a")] }], scopeB);
    await seed([{ seed: "o", refs: [path("src/a")] }], scopeOtherOwner);
    const page = await harness.repository.listDocumentsByRef(scopeA, query({ extraRefKinds: ["spec"] }));
    expect(ids(page)).toEqual(idsOf("pr"));
    expect(page.items[0]?.refs).toEqual([path("src/a/x.ts"), spec("specs/1"), spec("specs/2")]);
    expect(page.items[0]?.document).toMatchObject({ title: "Title pr", provenance: "git_pr", deletedAt: null });
    expect(ids(await harness.repository.listDocumentsByRef(scopeB, query()))).toEqual(idsOf("b"));
    expect(ids(await harness.repository.listDocumentsByRef(scopeA, query({ provenances: ["slack_message"] })))).toEqual(idsOf("slack"));
  });

  it("pages newest first exactly once across timestamp ties, with the total on every page", async () => {
    const times = ["2026-09-03T00:00:00Z", "2026-09-02T00:00:00.123456Z", "2026-09-02T00:00:00.123457Z"];
    const docs = Array.from({ length: 9 }, (_, n) => ({ seed: `d${n}`, refs: [path(`src/a/${n}.ts`)], at: times[n % 3] }));
    await seed(docs);
    const expected = docs.map((d) => ({ id: brainDocumentId(d.seed), at: new Date(d.at).getTime() + (d.at.endsWith("7Z") ? 0.5 : 0) }))
      .sort((x, y) => y.at - x.at || (x.id < y.id ? 1 : -1)).map((d) => d.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await harness.repository.listDocumentsByRef(scopeA, query({ limit: 2, cursor }));
      expect([result.total, result.totalCapped]).toEqual([9, false]);
      seen.push(...ids(result));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(expected);
  });

  it("labels documents by the shared cite rule and reads a two-backtick line as text", async () => {
    const handle = (value: string): BrainDocumentRef => ({ kind: "handle", value });
    await seed([
      { seed: "pr", provenance: "git_pr", refs: [path("src/a/1.ts")], at: "2026-09-04T00:00:00Z", body: "No footer." },
      { seed: "nonum", provenance: "git_pr", refs: [path("src/a/2.ts")], at: "2026-09-03T00:00:00Z",
        body: `\`\`not a fence\`\`\n## Summary\nKept.\n\n${footer()}` },
      { seed: "commit", refs: [path("src/a/3.ts")], at: "2026-09-02T00:00:00Z", body: "Plain commit." },
      { seed: "spec", provenance: "git_spec", refs: [path("src/a/4.md"), spec("specs/9-b"), spec("specs/1-a")],
        at: "2026-09-01T00:00:00Z", body: "Spec text." },
      { seed: "handled", provenance: "git_spec", refs: [path("src/a/5.md"), spec("specs/1-a"), handle("SPEC-5")],
        at: "2026-08-31T00:00:00Z", body: "Handled." },
      { seed: "bare", provenance: "git_spec", refs: [path("src/a/6.md")], at: "2026-08-30T00:00:00Z", body: "Bare." },
    ]);
    const page = await brainWhy(harness.repository, scopeA, { path: "src/a/" });
    // A pull request footer without a number cites its short sha, a spec its first spec ref, else its handle or title.
    expect(page.items.map((i) => [i.kind, i.label, i.number, i.sha, i.link, i.summary?.text])).toEqual([
      ["pr", "PR", null, null, "none", "No footer."], ["pr", SHA.slice(0, 12), null, SHA, "none", "Kept."],
      ["commit", "commit", null, null, "none", "Plain commit."], ["spec", "specs/1-a", null, null, "none", undefined],
      ["spec", "SPEC-5", null, null, "none", undefined], ["spec", "Title bare", null, null, "none", undefined],
    ]);
    expect(page.items[3]!.specs).toEqual(["specs/1-a", "specs/9-b"]);
  });

  it("caps the count and rejects bad cursors and queries", async () => {
    await seed([1, 2, 3].map((n) => ({ seed: `c${n}`, refs: [path(`src/a/${n}`)] })));
    const parsed = { ...query(), extraRefKinds: [], limit: 10, cursor: null };
    expect(await selectDocumentsByRef(harness.db, scopeA, parsed, 2)).toMatchObject({ total: 2, totalCapped: true });
    expect(await selectDocumentsByRef(harness.db, scopeA, parsed, 3)).toMatchObject({ total: 3, totalCapped: false });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const id = brainDocumentId("c1");
    for (const cursor of [
      "!!", "a b", Buffer.from("not json").toString("base64url"), encode([1, 2]), encode(["2026-09-01T00:00:00.000000Z"]),
      encode(["2026-09-01T00:00:00.000Z", id]), encode(["2026-09-01T00:00:00.000000Z", "abc"]),
      encode(["2026-09-01T00:00:00.000000Z", id, 1]), encode({ at: "2026-09-01T00:00:00.000000Z", id }),
      encode(["0000-01-01T00:00:00.000000Z", id]),
    ]) await expectBrainError(harness.repository.listDocumentsByRef(scopeA, query({ cursor })), "invalid");
    const good = encodeRefMatchCursor({ at: "2026-09-01T00:00:00.000000Z", documentId: "f".repeat(64) });
    expect((await harness.repository.listDocumentsByRef(scopeA, query({ cursor: good }))).total).toBe(3);
    for (const bad of [
      { provenances: [] }, { provenances: ["git_pr", "git_pr"] }, { limit: 51 }, { limit: 0 }, { value: "" },
      { value: "a\u0000b" }, { value: "\u00e9".repeat(257) }, { kind: "Path" }, { mode: "prefix" },
      { extraRefKinds: ["a", "b", "c", "d", "e"] }, { cursor: "x".repeat(257) }, { extra: 1 },
    ] as Partial<BrainRefMatchQuery>[]) await expectBrainError(harness.repository.listDocumentsByRef(scopeA, query(bad)), "invalid");
    await expectBrainError(harness.repository.listDocumentsByRef({ ownerId: "", scopeId: "s" }, query()), "invalid");
  });
});
