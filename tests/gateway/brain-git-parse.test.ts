import { describe, expect, it } from "vitest";
import {
  classifyCommit,
  compileSpecGlobs,
  isIndexablePath,
  isSafeBranchName,
  isSupportedGitVersion,
  isValidSpecGlob,
  parseCount,
  parseGitVersion,
  parseLsTree,
  parseNameStatusLog,
  parseRevParseInfo,
  parseShaLines,
  splitCommitMessage,
} from "../../packages/gateway/src/brain/git/parse.js";
import {
  GIT_AUTHOR_NAME_MAX_CHARS,
  GIT_DEFAULT_SPEC_GLOBS,
  GIT_COMMIT_MESSAGE_MAX_BYTES,
  GIT_MAX_PATHS_PER_COMMIT,
  GIT_SHA_PATTERN,
} from "../../packages/gateway/src/brain/git/types.js";
import { A, B, C, SHA1, US, bytes, expectGitCode, meta, nameStatus } from "./helpers/brain-git-pure.js";

const DATE = "2026-09-01T00:01:00+00:00";

const malformed = (run: () => unknown): void => expectGitCode(run, "git_output_malformed");

interface MetaFields { sha?: string; parents?: string; cI?: string; aI?: string; author?: string | number[]; message: string | number[] }

function metaRecord(fields: MetaFields): Uint8Array {
  const { sha = A, parents = "", cI = DATE, aI = DATE, author = "Fixture Author", message } = fields;
  return bytes(sha, US, parents, US, cI, US, aI, US, author, US, message);
}

describe("small command outputs", () => {
  it("parses git versions and checks the minimum", () => {
    expect(parseGitVersion(bytes("git version 2.52.0\n"))).toEqual({ major: 2, minor: 52, patch: 0 });
    expect(parseGitVersion(bytes("git version 2.39.5 (Apple Git-154)\n"))).toEqual({ major: 2, minor: 39, patch: 5 });
    expect(parseGitVersion(bytes("git version 2.45\n"))).toEqual({ major: 2, minor: 45, patch: 0 });
    expect(parseGitVersion(bytes("garbage\n"))).toBeNull();
    expect(parseGitVersion(bytes(""))).toBeNull();
    expect(isSupportedGitVersion({ major: 2, minor: 31, patch: 9 })).toBe(false);
    expect(isSupportedGitVersion({ major: 2, minor: 32, patch: 0 })).toBe(true);
    expect(isSupportedGitVersion({ major: 3, minor: 0, patch: 0 })).toBe(true);
    expect(isSupportedGitVersion({ major: 1, minor: 99, patch: 0 })).toBe(false);
  });

  it("parses rev-parse repository info", () => {
    const repo = "/home/u/projects/my repo";
    expect(parseRevParseInfo(bytes(`false\nsha1\n${repo}\n${repo}/.git\n${repo}/.git\n`))).toEqual({
      shallow: false, objectFormat: "sha1", toplevel: repo, gitDir: `${repo}/.git`, commonDir: `${repo}/.git`,
    });
    expect(parseRevParseInfo(bytes("true\nsha256\n/x\n/m/.git/worktrees/x\n/m/.git\n")))
      .toEqual({ shallow: true, objectFormat: "sha256", toplevel: "/x", gitDir: "/m/.git/worktrees/x", commonDir: "/m/.git" });
    for (const bad of [
      "false\nsha1\n/x\n/x/.git\n", "false\nsha1\n/x\n", "", "maybe\nsha1\n/x\n/g\n/g\n", "false\nmd5\n/x\n/g\n/g\n",
      "false\nsha1\nx\n/g\n/g\n", "false\nsha1\n/x\n.git\n/g\n", "false\nsha1\n/a\nb\n/a\nb/.git\n/g\n",
    ]) {
      malformed(() => parseRevParseInfo(bytes(bad)));
    }
    malformed(() => parseRevParseInfo(bytes("false\nsha1\n/x", [0xff], "\n/g\n/g\n")));
  });

  it("parses sha lines and counts", () => {
    expect(parseShaLines(bytes(`${A}\n${B}\n`), SHA1)).toEqual([A, B]);
    expect(parseShaLines(bytes(""), SHA1)).toEqual([]);
    expect(parseShaLines(bytes(`${"e".repeat(64)}\n`), GIT_SHA_PATTERN.sha256)).toEqual(["e".repeat(64)]);
    malformed(() => parseShaLines(bytes(`${A}\nnot-a-sha\n`), SHA1));
    malformed(() => parseShaLines(bytes(`${A}\n\n`), SHA1));
    expect(parseCount(bytes("3\n"))).toBe(3);
    expect(parseCount(bytes("0"))).toBe(0);
    for (const bad of ["-1\n", "1 2\n", "1234567890\n", "", "\n"]) malformed(() => parseCount(bytes(bad)));
  });
});

