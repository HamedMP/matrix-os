/**
 * The impact pull request comment formatter: escaping, mention safety, link safety, section order and the size cut.
 * Pure. Cite labels are tested with the shared rule in brain-cite.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  BRAIN_IMPACT_LIMITS, type BrainCiteView, type BrainImpactClaim, type BrainImpactView,
} from "../../packages/gateway/src/brain/contracts.js";
import { COMMENT_DEPENDENTS_MAX, code, plainText } from "../../packages/gateway/src/brain/impact/comment.js";
import { formatBrainImpactComment } from "../../packages/gateway/src/brain/impact/index.js";

const SHA = "a".repeat(40);
const AT = "2026-10-01T10:00:00.000Z";
const ZW = "\u200b";

const cite = (label: string, permalink = ""): BrainCiteView => ({
  documentId: "d".repeat(64), kind: "pr", provenance: "git_pr", sourceId: null, label, title: label, permalink,
  date: AT, revision: 1,
});

const claim = (statement: string, label: string | null, permalink: string): BrainImpactClaim => ({
  claimId: "c".repeat(64), kind: "invariant", label, statement, quote: `> ${statement}\nnext line`,
  paths: ["src/a.ts"], cite: cite("#12", permalink),
});

/** dependentTotals default to the listed dependents per depth (depth2 null when none is at depth 2). */
function view(overrides: Partial<BrainImpactView> = {}): BrainImpactView {
  const dependents = overrides.dependents ?? [];
  const deeper = dependents.filter((dependent) => dependent.depth === 2).length;
  return {
    base: { ref: "main", sha: SHA }, head: { ref: "feature/x", sha: "b".repeat(40) }, mergeBase: "c".repeat(40),
    changedFiles: [], changedTotal: 0, dependents, approximate: true, prior: [], invariants: [], decisions: [],
    untested: [], specs: [], notices: [],
    dependentTotals: { depth1: dependents.length - deeper, depth2: deeper === 0 ? null : deeper }, ...overrides,
  };
}

