/**
 * syncGitSource end to end: real fixture repos built with git plumbing in a
 * temp Matrix home, synced into a PGlite-backed BrainRepository. Failure paths
 * live in brain-git-sync-failures.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { GitSyncResult } from "../../packages/gateway/src/brain/git/index.js";
import { BRAIN_TABLES, countBrainRows, scopeA, scopeB, zeroCounts } from "./helpers/brain-store-helpers.js";
import {
  ALPHA_SPEC_V1, BETA_BODY, FEATURE_X_SPEC, FIXTURE_AUTHOR, FIXTURE_WEB_BASE, SPECIAL_PATH, SQUASH_1_BODY,
  UNIT_SEPARATOR_BODY, bigSpecText, buildBaseHistory, type BaseHistory,
} from "./helpers/brain-git-fixture.js";
import {
  createGitSource, documentRow, fixtureDocumentId as id, gitDocumentId, sortRefs, sourceState, useGitSyncHarness,
  withoutRevisions, type FixtureRef,
} from "./helpers/brain-git-harness.js";

const WEB = FIXTURE_WEB_BASE;
const specId = (file: string, part = 1): string => id("file", file, part);
const path = (value: string): FixtureRef => ({ kind: "path", value });
const pr = (n: number): FixtureRef => ({ kind: "pr", value: String(n) });
const spec = (value: string): FixtureRef => ({ kind: "spec", value });

/** `sha` is the commit whose %cI is the document's sourceUpdatedAt. */
interface Expected {
  readonly id: string; readonly title: string; readonly body: string; readonly permalink: string;
  readonly provenance: string; readonly sha: string; readonly refs: readonly FixtureRef[];
}

interface CommitExpectation {
  readonly sha: string; readonly title: string; readonly message?: string; readonly total: number;
  readonly pr?: number; readonly branch?: string; readonly refs: readonly FixtureRef[];
}