describe("parseCommitMetadata", () => {
  it("parses several NUL-terminated records", () => {
    const stdout = bytes(
      metaRecord({ parents: `${B} ${C}`, message: "feat: x (#1)\n\n## Summary\n- one\n" }), "\0",
      metaRecord({ sha: B, cI: "2026-09-01T02:00:00Z", aI: "2026-09-01T04:00:00+02:00", message: "Initial commit\n" }), "\0",
    );
    const records = meta(stdout);
    expect(records).toEqual([
      {
        sha: A, parents: [B, C], committedAt: DATE, authoredAt: DATE, authorName: "Fixture Author",
        subject: "feat: x (#1)", body: "## Summary\n- one", messageTruncated: false,
      },
      {
        sha: B, parents: [], committedAt: "2026-09-01T02:00:00Z", authoredAt: "2026-09-01T04:00:00+02:00",
        authorName: "Fixture Author", subject: "Initial commit", body: "", messageTruncated: false,
      },
    ]);
    expect(meta(bytes(""))).toEqual([]);
  });

  it("keeps unit separators inside %B", () => {
    const [record] = meta(bytes(metaRecord({ message: `a${US}b\n\nbody${US} here\n` }), "\0"));
    expect(record.subject).toBe(`a${US}b`);
    expect(record.body).toBe(`body${US} here`);
  });

  it("splits messages with git %s / %b semantics", () => {
    expect(splitCommitMessage("line one\n  line two \n\nbody\n")).toEqual({ subject: "line one line two", body: "body" });
    expect(splitCommitMessage("subject only\n")).toEqual({ subject: "subject only", body: "" });
    expect(splitCommitMessage("\n\n  \nsubject\n\n\n\n  indented body\nmore\n\n")).toEqual({ subject: "subject", body: "  indented body\nmore" });
    expect(splitCommitMessage("")).toEqual({ subject: "", body: "" });
    expect(splitCommitMessage("s\n\n## Summary\n\n* item\n\n---------\n\nCo-authored-by: X <x@example.com>\n"))
      .toEqual({ subject: "s", body: "## Summary\n\n* item\n\n---------\n\nCo-authored-by: X <x@example.com>" });
  });

  it("decodes non-ASCII and replaces invalid UTF-8 in messages", () => {
    const [emoji] = meta(bytes(metaRecord({ message: "feat: caf\u00e9 \u2615 \ud83d\ude80 (#9)\n" }), "\0"));
    expect(emoji.subject).toBe("feat: caf\u00e9 \u2615 \ud83d\ude80 (#9)");
    const [invalid] = meta(bytes(metaRecord({ message: "s\n\nbad " }), [0xff, 0xfe], " end\n\0"));
    expect(invalid.body).toBe("bad \ufffd\ufffd end");
  });

  it("cleans and caps author names", () => {
    const [record] = meta(bytes(metaRecord({ author: "  Ann\x07 Lee\x7f\u0085 ", message: "m" }), "\0"));
    expect(record.authorName).toBe("Ann Lee");
    const [long] = meta(bytes(metaRecord({ author: "\ud83d\ude00".repeat(250), message: "m" }), "\0"));
    expect(Array.from(long.authorName)).toHaveLength(GIT_AUTHOR_NAME_MAX_CHARS);
    const [invalid] = meta(bytes(metaRecord({ author: [0x41, 0xff, 0x42], message: "m" }), "\0"));
    expect(invalid.authorName).toBe("A\ufffdB");
  });

  it("rejects malformed records", () => {
    malformed(() => meta(bytes(metaRecord({ sha: "xyz", message: "m" }), "\0")));
    malformed(() => meta(bytes(metaRecord({ sha: A.toUpperCase(), message: "m" }), "\0")));
    malformed(() => meta(bytes(metaRecord({ cI: "2026-09-01 00:00:00", message: "m" }), "\0")));
    malformed(() => meta(bytes(metaRecord({ aI: "yesterday", message: "m" }), "\0")));
    malformed(() => meta(bytes(metaRecord({ parents: Array(65).fill(B).join(" "), message: "m" }), "\0")));
    malformed(() => meta(bytes(metaRecord({ parents: `${B}  ${C}`, message: "m" }), "\0")));
    malformed(() => meta(bytes(`${A}${US}${US}${DATE}${US}${DATE}\0`)));
    malformed(() => meta(bytes(metaRecord({ message: "no terminator" }))));
    malformed(() => meta(bytes(metaRecord({ message: "m" }), "\0\0")));
    expect(meta(bytes(metaRecord({ parents: Array(64).fill(B).join(" "), message: "m" }), "\0"))[0].parents).toHaveLength(64);
  });

  it("keeps a truncated per-commit record when its header is complete", () => {
    const [record] = meta(bytes(metaRecord({ message: "subject\n\nbody text that is cu" })), true);
    expect(record).toMatchObject({ sha: A, subject: "subject", body: "body text that is cu", messageTruncated: true });
    const [cut] = meta(bytes(metaRecord({ message: "s\n\ncaf" }), [0xc3]), true);
    expect(cut.body).toBe("caf");
    expect(meta(bytes(`${A}${US}${US}${DATE}`), true)).toEqual([]);
    const [complete] = meta(bytes(metaRecord({ message: "whole\n" }), "\0"), true);
    expect(complete.messageTruncated).toBe(false);
  });

  it("cuts a message over the cap on a code-point boundary", () => {
    const message = `s\n\n${"\u00e9".repeat(GIT_COMMIT_MESSAGE_MAX_BYTES)}`;
    const [record] = meta(bytes(metaRecord({ message }), "\0"));
    expect(record.messageTruncated).toBe(true);
    expect(record.body).toBe("\u00e9".repeat((GIT_COMMIT_MESSAGE_MAX_BYTES - 4) / 2));
    expect(record.body.includes("\ufffd")).toBe(false);
  });
});