describe("comment", () => {
  it("escapes text and never mentions people or links unsafe URLs", () => {
    expect(plainText("Hi @octocat, see #12 *now*\n\u0007[x](y) `z` <b> | ~ !", 200))
      .toBe(`Hi @${ZW}octocat, see #${ZW}12 \\*now\\* \\[x\\](y) \\\`z\\\` \\<b\\> \\| \\~ \\!`);
    expect(plainText("abcdef", 3)).toBe("abc...");
    expect(plainText(`ab\u{1F600}`, 3)).toBe("ab...");
    expect(code("a`b")).toBe("``a`b``");
    expect(code("`edge`")).toBe("`` `edge` ``");
    expect(code("plain")).toBe("`plain`");
    expect(plainText("&commat;a &num;1", 50)).toBe("\\&commat;a \\&num;1");
    expect(code("a\r\r@x\n\u0000")).toBe("`a??@x??`");
    const { markdown } = formatBrainImpactComment(view({
      dependents: [{ path: "src/b\r\r@octocat hi.ts", depth: 1, via: "src/a\n.ts" }],
    }));
    expect(markdown).toContain("- `src/b??@octocat hi.ts` imports `src/a?.ts` (depth 1)");
    expect(markdown).not.toMatch(/\r/);
    expect(code("a\u202Eb\u200Bc")).toBe("`a?b?c`");
  });

  it("breaks issue references, bare links and bidi or zero-width characters in text", () => {
    expect(plainText("See GH-5, http://evil.example/x, www.evil.example and https://github.com/other/repo/issues/9", 500))
      .toBe(`See GH${ZW}-5, http:${ZW}//evil.example/x, www${ZW}.evil.example and `
        + `https:${ZW}//github.com/other/repo/issues/9`);
    expect(plainText("gh-7 WWW.x.test FTP://x GH-pages a:b", 80)).toBe(`gh${ZW}-7 WWW${ZW}.x.test FTP:${ZW}//x GH-pages a:b`);
    expect(plainText("evil\u202Etxt.exe G\u200BH-1 @\u2066x w\uFEFFww.y", 80))
      .toBe(`eviltxt.exe GH${ZW}-1 @${ZW}x www${ZW}.y`);
    const { markdown } = formatBrainImpactComment(view({
      decisions: [claim("Close GH-5 via www.a.test", "See http://b.test", "https://github.com/acme/w/pull/12")],
    }));
    expect(markdown).toContain(`- **See http:${ZW}//b.test:** Close GH${ZW}-5 via www${ZW}.a.test `
      + `([#${ZW}12](https://github.com/acme/w/pull/12))`);
    expect(markdown).not.toMatch(/GH-\d|www\.|http:\/\/|\u202E/);
  });

  it("lays out every non-empty section", () => {
    const { markdown, truncated } = formatBrainImpactComment(view({
      changedFiles: [
        { path: "src/a.ts", status: "type_changed", previousPath: null, isTest: false },
        { path: "src/b.ts", status: "renamed", previousPath: "src/old.ts", isTest: false },
        { path: "tests/a.test.ts", status: "added", previousPath: null, isTest: true },
      ],
      changedTotal: 3,
      dependents: [{ path: "src/c.ts", depth: 2, via: "src/d.ts" }],
      prior: [{ path: "src/a.ts", items: [cite("#12", "https://github.com/acme/w/pull/12"), cite("#3", "javascript:x")] }],
      invariants: [claim("Stay @safe", "Source of truth", "https://github.com/acme/w/pull/12")],
      decisions: [claim("Use Postgres", null, "")],
      untested: [{ path: "src/a.ts" }],
      specs: [
        { spec: "specs/001-a", changedPaths: ["specs/001-a/spec.md"], cite: { ...cite("specs/001-a", "https://x.test/s") } },
        { spec: "specs/002-b", changedPaths: ["specs/002-b/a.md", "specs/002-b/b.md"], cite: null },
      ],
      notices: ["scan_capped", "brain_behind_head"],
    }));
    expect(truncated).toBe(false);
    expect(markdown).toContain("### Impact brief: `feature/x` against `main`");
    expect(markdown).toContain("Merge base `cccccccccccc`, head `bbbbbbbbbbbb`.");
    expect(markdown).toContain("- `src/a.ts` type changed\n- `src/b.ts` renamed from `src/old.ts`\n- `tests/a.test.ts` added (test)");
    expect(markdown).toContain("- `src/c.ts` imports `src/d.ts` (depth 2)");
    expect(markdown).toContain(`- \`src/a.ts\`: [#${ZW}12](https://github.com/acme/w/pull/12), #${ZW}3`);
    expect(markdown).toContain(`- **Source of truth:** Stay @${ZW}safe ([#${ZW}12](https://github.com/acme/w/pull/12))\n`
      + `  > \\> Stay @${ZW}safe next line`);
    expect(markdown).toContain(`- Use Postgres (#${ZW}12)`);
    expect(markdown).toContain("#### Changed code without a matching test change (approximate)\n- `src/a.ts`");
    const order = ["Notes", "Changed files", "Invariants", "Decisions", "Specs", "Changed code", "Earlier", "Files that"];
    const at = order.map((heading) => markdown.indexOf(`#### ${heading}`));
    expect(at.every((value, i) => value > 0 && (i === 0 || value > at[i - 1]!))).toBe(true);
    expect(markdown).toContain("- [specs/001-a](https://x.test/s): `specs/001-a/spec.md`");
    expect(markdown).toContain("- `specs/002-b`: `specs/002-b/a.md`, `specs/002-b/b.md`");
    expect(markdown).toContain("- The import scan covered only part of the repository.\n- The brain has not synced");
    expect(markdown.endsWith("approximate._")).toBe(true);
  });

  it("leaves out empty sections and cuts long bodies under the limit", () => {
    const empty = formatBrainImpactComment(view());
    expect(empty.markdown).not.toContain("####");
    const dependents = Array.from({ length: 3_000 }, (_, i) => ({ path: `src/${"p".repeat(40)}${i}.ts`, depth: 1 as const, via: "src/a.ts" }));
    const big = formatBrainImpactComment(view({ dependents, notices: ["dependents_capped"] }));
    expect(big.truncated).toBe(false);
    expect(big.markdown).toContain("#### Notes\n- More files import the changed files than are listed.");
    expect(big.markdown).toContain(`- and ${3_000 - COMMENT_DEPENDENTS_MAX} more`);
    expect(big.markdown).toContain("#### Files that import the changed files (approximate): 3,000 direct\n");
    const notes = formatBrainImpactComment(view({
      changedFiles: [{ path: "x".repeat(59_850), status: "added", previousPath: null, isTest: false }],
      notices: ["read_budget_exhausted"],
    }));
    expect([notes.truncated, notes.markdown.includes("The import scan stopped at its read limit.")]).toEqual([true, true]);
    expect(notes.markdown).toContain("_Cut to fit the comment size limit._");
    const edge = formatBrainImpactComment(view({
      changedFiles: [{ path: "x".repeat(59_850), status: "added", previousPath: null, isTest: false }],
      untested: [{ path: "src/a.ts" }],
    }));
    expect(edge.truncated).toBe(true);
    expect(edge.markdown).not.toContain("#### Changed code");
    // The change line fits and the next heading does not: the cut comes before that heading.
    const heading = formatBrainImpactComment(view({
      changedFiles: [{ path: "y".repeat(59_650), status: "added", previousPath: null, isTest: false }],
      untested: [{ path: "src/a.ts" }],
    }));
    expect([heading.truncated, heading.markdown.includes("` added"), heading.markdown.includes("#### Changed code")])
      .toEqual([true, true, false]);
    for (let length = 59_600; length < 59_800; length += 1) {
      const near = formatBrainImpactComment(view({
        changedFiles: [{ path: "y".repeat(length), status: "added", previousPath: null, isTest: false }],
        untested: [{ path: "src/a.ts" }],
      }));
      expect(near.markdown.length).toBeLessThanOrEqual(BRAIN_IMPACT_LIMITS.commentMaxChars);
    }
  });

  it("states how many files import the changed files at each depth, beyond the listed ones", () => {
    const one = { path: "src/b.ts", depth: 1 as const, via: "src/a.ts" };
    const both = formatBrainImpactComment(view({
      dependents: [one], dependentTotals: { depth1: 1_204, depth2: 3_310 },
    })).markdown;
    expect(both).toContain("#### Files that import the changed files (approximate): 1,204 direct, 3,310 through one"
      + " more file\n- `src/b.ts` imports `src/a.ts` (depth 1)\n- and 4513 more");
    const direct = formatBrainImpactComment(view({ dependents: [one] })).markdown;
    expect(direct).toContain("(approximate): 1 direct\n- `src/b.ts` imports `src/a.ts` (depth 1)\n\n_From");
  });
});
