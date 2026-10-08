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