describe("parseNameStatusLog", () => {
  it("parses the verified layout including an empty commit between two commits", () => {
    const stdout = bytes(A, "\0\nD\0README.md\0A\0side.txt\0", B, "\0", C, "\0\nA\0a b/c#?.md\0A\0caf\u00e9.md\0");
    const parsed = nameStatus(stdout);
    expect(parsed.map((entry) => entry.sha)).toEqual([A, B, C]);
    expect(parsed[0].changes).toEqual({
      paths: [{ status: "D", path: "README.md" }, { status: "A", path: "side.txt" }],
      totalPaths: 2, invalidPaths: 0, truncated: false, specPaths: [],
    });
    expect(parsed[1].changes).toEqual({ paths: [], totalPaths: 0, invalidPaths: 0, truncated: false, specPaths: [] });
    expect(parsed[2].changes.paths.map((path) => path.path)).toEqual(["a b/c#?.md", "caf\u00e9.md"]);
    expect(nameStatus(bytes(""))).toEqual([]);
    expect(nameStatus(bytes(A, "\0"))).toEqual([{ sha: A, changes: parsed[1].changes }]);
  });

  it("parses a root commit and treats a 40-hex path as a path", () => {
    const parsed = nameStatus(bytes(A, "\0\nA\0", B, "\0A\0specs/001-a/spec.md\0", C, "\0"), {
      isSpecPath: (path) => path.endsWith("/spec.md"),
    });
    expect(parsed.map((entry) => entry.sha)).toEqual([A, C]);
    expect(parsed[0].changes.paths).toEqual([{ status: "A", path: B }, { status: "A", path: "specs/001-a/spec.md" }]);
    expect(parsed[0].changes.specPaths).toEqual(["specs/001-a/spec.md"]);
  });

  it("keeps special characters verbatim", () => {
    const names = ["dir with space/x.md", "#1.md", "q?.md", "100%.md", "(a).md", "[b].md", "@c.md", "d+e.md", "docs/caf\u00e9/na\u00efve file #1?.md", "\u65e5\u672c\u8a9e.md"];
    const stdout = bytes(A, "\0", ...names.flatMap((name, index) => [`${index === 0 ? "\n" : ""}M\0${name}\0`]));
    expect(nameStatus(stdout)[0].changes.paths.map((path) => path.path)).toEqual(names);
  });

  it("drops and counts paths that are not indexable", () => {
    const stdout = bytes(
      A, "\0\nA\0ok.md\0A\0bad", [0xff], ".md\0A\0", "x".repeat(513), "\0A\0line\nbreak.md\0A\0", "y".repeat(512), "\0",
    );
    const [{ changes }] = nameStatus(stdout);
    expect(changes.paths.map((path) => path.path)).toEqual(["ok.md", "y".repeat(512)]);
    expect(changes).toMatchObject({ totalPaths: 5, invalidPaths: 3, truncated: false });
  });

  it("parses every status, including two-path R and C entries", () => {
    const stdout = bytes(A, "\0\nT\0t\0U\0u\0X\0x\0B\0b\0R100\0old.md\0new.md\0C075\0src.md\0copy.md\0M\0m\0");
    const [{ changes }] = nameStatus(stdout);
    expect(changes.paths).toEqual([
      { status: "T", path: "t" }, { status: "U", path: "u" }, { status: "X", path: "x" }, { status: "B", path: "b" },
      { status: "R", path: "new.md", previousPath: "old.md" }, { status: "C", path: "copy.md", previousPath: "src.md" },
      { status: "M", path: "m" },
    ]);
    expect(changes.totalPaths).toBe(7);
  });

  it("caps kept paths but counts all and keeps every spec path", () => {
    const paths = Array.from({ length: 250 }, (_, index) => `specs/${String(index).padStart(3, "0")}/spec.md`);
    const stdout = bytes(A, "\0", ...paths.map((path, index) => `${index === 0 ? "\n" : ""}M\0${path}\0`));
    const [{ changes }] = nameStatus(stdout, { isSpecPath: (path) => path.endsWith("/spec.md") });
    expect(changes.paths).toHaveLength(GIT_MAX_PATHS_PER_COMMIT);
    expect(changes.paths[199].path).toBe(paths[199]);
    expect(changes).toMatchObject({ totalPaths: 250, invalidPaths: 0, truncated: true });
    expect(changes.specPaths).toEqual(paths);
  });

  it("drops incomplete trailing input from truncated per-commit output", () => {
    const midPath = nameStatus(bytes(A, "\0\nM\0one.md\0M\0tw"), { truncated: true });
    expect(midPath[0].changes).toMatchObject({ paths: [{ status: "M", path: "one.md" }], totalPaths: 1, truncated: true });
    const midStatus = nameStatus(bytes(A, "\0\nM\0one.md\0M\0"), { truncated: true });
    expect(midStatus[0].changes).toMatchObject({ totalPaths: 1, truncated: true });
    const renameCut = nameStatus(bytes(A, "\0\nM\0one.md\0R100\0old.md\0"), { truncated: true });
    expect(renameCut[0].changes.paths).toEqual([{ status: "M", path: "one.md" }]);
    expect(nameStatus(bytes(A.slice(0, 20)), { truncated: true })).toEqual([]);
  });

  it("rejects garbage", () => {
    malformed(() => nameStatus(bytes("hello\0")));
    malformed(() => nameStatus(bytes(A, "\0\nQ\0x\0")));
    malformed(() => nameStatus(bytes(A, "\0\nMM\0x\0")));
    malformed(() => nameStatus(bytes(A, "\0\nM\0")));
    malformed(() => nameStatus(bytes(A, "\0\nM\0x\0trailing")));
    malformed(() => nameStatus(bytes(A, "\0\0")));
    malformed(() => nameStatus(bytes("\nM\0x\0")));
  });

  it("uses the object format's sha pattern", () => {
    const sha256 = "f".repeat(64);
    const parsed = parseNameStatusLog(bytes(sha256, "\0\nA\0x\0"), { shaPattern: GIT_SHA_PATTERN.sha256, isSpecPath: () => false, truncated: false });
    expect(parsed[0].sha).toBe(sha256);
    malformed(() => nameStatus(bytes(sha256, "\0\nA\0x\0")));
  });
});

