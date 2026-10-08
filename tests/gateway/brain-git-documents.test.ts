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
