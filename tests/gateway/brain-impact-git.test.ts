/**
 * Impact brief git reads and import scan: output parsers, revision lookup on a real fixture repository, runner
 * failures, and every scan cap over a fake ImpactGit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGitRunner } from "../../packages/gateway/src/brain/git/index.js";
import { GitRunnerError, GitSourceError, type GitTreeEntry } from "../../packages/gateway/src/brain/git/types.js";
import {
  openImpactGit, parseImportGrep, parseNameStatus, type ImpactChange, type ImpactGit,
} from "../../packages/gateway/src/brain/impact/git.js";
import { IMPACT_PACKAGE_FILES_MAX, scanDependents } from "../../packages/gateway/src/brain/impact/scan.js";
import { createBrainGitFixture, fakeRunner, gitRunResult, type BrainGitFixture } from "./helpers/brain-git-fixture.js";
import { buildImpactHistory, type ImpactHistory } from "./helpers/brain-impact-fixture.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const SHA = "a".repeat(40);

async function gitError(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(GitSourceError);
  return (error as GitSourceError).code;
}

describe("output parsers", () => {
  it("parses name-status records, renames, bad paths and truncation", () => {
    const out = parseNameStatus(bytes("M\0a.ts\0R087\0old.ts\0new.ts\0A\0bad\u0001.ts\0D\0gone.ts\0"), false);
    expect(out).toEqual({
      files: [
        { status: "modified", path: "a.ts", previousPath: null },
        { status: "renamed", path: "new.ts", previousPath: "old.ts" },
        { status: "deleted", path: "gone.ts", previousPath: null },
      ],
      total: 4, truncated: false,
    });
    expect(parseNameStatus(bytes("T\0t.ts\0R100\0x.ts\0y."), true)).toEqual({
      files: [{ status: "type_changed", path: "t.ts", previousPath: null }], total: 1, truncated: true,
    });
    expect(parseNameStatus(bytes("C050\0a\0b\0"), false).files).toEqual([{ status: "added", path: "b", previousPath: "a" }]);
    expect(() => parseNameStatus(bytes("Q\0a\0"), false)).toThrow(GitSourceError);
    expect(() => parseNameStatus(bytes("M\0"), false)).toThrow(GitSourceError);
    expect(() => parseNameStatus(bytes("M\0a"), false)).toThrow(GitSourceError);
    expect(parseNameStatus(bytes(""), false)).toEqual({ files: [], total: 0, truncated: false });
    const badUtf8 = new Uint8Array([0x4d, 0, 0x61, 0xff, 0]);
    expect(parseNameStatus(badUtf8, false)).toEqual({ files: [], total: 1, truncated: false });
  });

  it("parses import grep records and drops a cut record", () => {
    const out = `${SHA}:src/a.ts\x001\x00 from "./b.js"\n${SHA}:src/c.ts\x0012\x00import("./d")\n${SHA}:src/e`;
    expect(parseImportGrep(bytes(out), SHA, true)).toEqual([
      { path: "src/a.ts", text: " from \"./b.js\"" }, { path: "src/c.ts", text: "import(\"./d\")" },
    ]);
    expect(() => parseImportGrep(bytes(`${SHA}:a\x00x\x00m\n`), SHA, false)).toThrow(GitSourceError);
    expect(() => parseImportGrep(bytes(`other:a\x001\x00m\n`), SHA, false)).toThrow(GitSourceError);
    expect(() => parseImportGrep(bytes(`${SHA}:a\x001\n`), SHA, false)).toThrow(GitSourceError);
    expect(() => parseImportGrep(bytes(`${SHA}:a\x001\x00m\x00n\n`), SHA, false)).toThrow(GitSourceError);
  });
});

describe("git reads on a fixture", { timeout: 120_000 }, () => {
  let fixture: BrainGitFixture;
  let history: ImpactHistory;

  beforeEach(async () => {
    fixture = await createBrainGitFixture();
    history = await buildImpactHistory(fixture);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.destroy();
  });

  const open = (runner = defaultGitRunner) => openImpactGit({ repoPath: fixture.repoPath, homePath: fixture.homePath, runner });

  it("resolves branches, remote branches and abbreviated shas", async () => {
    await fixture.git(["update-ref", "refs/remotes/origin/shared", history.pr1]);
    await fixture.git(["update-ref", "refs/remotes/fork/topic", history.root]);
    const git = await open();
    expect(await git.resolveRev("feature")).toEqual({ ref: "refs/heads/feature", sha: history.feature });
    expect(await git.resolveRev("shared")).toEqual({ ref: "refs/remotes/origin/shared", sha: history.pr1 });
    expect(await git.resolveRev("fork/topic")).toEqual({ ref: "refs/remotes/fork/topic", sha: history.root });
    expect((await git.resolveRev(history.root.slice(0, 8)))!.sha).toBe(history.root);
    expect(await git.resolveRev("missing")).toBeNull();
    expect(await git.resolveRev("bad..name")).toBeNull();
    expect(await git.mergeBase(history.feature, history.mainTip)).toBe(history.mainTip);
    expect(await git.grepImports(history.feature, [])).toEqual({ matches: [], truncated: false });
    expect(await git.grepImports(history.feature, ["docs/notes.md"])).toEqual({ matches: [], truncated: false });
    expect(await gitError(git.diff("nope", history.feature))).toBe("git_output_malformed");
  });

  it("maps runner failures and reads truncated trees", async () => {
    const failing = (failure: unknown) => fakeRunner(defaultGitRunner, (sub) => {
      if (sub[0] === "merge-base") throw failure;
      return undefined;
    });
    expect(await gitError((await open(failing(new GitRunnerError("spawn_failed")))).mergeBase(SHA, SHA))).toBe("git_unavailable");
    await expect((await open(failing(new RangeError("x")))).mergeBase(SHA, SHA)).rejects.toThrow(RangeError);
    const exit = fakeRunner(defaultGitRunner, (sub) => (sub[0] === "ls-tree" ? gitRunResult("", 128) : undefined));
    expect(await gitError((await open(exit)).listTree(history.feature))).toBe("git_command_failed");
    const notDate = fakeRunner(defaultGitRunner, (sub) => (sub[0] === "log" ? gitRunResult("yesterday\n") : undefined));
    expect(await gitError((await open(notDate)).commitTime(history.feature))).toBe("git_output_malformed");
    const entry = `100644 blob ${"b".repeat(40)}       7\tsrc/a.ts\x00100644 blob ${"c".repeat(40)} 3\tsrc/b`;
    const cut = fakeRunner(defaultGitRunner, (sub) => (sub[0] === "ls-tree" ? gitRunResult(entry, null, true) : undefined));
    const tree = await (await open(cut)).listTree(history.feature);
    expect([tree.truncated, tree.entries.map((item) => item.path)]).toEqual([true, ["src/a.ts"]]);
  });

  it("skips tree paths that are not indexable instead of failing the scan", async () => {
    const importsAlpha = "import { alpha } from \"./alpha.js\";\n";
    const long = `packages/core/src/${"x".repeat(200)}/${"y".repeat(200)}/${"z".repeat(120)}.ts`;
    const head = await fixture.commit({
      branch: "feature", message: "feat: odd names", files: {
        "packages/core/src/b\nc.ts": importsAlpha, "packages/core/src/d\re.ts": importsAlpha,
        [long]: "import { alpha } from \"../../alpha.js\";\n",
      },
    });
    const git = await open();
    const changed = (await git.diff(history.mainTip, head)).files;
    const scan = await scanDependents({ git, head, changed, depth: 1, deadline: Number.MAX_SAFE_INTEGER, now: () => 0 });
    const paths = scan.dependents.map((item) => item.path);
    expect(paths).toContain("tests/core/alpha.test.ts");
    expect(paths.filter((path) => /[\r\n]/.test(path) || path.length > 512)).toEqual([]);
  });
});

describe("scan caps", () => {
  const blob = (path: string, size = 10): GitTreeEntry => ({ mode: "100644", type: "blob", oid: "d".repeat(40), size, path });

  function fakeGit(entries: readonly GitTreeEntry[], options: { truncatedTree?: boolean; truncatedGrep?: boolean } = {}) {
    const grepCalls: string[][] = [];
    const git = {
      repo: { readBlob: async (_oid: string, size: number) => bytes(BLOBS[size] ?? JSON.stringify({ name: "pkg-a" })) },
      listTree: async () => ({ entries, truncated: options.truncatedTree === true }),
      grepImports: async (_commit: string, paths: readonly string[]) => {
        grepCalls.push([...paths]);
        const matches = paths.map((path) => ({ path, text: "from \"pkg-a/src/a.js\"" }));
        return { matches, truncated: options.truncatedGrep === true };
      },
    } as unknown as ImpactGit;
    return { git, grepCalls };
  }

  const BLOBS: Record<number, string> = {
    3: "{x}", 4: "{}", 11: JSON.stringify({ name: "pkg-b" }), 12: JSON.stringify({ name: "pkg-c" }),
  };
  const changed: ImpactChange[] = [{ status: "modified", path: "src/a.ts", previousPath: null }];
  const limits = { scannedFilesMax: 100, fileReadMaxBytes: 50, readBytesPerRequest: 1_000, dependentsMax: 100 };
  const run = (git: ImpactGit, overrides: Partial<typeof limits> = {}, now = () => 0) => scanDependents({
    git, head: SHA, changed, depth: 1, deadline: 10, now, limits: { ...limits, ...overrides },
  });

  it("orders, skips and caps the scanned files", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const entries = [
      blob("src/a.ts"), blob("src/b.ts"), blob("pkg/x/c.ts"), blob("tests/t.test.ts"), blob("other/big.ts", 60),
      blob("node_modules/m/index.js"), blob("src/x.min.js"), blob("package.json"), blob("pkg/x/package.json", 3),
      blob("pkg/x/huge/package.json", 99), { ...blob("link.ts"), mode: "120000" }, blob("README.md"),
    ];
    const { git, grepCalls } = fakeGit(entries, { truncatedGrep: true });
    const result = await run(git);
    expect(grepCalls).toEqual([["src/a.ts", "src/b.ts", "tests/t.test.ts", "pkg/x/c.ts"]]);
    expect([...result.packageRoots]).toEqual(["", "pkg/x", "pkg/x/huge"]);
    expect(result.dependents.map((item) => item.path)).toEqual(["pkg/x/c.ts", "src/b.ts", "tests/t.test.ts"]);
    expect([...result.notices]).toEqual(["read_budget_exhausted"]);
    expect([...(await run(git, { scannedFilesMax: 3, dependentsMax: 1 })).notices])
      .toEqual(["scan_capped", "read_budget_exhausted", "dependents_capped"]);
    expect([...(await run(git, { readBytesPerRequest: 25 })).notices]).toEqual(["read_budget_exhausted"]);
    expect([...(await run(git, {}, () => 99)).notices]).toEqual(["run_budget_exhausted"]);
  });

  it("caps package manifests, reports a cut tree and skips scans with no source change", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const manifests = Array.from({ length: IMPACT_PACKAGE_FILES_MAX + 1 }, (_, i) => blob(`p${i}/package.json`));
    const { git } = fakeGit([blob("src/a.ts"), ...manifests], { truncatedTree: true });
    expect([...(await run(git, { readBytesPerRequest: 5_000 })).notices]).toEqual(["scan_capped"]);
    const docs = await scanDependents({
      git, head: SHA, changed: [{ status: "added", path: "docs/a.md", previousPath: null }], depth: 2, deadline: 10,
      now: () => 0,
    });
    expect([docs.dependents, docs.totals]).toEqual([[], { depth1: 0, depth2: 0 }]);
    const direct = await scanDependents({
      git, head: SHA, changed: [{ status: "added", path: "docs/a.md", previousPath: null }], depth: 1, deadline: 10,
      now: () => 0,
    });
    expect(direct.totals).toEqual({ depth1: 0, depth2: null });
  });

  it("orders packages, prefers the changed package and caps import edges", async () => {
    const entries = [
      blob("c/src/a.ts"), blob("c/lib/b.ts"), blob("z/q.ts"), blob("package.json", 11), blob("a/package.json"),
      blob("c/package.json", 12), blob("b/package.json", 4),
    ];
    const { git, grepCalls } = fakeGit(entries);
    (git as { grepImports: unknown }).grepImports = async (_commit: string, paths: readonly string[]) => {
      grepCalls.push([...paths]);
      return { matches: paths.map((path) => ({ path, text: "from \"pkg-c/src/a.js\"" })), truncated: false };
    };
    const input = {
      git, head: SHA, changed: [{ status: "modified" as const, path: "c/src/a.ts", previousPath: null }], depth: 1 as const,
      deadline: 10, now: () => 0,
    };
    const capped = await scanDependents({ ...input, limits: { ...limits, importEdgesMax: 1 } });
    expect(grepCalls).toEqual([["c/src/a.ts", "c/lib/b.ts", "z/q.ts"]]);
    expect(capped.dependents).toEqual([{ path: "c/lib/b.ts", depth: 1, via: "c/src/a.ts" }]);
    expect([...capped.notices]).toEqual(["scan_capped"]);
    const starved = await scanDependents({ ...input, limits: { ...limits, readBytesPerRequest: 5 } });
    expect([...starved.notices]).toEqual(["read_budget_exhausted"]);
  });

  it("rethrows a package.json read failure that is not a parse error", async () => {
    const { git } = fakeGit([blob("src/a.ts"), blob("package.json")]);
    (git.repo as { readBlob: unknown }).readBlob = async () => {
      throw new GitSourceError("git_output_malformed");
    };
    await expect(run(git)).rejects.toThrow(GitSourceError);
    (git.repo as { readBlob: unknown }).readBlob = async () => {
      vi.spyOn(JSON, "parse").mockImplementationOnce(() => {
        throw new TypeError("not json");
      });
      return bytes("{}");
    };
    await expect(run(git)).rejects.toThrow(TypeError);
  });
});