describe("syncGitSource", { timeout: 60_000 }, () => {
  const t = useGitSyncHarness();
  const { sync, spy } = t;
  const getDocument = (documentId: string) => t.harness.repository.getDocument(scopeA, documentId);
  const refsOf = (documentId: string, scope = scopeA) => t.harness.repository.listDocumentRefs(scope, documentId);
  const liveIds = async (sourceId: string, scope = scopeA) =>
    [...(await sourceState(t.harness.repository, scope, sourceId)).keys()].sort();

  async function footer(sha: string, extra: readonly string[], total: number, indexed?: number): Promise<string> {
    return [
      `Commit: ${sha}`, `Author: ${FIXTURE_AUTHOR}`, `Committed: ${await t.f.committedAt(sha)}`, ...extra,
      indexed === undefined ? `Changed paths: ${total}` : `Changed paths: ${total} (${indexed} indexed)`,
    ].join("\n");
  }

  async function commitDoc(o: CommitExpectation): Promise<Expected> {
    const extra = [...(o.pr ? [`Pull request: #${o.pr}`] : []), ...(o.branch ? [`Merged branch: ${o.branch}`] : [])];
    const foot = await footer(o.sha, extra, o.total);
    return {
      id: o.pr ? id("pr", o.pr) : id("commit", o.sha), title: o.title, sha: o.sha, refs: o.refs,
      body: o.message ? `${o.message}\n\n${foot}` : foot,
      permalink: o.pr ? `${WEB}/pull/${o.pr}` : `${WEB}/commit/${o.sha}`,
      provenance: o.pr ? "git_pr" : "git_commit",
    };
  }

  function specDoc(file: string, title: string, body: string, sha: string): Expected {
    return {
      id: specId(file), title, body, sha, permalink: `${WEB}/blob/${sha}/${file}`, provenance: "git_spec",
      refs: [path(file), spec(file.slice(0, file.lastIndexOf("/")))],
    };
  }

  async function expectDocument(e: Expected): Promise<void> {
    expect(await getDocument(e.id), e.title).toMatchObject({
      title: e.title, body: e.body, permalink: e.permalink, provenance: e.provenance,
      sourceUpdatedAt: new Date(await t.f.committedAt(e.sha)).toISOString(),
    });
    expect(await refsOf(e.id), e.title).toEqual(sortRefs(e.refs));
  }

  async function baseExpectations(h: BaseHistory): Promise<Expected[]> {
    const alpha = "specs/001-alpha/spec.md";
    const featureX = "specs/002-feature-x/spec.md";
    return [
      await commitDoc({
        sha: h.root, title: "Initial commit", total: 2,
        refs: [spec("specs/001-alpha"), path("README.md"), path(alpha)],
      }),
      await commitDoc({
        sha: h.squash1, title: "feat(brain): alpha", message: SQUASH_1_BODY, pr: 1, total: 2,
        refs: [pr(1), spec("specs/001-alpha"), path(alpha), path("src/alpha.ts")],
      }),
      await commitDoc({ sha: h.tidy, title: "chore: tidy", total: 1, refs: [path("README.md")] }),
      await commitDoc({
        sha: h.merge2, title: "Add feature X", pr: 2, branch: "acme/feature-x", total: 2,
        refs: [pr(2), spec("specs/002-feature-x"), path(featureX), path("src/x.ts")],
      }),
      await commitDoc({
        sha: h.merge3, title: "feat: beta", message: BETA_BODY, pr: 3, total: 1, refs: [pr(3), path("src/beta.ts")],
      }),
      await commitDoc({
        sha: h.revert1, title: 'Revert "feat(brain): alpha (#1)"', message: `This reverts commit ${h.squash1}.`,
        total: 2, refs: [pr(1), spec("specs/001-alpha"), path(alpha), path("src/alpha.ts")],
      }),
      await commitDoc({ sha: h.empty4, title: "chore: empty", pr: 4, total: 0, refs: [pr(4)] }),
      await commitDoc({
        sha: h.unitSeparator, title: "fix: keep unit separators", message: UNIT_SEPARATOR_BODY, total: 1,
        refs: [path("notes/unit.txt")],
      }),
      await commitDoc({ sha: h.special, title: "docs: caf\u00e9 notes", total: 1, refs: [path(SPECIAL_PATH)] }),
      specDoc(alpha, "Alpha", ALPHA_SPEC_V1, h.revert1),
      specDoc(featureX, "Feature X", FEATURE_X_SPEC, h.merge2),
    ];
  }

  it("indexes each first-parent commit as a PR or commit document, plus spec files, with refs", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const result = await sync(sourceId);

    expect(result).toMatchObject({
      status: "succeeded", errorCode: null, nextAction: "", cursorBefore: null, cursorAfter: h.tip,
      commitsProcessed: 9, commitsRemaining: 0, caughtUp: true, historyRewritten: false, batches: 1,
      rejectedDocumentIds: [], notices: [],
    });
    // read is upserts plus tombstones that hit a live document; the no-op deletions of parts 2..8 do not count.
    expect(result.counts).toEqual({ read: 11, written: 11, unchanged: 0, deleted: 0, failed: 0 });
    expect(result.receipt).toMatchObject({
      status: "succeeded", counts: result.counts, nextAction: "", errorCode: null, cursorBefore: null, cursorAfter: h.tip,
    });
    expect(await t.harness.repository.listSyncReceipts(scopeA, sourceId)).toEqual([result.receipt]);
    expect((await t.harness.repository.getSyncCursor(scopeA, sourceId))?.cursor).toBe(h.tip);

    const expected = await baseExpectations(h);
    const state = await sourceState(t.harness.repository, scopeA, sourceId);
    expect([...state.keys()].sort()).toEqual(expected.map((e) => e.id).sort());
    for (const e of expected) await expectDocument(e);
    expect([...state.values()].map((d) => d.revision)).toEqual(expected.map(() => 1));
  });

  it("makes no store writes when the cursor is already at the tip", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect((await sync(sourceId)).status).toBe("succeeded");
    const before = await sourceState(t.harness.repository, scopeA, sourceId);
    const cursor = await t.harness.repository.getSyncCursor(scopeA, sourceId);
    t.harness.tick(60_000);

    const repository = spy();
    const again = await sync(sourceId, { repository });
    expect(repository.calls).toHaveLength(0);
    expect(again).toMatchObject({
      status: "succeeded", errorCode: null, nextAction: "", cursorBefore: h.tip, cursorAfter: h.tip,
      commitsProcessed: 0, commitsRemaining: 0, caughtUp: true, batches: 0,
    });
    expect(again.counts).toEqual(zeroCounts);
    expect(again.receipt).toMatchObject({ status: "succeeded", counts: zeroCounts, nextAction: "" });
    expect(await t.harness.repository.getSyncCursor(scopeA, sourceId)).toEqual(cursor);
    expect(await sourceState(t.harness.repository, scopeA, sourceId)).toEqual(before);
  });

  it("applies one new commit as exactly one created document", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    await sync(sourceId);
    const before = await sourceState(t.harness.repository, scopeA, sourceId);
    t.harness.tick();

    const sha = await t.f.commit({ message: "fix: incremental", files: { "src/inc.ts": "inc\n" } });
    const result = await sync(sourceId);
    expect(result).toMatchObject({
      status: "succeeded", cursorBefore: h.tip, cursorAfter: sha, commitsProcessed: 1, caughtUp: true, batches: 1,
    });
    expect(result.counts).toEqual({ read: 1, written: 1, unchanged: 0, deleted: 0, failed: 0 });
    const after = await sourceState(t.harness.repository, scopeA, sourceId);
    expect(after.size).toBe(before.size + 1);
    expect(after.get(id("commit", sha))).toMatchObject({ title: "fix: incremental", revision: 1, refs: [path("src/inc.ts")] });
    for (const [documentId, state] of before) expect(after.get(documentId)).toEqual(state);
  });

  it("finishes over several bounded runs and converges with a single-run sync", async () => {
    const h = await buildBaseHistory(t.f);
    const fp = h.firstParent;
    const sourceA = await createGitSource(t.harness.repository, scopeA);
    const runs: GitSyncResult[] = [];
    for (let run = 0; run < 10; run++) {
      const result = await sync(sourceA, { limits: { commitsPerRun: 2, commitsPerWindow: 1 } });
      runs.push(result);
      if (result.caughtUp || result.status !== "succeeded") break;
    }
    // A run that stops short records the tip it read after the cursor's position.
    expect(runs.map((r) => [r.status, r.commitsProcessed, r.commitsRemaining, r.cursorAfter, r.nextAction, r.batches]))
      .toEqual([
        ["succeeded", 2, 7, `${fp[1]}>${h.tip}`, "run_again", 2],
        ["succeeded", 2, 5, `${fp[3]}>${h.tip}`, "run_again", 2],
        ["succeeded", 2, 3, `${fp[5]}>${h.tip}`, "run_again", 2],
        ["succeeded", 2, 1, `${fp[7]}>${h.tip}`, "run_again", 2],
        ["succeeded", 1, 0, fp[8], "", 1],
      ]);
    expect(runs.map((r) => [r.caughtUp, r.receipt?.status, r.receipt?.nextAction])).toEqual([
      ...Array.from({ length: 4 }, () => [false, "succeeded", "run_again"]), [true, "succeeded", ""],
    ]);

    const sourceB = await createGitSource(t.harness.repository, scopeB);
    expect(await sync(sourceB, { scope: scopeB })).toMatchObject({ status: "succeeded", caughtUp: true, cursorAfter: h.tip });
    const stateA = await sourceState(t.harness.repository, scopeA, sourceA);
    expect(stateA.size).toBe(11);
    expect(withoutRevisions(stateA)).toEqual(withoutRevisions(await sourceState(t.harness.repository, scopeB, sourceB)));
  });

  it("spills a window over batches under an in-progress cursor, and replays a crashed window", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const repository = spy();
    const limits = { upsertsPerBatch: 1, commitsPerWindow: 3 };
    const first = await sync(sourceId, { repository, limits });
    const token = (start: string, tip: string, result: GitSyncResult): string => `${start}>${tip}@${result.receipt!.receiptId}`;
    const [w1, w2] = [`${h.firstParent[2]}>${h.tip}`, `${h.firstParent[5]}>${h.tip}`];
    const [t1, t2, t3] = [token("", h.tip, first), token(h.firstParent[2]!, h.tip, first), token(h.firstParent[5]!, h.tip, first)];
    // Window 1 skips the alpha spec: its content at the window end (v2) is not its content at the tip (v1).
    expect(repository.calls.map((c) => [c.expectedCursor, c.nextCursor])).toEqual([
      [null, t1], [t1, t1], [t1, w1],
      [w1, t2], [t2, t2], [t2, t2], [t2, t2], [t2, w2],
      [w2, t3], [t3, t3], [t3, h.tip],
    ]);
    expect(repository.calls.map((c) => c.upserts.length)).toEqual(Array(11).fill(1));
    // Spec part deletions (parts 2..8 per written one-part spec) ride in the window's final batch.
    expect(repository.calls.map((c) => c.deletions.length)).toEqual([0, 0, 0, 0, 0, 0, 0, 14, 0, 0, 0]);
    expect(first).toMatchObject({ status: "succeeded", batches: 11, cursorAfter: h.tip, caughtUp: true });
    expect(first.counts).toEqual({ read: 11, written: 11, unchanged: 0, deleted: 0, failed: 0 });

    const added: string[] = [];
    for (const n of [1, 2, 3]) added.push(await t.f.commit({ message: `feat: step ${n}`, files: { [`src/step-${n}.ts`]: `${n}\n` } }));
    const last = added[2]!;
    repository.calls.length = 0;
    repository.onApply = (input) => {
      if (input.nextCursor === last) throw new Error("simulated crash before the final batch");
    };
    const crashed = await sync(sourceId, { repository, limits });
    const left = token(h.tip, last, crashed);
    expect(repository.calls.map((c) => c.nextCursor)).toEqual([left, left, last]);
    expect(crashed).toMatchObject({
      status: "failed", errorCode: "store_unavailable", nextAction: "retry_later", cursorBefore: h.tip, cursorAfter: left,
    });
    expect(crashed.counts).toMatchObject({ written: 2 });
    expect(crashed.receipt).toMatchObject({ status: "failed", errorCode: "store_unavailable", nextAction: "retry_later" });
    expect((await t.harness.repository.getSyncCursor(scopeA, sourceId))?.cursor).toBe(left);
    expect(await getDocument(id("commit", last))).toBeNull();

    repository.onApply = null;
    repository.calls.length = 0;
    const replay = await sync(sourceId, { repository, limits });
    // The next run takes the crashed run's window over through the same compare-and-set.
    expect(repository.calls[0]).toMatchObject({ expectedCursor: left, nextCursor: token(h.tip, last, replay) });
    expect(replay).toMatchObject({ status: "succeeded", cursorBefore: left, cursorAfter: last, caughtUp: true });
    expect(replay.counts).toEqual({ read: 3, written: 1, unchanged: 2, deleted: 0, failed: 0 });
    for (const sha of added) expect(await getDocument(id("commit", sha))).toMatchObject({ revision: 1 });
  });

  it("splits a large spec into parts, tombstones parts when it shrinks, and part 1 when it is removed", async () => {
    await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const file = "specs/100-big/spec.md";
    const big = bigSpecText(110);
    expect(Buffer.byteLength(big)).toBeGreaterThan(125_000);
    const added = await t.f.writeSpec("100-big", big);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", notices: [] });

    const parts = await Promise.all([1, 2, 3, 4].map((part) => getDocument(specId(file, part))));
    expect(parts[3]).toBeNull();
    const live = parts.slice(0, 3).map((d) => d!);
    expect(live.map((d) => d.title)).toEqual([1, 2, 3].map((i) => `Big spec (part ${i} of 3)`));
    expect(live.map((d) => d.body).join("")).toBe(big);
    expect(live.slice(1).every((d) => d.body.startsWith("## Section "))).toBe(true);
    for (const d of live) {
      expect(Buffer.byteLength(d.body)).toBeLessThanOrEqual(60_000);
      expect(d).toMatchObject({ provenance: "git_spec", permalink: `${WEB}/blob/${added}/${file}` });
      expect(await refsOf(d.documentId)).toEqual(sortRefs([path(file), spec("specs/100-big")]));
    }

    const small = "# Big spec\n\nNow small.\n";
    await t.f.writeSpec("100-big", small);
    const shrunk = await sync(sourceId);
    expect(shrunk).toMatchObject({ status: "succeeded", counts: { written: 2, deleted: 2, failed: 0 } });
    expect(await getDocument(specId(file, 1))).toMatchObject({ title: "Big spec", body: small, revision: 2 });
    for (const part of [2, 3]) {
      expect(await getDocument(specId(file, part))).toBeNull();
      expect(await documentRow(t.harness.db, scopeA, specId(file, part))).toMatchObject({ deleted: true });
      expect(await refsOf(specId(file, part))).toEqual([]);
    }

    const removed = await t.f.removeSpec("100-big");
    const gone = await sync(sourceId);
    expect(gone).toMatchObject({ status: "succeeded", counts: { written: 1, deleted: 1, failed: 0 } });
    expect(await documentRow(t.harness.db, scopeA, specId(file, 1))).toMatchObject({ deleted: true });
    expect(await refsOf(specId(file, 1))).toEqual([]);
    expect(await refsOf(id("commit", removed))).toEqual(sortRefs([path(file), spec("specs/100-big")]));
  });

  it("stubs an oversize spec, indexes plan and top-level files, skips nested ones, keeps same-number dirs apart", async () => {
    await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const huge = `# Huge\n${"x".repeat(450_000 - 8)}\n`;
    expect(Buffer.byteLength(huge)).toBe(450_000);
    await t.f.writeSpec("200-huge", huge);
    const loose = await t.f.commit({
      message: "docs: loose notes",
      files: { "specs/top.md": "# Top\n", "specs/a/b/spec.md": "# Nested\n", "specs/a/plan.md": "# Plan\n" },
    });
    await t.f.commit({
      message: "docs: twin specs", files: { "specs/118-a/spec.md": "# Twin A\n", "specs/118-b/spec.md": "# Twin B\n" },
    });
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", notices: ["spec_file_oversize"] });

    expect(await getDocument(specId("specs/200-huge/spec.md"))).toMatchObject({
      provenance: "git_spec",
      body: "This file is 450000 bytes, over the 400000 byte indexing limit. Open the permalink to read it.",
    });
    expect(await documentRow(t.harness.db, scopeA, specId("specs/200-huge/spec.md", 2))).toBeNull();
    expect(await documentRow(t.harness.db, scopeA, specId("specs/a/b/spec.md"))).toBeNull();
    // Each file is its own document; a top-level file has no spec folder, so only its path ref.
    expect(await getDocument(specId("specs/a/plan.md"))).toMatchObject({ title: "Plan", provenance: "git_spec" });
    expect(await refsOf(specId("specs/a/plan.md"))).toEqual(sortRefs([path("specs/a/plan.md"), spec("specs/a")]));
    expect(await getDocument(specId("specs/top.md"))).toMatchObject({ title: "Top", body: "# Top\n" });
    expect(await refsOf(specId("specs/top.md"))).toEqual([path("specs/top.md")]);
    expect(await refsOf(id("commit", loose))).toEqual(sortRefs([
      spec("specs/a"), path("specs/a/b/spec.md"), path("specs/a/plan.md"), path("specs/top.md"),
    ]));
    const twinA = specId("specs/118-a/spec.md");
    const twinB = specId("specs/118-b/spec.md");
    expect(twinA).not.toBe(twinB);
    expect(await getDocument(twinA)).toMatchObject({ title: "Twin A", body: "# Twin A\n" });
    expect(await getDocument(twinB)).toMatchObject({ title: "Twin B", body: "# Twin B\n" });
    expect(await refsOf(twinB)).toEqual(sortRefs([path("specs/118-b/spec.md"), spec("specs/118-b")]));
    expect((await liveIds(sourceId)).length).toBe(4 + 5);
  });

  it("caps refs at 200 per document and reports the indexed count in the footer", async () => {
    await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const bulk = Array.from({ length: 249 }, (_, i) => `bulk/f-${String(i).padStart(3, "0")}.txt`);
    const files: Record<string, string> = { "specs/250-bulk/spec.md": "# Bulk\n" };
    for (const file of bulk) files[file] = `${file}\n`;
    const sha = await t.f.squashPr(9, "feat: bulk", undefined, files);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", notices: ["paths_truncated"] });

    const refs = await refsOf(id("pr", 9));
    expect(refs).toHaveLength(200);
    expect(refs).toEqual(sortRefs([pr(9), spec("specs/250-bulk"), ...bulk.slice(0, 198).map(path)]));
    expect(await getDocument(id("pr", 9))).toMatchObject({
      title: "feat: bulk", body: await footer(sha, ["Pull request: #9"], 250, 198),
    });
    expect(await getDocument(specId("specs/250-bulk/spec.md"))).toMatchObject({ title: "Bulk" });
  });

  it("stores non-ASCII and special paths verbatim and encodes spec blob permalinks", async () => {
    await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const file = "specs/003-caf\u00e9 #x?/spec.md";
    const sha = await t.f.commit({ message: "docs: special", files: { [SPECIAL_PATH]: "n\n", [file]: "# Caf\u00e9 spec\n" } });
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded" });

    expect(await refsOf(id("commit", sha))).toEqual(sortRefs([spec("specs/003-caf\u00e9 #x?"), path(SPECIAL_PATH), path(file)]));
    expect(await getDocument(specId(file))).toMatchObject({
      title: "Caf\u00e9 spec", permalink: `${WEB}/blob/${sha}/specs/003-caf%C3%A9%20%23x%3F/spec.md`,
    });
    expect(await refsOf(specId(file))).toEqual(sortRefs([path(file), spec("specs/003-caf\u00e9 #x?")]));
  });

  it("indexes the origin/HEAD branch rather than HEAD, and honours config.branch", async () => {
    const root = await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const main = await t.f.commit({ message: "feat: on main", files: { "src/main.ts": "m\n" } });
    await t.f.commit({ branch: "feature", parents: [main], message: "feat: feature only", files: { "src/feature.ts": "f\n" } });
    await t.f.commit({ branch: "feature", message: "feat: more feature", files: { "src/feature.ts": "g\n" } });
    await t.f.git(["symbolic-ref", "HEAD", "refs/heads/feature"]);
    await t.f.setOriginHead("main", main);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", commitsProcessed: 2, cursorAfter: main });
    expect(await liveIds(sourceId)).toEqual([id("commit", root), id("commit", main)].sort());

    const release = await t.f.commit({
      branch: "release", parents: [root], message: "chore: release 1.0", files: { VERSION: "1.0\n" },
    });
    const releaseSource = await createGitSource(t.harness.repository, scopeB);
    expect(await sync(releaseSource, { scope: scopeB, config: { branch: "release" } }))
      .toMatchObject({ status: "succeeded", commitsProcessed: 2, cursorAfter: release });
    expect(await liveIds(releaseSource, scopeB)).toEqual([id("commit", root), id("commit", release)].sort());
  });

  it("maps a GitLab merge to a merge request document with GitLab permalinks", async () => {
    const identity = "project:widgets";
    const web = "https://gitlab.com/acme/platform/widgets";
    const mrId = gitDocumentId(identity, "pr", 7);
    await t.f.setRemote("git@gitlab.com:acme/platform/widgets.git");
    const root = await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const side = await t.f.commit({ branch: "feature", parents: [root], message: "feat: search", files: { "src/search.ts": "s\n" } });
    const mrBody = "Add widgets search\n\nSee merge request acme/platform/widgets!7";
    const merge = await t.f.commit({
      message: `Merge branch 'feature' into 'main'\n\n${mrBody}`, parents: [root, side], files: { "src/search.ts": "s\n" },
    });
    const fix = await t.f.commit({ message: "fix: thing (#5)", files: { "src/fix.ts": "x\n" } });
    const sourceId = await createGitSource(t.harness.repository, scopeA, identity);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", caughtUp: true, cursorAfter: fix });

    expect(await getDocument(mrId)).toMatchObject({
      title: "Add widgets search", provenance: "git_pr", permalink: `${web}/-/merge_requests/7`,
      body: `${mrBody}\n\n${await footer(merge, ["Merge request: !7"], 1)}`,
    });
    expect(await refsOf(mrId)).toEqual(sortRefs([pr(7), path("src/search.ts")]));
    for (const sha of [root, fix]) {
      expect(await getDocument(gitDocumentId(identity, "commit", sha)))
        .toMatchObject({ provenance: "git_commit", permalink: `${web}/-/commit/${sha}` });
    }
    expect(await getDocument(gitDocumentId(identity, "commit", fix))).toMatchObject({ title: "fix: thing (#5)" });
    expect(await refsOf(gitDocumentId(identity, "commit", fix))).toEqual([path("src/fix.ts")]);
    expect(await getDocument(gitDocumentId(identity, "pr", 5))).toBeNull();
  });

  it("keeps scopes isolated: same ids, separate rows, refs and receipts", async () => {
    await buildBaseHistory(t.f);
    const sourceA = await createGitSource(t.harness.repository, scopeA);
    const sourceB = await createGitSource(t.harness.repository, scopeB);
    expect((await sync(sourceA)).status).toBe("succeeded");
    expect((await sync(sourceB, { scope: scopeB })).status).toBe("succeeded");

    const stateA = await sourceState(t.harness.repository, scopeA, sourceA);
    const stateB = await sourceState(t.harness.repository, scopeB, sourceB);
    expect(stateB.size).toBe(11);
    expect([...stateB.keys()]).toEqual([...stateA.keys()]);
    expect([...stateB.values()].map((d) => d.refs)).toEqual([...stateA.values()].map((d) => d.refs));
    expect(await t.harness.repository.getSource(scopeB, sourceA)).toBeNull();
    expect(await t.harness.repository.getSyncCursor(scopeB, sourceA)).toBeNull();
    expect(await t.harness.repository.listSyncReceipts(scopeB, sourceA)).toEqual([]);
    const [receiptA] = await t.harness.repository.listSyncReceipts(scopeA, sourceA);
    const [receiptB] = await t.harness.repository.listSyncReceipts(scopeB, sourceB);
    expect(receiptA?.receiptId).not.toBe(receiptB?.receiptId);

    await t.harness.repository.eraseScope(scopeA);
    for (const table of BRAIN_TABLES) expect(await countBrainRows(t.harness.db, table, scopeA), table).toBe(0);
    expect(await refsOf(id("pr", 1))).toEqual([]);
    expect(await sourceState(t.harness.repository, scopeB, sourceB)).toEqual(stateB);
    expect(await refsOf(id("pr", 1), scopeB)).toEqual(sortRefs([
      pr(1), spec("specs/001-alpha"), path("specs/001-alpha/spec.md"), path("src/alpha.ts"),
    ]));
  });
});
