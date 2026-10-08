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
