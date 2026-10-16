/**
 * syncGitSource failure paths: rewritten history, git failures through fake
 * runners, partial progress, web base and repository checks, source state,
 * concurrency, capacity, foreign documents and mid-run source changes. Every
 * failure is a result with a stable code; once a receipt is open it is closed
 * `failed` with the same code and nextAction.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GitRunnerError, defaultGitRunner, syncGitSource, type GitRunner, type GitSyncOptions, type GitSyncResult,
} from "../../packages/gateway/src/brain/git/index.js";
import type { BrainScopeKey } from "../../packages/gateway/src/brain/index.js";
import { createBrainHarness, manualDocument, scopeA, scopeB } from "./helpers/brain-store-helpers.js";
import {
  ALPHA_SPEC_V2, FIXTURE_WEB_BASE, buildBaseHistory, fakeRunner, gitRunResult, isGitLog,
} from "./helpers/brain-git-fixture.js";
import {
  createGitSource, fixtureDocumentId as id, sourceState, useGitSyncHarness, withoutRevisions,
} from "./helpers/brain-git-harness.js";

const ALPHA = "specs/001-alpha/spec.md";
const isMetadataLog = (sub: readonly string[]): boolean => isGitLog(sub, { nameStatus: false });

describe("syncGitSource failures", { timeout: 60_000 }, () => {
  const t = useGitSyncHarness({ muteWarnings: true });
  const { sync, spy } = t;
  const cursorOf = async (sourceId: string, scope: BrainScopeKey = scopeA) =>
    (await t.harness.repository.getSyncCursor(scope, sourceId))?.cursor ?? null;

  async function expectFailed(result: GitSyncResult, errorCode: string, nextAction: string): Promise<void> {
    expect(result).toMatchObject({ status: "failed", errorCode, nextAction, caughtUp: false, commitsRemaining: 0 });
    expect(result.receipt).toMatchObject({ status: "failed", errorCode, nextAction });
  }

  it("rescans after a force-push and keeps documents of dropped commits", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    await sync(sourceId);
    const before = await sourceState(t.harness.repository, scopeA, sourceId);
    const added = await t.f.forcePush("main", h.merge3, [
      { message: "feat: rewritten one", files: { "src/r1.ts": "1\n" } },
      { message: "feat: rewritten two", files: { "src/r2.ts": "2\n" } },
    ]);

    const result = await sync(sourceId);
    expect(result).toMatchObject({
      status: "succeeded", errorCode: "history_rewritten", nextAction: "", historyRewritten: true,
      notices: ["history_rewritten"], cursorBefore: h.tip, cursorAfter: added[1], commitsProcessed: 7, caughtUp: true,
    });
    expect(result.receipt).toMatchObject({ status: "succeeded", errorCode: "history_rewritten" });
    // The alpha spec changed for real: the revert that restored v1 is gone.
    expect(result.counts).toMatchObject({ written: 3, unchanged: 6, deleted: 0, failed: 0 });
    expect(await t.harness.repository.getDocument(scopeA, id("file", ALPHA, 1))).toMatchObject({ body: ALPHA_SPEC_V2 });
    const after = await sourceState(t.harness.repository, scopeA, sourceId);
    for (const sha of [h.root, h.tidy]) expect(after.get(id("commit", sha))).toEqual(before.get(id("commit", sha)));
    for (const n of [1, 2, 3]) expect(after.get(id("pr", n))).toEqual(before.get(id("pr", n)));
    for (const sha of [h.revert1, h.unitSeparator, h.special]) expect(after.has(id("commit", sha))).toBe(true);
    for (const sha of added) expect(after.get(id("commit", sha))).toMatchObject({ revision: 1 });
  });

  it("rescans over several runs without rolling a spec back or reviving a removed one", async () => {
    await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    await t.f.writeSpec("010-x", "# X\n\nv1\n");
    await t.f.writeSpec("020-y", "# Y\n\ny\n");
    await t.f.commit({ message: "chore: one", files: { "src/one.ts": "1\n" } });
    await t.f.writeSpec("010-x", "# X\n\nv2\n");
    await t.f.commit({ message: "chore: two", files: { "src/two.ts": "2\n" } });
    await t.f.writeSpec("010-x", "# X\n\nv3\n");
    await t.f.removeSpec("020-y");
    await t.f.commit({ message: "chore: three", files: { "src/three.ts": "3\n" } });
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", caughtUp: true });
    const before = await sourceState(t.harness.repository, scopeA, sourceId);
    const [x, y] = [id("file", "specs/010-x/spec.md", 1), id("file", "specs/020-y/spec.md", 1)];
    expect(before.get(x)).toMatchObject({ revision: 1 });
    expect(before.has(y)).toBe(false);

    const cursor = (await t.harness.repository.getSyncCursor(scopeA, sourceId))!.cursor;
    await t.harness.repository.applySyncBatch(scopeA, { sourceId, expectedCursor: cursor, nextCursor: "f".repeat(40), upserts: [], deletions: [] });
    const runs: GitSyncResult[] = [];
    for (let run = 0; run < 10 && runs.at(-1)?.caughtUp !== true; run++) {
      runs.push(await sync(sourceId, { limits: { commitsPerRun: 4, commitsPerWindow: 2 } }));
      // Between runs every document, spec or not, is exactly as before the rescan.
      expect(await sourceState(t.harness.repository, scopeA, sourceId)).toEqual(before);
      expect(await t.harness.repository.getDocument(scopeA, y)).toBeNull();
    }
    expect(runs.map((r) => [r.status, r.historyRewritten, r.commitsProcessed, r.counts.written, r.counts.deleted]))
      .toEqual([["succeeded", true, 4, 0, 0], ["succeeded", false, 4, 0, 0], ["succeeded", false, 1, 0, 0]]);
    for (const r of runs) expect(r.counts.read).toBe(r.counts.written + r.counts.unchanged + r.counts.deleted + r.counts.failed);
    expect(await t.harness.repository.listRevisions(scopeA, x)).toEqual([]);
  });

  it("rescans when commits a stopped run read ahead are force-pushed away", async () => {
    await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const v1 = await t.f.writeSpec("010-x", "# X\n\nv1\n");
    const kept = await t.f.commit({ message: "chore: kept", files: { "src/kept.ts": "k\n" } });
    const dropped = await t.f.writeSpec("010-x", "# X\n\nv2\n");
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const limits = { commitsPerRun: 2, commitsPerWindow: 1 };
    const stopped = await sync(sourceId, { limits });
    // The spec's content at its window end (v1) is not its content at this run's tip (v2), so it waits.
    expect(stopped).toMatchObject({ nextAction: "run_again", cursorAfter: `${v1}>${dropped}` });
    expect(await t.harness.repository.getDocument(scopeA, id("file", "specs/010-x/spec.md", 1))).toBeNull();

    const [tip] = await t.f.forcePush("main", kept, [{ message: "chore: after", files: { "src/after.ts": "a\n" } }]);
    const runs: GitSyncResult[] = [];
    for (let run = 0; run < 10 && runs.at(-1)?.caughtUp !== true; run++) runs.push(await sync(sourceId, { limits }));
    expect(runs[0]).toMatchObject({ status: "succeeded", historyRewritten: true, errorCode: "history_rewritten" });
    expect(runs.at(-1)).toMatchObject({ caughtUp: true, cursorAfter: tip });
    expect(await t.harness.repository.getDocument(scopeA, id("file", "specs/010-x/spec.md", 1))).toMatchObject({ body: "# X\n\nv1\n" });
  });

  it("rescans when the cursor is an ancestor off the first-parent chain, then converges", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    await sync(sourceId);
    const side = await t.f.commit({ branch: "side", parents: [h.squash1], message: "feat: side", files: { "src/side.ts": "s\n" } });
    const merge = await t.f.commit({ message: "Merge branch 'main' into side", parents: [side, h.tip], files: { "src/m.ts": "m\n" } });

    expect(await sync(sourceId)).toMatchObject({
      status: "succeeded", errorCode: "history_rewritten", historyRewritten: true, commitsProcessed: 4, cursorAfter: merge,
    });
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", errorCode: null, batches: 0, cursorAfter: merge });
  });

  it("treats an unknown, non-sha or abandoned cursor as rewritten, and a first-window token as a fresh start", async () => {
    const h = await buildBaseHistory(t.f);
    const receipt = `rcp_${"1".repeat(32)}`;
    const cases: Array<[BrainScopeKey, string, boolean]> = [
      [scopeA, "f".repeat(40), true],
      [scopeB, "not-a-sha", true],
      [{ ownerId: "owner_a", scopeId: "scope_c" }, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", true],
      // A stopped run read ahead to a tip that is no longer on the branch.
      [{ ownerId: "owner_a", scopeId: "scope_d" }, `${h.firstParent[3]}>${"e".repeat(40)}`, true],
      [{ ownerId: "owner_a", scopeId: "scope_e" }, `>${h.tip}@${receipt}`, false],
      [{ ownerId: "owner_a", scopeId: "scope_f" }, `${h.tip}>${h.tip}`, true],
    ];
    for (const [scope, cursor, rewritten] of cases) {
      const sourceId = await createGitSource(t.harness.repository, scope);
      await t.harness.repository.applySyncBatch(scope, { sourceId, expectedCursor: null, nextCursor: cursor, upserts: [], deletions: [] });
      expect(await sync(sourceId, { scope }), cursor).toMatchObject({
        status: "succeeded", historyRewritten: rewritten, errorCode: rewritten ? "history_rewritten" : null,
        cursorBefore: cursor, cursorAfter: h.tip, commitsProcessed: 9, counts: { written: 11 },
      });
    }
  });

  it("records git failures as codes and leaves the cursor alone", async () => {
    await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const failing = (match: (sub: readonly string[]) => boolean, answer: () => never | ReturnType<typeof gitRunResult>): GitRunner =>
      fakeRunner(defaultGitRunner, (sub) => (match(sub) ? answer() : undefined));
    const cases: Array<[GitRunner, string, string]> = [
      [failing((sub) => sub[0] === "log", () => { throw new GitRunnerError("timeout"); }), "git_timeout", "retry_later"],
      [failing(isMetadataLog, () => gitRunResult("garbage\u0000")), "git_output_malformed", "contact_support"],
      [failing((sub) => sub[0] === "rev-list", () => ({ ...gitRunResult(""), exitCode: 2 })), "git_command_failed", "contact_support"],
      [failing((sub) => sub[0] === "version", () => { throw new GitRunnerError("spawn_failed"); }), "git_unavailable", "fix_source"],
      [failing((sub) => sub[0] === "version", () => gitRunResult("git version 2.20.1\n")), "git_version_unsupported", "fix_source"],
      [failing((sub) => sub[0] === "ls-tree", () => { throw new GitRunnerError("output_too_large"); }), "git_output_too_large", "contact_support"],
      [failing((sub) => sub[0] === "version", () => { throw new Error("runner bug"); }), "internal_error", "contact_support"],
    ];
    for (const [runner, code, nextAction] of cases) {
      const result = await sync(sourceId, { runner });
      await expectFailed(result, code, nextAction);
      expect(result).toMatchObject({ cursorBefore: null, cursorAfter: null, commitsProcessed: 0, batches: 0 });
      expect(JSON.stringify(result)).not.toMatch(/runner bug|fatal|usage/);
      expect(await cursorOf(sourceId)).toBeNull();
    }

    const overflow = failing((sub) => isGitLog(sub, { window: true, nameStatus: false }), () => {
      throw new GitRunnerError("output_too_large");
    });
    expect(await sync(sourceId, { runner: overflow })).toMatchObject({ status: "succeeded", caughtUp: true, counts: { written: 11 } });
  });

  it("keeps committed windows after a failure and resumes from them", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    let windows = 0;
    const runner = fakeRunner(defaultGitRunner, (sub) => {
      if (isMetadataLog(sub) && (windows += 1) === 3) throw new GitRunnerError("timeout");
      return undefined;
    });
    const limits = { commitsPerWindow: 1 };
    const failed = await sync(sourceId, { runner, limits });
    await expectFailed(failed, "git_timeout", "retry_later");
    const stopped = `${h.firstParent[1]}>${h.tip}`;
    expect(failed).toMatchObject({ cursorAfter: stopped, commitsProcessed: 2, batches: 2 });
    expect(failed.receipt).toMatchObject({ cursorAfter: stopped, counts: failed.counts });
    expect(await cursorOf(sourceId)).toBe(stopped);

    expect(await sync(sourceId, { limits })).toMatchObject({
      status: "succeeded", cursorBefore: stopped, cursorAfter: h.tip, commitsProcessed: 7, caughtUp: true, historyRewritten: false,
    });
    const sourceB = await createGitSource(t.harness.repository, scopeB);
    await sync(sourceB, { scope: scopeB });
    expect(withoutRevisions(await sourceState(t.harness.repository, scopeA, sourceId)))
      .toEqual(withoutRevisions(await sourceState(t.harness.repository, scopeB, sourceB)));
  });

  it("derives the web base from the remote or the externalRef, and refuses a mismatch", async () => {
    const h = await buildBaseHistory(t.f);
    await t.f.setRemote(null);
    const opaque = await createGitSource(t.harness.repository, scopeA, "project:widgets");
    await expectFailed(await sync(opaque), "web_base_unavailable", "fix_source");

    const explicit = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(explicit)).toMatchObject({ status: "succeeded", cursorAfter: h.tip });
    expect(await t.harness.repository.getDocument(scopeA, id("pr", 1))).toMatchObject({ permalink: `${FIXTURE_WEB_BASE}/pull/1` });

    await t.f.setRemote("git@github.com:other/repo.git");
    const mismatched = await createGitSource(t.harness.repository, scopeB);
    await expectFailed(await sync(mismatched, { scope: scopeB }), "remote_mismatch", "fix_source");
  });

  it("refuses repositories outside home, home itself, a subdirectory and a missing path", async () => {
    await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const otherHome = join(t.f.homePath, "other-home");
    const subdirectory = join(t.f.repoPath, "src-dir");
    await Promise.all([mkdir(otherHome), mkdir(subdirectory)]);
    for (const paths of [
      { homePath: otherHome }, { homePath: t.f.repoPath }, { repoPath: subdirectory }, { repoPath: join(t.f.homePath, "gone") },
    ]) {
      await expectFailed(await sync(sourceId, paths), "not_a_repository", "fix_source");
    }
    expect(await t.harness.repository.listSyncReceipts(scopeA, sourceId)).toHaveLength(4);
  });

  it("checks options and source state before opening a receipt", async () => {
    await buildBaseHistory(t.f);
    const { source: paused } = await t.harness.repository.createSource(scopeA, { kind: "git", externalRef: "project:a", label: "a" });
    await t.harness.repository.updateSource(scopeA, { sourceId: paused.sourceId, expectedRevision: paused.revision, status: "paused" });
    const { source: slack } = await t.harness.repository.createSource(scopeA, { kind: "slack", externalRef: "T/C", label: "s" });
    const { source: deleted } = await t.harness.repository.createSource(scopeA, { kind: "git", externalRef: "project:d", label: "d" });
    await t.harness.repository.deleteSource(scopeA, { sourceId: deleted.sourceId, expectedRevision: deleted.revision });
    const cases: Array<[string, string]> = [
      [paused.sourceId, "source_inactive"], [slack.sourceId, "source_kind_mismatch"],
      [deleted.sourceId, "source_unavailable"], [`src_${"0".repeat(32)}`, "source_unavailable"],
    ];
    for (const [sourceId, code] of cases) {
      expect(await sync(sourceId), code).toMatchObject({ status: "failed", errorCode: code, nextAction: "fix_source", receipt: null });
      expect(await t.harness.repository.listSyncReceipts(scopeA, sourceId)).toEqual([]);
    }

    const valid = await createGitSource(t.harness.repository, scopeA);
    const invalid: Array<Partial<GitSyncOptions>> = [
      { sourceId: "bad id" }, { limits: { commitsPerRun: 0 } }, { limits: { gitTimeoutMs: 1.5 } }, { repoPath: "relative" },
      { config: { branch: "-x" } }, { config: { specGlobs: ["a/**/b"] } }, { config: { specGlobs: [] } },
      { runner: 42 as unknown as GitRunner }, { now: "soon" as unknown as () => number },
    ];
    for (const options of invalid) {
      expect(await sync(valid, options), JSON.stringify(options)).toMatchObject({
        status: "failed", errorCode: "invalid_options", nextAction: "fix_source", receipt: null, counts: { read: 0 },
      });
    }
    expect(await syncGitSource(null as unknown as GitSyncOptions)).toMatchObject({ errorCode: "internal_error", receipt: null });
    expect(await t.harness.repository.listSyncReceipts(scopeA, valid)).toEqual([]);
  });

  it("refuses overlapping runs in process and reports a cross-process cursor move as a conflict", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const [first, second] = await Promise.all([sync(sourceId), sync(sourceId)]);
    expect(first).toMatchObject({ status: "succeeded", cursorAfter: h.tip });
    expect(second).toMatchObject({ status: "failed", errorCode: "sync_in_progress", nextAction: "retry_later", receipt: null });

    const sourceB = await createGitSource(t.harness.repository, scopeB);
    const repository = spy();
    repository.onApply = async (input, call) => {
      if (call !== 2) return;
      await t.harness.repository.applySyncBatch(scopeB, {
        sourceId: sourceB, expectedCursor: input.expectedCursor, nextCursor: "0".repeat(40), upserts: [], deletions: [],
      });
    };
    const conflicted = await sync(sourceB, { scope: scopeB, repository, limits: { commitsPerWindow: 1 } });
    await expectFailed(conflicted, "cursor_conflict", "retry_later");
    expect(conflicted).toMatchObject({ cursorAfter: `${h.firstParent[0]}>${h.tip}`, batches: 1 });
    expect(await cursorOf(sourceB, scopeB)).toBe("0".repeat(40));
  });

  it("stops at the scope capacity and keeps the windows committed before it", async () => {
    const h = await buildBaseHistory(t.f);
    const small = await createBrainHarness({ maxDocumentsPerScope: 3 });
    try {
      const sourceId = await createGitSource(small.repository, scopeA);
      const result = await sync(sourceId, { repository: small.repository, limits: { commitsPerWindow: 1 } });
      await expectFailed(result, "brain_capacity", "raise_capacity");
      expect(result).toMatchObject({ cursorAfter: `${h.firstParent[1]}>${h.tip}`, commitsProcessed: 2 });
      expect(await small.repository.getDocument(scopeA, id("pr", 1))).toMatchObject({ revision: 1 });
    } finally {
      await small.destroy();
    }
  });

  it("reports documents owned by someone else as rejected, capping the echoed ids", async () => {
    const specs: Record<string, string> = { "README.md": "r\n" };
    const specPaths = Array.from({ length: 101 }, (_, i) => `specs/${String(i).padStart(3, "0")}-s/spec.md`);
    for (const path of specPaths) specs[path] = `# Spec ${path}\n`;
    await t.f.commit({ message: "Initial commit", files: specs });
    const tip = await t.f.squashPr(1, "feat: alpha", undefined, { "src/a.ts": "a\n" });
    const foreign = [id("pr", 1), ...specPaths.map((path) => id("file", path, 1))];
    for (const documentId of foreign) {
      await t.harness.repository.upsertDocument(scopeA, manualDocument(documentId, { documentId }));
    }
    const sourceId = await createGitSource(t.harness.repository, scopeA);

    const result = await sync(sourceId);
    expect(result).toMatchObject({
      status: "partial", errorCode: "documents_rejected", nextAction: "", caughtUp: true, cursorAfter: tip,
      counts: { written: 1, failed: 102 },
    });
    // Upsert order: commit documents oldest first, then spec parts by path; ids past the cap are counted only.
    expect(result.rejectedDocumentIds).toEqual(foreign.slice(0, 100));
    expect(result.receipt).toMatchObject({ status: "partial", errorCode: "documents_rejected", counts: { failed: 102 } });
    expect(await t.harness.repository.getDocument(scopeA, id("pr", 1))).toMatchObject({ sourceId: null });
  });

  it("fails with the source state when the source is paused or deleted mid-run", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const repository = spy();
    const changeSource = (change: "pause" | "delete") => async (_input: unknown, call: number) => {
      if (call !== 2) return;
      const source = (await t.harness.repository.getSource(scopeA, sourceId))!;
      if (change === "pause") {
        await t.harness.repository.updateSource(scopeA, { sourceId, expectedRevision: source.revision, status: "paused" });
      } else {
        await t.harness.repository.deleteSource(scopeA, { sourceId, expectedRevision: source.revision });
      }
    };
    repository.onApply = changeSource("pause");
    const paused = await sync(sourceId, { repository, limits: { commitsPerWindow: 1 } });
    await expectFailed(paused, "source_inactive", "fix_source");
    expect(paused).toMatchObject({ cursorAfter: `${h.firstParent[0]}>${h.tip}` });

    const source = (await t.harness.repository.getSource(scopeA, sourceId))!;
    await t.harness.repository.updateSource(scopeA, { sourceId, expectedRevision: source.revision, status: "active" });
    repository.calls.length = 0;
    repository.onApply = changeSource("delete");
    const deleted = await sync(sourceId, { repository, limits: { commitsPerWindow: 1 } });
    // deleteSource interrupts the running receipt, so it cannot be closed.
    expect(deleted).toMatchObject({ status: "failed", errorCode: "source_unavailable", nextAction: "fix_source", receipt: null });
    expect(t.warn).toHaveBeenCalledWith("[brain-git] receipt close failed", expect.objectContaining({ name: "BrainStoreError" }));
  });
});