describe("parseLsTree", () => {
  const oid = "1".repeat(40);

  it("parses blob, tree and submodule entries", () => {
    const stdout = bytes(
      `100644 blob ${oid}     123\tspecs/001-a/spec.md\0`,
      `100755 blob ${oid} 4000000\tspecs/run.sh\0`,
      `040000 tree ${oid}       -\tspecs/dir\0`,
      `160000 commit ${oid}       -\tspecs/sub\0`,
      `100644 blob ${oid}       5\tspecs/with\ttab.md\0`,
    );
    expect(parseLsTree(stdout, SHA1)).toEqual([
      { mode: "100644", type: "blob", oid, size: 123, path: "specs/001-a/spec.md" },
      { mode: "100755", type: "blob", oid, size: 4000000, path: "specs/run.sh" },
      { mode: "040000", type: "tree", oid, size: null, path: "specs/dir" },
      { mode: "160000", type: "commit", oid, size: null, path: "specs/sub" },
      { mode: "100644", type: "blob", oid, size: 5, path: "specs/with\ttab.md" },
    ]);
    expect(parseLsTree(bytes(""), SHA1)).toEqual([]);
  });

  it("accepts sha256 oids and skips paths that are not UTF-8", () => {
    const oid256 = "2".repeat(64);
    expect(parseLsTree(bytes(`100644 blob ${oid256}       1\tx.md\0`), GIT_SHA_PATTERN.sha256)[0].oid).toBe(oid256);
    expect(parseLsTree(bytes(`100644 blob ${oid}       1\tbad`, [0xff], "\0"), SHA1)).toEqual([]);
  });

  it("rejects malformed records", () => {
    for (const bad of [
      `100644 blob xyz       1\tp\0`, `100644 blob ${oid}       1 p\0`, `100644 file ${oid}       1\tp\0`,
      `10064 blob ${oid}       1\tp\0`, `100644 blob ${oid}       1\t\0`, `100644 blob ${oid}       1\tp`,
      `100644 blob ${"2".repeat(64)}       1\tp\0`, `\0`,
    ]) {
      malformed(() => parseLsTree(bytes(bad), SHA1));
    }
  });
});

