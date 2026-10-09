/**
 * syncGitSource guards: the run budget, git output that contradicts itself,
 * spec entries that are not regular files, the per-window spec file cap and
 * its exact-path tree reads, store refusals, races around opening a receipt,
 * concurrent runs in two processes, and the in-process cap on concurrent syncs.
 */
import { describe, expect, it, vi } from "vitest";
import {
  GIT_GLOBAL_ARGS, GIT_MAX_CONCURRENT_SYNCS, GIT_MAX_SPEC_FILES_PER_WINDOW, defaultGitRunner,
  type GitRunner,
} from "../../packages/gateway/src/brain/git/index.js";
import {
  BrainStoreError, type BrainOpenSyncReceiptInput, type BrainScopeKey, type BrainSource, type BrainSyncBatchInput,
  type BrainSyncReceipt,
} from "../../packages/gateway/src/brain/index.js";
import { scopeA, scopeB } from "./helpers/brain-store-helpers.js";
import { buildBaseHistory, fakeRunner, gitRunResult, isGitLog } from "./helpers/brain-git-fixture.js";
import {
  SpyRepository, createGitSource, fixtureDocumentId as id, useGitSyncHarness,
} from "./helpers/brain-git-harness.js";

const isWindowMetadataLog = (sub: readonly string[]): boolean => isGitLog(sub, { window: true, nameStatus: false });

/** Runs real git, then rewrites stdout (as latin1, so bytes survive) for matching subcommands. */
function rewriting(match: (sub: readonly string[]) => boolean, transform: (stdout: string, sub: readonly string[]) => string): GitRunner {
  return async (args, options) => {
    const result = await defaultGitRunner(args, options);
    const sub = args.slice(GIT_GLOBAL_ARGS.length);
    if (!match(sub)) return result;
    return { ...result, stdout: Buffer.from(transform(Buffer.from(result.stdout).toString("latin1"), sub), "latin1") };
  };
}

/** Hooks around source reads and receipt opening; everything else is the real repository. */
class HookedRepository extends SpyRepository {
  getSourceGate: Promise<void> | null = null;
  failGetSource = false;
  beforeOpenReceipt: (() => Promise<void>) | null = null;

  override async getSource(scope: BrainScopeKey, sourceId: string): Promise<BrainSource | null> {
    if (this.getSourceGate !== null) await this.getSourceGate;
    if (this.failGetSource) throw new Error("connection reset");
    return super.getSource(scope, sourceId);
  }

  override async openSyncReceipt(scope: BrainScopeKey, input: BrainOpenSyncReceiptInput): Promise<BrainSyncReceipt> {
    if (this.beforeOpenReceipt !== null) await this.beforeOpenReceipt();
    return super.openSyncReceipt(scope, input);
  }
}

