import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { planWindowBatches } from "../../packages/gateway/src/brain/git/batches.js";
import {
  buildCommitDocument,
  clampTitle,
  commitDocumentId,
  pullRequestDocumentId,
  specPartDocumentId,
  truncateUtf8,
} from "../../packages/gateway/src/brain/git/documents.js";
import {
  blobPermalink,
  commitPermalink,
  deriveWebBase,
  parseWebBase,
  pullRequestPermalink,
  resolveGitWebBase,
} from "../../packages/gateway/src/brain/git/permalinks.js";
import { buildSpecDocuments, splitSpecText } from "../../packages/gateway/src/brain/git/specs.js";
import {
  GIT_MAX_SPEC_PARTS,
  GIT_SPEC_PART_MAX_BYTES,
  GIT_TRUNCATION_MARKER,
  type GitChangedPath,
  type GitCommitRecord,
  type GitUpsertDraft,
} from "../../packages/gateway/src/brain/git/types.js";
import { BRAIN_DOCUMENT_MAX_BYTES } from "../../packages/gateway/src/brain/index.js";
import { GITHUB, GITHUB_CTX, GITLAB, expectGitCode } from "./helpers/brain-git-pure.js";

const IDENTITY = GITHUB.href;
const SHA = "1f0c".padEnd(40, "a");
const PARENT = "0".repeat(40);
const ctx = GITHUB_CTX;
const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

function commit(overrides: Partial<GitCommitRecord> & { paths?: readonly string[] } = {}): GitCommitRecord {
  const { paths = [], ...rest } = overrides;
  const changed: GitChangedPath[] = paths.map((path) => ({ status: "M", path }));
  return {
    sha: SHA, parents: [PARENT], committedAt: "2026-09-01T00:01:00+00:00", authoredAt: "2026-09-01T00:01:00+00:00",
    authorName: "Fixture Author", subject: "chore: tidy", body: "", messageTruncated: false,
    changes: {
      paths: changed, totalPaths: changed.length, invalidPaths: 0, truncated: false,
      specPaths: paths.filter((path) => ctx.matcher.matches(path)),
    },
    ...rest,
  };
}

describe("deriveWebBase", () => {
  it.each([
    ["https://github.com/acme/widgets", "https://github.com/acme/widgets"],
    ["https://github.com/acme/widgets.git", "https://github.com/acme/widgets"],
    ["https://github.com/acme/widgets/", "https://github.com/acme/widgets"],
    ["git@github.com:acme/widgets.git", "https://github.com/acme/widgets"],
    ["github.com:acme/widgets", "https://github.com/acme/widgets"],
    ["ssh://git@github.com:22/acme/widgets.git", "https://github.com/acme/widgets"],
    ["https://user:token@github.com/acme/widgets", "https://github.com/acme/widgets"],
    ["http://github.com/acme/widgets", "https://github.com/acme/widgets"],
    ["git://github.com/acme/widgets.git", "https://github.com/acme/widgets"],
    ["  https://GitHub.COM/Acme/Widgets.git \n", "https://github.com/Acme/Widgets"],
    ["git@GITHUB.com:acme/widgets.git", "https://github.com/acme/widgets"],
  ])("maps %s to its https base", (remote, href) => {
    expect(deriveWebBase(remote)).toEqual({ href, flavor: "github" });
    expect(JSON.stringify(deriveWebBase(remote))).not.toContain("token");
  });

  it("maps gitlab.com remotes with nested groups", () => {
    expect(deriveWebBase("git@gitlab.com:acme/platform/widgets.git"))
      .toEqual({ href: "https://gitlab.com/acme/platform/widgets", flavor: "gitlab" });
    expect(deriveWebBase("https://gitlab.com/g/sub/r.git")).toEqual({ href: "https://gitlab.com/g/sub/r", flavor: "gitlab" });
  });

  it.each([
    "/abs/path/repo", "../relative/repo", "file:///srv/repo.git", "https://ghe.example.com/acme/widgets",
    "https://github.com/acme/wid%20gets", "https://github.com/acme/widgets/tree", "https://github.com/acme",
    "https://github.com/acme/widgets?x=1", "https://github.com/acme/widgets#readme", "git@github.com:/acme/widgets",
    "https://github.com/acme/.hidden", "https://github.com/acme/wid gets", "", "x".repeat(3000),
    "ftp://github.com/acme/widgets",
  ])("rejects %s", (remote) => {
    expect(deriveWebBase(remote)).toBeNull();
  });
});