describe("classifyCommit", () => {
  const github = (subject: string, body = "", parents: string[] = [A]) => classifyCommit({ subject, body, parents }, "github");
  const gitlab = (subject: string, body = "", parents: string[] = [A]) => classifyCommit({ subject, body, parents }, "gitlab");

  it("classifies GitHub squash, titled merge and branch merge pull requests", () => {
    expect(github("feat(brain): alpha (#1)", "## Summary\n- Adds alpha.")).toEqual({
      kind: "pull_request", number: 1, form: "squash", branch: null,
      title: "feat(brain): alpha", body: "## Summary\n- Adds alpha.", mentions: [],
    });
    expect(github("feat: beta (#3)", "* item", [A, B])).toMatchObject({ kind: "pull_request", number: 3, form: "merge_titled", title: "feat: beta" });
    expect(github("Merge pull request #2 from acme/feature-x", "\nAdd feature X\n\n\nMore details\n\n", [A, B])).toEqual({
      kind: "pull_request", number: 2, form: "merge_branch", branch: "acme/feature-x",
      title: "Add feature X", body: "More details", mentions: [],
    });
    expect(github("Merge pull request #2 from acme/feature-x", "", [A, B])).toMatchObject({ form: "merge_branch", title: "", body: "" });
  });

  it("handles the required edge cases", () => {
    expect(github('Revert "x (#157)"')).toEqual({ kind: "commit", title: 'Revert "x (#157)"', body: "", mentions: [157] });
    expect(github('Revert "x (#157)" (#158)')).toMatchObject({ kind: "pull_request", number: 158, title: 'Revert "x (#157)"', mentions: [157] });
    expect(github("feat: port from #1032 (#1064)")).toMatchObject({ kind: "pull_request", number: 1064, mentions: [1032] });
    expect(github("address PR #19 review")).toEqual({ kind: "commit", title: "address PR #19 review", body: "", mentions: [19] });
    expect(github("x (#12) trailing")).toMatchObject({ kind: "commit", mentions: [12] });
    expect(github("(#4)")).toMatchObject({ kind: "pull_request", number: 4, form: "squash", title: "" });
    expect(github("Merge commit 'abc'", "", [A, B])).toMatchObject({ kind: "commit", mentions: [] });
    expect(github("Merge pull request #2 from acme/feature-x")).toMatchObject({ kind: "commit", mentions: [2] });
    expect(github("x (#0)")).toMatchObject({ kind: "commit" });
    expect(github("x (#1234567890)")).toMatchObject({ kind: "commit" });
  });

  it("follows the same rules for octopus merges", () => {
    expect(github("Merge pull request #9 from a/b", "Octo", [A, B, C])).toMatchObject({ form: "merge_branch", number: 9, title: "Octo" });
    expect(github("feat: many (#10)", "", [A, B, C])).toMatchObject({ form: "merge_titled", number: 10 });
  });

  it("extracts subject mentions with exclusions, dedupe and a cap", () => {
    expect(github("fix &#38; a/#5 ##6 #7x #08 #9").mentions).toEqual([7, 9]);
    expect(github("#5 #5 #6 (#5)")).toMatchObject({ number: 5, mentions: [6] });
    const many = Array.from({ length: 12 }, (_, index) => `#${index + 1}`).join(" ");
    expect(github(many).mentions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(github("see #1", "body mentions #2").mentions).toEqual([1]);
  });

  it("classifies GitLab merge requests and never reports mentions", () => {
    const body = "Long description\n\nSee merge request acme/platform/widgets!7";
    expect(gitlab("Add widgets", body)).toEqual({
      kind: "pull_request", number: 7, form: "gitlab_merge", branch: null, title: "Add widgets", body, mentions: [],
    });
    expect(gitlab("Merge branch 'feature' into 'main'", "Add the thing\n\nSee merge request acme/widgets!12", [A, B]))
      .toMatchObject({ number: 12, title: "Add the thing" });
    expect(gitlab("Merge branch 'f' into 'main'", "See merge request g/r!3")).toMatchObject({ number: 3, title: "" });
    expect(gitlab("feat: x (#4) and #5", "")).toEqual({ kind: "commit", title: "feat: x (#4) and #5", body: "", mentions: [] });
    expect(gitlab("x", "See merge request g/r!3 extra")).toMatchObject({ kind: "commit" });
  });

  it("classifies a 256 KiB hostile GitLab subject in linear time", () => {
    const hostile = `Merge branch '${"' into '".repeat(32 * 1024)}x`;
    expect(hostile.length).toBeGreaterThan(256 * 1024);
    const started = performance.now();
    expect(gitlab(hostile, "Real title\n\nSee merge request g/r!3")).toMatchObject({ number: 3, title: hostile });
    expect(performance.now() - started).toBeLessThan(250);
    const longBranch = `Merge branch '${"b".repeat(255)}' into '${"m".repeat(255)}'`;
    expect(gitlab(longBranch, "Real title\n\nSee merge request g/r!3")).toMatchObject({ title: "Real title" });
  });
});

describe("spec globs", () => {
  it("compiles the default glob", () => {
    const matcher = compileSpecGlobs(["specs/*/spec.md"]);
    expect(matcher.globs).toEqual(["specs/*/spec.md"]);
    expect(matcher.matches("specs/001-a/spec.md")).toBe(true);
    for (const path of ["specs/spec.md", "specs/a/b/spec.md", "specs/a/plan.md", "specs//spec.md", "xspecs/a/spec.md"]) {
      expect(matcher.matches(path)).toBe(false);
    }
    expect(matcher.specDirOf("specs/a/plan.md")).toBe("specs/a");
    expect(matcher.specDirOf("specs/001-a/spec.md")).toBe("specs/001-a");
    expect(matcher.specDirOf("specs/spec.md")).toBeNull();
    expect(matcher.specDirOf("README.md")).toBeNull();
  });

  it("indexes spec, plan, research, data model and quickstart files, and top-level files without a spec folder", () => {
    const matcher = compileSpecGlobs(GIT_DEFAULT_SPEC_GLOBS);
    for (const name of ["spec", "plan", "research", "data-model", "quickstart"]) {
      expect([matcher.matches(`specs/1-a/${name}.md`), matcher.specDirOf(`specs/1-a/${name}.md`)]).toEqual([true, "specs/1-a"]);
    }
    expect([matcher.matches("specs/1-a/tasks.md"), matcher.specDirOf("specs/1-a/tasks.md")]).toEqual([false, "specs/1-a"]);
    expect([matcher.matches("specs/ux-guide.md"), matcher.specDirOf("specs/ux-guide.md")]).toEqual([true, null]);
    expect(matcher.matches("specs/1-a/b/plan.md")).toBe(false);
    // Only a literal folder holding another glob's deeper folders loses its spec folder.
    const nested = compileSpecGlobs(["docs/*.md", "docs/README.md", "docs/*/x/a.md", "specs/*/x/b.md", "specs/*/c.md"]);
    expect(["docs/a.md", "specs/1-a/c.md"].map((path) => nested.specDirOf(path))).toEqual([null, "specs/1-a"]);
  });

  it("compiles custom globs, literals and dedupes", () => {
    const matcher = compileSpecGlobs(["docs/adr/*.md", "specs/*-api/spec.md", "docs/v1.0/*.md", "README.md", "docs/adr/*.md"]);
    expect(matcher.globs).toEqual(["docs/adr/*.md", "specs/*-api/spec.md", "docs/v1.0/*.md", "README.md"]);
    expect(matcher.matches("docs/adr/0001-record.md")).toBe(true);
    expect(matcher.matches("docs/adr/sub/x.md")).toBe(false);
    expect(matcher.matches("specs/001-api/spec.md")).toBe(true);
    expect(matcher.matches("specs/001-web/spec.md")).toBe(false);
    expect(matcher.matches("docs/v1x0/a.md")).toBe(false);
    expect(matcher.matches("README.md")).toBe(true);
    expect(matcher.specDirOf("docs/adr/0001-record.md")).toBe("docs/adr");
    expect(matcher.specDirOf("README.md")).toBeNull();
  });

  it("rejects invalid globs and too many globs", () => {
    const invalid = ["*/x", "a/**/b", "a/../b", "./a", "a/./b", "", "a".repeat(201), "a b/*.md", "/abs/*.md", "a/", "a/b/c/d/e/f/g/h/i"];
    for (const glob of invalid) {
      expect(isValidSpecGlob(glob)).toBe(false);
      expectGitCode(() => compileSpecGlobs([glob]), "invalid_options");
    }
    for (const glob of ["specs/*-*/spec.md", "docs/*a*/*.md", "specs/**/spec.md", "a/*b*c*/x.md"]) {
      expect(isValidSpecGlob(glob), glob).toBe(false);
    }
    expect(isValidSpecGlob("specs/*-api/v*.md")).toBe(true);
    const nine = Array.from({ length: 9 }, (_, index) => `docs${index}/*.md`);
    expectGitCode(() => compileSpecGlobs(nine), "invalid_options");
    expect(compileSpecGlobs([...nine.slice(0, 8), nine[0], nine[1]]).globs).toHaveLength(8);
    expectGitCode(() => compileSpecGlobs([]), "invalid_options");
  });
});

describe("spec glob matching cost", () => {
  it("matches hostile 500-byte paths in linear time with one star per segment", () => {
    const matcher = compileSpecGlobs(["specs/*-x/spec.md", "docs/a*z/*.md", "specs/*/spec.md"]);
    const hostile = [
      `specs/${"-".repeat(490)}/spec.md`, `docs/${"a".repeat(490)}/x.md`, `specs/${"-x".repeat(245)}y/spec.md`,
    ];
    const started = performance.now();
    for (let round = 0; round < 200; round++) {
      for (const path of hostile) {
        matcher.matches(path);
        matcher.specDirOf(path);
      }
    }
    expect(performance.now() - started).toBeLessThan(250);
    expect(matcher.matches(`specs/${"-".repeat(490)}-x/spec.md`)).toBe(true);
  });
});

describe("validators", () => {
  it("accepts only indexable paths", () => {
    const good = ["README.md", "specs/001-a/spec.md", "docs/caf\u00e9/na\u00efve file #1?.md", "a".repeat(512), ".github/ci.yml", "\u00e9".repeat(256)];
    for (const path of good) expect(isIndexablePath(path)).toBe(true);
    const bad = [
      "", "/abs", "a//b", "a/./b", "a/../b", "trailing/", "..", ".", "with\nnewline", "tab\there", "del\x7f", "nul\u0000",
      "a".repeat(513), "\u00e9".repeat(257), "lone\uD800",
    ];
    for (const path of bad) expect(isIndexablePath(path)).toBe(false);
  });

  it("accepts only safe short branch names", () => {
    for (const name of ["main", "release/1.2", "feature-x", "a_b.c", "x".repeat(200)]) expect(isSafeBranchName(name)).toBe(true);
    const bad = [
      "", "HEAD", "refs/heads/main", "-x", "/x", "x/", "x.", ".x", "a..b", "a//b", "a/.b", "a@{1}", "x.lock", "a.lock/b",
      "has space", "x".repeat(201), "\u00fc", "a~1", "a^", "a:b",
    ];
    for (const name of bad) expect(isSafeBranchName(name)).toBe(false);
  });
});