describe("syncGitSource guards", { timeout: 60_000 }, () => {
  const t = useGitSyncHarness({ muteWarnings: true });
  const { sync } = t;
  const hooked = (): HookedRepository => new HookedRepository(t.harness.db, () => t.harness.now());

  it("stops before a window once the run budget is spent and asks to run again", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    let clock = 0;
    const now = (): number => (clock += 1_000) - 1_000;
    const result = await sync(sourceId, { now, limits: { commitsPerWindow: 1, runBudgetMs: 1_000 } });
    expect(result).toMatchObject({
      status: "succeeded", errorCode: null, nextAction: "run_again", notices: ["run_budget_exhausted"],
      commitsProcessed: 1, commitsRemaining: 8, caughtUp: false, cursorAfter: `${h.firstParent[0]}>${h.tip}`,
    });
    expect(result.receipt).toMatchObject({ status: "succeeded", nextAction: "run_again" });
  });

  it("stops before a window once the caller's signal aborts", async () => {
    await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId, { signal: AbortSignal.abort(), limits: { commitsPerWindow: 1 } })).toMatchObject({
      status: "succeeded", nextAction: "run_again", notices: ["run_budget_exhausted"], commitsProcessed: 1, commitsRemaining: 8,
    });
  });

  it("refuses git output that contradicts itself", async () => {
    const h = await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const noShas = fakeRunner(defaultGitRunner, (sub) => (sub[0] === "rev-list" && sub.includes("--max-count=101") ? gitRunResult("") : undefined));
    expect(await sync(sourceId, { runner: noShas })).toMatchObject({ status: "failed", errorCode: "git_output_malformed" });

    // Every window after the first claims a parent other than the cursor: one rescan, then a refusal.
    const offChain = rewriting(isWindowMetadataLog, (stdout, sub) => {
      const range = sub[sub.length - 2]!;
      return range.includes("..") ? stdout.replaceAll(`\u001f${range.split("..")[0]}`, `\u001f${"e".repeat(40)}`) : stdout;
    });
    const result = await sync(sourceId, { runner: offChain, limits: { commitsPerWindow: 1 } });
    expect(result).toMatchObject({
      status: "failed", errorCode: "git_output_malformed", nextAction: "contact_support", historyRewritten: true,
      notices: ["history_rewritten"], cursorAfter: `${h.firstParent[0]}>${h.tip}`,
    });
  });

  it("refuses a spec blob without a size and skips spec paths that are not regular files", async () => {
    await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const sizeless = rewriting((sub) => sub[0] === "ls-tree", (stdout) => stdout.replace(/(blob [0-9a-f]{40}) +\d+\t/g, "$1 -\t"));
    expect(await sync(sourceId, { runner: sizeless })).toMatchObject({ status: "failed", errorCode: "git_output_malformed" });

    const symlinks = rewriting((sub) => sub[0] === "ls-tree", (stdout) => stdout.replaceAll("100644 blob", "120000 blob"));
    const result = await sync(sourceId, { runner: symlinks });
    expect(result).toMatchObject({ status: "succeeded", counts: { written: 9 } });
    expect(await t.harness.repository.getDocument(scopeA, id("file", "specs/001-alpha/spec.md", 1))).toBeNull();

    // An entry nobody asked for is ignored.
    const other = await createGitSource(t.harness.repository, scopeB);
    const extra = rewriting((sub) => sub[0] === "ls-tree", (stdout) => `${stdout}100644 blob ${"1".repeat(40)} 5\tspecs/999-x/spec.md\u0000`);
    expect(await sync(other, { scope: scopeB, runner: extra })).toMatchObject({ status: "succeeded", counts: { written: 11 } });
    expect(await t.harness.repository.getDocument(scopeB, id("file", "specs/999-x/spec.md", 1))).toBeNull();
  });

  it("indexes at most the first 500 spec paths of a window and says so", async () => {
    const files: Record<string, string> = {};
    const paths = Array.from({ length: GIT_MAX_SPEC_FILES_PER_WINDOW + 1 }, (_, i) => `specs/${String(i).padStart(3, "0")}-s/spec.md`);
    for (const path of paths) files[path] = `# ${path}\n`;
    await t.f.commit({ message: "Initial commit", files });
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const result = await sync(sourceId);
    expect(result).toMatchObject({ status: "succeeded", notices: ["paths_truncated", "spec_files_capped"] });
    expect(result.counts.written).toBe(1 + GIT_MAX_SPEC_FILES_PER_WINDOW);
    expect(await t.harness.repository.getDocument(scopeA, id("file", paths[499]!, 1))).toMatchObject({ title: `${paths[499]}` });
    expect(await t.harness.repository.getDocument(scopeA, id("file", paths[500]!, 1))).toBeNull();
  });

  it("reads only the touched spec paths from the tree, once more at the tip for windows before it", async () => {
    const spec = "specs/001-a/spec.md";
    const files: Record<string, string> = { [spec]: "# A\n" };
    for (let i = 0; i < 50; i++) files[`specs/001-a/notes-${i}.md`] = `${i}\n`;
    await t.f.commit({ message: "Initial commit", files });
    await t.f.commit({ message: "docs: a v2", files: { [spec]: "# A v2\n", "specs/001-a/notes-0.md": "x\n" } });
    const trees: string[][] = [];
    const runner: GitRunner = (args, options) => {
      const sub = args.slice(GIT_GLOBAL_ARGS.length);
      if (sub[0] === "ls-tree") trees.push([...sub]);
      return defaultGitRunner(args, options);
    };
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId, { runner, limits: { commitsPerWindow: 1 } })).toMatchObject({ status: "succeeded", caughtUp: true });
    expect(trees.map((sub) => sub.slice(sub.indexOf("--") + 1))).toEqual([[spec], [spec], [spec]]);
    expect(trees.every((sub) => !sub.includes("-r"))).toBe(true);
    expect(await t.harness.repository.getDocument(scopeA, id("file", spec, 1))).toMatchObject({ body: "# A v2\n", revision: 1 });
  });

  it("reports a notice once however many files raise it", async () => {
    await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const huge = "x".repeat(400_001);
    await t.f.commit({ message: "docs: two huge specs", files: { "specs/301-a/spec.md": huge, "specs/302-b/spec.md": huge } });
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", notices: ["spec_file_oversize"], counts: { written: 4 } });
  });

  it("maps store refusals to codes without echoing their text", async () => {
    await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const badDates = rewriting(isWindowMetadataLog, (stdout) => stdout.replaceAll("\u001f2026-09-01T", "\u001f2026-13-01T"));
    const invalid = await sync(sourceId, { runner: badDates });
    expect(invalid).toMatchObject({ status: "failed", errorCode: "document_invalid", nextAction: "contact_support" });
    expect(t.warn).toHaveBeenCalledWith("[brain-git] store rejected adapter input", expect.objectContaining({ code: "document_invalid" }));

    const repository = hooked();
    const failures: Array<[unknown, string, string]> = [
      [new BrainStoreError("forbidden"), "internal_error", "contact_support"],
      ["a thrown string", "store_unavailable", "retry_later"],
    ];
    for (const [thrown, code, nextAction] of failures) {
      repository.onApply = () => {
        throw thrown;
      };
      const result = await sync(sourceId, { repository });
      expect(result).toMatchObject({ status: "failed", errorCode: code, nextAction, cursorAfter: null });
      expect(result.receipt).toMatchObject({ status: "failed", errorCode: code });
      expect(JSON.stringify(result)).not.toContain("thrown string");
    }
    expect(t.warn).toHaveBeenCalledWith("[brain-git] sync step failed", expect.objectContaining({
      code: "store_unavailable", cause: { name: "string", message: "" },
    }));
  });

  it("maps a source that changes or a store that fails around opening the receipt", async () => {
    await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const repository = hooked();
    const changeSource = (change: "pause" | "delete") => async () => {
      repository.beforeOpenReceipt = null;
      const source = (await t.harness.repository.getSource(scopeA, sourceId))!;
      if (change === "pause") {
        await t.harness.repository.updateSource(scopeA, { sourceId, expectedRevision: source.revision, status: "paused" });
      } else {
        await t.harness.repository.deleteSource(scopeA, { sourceId, expectedRevision: source.revision });
      }
    };

    repository.failGetSource = true;
    expect(await sync(sourceId, { repository })).toMatchObject({ errorCode: "store_unavailable", nextAction: "retry_later", receipt: null });
    repository.failGetSource = false;
    repository.beforeOpenReceipt = changeSource("pause");
    expect(await sync(sourceId, { repository })).toMatchObject({ errorCode: "source_inactive", receipt: null });
    const paused = (await t.harness.repository.getSource(scopeA, sourceId))!;
    await t.harness.repository.updateSource(scopeA, { sourceId, expectedRevision: paused.revision, status: "active" });
    repository.beforeOpenReceipt = changeSource("delete");
    expect(await sync(sourceId, { repository })).toMatchObject({ errorCode: "source_unavailable", receipt: null });
    expect(await t.harness.repository.listSyncReceipts(scopeA, sourceId)).toEqual([]);
  });

  it("still reports a cursor conflict when re-reading the source fails", async () => {
    await buildBaseHistory(t.f);
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    const repository = hooked();
    repository.onApply = async (input) => {
      await t.harness.repository.applySyncBatch(scopeA, {
        sourceId, expectedCursor: input.expectedCursor, nextCursor: "0".repeat(40), upserts: [], deletions: [],
      });
      repository.failGetSource = true;
    };
    const result = await sync(sourceId, { repository });
    expect(result).toMatchObject({ status: "failed", errorCode: "cursor_conflict", nextAction: "retry_later" });
    expect(t.warn).toHaveBeenCalledWith("[brain-git] source re-read failed", expect.objectContaining({ message: "connection reset" }));
  });

  it("keeps a window to one run when two processes sync one source", async () => {
    await t.f.commit({ message: "Initial commit", files: { "README.md": "r\n" } });
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded" });
    const [x, y, z] = ["specs/010-x/spec.md", "specs/015-y/spec.md", "specs/020-z/spec.md"];
    const tipA = await t.f.commit({ message: "docs: x v2, y", files: { [x]: "# X\n\nv2\n", [y]: "# Y\n" } });
    const gate = () => {
      let open: () => void = () => undefined;
      return { opened: new Promise<void>((resolve) => { open = resolve; }), open: () => open() };
    };
    const [aStarted, aGo, aAtFinal, bDone] = [gate(), gate(), gate(), gate()];

    // Process A resolves the older tip, then waits before its first batch.
    const repositoryA = new SpyRepository(t.harness.db, () => t.harness.now());
    repositoryA.onApply = async (input, call) => {
      if (call === 1) {
        aStarted.open();
        await aGo.opened;
      }
      if (input.nextCursor !== tipA) return;
      aAtFinal.open();
      await bDone.opened;
    };
    const runA = sync(sourceId, { repository: repositoryA, limits: { upsertsPerBatch: 1 } });
    await aStarted.opened;
    const tipB = await t.f.commit({ message: "docs: x v3, z", files: { [x]: "# X\n\nv3\n", [z]: "# Z\n" } });

    // Process B: a second copy of the adapter and store modules, so the in-process guard is not shared.
    vi.resetModules();
    const store = await import("../../packages/gateway/src/brain/index.js");
    const adapter = await import("../../packages/gateway/src/brain/git/sync.js");
    const settledA = runA.then(() => undefined, () => undefined);
    class RepositoryB extends store.BrainRepository {
      override async applySyncBatch(scope: BrainScopeKey, input: BrainSyncBatchInput) {
        if (input.nextCursor === tipB) {
          aGo.open();
          await Promise.race([aAtFinal.opened, settledA]);
        }
        return super.applySyncBatch(scope, input);
      }
    }
    const resultB = await adapter.syncGitSource({
      repository: new RepositoryB(t.harness.db, { now: () => t.harness.now() }), scope: scopeA, sourceId,
      repoPath: t.f.repoPath, homePath: t.f.homePath, limits: { upsertsPerBatch: 1 },
    });
    bDone.open();
    const resultA = await runA;

    expect(resultB).toMatchObject({ status: "succeeded", cursorAfter: tipB, caughtUp: true });
    // A's first batch fails its compare-and-set against B's in-progress cursor, before A writes anything.
    expect(resultA).toMatchObject({ status: "failed", errorCode: "cursor_conflict", batches: 0, counts: { read: 0 } });
    expect(repositoryA.calls).toHaveLength(1);
    expect(await t.harness.repository.getDocument(scopeA, id("file", x, 1))).toMatchObject({ body: "# X\n\nv3\n" });
    expect(await sync(sourceId)).toMatchObject({ status: "succeeded", batches: 0, cursorAfter: tipB });
  });

  it("caps concurrent syncs in process and frees the slots when they finish", async () => {
    await buildBaseHistory(t.f);
    const repository = hooked();
    let release: () => void = () => undefined;
    repository.getSourceGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sourceIds = Array.from({ length: GIT_MAX_CONCURRENT_SYNCS + 1 }, (_, i) => `src_${i.toString(16).padStart(32, "0")}`);
    const running = sourceIds.slice(0, GIT_MAX_CONCURRENT_SYNCS).map((sourceId) => sync(sourceId, { repository }));
    expect(await sync(sourceIds[GIT_MAX_CONCURRENT_SYNCS]!, { repository })).toMatchObject({ errorCode: "sync_in_progress" });
    release();
    for (const result of await Promise.all(running)) expect(result.errorCode).toBe("source_unavailable");
    repository.getSourceGate = null;
    const sourceId = await createGitSource(t.harness.repository, scopeA);
    expect(await sync(sourceId, { repository })).toMatchObject({ status: "succeeded", caughtUp: true });
  });
});