describe("parseWebBase and resolveGitWebBase", () => {
  it("accepts canonical https bases only", () => {
    expect(parseWebBase(IDENTITY)).toEqual(GITHUB);
    expect(parseWebBase("https://ghe.example.com:8443/acme/widgets"))
      .toEqual({ href: "https://ghe.example.com:8443/acme/widgets", flavor: "github" });
    expect(parseWebBase("https://gitlab.example.com/acme/widgets")?.flavor).toBe("gitlab");
    expect(parseWebBase(GITLAB.href)).toEqual(GITLAB);
    for (const bad of [
      `${IDENTITY}/`, `${IDENTITY}?q=1`, `${IDENTITY}?`, `${IDENTITY}#x`, "https://GitHub.com/acme/widgets",
      "http://github.com/acme/widgets", "https://u:p@github.com/acme/widgets", "https://github.com", "project:proj_abc123",
      "https://github.com/acme/wid%20gets",
    ]) expect(parseWebBase(bad)).toBeNull();
  });

  it("prefers the explicit base and detects a mismatching remote", () => {
    expect(resolveGitWebBase({ externalRef: IDENTITY, remoteUrl: "git@github.com:acme/widgets.git" }))
      .toEqual({ ok: true, webBase: GITHUB });
    expect(resolveGitWebBase({ externalRef: IDENTITY, remoteUrl: "git@github.com:other/repo.git" }))
      .toEqual({ ok: false, code: "remote_mismatch" });
    expect(resolveGitWebBase({ externalRef: IDENTITY, remoteUrl: "/srv/mirror.git" })).toEqual({ ok: true, webBase: GITHUB });
    expect(resolveGitWebBase({ externalRef: "project:widgets", remoteUrl: "git@gitlab.com:acme/platform/widgets.git" }))
      .toEqual({ ok: true, webBase: GITLAB });
    expect(resolveGitWebBase({ externalRef: "project:widgets", remoteUrl: null }))
      .toEqual({ ok: false, code: "web_base_unavailable" });
  });
});

describe("permalinks", () => {
  it("builds exact github and gitlab links", () => {
    expect(pullRequestPermalink(GITHUB, 12)).toBe(`${IDENTITY}/pull/12`);
    expect(commitPermalink(GITHUB, SHA)).toBe(`${IDENTITY}/commit/${SHA}`);
    expect(blobPermalink(GITHUB, SHA, "specs/001-a/spec.md")).toBe(`${IDENTITY}/blob/${SHA}/specs/001-a/spec.md`);
    expect(pullRequestPermalink(GITLAB, 7)).toBe(`${GITLAB.href}/-/merge_requests/7`);
    expect(commitPermalink(GITLAB, SHA)).toBe(`${GITLAB.href}/-/commit/${SHA}`);
    expect(blobPermalink(GITLAB, SHA, "a/b.md")).toBe(`${GITLAB.href}/-/blob/${SHA}/a/b.md`);
  });

  it("encodes special paths canonically and falls back to the commit page when too long", () => {
    const link = blobPermalink(GITHUB, SHA, "docs/caf\u00e9/na\u00efve file #1?%(x)[y]@+.md");
    expect(link).toBe(`${IDENTITY}/blob/${SHA}/docs/caf%C3%A9/na%C3%AFve%20file%20%231%3F%25(x)%5By%5D%40%2B.md`);
    expect(new URL(link).href).toBe(link);
    expect(blobPermalink(GITHUB, SHA, `${"d/".repeat(1_100)}x.md`)).toBe(`${IDENTITY}/commit/${SHA}`);
  });
});

describe("document ids", () => {
  const recipe = (...tail: unknown[]): string =>
    createHash("sha256").update(JSON.stringify(["brain_git_v1", IDENTITY, ...tail])).digest("hex");

  it("hashes the fixed identity tuple", () => {
    expect(pullRequestDocumentId(IDENTITY, 1)).toBe(recipe("pr", 1));
    expect(commitDocumentId(IDENTITY, SHA)).toBe(recipe("commit", SHA));
    expect(specPartDocumentId(IDENTITY, "specs/a/spec.md", 2)).toBe(recipe("file", "specs/a/spec.md", 2));
    expect(pullRequestDocumentId(IDENTITY, 1)).toBe(pullRequestDocumentId(IDENTITY, 1));
    expect(pullRequestDocumentId("project:x", 1)).not.toBe(pullRequestDocumentId(IDENTITY, 1));
  });
});

