/** brain_why: listDocumentsByRef, brainWhy on a synced fixture repository, and the pure helpers. PGlite-backed. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GIT_TRUNCATION_MARKER } from "../../packages/gateway/src/brain/git/index.js";
import { type BrainDocumentRef, type BrainRefMatchQuery } from "../../packages/gateway/src/brain/index.js";
import { encodeRefMatchCursor, selectDocumentsByRef } from "../../packages/gateway/src/brain/refs-reads.js";
import {
  brainWhy, extractBrainWhySections, normalizeBrainWhyPath, parseBrainGitFooter,
} from "../../packages/gateway/src/brain/why.js";
import { FIXTURE_WEB_BASE as WEB, SPECIAL_PATH, buildBaseHistory } from "./helpers/brain-git-fixture.js";
import { createGitSource, useGitSyncHarness } from "./helpers/brain-git-harness.js";
import {
  brainContent, brainDocumentId, createBrainHarness, expectBrainError, scopeA, scopeB, scopeOtherOwner,
  type BrainHarness,
} from "./helpers/brain-store-helpers.js";

const path = (value: string): BrainDocumentRef => ({ kind: "path", value });
const spec = (value: string): BrainDocumentRef => ({ kind: "spec", value });
const GIT = ["git_pr", "git_commit", "git_spec"];
const query = (overrides: Partial<BrainRefMatchQuery> = {}): BrainRefMatchQuery => ({
  kind: "path", value: "src/a", mode: "exact_or_under", provenances: GIT, ...overrides,
});
interface Seed {
  readonly seed: string; readonly refs: readonly BrainDocumentRef[]; readonly at?: string; readonly provenance?: string;
  readonly body?: string;
}
const SHA = "a".repeat(40);
const footer = (extra: readonly string[] = [], sha = SHA) =>
  [`Commit: ${sha}`, "Author: A", "Committed: 2026-09-01T00:00:00Z", ...extra, "Changed paths: 1"].join("\n");

describe("listDocumentsByRef", () => {
  let harness: BrainHarness;
  beforeEach(async () => { harness = await createBrainHarness(); });
  afterEach(() => harness.destroy());

  async function seed(docs: readonly Seed[], scope = scopeA): Promise<string> {
    const { source } = await harness.repository.createSource(scope, { kind: "git", externalRef: "R", label: "R" });
    await harness.repository.applySyncBatch(scope, {
      sourceId: source.sourceId, expectedCursor: null, nextCursor: "c1", deletions: [],
      upserts: docs.map((d) => ({
        ...brainContent(d.seed, { provenance: d.provenance ?? "git_commit", sourceUpdatedAt: d.at ?? "2026-09-01T00:00:00Z" }),
        ...(d.body === undefined ? {} : { body: d.body }),
        refs: [...d.refs],
      })),
    });
    return source.sourceId;
  }
  const ids = (page: { items: readonly { document: { documentId: string } }[] }) =>
    page.items.map((item) => item.document.documentId);
  const idsOf = (...seeds: string[]) => seeds.map(brainDocumentId);

  it("matches a file exactly and a folder by bytewise prefix", async () => {
    await seed([
      { seed: "file", refs: [path("src/a")], at: "2026-09-08T00:00:00Z" },
      { seed: "under", refs: [path("src/a/b.ts"), path("other.ts")], at: "2026-09-07T00:00:00Z" },
      { seed: "deep", refs: [path("src/a/c/d.ts")], at: "2026-09-06T00:00:00Z" },
      ...["src/a-b", "src/a.b", "src/a0", "src/ab/x.ts", "src/a.ts", "src", "a/src/a/x"].map((value, n) => ({
        seed: `near${n}`, refs: [path(value)],
      })),
      { seed: "spec-only", refs: [spec("src/a/x")] },
    ]);
    const { repository } = harness;
    const both = await repository.listDocumentsByRef(scopeA, query());
    expect(ids(both)).toEqual(idsOf("file", "under", "deep"));
    expect(both).toMatchObject({ total: 3, totalCapped: false, nextCursor: null });
    expect(both.items[1]?.refs).toEqual([path("src/a/b.ts")]);
    expect(ids(await repository.listDocumentsByRef(scopeA, query({ mode: "under" })))).toEqual(idsOf("under", "deep"));
    expect(ids(await repository.listDocumentsByRef(scopeA, query({ value: "src/a.ts" })))).toEqual(idsOf("near4"));
    expect(ids(await repository.listDocumentsByRef(scopeA, query({ value: "src/a/c", mode: "under" })))).toEqual(idsOf("deep"));
    expect((await repository.listDocumentsByRef(scopeA, query({ value: "nope" }))).items).toEqual([]);
  });

  it("returns only live documents of the scope and provenances, with extra ref kinds", async () => {
    const sourceId = await seed([
      { seed: "pr", provenance: "git_pr", refs: [spec("specs/2"), path("src/a/x.ts"), { kind: "pr", value: "7" }, spec("specs/1")] },
      { seed: "slack", provenance: "slack_message", refs: [path("src/a/x.ts")] },
      { seed: "gone", refs: [path("src/a/y.ts")] },
    ]);
    await harness.repository.applySyncBatch(scopeA, {
      sourceId, expectedCursor: "c1", nextCursor: "c2", upserts: [], deletions: [brainDocumentId("gone")],
    });
    await seed([{ seed: "b", refs: [path("src/a")] }], scopeB);
    await seed([{ seed: "o", refs: [path("src/a")] }], scopeOtherOwner);
    const page = await harness.repository.listDocumentsByRef(scopeA, query({ extraRefKinds: ["spec"] }));
    expect(ids(page)).toEqual(idsOf("pr"));
    expect(page.items[0]?.refs).toEqual([path("src/a/x.ts"), spec("specs/1"), spec("specs/2")]);
    expect(page.items[0]?.document).toMatchObject({ title: "Title pr", provenance: "git_pr", deletedAt: null });
    expect(ids(await harness.repository.listDocumentsByRef(scopeB, query()))).toEqual(idsOf("b"));
    expect(ids(await harness.repository.listDocumentsByRef(scopeA, query({ provenances: ["slack_message"] })))).toEqual(idsOf("slack"));
  });

  it("pages newest first exactly once across timestamp ties, with the total on every page", async () => {
    const times = ["2026-09-03T00:00:00Z", "2026-09-02T00:00:00.123456Z", "2026-09-02T00:00:00.123457Z"];
    const docs = Array.from({ length: 9 }, (_, n) => ({ seed: `d${n}`, refs: [path(`src/a/${n}.ts`)], at: times[n % 3] }));
    await seed(docs);
    const expected = docs.map((d) => ({ id: brainDocumentId(d.seed), at: new Date(d.at).getTime() + (d.at.endsWith("7Z") ? 0.5 : 0) }))
      .sort((x, y) => y.at - x.at || (x.id < y.id ? 1 : -1)).map((d) => d.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await harness.repository.listDocumentsByRef(scopeA, query({ limit: 2, cursor }));
      expect([result.total, result.totalCapped]).toEqual([9, false]);
      seen.push(...ids(result));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(expected);
  });

  it("labels documents by the shared cite rule and reads a two-backtick line as text", async () => {
    const handle = (value: string): BrainDocumentRef => ({ kind: "handle", value });
    await seed([
      { seed: "pr", provenance: "git_pr", refs: [path("src/a/1.ts")], at: "2026-09-04T00:00:00Z", body: "No footer." },
      { seed: "nonum", provenance: "git_pr", refs: [path("src/a/2.ts")], at: "2026-09-03T00:00:00Z",
        body: `\`\`not a fence\`\`\n## Summary\nKept.\n\n${footer()}` },
      { seed: "commit", refs: [path("src/a/3.ts")], at: "2026-09-02T00:00:00Z", body: "Plain commit." },
      { seed: "spec", provenance: "git_spec", refs: [path("src/a/4.md"), spec("specs/9-b"), spec("specs/1-a")],
        at: "2026-09-01T00:00:00Z", body: "Spec text." },
      { seed: "handled", provenance: "git_spec", refs: [path("src/a/5.md"), spec("specs/1-a"), handle("SPEC-5")],
        at: "2026-08-31T00:00:00Z", body: "Handled." },
      { seed: "bare", provenance: "git_spec", refs: [path("src/a/6.md")], at: "2026-08-30T00:00:00Z", body: "Bare." },
    ]);
    const page = await brainWhy(harness.repository, scopeA, { path: "src/a/" });
    // A pull request footer without a number cites its short sha, a spec its first spec ref, else its handle or title.
    expect(page.items.map((i) => [i.kind, i.label, i.number, i.sha, i.link, i.summary?.text])).toEqual([
      ["pr", "PR", null, null, "none", "No footer."], ["pr", SHA.slice(0, 12), null, SHA, "none", "Kept."],
      ["commit", "commit", null, null, "none", "Plain commit."], ["spec", "specs/1-a", null, null, "none", undefined],
      ["spec", "SPEC-5", null, null, "none", undefined], ["spec", "Title bare", null, null, "none", undefined],
    ]);
    expect(page.items[3]!.specs).toEqual(["specs/1-a", "specs/9-b"]);
  });

  it("caps the count and rejects bad cursors and queries", async () => {
    await seed([1, 2, 3].map((n) => ({ seed: `c${n}`, refs: [path(`src/a/${n}`)] })));
    const parsed = { ...query(), extraRefKinds: [], limit: 10, cursor: null };
    expect(await selectDocumentsByRef(harness.db, scopeA, parsed, 2)).toMatchObject({ total: 2, totalCapped: true });
    expect(await selectDocumentsByRef(harness.db, scopeA, parsed, 3)).toMatchObject({ total: 3, totalCapped: false });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const id = brainDocumentId("c1");
    for (const cursor of [
      "!!", "a b", Buffer.from("not json").toString("base64url"), encode([1, 2]), encode(["2026-09-01T00:00:00.000000Z"]),
      encode(["2026-09-01T00:00:00.000Z", id]), encode(["2026-09-01T00:00:00.000000Z", "abc"]),
      encode(["2026-09-01T00:00:00.000000Z", id, 1]), encode({ at: "2026-09-01T00:00:00.000000Z", id }),
      encode(["0000-01-01T00:00:00.000000Z", id]),
    ]) await expectBrainError(harness.repository.listDocumentsByRef(scopeA, query({ cursor })), "invalid");
    const good = encodeRefMatchCursor({ at: "2026-09-01T00:00:00.000000Z", documentId: "f".repeat(64) });
    expect((await harness.repository.listDocumentsByRef(scopeA, query({ cursor: good }))).total).toBe(3);
    for (const bad of [
      { provenances: [] }, { provenances: ["git_pr", "git_pr"] }, { limit: 51 }, { limit: 0 }, { value: "" },
      { value: "a\u0000b" }, { value: "\u00e9".repeat(257) }, { kind: "Path" }, { mode: "prefix" },
      { extraRefKinds: ["a", "b", "c", "d", "e"] }, { cursor: "x".repeat(257) }, { extra: 1 },
    ] as Partial<BrainRefMatchQuery>[]) await expectBrainError(harness.repository.listDocumentsByRef(scopeA, query(bad)), "invalid");
    await expectBrainError(harness.repository.listDocumentsByRef({ ownerId: "", scopeId: "s" }, query()), "invalid");
  });
});

describe("brainWhy on a synced repository", { timeout: 60_000 }, () => {
  const t = useGitSyncHarness();
  const why = (path: string, extra: Record<string, unknown> = {}) =>
    brainWhy(t.harness.repository, scopeA, { path, ...extra });
  const date = async (sha: string) => new Date(await t.f.committedAt(sha)).toISOString();

  it("answers files, folders and specs with labels, links, excerpts and pages", async () => {
    const h = await buildBaseHistory(t.f);
    expect((await t.sync(await createGitSource(t.harness.repository, scopeA))).status).toBe("succeeded");

    const alpha = await why("src/alpha.ts");
    expect(alpha).toMatchObject({ path: "src/alpha.ts", match: "file_or_folder", detail: "brief", total: 2, totalCapped: false, nextCursor: null });
    expect(alpha.items[0]).toEqual({
      documentId: expect.any(String), kind: "commit", label: h.revert1.slice(0, 12), number: null, sha: h.revert1,
      title: 'Revert "feat(brain): alpha (#1)"', date: await date(h.revert1), permalink: `${WEB}/commit/${h.revert1}`,
      link: "none", summary: { heading: null, text: `This reverts commit ${h.squash1}.`, truncated: false }, invariants: null,
      specs: ["specs/001-alpha"], matchedPaths: ["src/alpha.ts"], matchedPathCount: 1,
    });
    expect(alpha.items[1]).toMatchObject({
      kind: "pr", label: "#1", number: 1, sha: h.squash1, title: "feat(brain): alpha", link: "inferred",
      permalink: `${WEB}/pull/1`, date: await date(h.squash1), specs: ["specs/001-alpha"],
      summary: { heading: "Summary", text: "- Adds alpha.", truncated: false },
      invariants: { heading: "Invariants", text: "- Alpha stays bounded.", truncated: false },
    });

    const first = await why("src/alpha.ts", { limit: 1 });
    expect([first.items.map((i) => i.label), first.total]).toEqual([[h.revert1.slice(0, 12)], 2]);
    const second = await why("src/alpha.ts", { limit: 1, cursor: first.nextCursor });
    expect([second.items.map((i) => i.label), second.nextCursor]).toEqual([["#1"], null]);

    const src = await why("src/");
    expect(src).toMatchObject({ path: "src", match: "folder", total: 4 });
    expect(src.items.map((i) => [i.label, i.link])).toEqual([
      [h.revert1.slice(0, 12), "none"], ["#3", "inferred"], ["#2", "explicit"], ["#1", "inferred"],
    ]);
    expect(src.items[1]?.summary).toEqual({ heading: null, text: "* add beta\n* wire beta", truncated: false });
    expect(src.items[2]).toMatchObject({ title: "Add feature X", summary: null, invariants: null, matchedPaths: ["src/x.ts"] });
    expect((await why("src")).items.map((i) => i.documentId)).toEqual(src.items.map((i) => i.documentId));

    const specs = await why("specs/");
    expect(specs.total).toBe(6);
    expect(specs.items.filter((i) => i.kind === "spec").map((i) => [i.label, i.title, i.sha, i.summary]).sort()).toEqual([
      ["specs/001-alpha", "Alpha", null, null], ["specs/002-feature-x", "Feature X", null, null],
    ]);
    const featureX = specs.items.find((i) => i.kind === "spec" && i.label === "specs/002-feature-x");
    expect(featureX).toMatchObject({ permalink: `${WEB}/blob/${h.merge2}/specs/002-feature-x/spec.md`, link: "none", specs: ["specs/002-feature-x"] });

    expect((await why("notes/unit.txt")).items[0]).toMatchObject({
      kind: "commit", label: h.unitSeparator.slice(0, 12), summary: { heading: null, text: "before\u001fafter", truncated: false },
    });
    expect((await why(SPECIAL_PATH)).items[0]?.matchedPaths).toEqual([SPECIAL_PATH]);
    expect(await why("missing/")).toMatchObject({ total: 0, items: [], nextCursor: null });
    for (const bad of ["/abs", "a/../b", "", "/", "a//", "./a"]) await expectBrainError(why(bad), "invalid");
    await expectBrainError(why("src/", { detail: "long" }), "invalid");
    await expectBrainError(why("src/", { limit: 51 }), "invalid");
    await expectBrainError(why("src/", { cursor: "nope" }), "invalid");
  });

  it("gives longer excerpts and more specs and paths with detail full", async () => {
    const lines = Array.from({ length: 30 }, (_, n) => `- change ${n} keeps the widget pipeline bounded and readable.`);
    const body = `## Summary\n${lines.join("\n")}\n\n## Validation and invariants\n- Never unbounded.`;
    const files = Object.fromEntries(Array.from({ length: 6 }, (_, n) => [
      [`lib/m${n}.ts`, `export const m${n} = ${n};\n`], [`specs/00${n}-s${n}/notes.md`, `notes ${n}\n`],
    ]).flat());
    await t.f.squashPr(7, "feat: many modules", body, files);
    await t.sync(await createGitSource(t.harness.repository, scopeA));

    const [brief] = (await why("lib/")).items;
    expect(brief).toMatchObject({ label: "#7", matchedPathCount: 6, invariants: { heading: "Validation and invariants", text: "- Never unbounded." } });
    expect([brief?.specs.length, brief?.matchedPaths, brief?.summary?.truncated]).toEqual([4, ["lib/m0.ts", "lib/m1.ts", "lib/m2.ts"], true]);
    expect(brief?.summary?.text.length).toBeLessThanOrEqual(480);
    expect(lines.join("\n").startsWith(brief?.summary?.text ?? "x")).toBe(true);

    const [full] = (await why("lib/", { detail: "full" })).items;
    expect([full?.specs.length, full?.matchedPaths.length]).toEqual([6, 6]);
    expect(full?.summary).toEqual({ heading: "Summary", text: lines.join("\n"), truncated: false });
  });
});

describe("brain_why helpers", () => {
  it("normalizes paths", () => {
    expect(normalizeBrainWhyPath("src/a.ts")).toEqual({ path: "src/a.ts", match: "file_or_folder" });
    expect(normalizeBrainWhyPath("src/")).toEqual({ path: "src", match: "folder" });
    expect(normalizeBrainWhyPath("docs/caf\u00e9/na\u00efve file #1?.md")?.path).toBe("docs/caf\u00e9/na\u00efve file #1?.md");
    expect(normalizeBrainWhyPath(`${"\u00e9".repeat(256)}/`)?.match).toBe("folder");
    for (const bad of ["", "/", "a//", "//", "/a", "./a", "a/./b", "a/../b", "..", "a\tb", "a\u0000b", "a\u007f", `${"\u00e9".repeat(257)}`, "\ud800"]) {
      expect(normalizeBrainWhyPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("parses the git adapter footer", () => {
    expect(parseBrainGitFooter(`Body text.\n\n${footer(["Pull request: #12"])}`)).toEqual({
      message: "Body text.", messageTruncated: false, sha: SHA, number: 12, sigil: "#", mergedBranch: false,
    });
    expect(parseBrainGitFooter(footer(["Merge request: !9"]))).toMatchObject({ message: "", number: 9, sigil: "!" });
    expect(parseBrainGitFooter(footer(["Pull request: #2", "Merged branch: acme/x"]))).toMatchObject({ number: 2, mergedBranch: true });
    expect(parseBrainGitFooter(`m\n\n${footer([], "b".repeat(64))}`)).toMatchObject({ sha: "b".repeat(64), number: null, sigil: null });
    expect(parseBrainGitFooter(`kept${GIT_TRUNCATION_MARKER}\n\n${footer()}`)).toMatchObject({ message: "kept", messageTruncated: true });
    const fake = `Moved.\nCommit: ${"c".repeat(40)}\nAuthor: Someone\nnot a footer line`;
    expect(parseBrainGitFooter(`${fake}\n\n${footer(["Pull request: #5"])}`)).toMatchObject({ message: fake, sha: SHA, number: 5 });
    expect(parseBrainGitFooter("Just a message.")).toBeNull();
    expect(parseBrainGitFooter(`${footer()}\ntrailing`)).toBeNull();
    expect(parseBrainGitFooter(footer().replace("Changed paths: 1", "Changed paths: 2 (1 indexed)"))?.sha).toBe(SHA);
    expect(parseBrainGitFooter(`Commit: ${"A".repeat(40)}\nAuthor: a`)).toBeNull();
  });

  it("extracts Summary and Invariants sections verbatim", () => {
    const pr = { kind: "pr" as const, maxChars: 480 };
    const message = [
      "Intro line.", "", "# Summary of changes", "Top summary.", "### Detail", "Deeper stays inside.", "# Next", "After.",
      "## Validation and invariants:", "- inv one", "```ts", "## Summary", "```", "- inv two", "",
    ].join("\n");
    const sections = extractBrainWhySections(message, pr);
    expect(sections).toEqual({
      summary: { heading: "Summary of changes", text: "Top summary.\n### Detail\nDeeper stays inside.", truncated: false },
      invariants: { heading: "Validation and invariants:", text: "- inv one\n```ts\n## Summary\n```\n- inv two", truncated: false },
    });
    expect(message.includes(sections.invariants!.text)).toBe(true);
    const ex = (text: string, options: Parameters<typeof extractBrainWhySections>[1] = pr) => extractBrainWhySections(text, options);
    expect(ex("## Summary\nA\n## Other\nB").summary?.text).toBe("A");
    expect(ex("## Summary\n\n## Summary\n  Second.  \n").summary).toEqual({ heading: "Summary", text: "  Second.", truncated: false });
    expect(ex("~~~~\n## Summary\n~~~\nfake\n~~~~\n### TL;DR\nShort.").summary?.text).toBe("Short.");
    // A closing fence takes only spaces or tabs after its run; `~~~example` or "```ts" inside a block is code.
    expect(ex("~~~\n~~~example\n## Summary\nfake\n~~~ \t\n## Summary\nReal.").summary?.text).toBe("Real.");
    expect(ex("```\n```ts\n## Summary\nfake\n  ````\n## Summary\nReal.").summary?.text).toBe("Real.");
    expect(ex("```\r\n## Summary\r\nfake\r\n```\r\n## Summary\r\nReal.").summary?.text).toBe("Real.");
    expect(ex("##   Key invariant ##  \nOne.\n## Summary : \nS.")).toEqual({
      summary: { heading: "Summary :", text: "S.", truncated: false }, invariants: { heading: "Key invariant", text: "One.", truncated: false },
    });
    for (const text of ["#Summary\nx", "    ## Summary\nx", "####### Summary\nx", `## Summary ${"x".repeat(200)}\ny`, "## Invariantsfoo\nx"]) {
      expect(ex(text, { kind: "spec", maxChars: 480 }), text).toEqual({ summary: null, invariants: null });
    }
    expect(ex("\n\nFirst line\nsecond line\n\nNext para.\n## Notes\nx").summary).toEqual({ heading: null, text: "First line\nsecond line", truncated: false });
    expect(ex("## Notes\nx").summary).toBeNull();
    expect(ex("Co-authored-by: X <x@y>\nSigned-off-by: Y").summary).toBeNull();
    expect(ex("Note: kept\n\nCo-authored-by: X <x@y>").summary?.text).toBe("Note: kept");
    expect(ex("* feat: alpha\n\n* fix: beta", { ...pr, title: "feat: alpha" }).summary).toBeNull();
    expect(ex("# Title\n\n## Outcome\nShips X.\n\n## Other", { kind: "spec", maxChars: 480 }).summary?.text).toBe("Ships X.");
    expect(ex("# Title\n\nNo summary here.", { kind: "spec", maxChars: 480 }).summary).toBeNull();
    expect(ex("## Summary\nCut here", { ...pr, messageTruncated: true }).summary?.truncated).toBe(true);
    expect(ex("## Summary\nWhole\n## Next\nCut", { ...pr, messageTruncated: true }).summary?.truncated).toBe(false);
  });

  it("bounds excerpts on a newline, a space, or hard without splitting a surrogate pair", () => {
    const cut = (body: string) => extractBrainWhySections(`## Summary\n${body}`, { kind: "pr", maxChars: 20 }).summary;
    expect(cut(`${"a".repeat(12)}  \n${"b".repeat(16)}`)).toEqual({ heading: "Summary", text: "a".repeat(12), truncated: true });
    expect(cut(`${"a".repeat(12)} ${"b".repeat(16)}`)?.text).toBe("a".repeat(12));
    expect(cut(`aaa\n${"b".repeat(40)}`)?.text).toBe(`aaa\n${"b".repeat(16)}`);
    expect(cut(`${"a".repeat(19)}\ud83d\ude00${"b".repeat(10)}`)?.text).toBe("a".repeat(19));
    expect(cut("a".repeat(20))).toEqual({ heading: "Summary", text: "a".repeat(20), truncated: false });
  });
});
