/** Pure graph derivation and identifier rules: footers, trailers, refs per provenance, text, decisions and caps. */
import { describe, expect, it } from "vitest";
import { BrainApiError } from "../../packages/gateway/src/brain/api/types.js";
import { deriveBrainGraph } from "../../packages/gateway/src/brain/graph/index.js";
import { describedFor } from "../../packages/gateway/src/brain/graph/derive.js";
import {
  brainEntityId, cutText, decodeGraphCursor, encodeGraphCursor, isEntityKey, parseEntityInput, parseQueryDate,
  personEmailKey, personNameKey, queryFingerprint,
} from "../../packages/gateway/src/brain/graph/ids.js";
import type { BrainGraphDocumentInput } from "../../packages/gateway/src/brain/graph/types.js";
import { gitBody } from "./helpers/brain-graph-fixtures.js";

const DOC = "d".repeat(64);
const refs = (...pairs: [string, string][]) => pairs.map(([kind, value]) => ({ kind, value }));
const derive = (input: Partial<BrainGraphDocumentInput>) => deriveBrainGraph({
  documentId: DOC, provenance: "github_issue", title: "Title", body: "Body", refs: [], decisionQuotes: [],
  parentTargets: [], commitPullRequests: [], ...input,
});
const summary = (input: Partial<BrainGraphDocumentInput>) => derive(input).links
  .map((link) => `${link.from.kind}:${link.from.key}|${link.type}|${link.mode}|${link.to.kind}:${link.to.key}`);
const d = `document:${DOC}`;

