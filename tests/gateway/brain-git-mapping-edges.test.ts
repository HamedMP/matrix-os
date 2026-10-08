/**
 * Edge cases of the pure git adapter modules that the main parser and
 * mapping suites do not reach: truncated multi-byte tails, malformed small
 * outputs, author caps at a surrogate boundary, globs sharing a directory, web base
 * and permalink refusals, heading-only title lines, NUL-expanded spec files
 * and long plain titles.
 */
import { describe, expect, it } from "vitest";
import { appliedCursor, inProgressCursor, parseGitCursor } from "../../packages/gateway/src/brain/git/cursor.js";
import { clampTitle, specPartDocumentId } from "../../packages/gateway/src/brain/git/documents.js";
import { compileSpecGlobs, parseCount, parseRevParseInfo, parseShaLines } from "../../packages/gateway/src/brain/git/parse.js";
import {
  blobPermalink, commitPermalink, deriveWebBase, parseWebBase, pullRequestPermalink,
} from "../../packages/gateway/src/brain/git/permalinks.js";
import { buildSpecDocuments, splitSpecText } from "../../packages/gateway/src/brain/git/specs.js";
import {
  GIT_MAX_SPEC_PARTS, GIT_SHA_PATTERN, type GitSpecFile, type GitWebBase,
} from "../../packages/gateway/src/brain/git/types.js";
import { A, B, GITHUB, GITHUB_CTX as ctx, US, bytes, expectGitCode, meta } from "./helpers/brain-git-pure.js";

const DATE = "2026-09-01T00:01:00Z";

const header = (sha = A, author = "Fixture Author"): string => `${sha}${US}${US}${DATE}${US}${DATE}${US}${author}${US}`;

function specFile(path: string, content: Uint8Array): GitSpecFile {
  return { path, touchSha: A, touchCommittedAt: DATE, blob: { oid: B, size: content.length, content } };
}

describe("parse.ts edges", () => {
  it("drops a multi-byte character cut off by a truncated per-commit read", () => {
    const subjectOf = (tail: number[]): string => meta(bytes(header(), "ok ", tail), true)[0]!.subject;
    expect(subjectOf([0xf0, 0x9f, 0x98])).toBe("ok");
    expect(subjectOf([0xe2, 0x80])).toBe("ok");
    expect(subjectOf([0xc3])).toBe("ok");
    expect(subjectOf([0xc3, 0xa9])).toBe("ok \u00e9");
    expect(subjectOf([0xf0, 0x9f, 0x98, 0x80])).toBe("ok \u{1f600}");
    // Stray continuation bytes are not a cut sequence; lossy decoding shows them.
    expect(meta(bytes(header(), [0x80]), true)[0]!.subject).toBe("\ufffd");
    expect(meta(bytes(header(), [0x80, 0x80, 0x80, 0x80]), true)[0]!.subject).toBe("\ufffd".repeat(4));
    expect(meta(bytes(header(), "msg"), true)[0]).toMatchObject({ subject: "msg", messageTruncated: true });
  });

  it("refuses a complete record without its header and drops a truncated one", () => {
    expectGitCode(() => meta(bytes(`${A}${US}no header\u0000`)), "git_output_malformed");
    const complete = bytes(header(), "first\u0000");
    expect(meta(bytes(complete, `${B}${US}${US}`), true).map((c) => c.sha)).toEqual([A]);
    expectGitCode(() => meta(bytes(header("c".repeat(65)), "x\u0000")), "git_output_malformed");
  });

  it("caps author names at 200 code points without splitting a surrogate pair", () => {
    const [commit] = meta(bytes(header(A, `a${"\u{1f600}".repeat(250)}`), "msg\u0000"));
    expect(commit!.authorName).toBe(`a${"\u{1f600}".repeat(199)}`);
    expect(Array.from(commit!.authorName)).toHaveLength(200);
  });

  it("refuses malformed small outputs", () => {
    expectGitCode(() => parseRevParseInfo(bytes("true\nsha1\n\n/g\n/g\n")), "git_output_malformed");
    expectGitCode(() => parseRevParseInfo(bytes("false\nsha1\n/a\u0000b\n/g\n/g\n")), "git_output_malformed");
    expectGitCode(() => parseRevParseInfo(bytes("false\nsha1\n/x\n/x/.git\n/x/.git\u0000\n")), "git_output_malformed");
    expectGitCode(() => parseRevParseInfo(bytes("false\nsha1\n/", [0xff], "\n/g\n/g\n")), "git_output_malformed");
    expect(parseShaLines(bytes(A), GIT_SHA_PATTERN.sha1)).toEqual([A]);
    expectGitCode(() => parseCount(bytes("12345678901234567\n")), "git_output_malformed");
  });

  it("keeps globs that share a directory apart and gives a single-segment glob no spec dir", () => {
    const matcher = compileSpecGlobs(["specs/*/spec.md", "specs/*/plan.md", "docs/adr/*.md"]);
    expect(matcher.globs).toEqual(["specs/*/spec.md", "specs/*/plan.md", "docs/adr/*.md"]);
    expect(["specs/a/spec.md", "specs/a/plan.md", "docs/adr/1.md", "specs/a/x.md"].map(matcher.matches))
      .toEqual([true, true, true, false]);
    expect(compileSpecGlobs(["SPEC.md"]).specDirOf("SPEC.md")).toBeNull();
  });
});