describe("buildCommitDocument", () => {
  const squashBody = "## Summary\n- Adds alpha.\n\n## Invariants\n- Alpha stays bounded.";

  it("maps a squash commit to its pull request document", () => {
    const built = buildCommitDocument(commit({
      subject: "feat(brain): alpha (#1)", body: squashBody, paths: ["src/alpha.ts", "specs/001-alpha/spec.md"],
    }), ctx);
    expect(built.notices).toEqual([]);
    expect(built.draft).toEqual({
      documentId: pullRequestDocumentId(IDENTITY, 1),
      title: "feat(brain): alpha",
      body: `${squashBody}\n\nCommit: ${SHA}\nAuthor: Fixture Author\nCommitted: 2026-09-01T00:01:00+00:00\n`
        + "Pull request: #1\nChanged paths: 2",
      permalink: `${IDENTITY}/pull/1`,
      sourceUpdatedAt: "2026-09-01T00:01:00+00:00",
      provenance: "git_pr",
      refs: [
        { kind: "pr", value: "1" }, { kind: "spec", value: "specs/001-alpha" },
        { kind: "path", value: "src/alpha.ts" }, { kind: "path", value: "specs/001-alpha/spec.md" },
      ],
    });
  });

  it("titles a merge commit from its body and names the merged branch", () => {
    const built = buildCommitDocument(commit({
      parents: [PARENT, "b".repeat(40)], subject: "Merge pull request #2 from acme/feature-x",
      body: "Add feature X\n\nDetails here.", paths: ["x.ts"],
    }), ctx);
    expect(built.draft.title).toBe("Add feature X");
    expect(built.draft.body).toBe(`Details here.\n\nCommit: ${SHA}\nAuthor: Fixture Author\n`
      + "Committed: 2026-09-01T00:01:00+00:00\nPull request: #2\nMerged branch: acme/feature-x\nChanged paths: 1");
    expect(built.draft.documentId).toBe(pullRequestDocumentId(IDENTITY, 2));
  });

  it("maps a plain commit, an empty body and an unknown author", () => {
    const built = buildCommitDocument(commit({ subject: "", authorName: "" }), ctx);
    expect(built.draft.title).toBe(`Commit ${SHA.slice(0, 12)}`);
    expect(built.draft.body).toBe(`Commit: ${SHA}\nAuthor: unknown\nCommitted: 2026-09-01T00:01:00+00:00\nChanged paths: 0`);
    expect(built.draft.permalink).toBe(`${IDENTITY}/commit/${SHA}`);
    expect(built.draft.provenance).toBe("git_commit");
    expect(buildCommitDocument(commit({ subject: "(#4)" }), ctx).draft.title).toBe("Pull request #4");
  });

  it.each(["\u2014", "\ud83d\ude00"])("truncates a 70 KB body on a code point boundary (%s)", (glyph) => {
    const body = `${"a".repeat(65_000)}${glyph.repeat(3_000)}`;
    const built = buildCommitDocument(commit({ subject: "big (#9)", body }), ctx);
    expect(built.notices).toEqual(["message_truncated"]);
    expect(byteLength(built.draft.title) + byteLength(built.draft.body)).toBeLessThanOrEqual(BRAIN_DOCUMENT_MAX_BYTES);
    expect(built.draft.body).toContain(`${GIT_TRUNCATION_MARKER}\n\nCommit: ${SHA}`);
    expect(built.draft.body).not.toContain("\ufffd");
    expect(built.draft.body.endsWith("Changed paths: 0")).toBe(true);
  });

  it("marks a message the reader already truncated", () => {
    const built = buildCommitDocument(commit({ subject: "x", body: "short", messageTruncated: true }), ctx);
    expect(built.draft.body.startsWith(`short${GIT_TRUNCATION_MARKER}\n\n`)).toBe(true);
    expect(built.notices).toEqual(["message_truncated"]);
  });

  it("clamps a long title without splitting a surrogate pair and replaces NUL", () => {
    const title = `${"t".repeat(299)}\ud83d\ude00 rest`;
    const built = buildCommitDocument(commit({ subject: title, body: "a\u0000b" }), ctx);
    expect(built.draft.title).toBe("t".repeat(299));
    expect(built.draft.body.startsWith("a\ufffdb\n\n")).toBe(true);
    expect(clampTitle("  a \n\t b  ", "fallback")).toBe("a b");
    expect(clampTitle(" \n ", "fallback")).toBe("fallback");
  });

  it("orders and caps refs and reports the indexed path count", () => {
    const subject = `x #10 #11 #12 #13 #14 #15 #16 #17 #18 (#1)`;
    const specs = Array.from({ length: 20 }, (_, i) => `specs/${String(i).padStart(3, "0")}-s/spec.md`);
    const others = Array.from({ length: 230 }, (_, i) => `src/f${i}.ts`);
    const built = buildCommitDocument(commit({ subject, paths: [...specs, ...others] }), ctx);
    const kinds = built.draft.refs.map((ref) => ref.kind);
    expect(built.draft.refs.length).toBe(200);
    expect(kinds.filter((kind) => kind === "pr")).toHaveLength(8);
    expect(built.draft.refs.slice(0, 8).map((ref) => ref.value)).toEqual(["1", "10", "11", "12", "13", "14", "15", "16"]);
    expect(kinds.filter((kind) => kind === "spec")).toHaveLength(16);
    expect(kinds.filter((kind) => kind === "path")).toHaveLength(176);
    expect(built.draft.body).toContain("Changed paths: 250 (176 indexed)");
    expect(built.notices).toContain("paths_truncated");
  });

  it("reports dropped invalid paths", () => {
    const base = commit({ paths: ["a.ts"] });
    const built = buildCommitDocument({ ...base, changes: { ...base.changes, totalPaths: 2, invalidPaths: 1 } }, ctx);
    expect(built.notices).toEqual(["invalid_paths_dropped"]);
    expect(built.draft.body).toContain("Changed paths: 2 (1 indexed)");
  });
});