describe("brain graph derivation", () => {
  it("reads git footers and trailers into persons, identities and pull request links", () => {
    const message = [
      "feat: beta", "", "Closes #5 and see #6, fixes: #7", "",
      "Co-authored-by: Alice Smith <Alice@Acme.dev>", "Co-authored-by: Bob", "Reviewed-by: Carol <carol@acme.dev>",
      "Signed-off-by: <ops@acme.dev>", "Co-authored-by: Bad\u0001Name", "",
    ].join("\n");
    const result = derive({
      provenance: "git_pr", title: "feat: beta",
      body: gitBody(message, { sha: "c".repeat(40), author: "Dan Doe", pr: "#8", merged: "acme/beta" }),
      refs: refs(["pr", "8"], ["pr", "6"], ["spec", "specs/003-gamma"], ["spec", "/bad"]),
    });
    expect(result.links.map((link) => [link.type, link.mode, link.from.key, link.to.key, link.refKind])).toEqual([
      ["describes", "explicit", DOC, "8", null],
      ["authored", "explicit", "name:dan doe", DOC, null],
      ["authored", "explicit", "email:alice@acme.dev", DOC, null],
      ["authored", "explicit", "name:bob", DOC, null],
      ["reviewed", "explicit", "email:carol@acme.dev", DOC, null],
      ["authored", "explicit", "email:ops@acme.dev", DOC, null],
      ["implements_spec", "explicit", DOC, "specs/003-gamma", "spec"],
      ["mentions", "inferred", DOC, "6", "pr"],
      ["references_issue", "inferred", DOC, "#5", null],
      ["references_issue", "inferred", DOC, "#7", null],
    ]);
    expect(result.identities).toEqual([
      { n: "name:alice smith", e: "email:alice@acme.dev" }, { n: "name:carol", e: "email:carol@acme.dev" },
    ]);
    expect(result.links[2]!.from.displayName).toBe("Alice Smith");
    expect(result.links[5]!.from.displayName).toBe("ops@acme.dev");
    expect(result.links[0]!.quote).toBeNull();
    expect(result.links[1]!.quote).toBe("Author: Dan Doe");
  });

  it("treats GitLab merge requests as explicit and #N as issues, and skips unknown authors", () => {
    const body = gitBody("Merge branch 'x'\n\nFixes #3", { sha: "e".repeat(40), author: "unknown", pr: "!4" })
      .replace("Pull request: !4", "Merge request: !4");
    expect(summary({ provenance: "git_pr", body, decisionQuotes: ["Decided in #3 for src/x/y.ts"],
      knownPaths: new Set(["src/x/y.ts"]) })).toEqual([
      `${d}|describes|explicit|pull_request:4`, `${d}|references_issue|inferred|issue:#3`,
      `issue:#3|decided_in|inferred|${d}`, `file:src/x/y.ts|decided_in|inferred|${d}`,
    ]);
    expect(summary({ provenance: "git_pr", body: "no footer" })).toEqual([]);
    expect(summary({ provenance: "git_commit", body: gitBody("", { sha: "f".repeat(40), author: "Eve" }) }))
      .toEqual([`person:name:eve|authored|explicit|${d}`]);
  });

  it("maps refs by provenance: records, reviews, issues, persons and parents", () => {
    expect(summary({
      provenance: "github_pr", refs: refs(["pr", "9"], ["pr", "10"], ["issue", "ENG-1"], ["issue", "bad"],
        ["author", "github:al"], ["reviewer", "github:bo"], ["assignee", "linear:u1"], ["attendee", "bad key"]),
      commitPullRequests: ["11"],
    })).toEqual([
      `${d}|describes|explicit|pull_request:9`, `person:github:al|authored|explicit|${d}`,
      `person:github:bo|reviewed|explicit|${d}`, `${d}|mentions|explicit|person:linear:u1`,
      `${d}|references_issue|explicit|issue:ENG-1`, `${d}|mentions|explicit|pull_request:10`,
      `${d}|part_of|explicit|pull_request:11`,
    ]);
    expect(summary({ provenance: "github_review", title: "Review of #9", refs: refs(["pr", "9"]),
      parentTargets: [{ kind: "pull_request", key: "9", displayName: "#9" }] }))
      .toEqual([`${d}|part_of|explicit|pull_request:9`]);
    expect(summary({ provenance: "github_issue", title: "Bug #5 again, like #2", refs: refs(["handle", "#5"], ["issue", "#5"]) }))
      .toEqual([`${d}|describes|explicit|issue:#5`, `${d}|mentions|inferred|pull_request:2`]);
    expect(summary({ provenance: "linear_issue", refs: refs(["handle", "not a key"]) })).toEqual([]);
    expect(summary({ provenance: "github_pr" })).toEqual([]);
    expect(summary({ provenance: "git_spec", body: "See specs/010-x and specs/011-y/spec.md, specs/001-a.",
      refs: refs(["spec", "specs/001-a"], ["spec", "../bad"]) })).toEqual([
      `${d}|describes|explicit|spec:specs/001-a`, `${d}|mentions|inferred|spec:specs/010-x`,
      `${d}|mentions|inferred|spec:specs/011-y`,
    ]);
    expect(describedFor("linear_issue", "", refs(["handle", "ENG-7"]))[0]!.entity.key).toBe("ENG-7");
    expect(summary({ provenance: "git_spec" })).toEqual([]);
    const blank = derive({ title: "   ", refs: refs(["path", "a/b.ts"], ["path", "a/c.ts"]) });
    expect(blank.entities.map((entity) => [entity.kind, entity.displayName])).toEqual([
      ["document", DOC], ["file", "a/b.ts"], ["folder", "a"], ["file", "a/c.ts"],
    ]);
    const trailers = Array.from({ length: 40 }, (_, index) => `Co-authored-by: P${index} <p${index}@x.dev>`).join("\n");
    const many = derive({ provenance: "git_commit", body: gitBody(trailers, { sha: "f".repeat(40), author: "unknown" }) });
    expect([many.links.length, many.identities.length]).toEqual([32, 32]);
  });

  it("links decisions to the entities their quotes name and caps text links, folders and links", () => {
    const quote = "Use ENG-1 not ENG-2 for #4 in specs/005-e, keep a/b.ts and ../c.ts; UTF-8.";
    expect(summary({ refs: refs(["issue", "ENG-1"]), decisionQuotes: [quote], knownPaths: new Set(["a/b.ts"]) })).toEqual([
      `${d}|references_issue|explicit|issue:ENG-1`, `pull_request:4|decided_in|inferred|${d}`,
      `spec:specs/005-e|decided_in|inferred|${d}`, `issue:ENG-1|decided_in|inferred|${d}`,
      `file:a/b.ts|decided_in|inferred|${d}`,
    ]);
    // A quoted path that is no path ref of the scope (an import path, a partial path) never becomes a file.
    expect(summary({ decisionQuotes: ["Import fumadocs-ui/css/preset.css and src/app/layout.tsx"] })).toEqual([]);
    const many = Array.from({ length: 20 }, (_, index) => `#${index + 1} specs/${100 + index}-x`).join(" ");
    const text = summary({ body: many, decisionQuotes: [many] });
    expect(text.filter((link) => link.includes("|mentions|"))).toHaveLength(32);
    expect(text.filter((link) => link.includes("|decided_in|"))).toHaveLength(16);
    const paths = Array.from({ length: 200 }, (_, index) => ["path", `p${index}/q${index}/r${index}/f.ts`] as [string, string]);
    const derived = derive({ refs: refs(...paths, ["path", "/abs"]) });
    expect(derived.entities.filter((entity) => entity.kind === "folder")).toHaveLength(400);
    expect(derived.entities.filter((entity) => entity.kind === "file")).toHaveLength(200);
    const people = Array.from({ length: 350 }, (_, index) => ["participant", `email:p${index}@x.dev`] as [string, string]);
    expect(derive({ refs: refs(...people) }).links).toHaveLength(300);
  });

  it("drops person keys over 512 bytes and any entity whose key the table would refuse", () => {
    const cjk = "\u4e00".repeat(200);
    const body = gitBody(`fix\n\nCo-authored-by: ${cjk}\nCo-authored-by: ${cjk} <a@b.co>`, { sha: "f".repeat(40), author: cjk });
    const result = derive({ provenance: "git_commit", body, commitPullRequests: ["012"],
      parentTargets: [{ kind: "issue", key: "eng-1", displayName: "x" }] });
    expect(result.links.map((link) => `${link.from.key}|${link.type}`)).toEqual(["email:a@b.co|authored"]);
    expect([result.identities, personNameKey(cjk), personEmailKey(`${cjk}@x.co`)]).toEqual([[], null, null]);
  });

  it("parses trailers with long whitespace runs in linear time", () => {
    const gap = " ".repeat(64_000);
    const message = `fix\n\nCo-authored-by: a${gap}b\r\nReviewed-by: Eve${gap}Ng${gap}<eve@x.co>\nSigned-off-by: Zed <a@b@c>`;
    const started = performance.now();
    const result = derive({ provenance: "git_commit", body: gitBody(message, { sha: "f".repeat(40), author: "unknown" }) });
    expect(performance.now() - started).toBeLessThan(50);
    expect(result.links.map((link) => `${link.from.key}|${link.type}`)).toEqual([
      "name:a b|authored", "email:eve@x.co|reviewed", "name:zed|authored",
    ]);
    expect(result.identities).toEqual([{ n: "name:eve ng", e: "email:eve@x.co" }]);
  });

  it("does not read the linked issues of a GitHub pull request as pull request mentions", () => {
    // The body and refs the GitHub source writes for a pull request whose description closes #5 and #6.
    const body = "Fixes #5, fixes #6.\n\nPull request: #8\nState: open\nAuthor: al\nLinked issues: #5, #6\nCommits: 0";
    expect(summary({ provenance: "github_pr", title: "Fix", body, refs: refs(["handle", "#8"], ["pr", "8"],
      ["author", "github:al"], ["issue", "#5"], ["issue", "#6"]) })).toEqual([
      `${d}|describes|explicit|pull_request:8`, `person:github:al|authored|explicit|${d}`,
      `${d}|references_issue|explicit|issue:#5`, `${d}|references_issue|explicit|issue:#6`,
    ]);
  });
});