describe("permalinks.ts edges", () => {
  it("returns null for remotes and bases that do not parse", () => {
    expect(deriveWebBase("https://")).toBeNull();
    expect(parseWebBase("not a url")).toBeNull();
    expect(parseWebBase(`https://github.com/${"a".repeat(512)}`)).toBeNull();
  });

  it("falls back to the commit page for a blob path that would not stay canonical", () => {
    expect(blobPermalink(GITHUB, A, "specs/./spec.md")).toBe(`${GITHUB.href}/commit/${A}`);
  });

  it("refuses to build a page link over the permalink limit", () => {
    const long: GitWebBase = { href: `https://github.com/${"a".repeat(2_030)}`, flavor: "github" };
    expectGitCode(() => commitPermalink(long, A), "web_base_unavailable");
    expectGitCode(() => pullRequestPermalink(long, 1), "web_base_unavailable");
    expectGitCode(() => blobPermalink(long, A, "x.md"), "web_base_unavailable");
  });
});

describe("specs.ts edges", () => {
  it("splits four-byte characters on code point boundaries", () => {
    const text = "\u{1f600}".repeat(10);
    const parts = splitSpecText(text, 9);
    expect(parts.join("")).toBe(text);
    expect(parts.map((part) => Buffer.byteLength(part))).toEqual([8, 8, 8, 8, 8]);
  });

  it("treats heading lines with no text like the title regex does", () => {
    const path = "specs/001-a/spec.md";
    const titleOf = (text: string): string => buildSpecDocuments(specFile(path, bytes(text)), ctx).upserts[0]!.title;
    // `#  ` matches /^#[ \t]+(.+?)[ \t#]*$/ with a blank capture, so the path is the title.
    expect(titleOf("#  \n# Real\n")).toBe(path);
    expect(titleOf("# \n# Real\n")).toBe("Real");
    expect(titleOf("# Closing hashes ##\n")).toBe("Closing hashes");
  });

  it("indexes a spec under a single-segment glob with a path ref only", () => {
    const docs = buildSpecDocuments(specFile("SPEC.md", bytes("# Root spec\n")), {
      ...ctx, matcher: compileSpecGlobs(["SPEC.md"]),
    });
    expect(docs.upserts[0]!.refs).toEqual([{ kind: "path", value: "SPEC.md" }]);
  });

  it("stubs a file that needs more than 8 parts once its NUL bytes are replaced", () => {
    const path = "specs/009-nul/spec.md";
    const content = new Uint8Array(200_000);
    const docs = buildSpecDocuments(specFile(path, content), ctx);
    expect(docs.notices).toEqual(["spec_file_oversize"]);
    expect(docs.upserts).toHaveLength(1);
    expect(docs.upserts[0]).toMatchObject({
      documentId: specPartDocumentId(ctx.identity, path, 1), title: path,
      body: `This file is 200000 bytes and needs more than ${GIT_MAX_SPEC_PARTS} parts once its NUL characters are replaced. Open the permalink to read it.`,
    });
    expect(docs.deletions).toHaveLength(GIT_MAX_SPEC_PARTS - 1);
  });
});

describe("documents.ts edges", () => {
  it("cuts a long plain title at the limit", () => {
    expect(clampTitle("t".repeat(400), "fallback")).toBe("t".repeat(300));
    expect(clampTitle(`${"t".repeat(299)} tail`, "fallback")).toBe("t".repeat(299));
  });
});

describe("cursor.ts", () => {
  const RECEIPT = `rcp_${"0".repeat(32)}`;

  it("writes and reads back the three cursor forms", () => {
    expect(appliedCursor(A, A)).toBe(A);
    expect(appliedCursor(A, B)).toBe(`${A}>${B}`);
    expect(inProgressCursor(A, B, RECEIPT)).toBe(`${A}>${B}@${RECEIPT}`);
    expect(inProgressCursor(null, B, RECEIPT)).toBe(`>${B}@${RECEIPT}`);
    expect(parseGitCursor(A)).toEqual({ position: A, tip: null, receiptId: null });
    expect(parseGitCursor(`${A}>${B}`)).toEqual({ position: A, tip: B, receiptId: null });
    expect(parseGitCursor(`${A}>${B}@${RECEIPT}`)).toEqual({ position: A, tip: B, receiptId: RECEIPT });
    expect(parseGitCursor(`>${B}@${RECEIPT}`)).toEqual({ position: null, tip: B, receiptId: RECEIPT });
    const sha256 = "e".repeat(64);
    expect(parseGitCursor(`${sha256}>${sha256.replace(/^e/, "f")}`)).toMatchObject({ position: sha256 });
  });

  it("rejects text that is none of the forms, and a bad receipt id", () => {
    for (const text of [
      "", "not-a-sha", A.toUpperCase(), `${A}>${A}`, `>${B}`, `${A}@${RECEIPT}`, `@${RECEIPT}`, `${A}>${B}@rcp_x`,
      `${A}>${B}@${RECEIPT}x`, `${A} `, "a".repeat(41),
    ]) {
      expect(parseGitCursor(text), text).toBeNull();
    }
    expectGitCode(() => inProgressCursor(A, B, "rcp_bad"), "internal_error");
  });
});