describe("text helpers", () => {
  it("truncateUtf8 cuts on code point boundaries", () => {
    expect(truncateUtf8("ab\ud83d\ude00", 5)).toEqual({ value: "ab", truncated: true });
    expect(truncateUtf8("ab\ud83d\ude00", 6)).toEqual({ value: "ab\ud83d\ude00", truncated: false });
  });
});

describe("splitSpecText", () => {
  it("keeps the text, honours the byte limit and prefers heading cuts", () => {
    const section = (n: number): string => `## Section ${n}\n${"line of text\n".repeat(300)}`;
    const text = `# Title\n\n${[1, 2, 3, 4].map(section).join("")}`;
    const parts = splitSpecText(text, 8_000);
    expect(parts.join("")).toBe(text);
    for (const part of parts) expect(byteLength(part)).toBeLessThanOrEqual(8_000);
    expect(parts.slice(1).every((part) => part.startsWith("## Section"))).toBe(true);
  });

  it("falls back to newline cuts, then code point cuts", () => {
    const lines = "x".repeat(30).concat("\n").repeat(10);
    expect(splitSpecText(lines, 100).every((part) => part.endsWith("\n"))).toBe(true);
    const emoji = "\ud83d\ude00".repeat(10);
    const parts = splitSpecText(emoji, 10);
    expect(parts).toEqual(["\ud83d\ude00\ud83d\ude00", "\ud83d\ude00\ud83d\ude00", "\ud83d\ude00\ud83d\ude00", "\ud83d\ude00\ud83d\ude00", "\ud83d\ude00\ud83d\ude00"]);
  });

  it("hard-splits when the soft split needs too many parts", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(39)}`.repeat(GIT_MAX_SPEC_PARTS);
    const parts = splitSpecText(text, 100);
    expect(parts.join("")).toBe(text);
    expect(parts).toHaveLength(GIT_MAX_SPEC_PARTS);
    expect(parts.every((part) => byteLength(part) === 100)).toBe(true);
    expectGitCode(() => splitSpecText("abc", 3), "internal_error");
  });
});

describe("buildSpecDocuments", () => {
  const path = "specs/544-store/spec.md";
  const file = (content: string | Uint8Array | null, size?: number) => {
    const encoded = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const blob = encoded === null && size === undefined
      ? null
      : { oid: "c".repeat(40), size: size ?? encoded!.length, content: encoded };
    return { path, touchSha: SHA, touchCommittedAt: "2026-09-01T00:02:00+00:00", blob };
  };
  const ids = (from: number, to: number): string[] =>
    Array.from({ length: to - from + 1 }, (_, i) => specPartDocumentId(IDENTITY, path, from + i));

  it("splits a 130 KB spec into titled parts with spec refs", () => {
    const section = (n: number): string => `## Part ${n}\n${"spec words go here\n".repeat(1_150)}`;
    const text = `# Company Brain Store\n\n${[1, 2, 3, 4, 5, 6].map(section).join("")}`;
    const docs = buildSpecDocuments(file(text), ctx);
    expect(docs.upserts).toHaveLength(3);
    expect(docs.upserts.map((d) => d.title)).toEqual([1, 2, 3].map((i) => `Company Brain Store (part ${i} of 3)`));
    expect(docs.upserts.map((d) => d.body).join("")).toBe(text);
    expect(docs.upserts.map((d) => d.documentId)).toEqual(ids(1, 3));
    expect(docs.deletions).toEqual(ids(4, GIT_MAX_SPEC_PARTS));
    expect(docs.upserts[0]!.refs).toEqual([{ kind: "path", value: path }, { kind: "spec", value: "specs/544-store" }]);
    expect(docs.upserts[0]!.permalink).toBe(`${IDENTITY}/blob/${SHA}/${path}`);
    expect(docs.upserts[0]!.provenance).toBe("git_spec");
    for (const doc of docs.upserts) expect(byteLength(doc.body)).toBeLessThanOrEqual(GIT_SPEC_PART_MAX_BYTES);
  });

  it("shrinks to one part and tombstones the rest", () => {
    const docs = buildSpecDocuments(file("# Small\nBody\n"), ctx);
    expect(docs.upserts.map((d) => [d.title, d.body])).toEqual([["Small", "# Small\nBody\n"]]);
    expect(docs.deletions).toEqual(ids(2, GIT_MAX_SPEC_PARTS));
  });

  it("falls back to the path title and handles empty files", () => {
    expect(buildSpecDocuments(file("no heading\n## Sub\n"), ctx).upserts[0]!.title).toBe(path);
    expect(buildSpecDocuments(file("intro\n#   Late Title ##  \n"), ctx).upserts[0]!.title).toBe("Late Title");
    expect(buildSpecDocuments(file(""), ctx).upserts[0]!.body).toBe("(empty file)");
  });

  it("tombstones every part of a removed file", () => {
    expect(buildSpecDocuments(file(null), ctx)).toEqual({ upserts: [], deletions: ids(1, GIT_MAX_SPEC_PARTS), notices: [] });
  });

  it("stubs oversize and non-UTF-8 files", () => {
    const oversize = buildSpecDocuments(file(null, 450_000), ctx);
    expect(oversize.notices).toEqual(["spec_file_oversize"]);
    expect(oversize.upserts[0]!.body)
      .toBe("This file is 450000 bytes, over the 400000 byte indexing limit. Open the permalink to read it.");
    expect(oversize.deletions).toEqual(ids(2, GIT_MAX_SPEC_PARTS));
    const binary = buildSpecDocuments(file(new Uint8Array([0x23, 0x20, 0xff, 0xfe])), ctx);
    expect(binary.notices).toEqual(["spec_file_not_text"]);
    expect(binary.upserts[0]!.body).toBe("This file is not UTF-8 text and was not indexed.");
  });
});