describe("brain graph identifiers", () => {
  it("parses entity ids and refs per kind", () => {
    const id = brainEntityId("file", "a/b.ts");
    expect(id).toMatch(/^ent_[a-f0-9]{32}$/);
    expect(parseEntityInput(id)).toEqual({ entityId: id, kind: null });
    expect(parseEntityInput("file:a/b.ts")).toEqual({ entityId: id, kind: "file" });
    for (const ok of ["person:email:a@b.co", "pull_request:12", "issue:#3", "document:" + "a".repeat(64),
      "project:proj_x", "spec:specs/001-a", "folder:src"]) expect(parseEntityInput(ok)).not.toBeNull();
    for (const bad of ["team:x", "file:", "file:/abs", "pull_request:012", "issue:eng-1", "document:x", "project:x",
      "person:nobody", "noColon", `file:${"a".repeat(513)}`, "file:\uD800"]) expect(parseEntityInput(bad)).toBeNull();
    expect(isEntityKey("person", "name:\u0001")).toBe(false);
    expect([personNameKey(" Ada  Lovelace "), personNameKey("\u0001"), personEmailKey(" A@B.co "), personEmailKey("x")])
      .toEqual(["name:ada lovelace", null, "email:a@b.co", null]);
    expect(cutText("ab\uD83D\uDE00", 3)).toBe("ab");
    expect(cutText("  a   b ", 10)).toBe("a b");
  });

  it("refuses foreign or malformed cursors and dates", () => {
    const fingerprint = queryFingerprint(["q"]);
    const cursor = encodeGraphCursor(fingerprint, "2026-10-01T10:00:00.000000Z", "lnk_x");
    expect(decodeGraphCursor(cursor, fingerprint)).toEqual({ at: "2026-10-01T10:00:00.000000Z", id: "lnk_x" });
    const bad = [
      cursor.padEnd(513, "A"), "%%", encodeGraphCursor(fingerprint, "0000-01-01T00:00:00.000000Z", "x"),
      encodeGraphCursor(fingerprint, "yesterday", "x"), Buffer.from("{}").toString("base64url"),
    ];
    for (const value of bad) expect(() => decodeGraphCursor(value, fingerprint)).toThrow(BrainApiError);
    expect(() => decodeGraphCursor(cursor, queryFingerprint(["other"]))).toThrow(BrainApiError);
    expect([parseQueryDate(undefined), parseQueryDate("2026-02-03"), parseQueryDate("2026-02-03T04:05:06+02:00")])
      .toEqual([null, "2026-02-03T00:00:00.000Z", "2026-02-03T02:05:06.000Z"]);
    for (const value of ["2026-02-30", "2026-02-03T04:05:06", "0000-01-01", "soon"]) {
      expect(() => parseQueryDate(value)).toThrow(BrainApiError);
    }
  });
});
