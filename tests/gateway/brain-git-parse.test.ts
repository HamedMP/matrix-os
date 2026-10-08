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