describe("planWindowBatches", () => {
  const draft = (n: number, refs = 1): GitUpsertDraft => ({
    documentId: n.toString(16).padStart(64, "0"), title: `t${n}`, body: "b", permalink: "", provenance: "git_commit",
    sourceUpdatedAt: "2026-09-01T00:00:00+00:00",
    refs: Array.from({ length: refs }, (_, i) => ({ kind: "path" as const, value: `p${i}` })),
  });
  const del = (n: number): string => (n + 100_000).toString(16).padStart(64, "0");
  const limits = { upsertsPerBatch: 100, refsPerBatch: 5_000 };

  it("packs by upsert count and ref count", () => {
    const byCount = planWindowBatches(Array.from({ length: 5 }, (_, i) => draft(i)), [], { ...limits, upsertsPerBatch: 2 });
    expect(byCount.map((b) => b.upserts.length)).toEqual([2, 2, 1]);
    expect(byCount.map((b) => b.final)).toEqual([false, false, true]);
    const byRefs = planWindowBatches([draft(1, 60), draft(2, 50), draft(3, 200), draft(4, 10)], [], { ...limits, refsPerBatch: 100 });
    expect(byRefs.map((b) => b.upserts.map((u) => u.title))).toEqual([["t1"], ["t2"], ["t3"], ["t4"]]);
  });

  it("fills the last batch with deletions and spills the rest", () => {
    const plans = planWindowBatches([draft(1)], Array.from({ length: 450 }, (_, i) => del(i)), limits);
    expect(plans.map((p) => [p.upserts.length, p.deletions.length, p.final])).toEqual([[1, 200, false], [0, 200, false], [0, 50, true]]);
    expect(planWindowBatches([], [], limits)).toEqual([{ upserts: [], deletions: [], final: true }]);
  });

  it("rejects duplicate or overlapping ids", () => {
    expectGitCode(() => planWindowBatches([draft(1), draft(1)], [], limits), "document_invalid");
    expectGitCode(() => planWindowBatches([draft(1)], [draft(1).documentId], limits), "document_invalid");
  });
});
