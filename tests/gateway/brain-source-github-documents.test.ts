import { describe, expect, it, vi } from "vitest";
import { decodeGithubCursor, encodeGithubCursor } from "../../packages/gateway/src/brain/sources/github/cursor.js";
import {
  closingIssues, GITHUB_TRUNCATION_MARKER, githubDocumentId, issueDocument, personKey, pullRequestDocument,
  reviewCommentDocument, reviewDocument,
} from "../../packages/gateway/src/brain/sources/github/documents.js";
import {
  GithubIssueListSchema, GithubPullSchema, GithubReviewCommentListSchema, GithubReviewListSchema,
  type GithubIssue,
} from "../../packages/gateway/src/brain/sources/github/schemas.js";
import { BRAIN_DOCUMENT_MAX_BYTES } from "../../packages/gateway/src/brain/index.js";
import { githubFixture } from "./helpers/brain-source-github-fakes.js";

const ctx = { externalRef: "https://github.com/acme/widgets", repo: "acme/widgets" };
const issues = GithubIssueListSchema.parse(githubFixture("issues-page"));
const issue7 = issues[0]!;
const pr12 = issues[1]!;
const pull = GithubPullSchema.parse(githubFixture("pull-12"));
const reviews = GithubReviewListSchema.parse(githubFixture("pull-12-reviews"));
const comments = GithubReviewCommentListSchema.parse(githubFixture("pull-12-comments"));
const prId = githubDocumentId(ctx.externalRef, "pr", 12);
const refsOf = (refs: readonly { kind: string; value: string }[] | undefined, kind: string) =>
  (refs ?? []).filter((ref) => ref.kind === kind).map((ref) => ref.value);

describe("github document ids", () => {
  it("are stable sha256 ids of the identity tuple, distinct per kind", () => {
    expect(prId).toMatch(/^[a-f0-9]{64}$/);
    expect(githubDocumentId(ctx.externalRef, "pr", 12)).toBe(prId);
    expect(githubDocumentId(ctx.externalRef, "issue", 12)).not.toBe(prId);
    expect(githubDocumentId("https://github.com/acme/other", "pr", 12)).not.toBe(prId);
  });
});

describe("pull request documents", () => {
  const built = pullRequestDocument(ctx, pr12, pull, ["1111111111111111111111111111111111111111", "nothex"], ["Bob"]);

  it("keeps the description verbatim, then a footer, with a permalink built from the repository", () => {
    expect(built.truncated).toBe(false);
    expect(built.upsert).toMatchObject({
      documentId: prId, title: "fix(auth): handle Safari login click", provenance: "github_pr",
      permalink: "https://github.com/acme/widgets/pull/12", sourceUpdatedAt: "2026-03-03T12:00:00Z",
    });
    expect(built.upsert.body).toContain("Decision: we keep the click handler synchronous.\n\nPull request: #12\nState: merged");
    expect(built.upsert.body).toContain("Linked issues: #7");
    expect(built.upsert.body).toContain("Merge commit: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("writes handle, pr, status, people, labels, linked issues and commit refs (merge commit first, valid shas only)", () => {
    const refs = built.upsert.refs;
    expect(refsOf(refs, "handle")).toEqual(["#12"]);
    expect(refsOf(refs, "pr")).toEqual(["12"]);
    expect(refsOf(refs, "status")).toEqual(["merged"]);
    expect(refsOf(refs, "author")).toEqual(["github:alice"]);
    expect(refsOf(refs, "reviewer")).toEqual(["github:bob", "github:erin"]);
    expect(refsOf(refs, "label")).toEqual(["bug"]);
    expect(refsOf(refs, "issue")).toEqual(["#7"]);
    expect(refsOf(refs, "commit")).toEqual(["a".repeat(40), "1".repeat(40)]);
  });

  it("derives open, draft and closed states and falls back to a numbered title", () => {
    const open: GithubIssue = { ...pr12, state: "open", title: "  ", labels: [], pull_request: { merged_at: null } };
    const openPull = { number: 12, merge_commit_sha: "b".repeat(40) };
    const opened = pullRequestDocument(ctx, { ...open, assignees: [{ login: "Dave" }] }, openPull, [], []);
    expect(refsOf(opened.upsert.refs, "status")).toEqual(["open"]);
    expect(refsOf(opened.upsert.refs, "assignee")).toEqual(["github:dave"]);
    expect(refsOf(opened.upsert.refs, "commit")).toEqual([]);
    expect(opened.upsert.body).not.toContain("Merge commit");
    expect(refsOf(pullRequestDocument(ctx, open, { number: 12, draft: true }, [], []).upsert.refs, "status")).toEqual(["draft"]);
    const closed = pullRequestDocument(ctx, { ...open, state: "closed", body: null, user: null }, { number: 12 }, [], []);
    expect(refsOf(closed.upsert.refs, "status")).toEqual(["closed"]);
    expect(closed.upsert.title).toBe("Pull request #12");
    expect(closed.upsert.body.startsWith("Pull request: #12")).toBe(true);
    expect(refsOf(closed.upsert.refs, "author")).toEqual([]);
  });

  it("cuts an oversized description with a marker so title and body fit the store", () => {
    const big = pullRequestDocument(ctx, { ...pr12, body: `${"\u00e9".repeat(40_000)}\u0000` }, pull, [], []);
    expect(big.truncated).toBe(true);
    expect(big.upsert.body).toContain(GITHUB_TRUNCATION_MARKER);
    expect(big.upsert.body).not.toContain("\u0000");
    expect(Buffer.byteLength(big.upsert.body + big.upsert.title, "utf8")).toBeLessThanOrEqual(BRAIN_DOCUMENT_MAX_BYTES);
  });

  it("caps refs per kind", () => {
    const shas = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(40, "0"));
    const labels = Array.from({ length: 30 }, (_, i) => ({ name: `label-${i}` }));
    const many = pullRequestDocument(ctx, { ...pr12, labels }, { number: 12 }, shas, []);
    expect(refsOf(many.upsert.refs, "commit")).toHaveLength(100);
    expect(refsOf(many.upsert.refs, "label")).toHaveLength(20);
  });
});

describe("issue documents", () => {
  it("maps state, reason, people and labels", () => {
    const built = issueDocument(ctx, issue7);
    expect(built.upsert).toMatchObject({
      title: "Login button does nothing on Safari", provenance: "github_issue",
      permalink: "https://github.com/acme/widgets/issues/7",
    });
    expect(built.upsert.body).toContain("State: closed (completed)\nAuthor: Carol\nAssignees: dave\nLabels: bug, ui");
    expect(refsOf(built.upsert.refs, "issue")).toEqual(["#7"]);
    expect(refsOf(built.upsert.refs, "author")).toEqual(["github:carol"]);
    expect(refsOf(built.upsert.refs, "assignee")).toEqual(["github:dave"]);
    expect(refsOf(built.upsert.refs, "label")).toEqual(["bug", "ui"]);
  });

  it("accepts string labels and drops blank ones", () => {
    const built = issueDocument(ctx, { ...issue7, state: "open", labels: ["  ", "Needs Triage"], assignees: null });
    expect(refsOf(built.upsert.refs, "label")).toEqual(["Needs Triage"]);
    expect(built.upsert.body).not.toContain("(completed)");
    const bare = issueDocument(ctx, { ...issue7, user: null, body: null, title: "x".repeat(400) });
    expect(bare.upsert.title).toBe("x".repeat(300));
    expect(bare.upsert.body.startsWith("Issue: #7\nState: closed (completed)\nAuthor: unknown")).toBe(true);
  });
});

describe("review and review comment documents", () => {
  it("writes submitted reviews and skips pending and empty comment-only ones", () => {
    const approved = reviewDocument(ctx, 12, prId, reviews[0]!, "2026-03-03T12:00:00Z")!;
    expect(approved.upsert).toMatchObject({
      title: "Review of #12 by Bob: approved", provenance: "github_review",
      permalink: "https://github.com/acme/widgets/pull/12#pullrequestreview-501", sourceUpdatedAt: "2026-03-03T11:00:00Z",
    });
    expect(refsOf(approved.upsert.refs, "parent")).toEqual([prId]);
    expect(refsOf(approved.upsert.refs, "reviewer")).toEqual(["github:bob"]);
    expect(refsOf(approved.upsert.refs, "handle")).toEqual([]);
    expect(reviewDocument(ctx, 12, prId, reviews[1]!, "x")).toBeNull();
    expect(reviewDocument(ctx, 12, prId, reviews[2]!, "x")).toBeNull();
    const dismissed = reviewDocument(ctx, 12, prId, { id: 9, user: null, state: "DISMISSED" }, "2026-03-04T00:00:00Z")!;
    expect(dismissed.upsert.sourceUpdatedAt).toBe("2026-03-04T00:00:00Z");
    expect(dismissed.upsert.body).toContain("Reviewer: unknown");
  });

  it("writes review comments with a path ref only for safe repository paths", () => {
    const reply = reviewCommentDocument(ctx, 12, prId, comments[1]!);
    expect(reply.upsert).toMatchObject({
      title: "Comment on #12 src/auth/login.ts by alice", provenance: "github_review_comment",
      permalink: "https://github.com/acme/widgets/pull/12#discussion_r902",
    });
    expect(reply.upsert.body).toContain("Path: src/auth/login.ts\nLine: 42\nIn reply to: 901");
    expect(refsOf(reply.upsert.refs, "path")).toEqual(["src/auth/login.ts"]);
    const unsafe = reviewCommentDocument(ctx, 12, prId, { ...comments[0]!, path: "../etc/passwd", line: null, user: null });
    expect(refsOf(unsafe.upsert.refs, "path")).toEqual([]);
    expect(unsafe.upsert.title).toBe("Comment on #12 by unknown");
  });
});

describe("helpers", () => {
  it("finds closing keywords for this repository only, deduplicated and capped", () => {
    expect(closingIssues("fixes #1, Closes: #2, resolved ACME/Widgets#3, fix acme/other#4, mentions #5, fixes #1", "acme/widgets"))
      .toEqual(["#1", "#2", "#3"]);
    const many = Array.from({ length: 20 }, (_, i) => `fixes #${i + 1}`).join(" ");
    expect(closingIssues(many, "acme/widgets")).toHaveLength(16);
  });

  it("builds lowercase github person keys", () => {
    expect(personKey("Dependabot[bot]")).toBe("github:dependabot[bot]");
    expect(personKey(undefined)).toBeNull();
    expect(personKey(" bad")).toBeNull();
  });
});

describe("cursor and titles", () => {
  it("round-trips cursors and refuses anything else", () => {
    const text = encodeGithubCursor({ since: "2026-01-02T03:04:05Z", page: 2, done: [1, 2] });
    expect(text.startsWith("gh1:")).toBe(true);
    expect(decodeGithubCursor(text)).toEqual({ since: "2026-01-02T03:04:05Z", page: 2, done: [1, 2] });
    const encode = (value: unknown) => `gh1:${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
    for (const bad of [
      "gh2:x", "gh1:", "gh1:a+b", `gh1:${"a".repeat(3000)}`, `gh1:${Buffer.from("{oops").toString("base64url")}`,
      encode({ v: 1, s: "2026-01-02", p: 1, d: [] }), encode({ v: 1, s: "2026-01-02T03:04:05Z", p: 4, d: [] }),
    ]) expect(decodeGithubCursor(bad)).toBeNull();
  });

  it("rethrows anything but a syntax error while reading a cursor", () => {
    const parse = vi.spyOn(JSON, "parse").mockImplementation(() => { throw new RangeError("odd"); });
    try {
      expect(() => decodeGithubCursor(encodeGithubCursor({ since: "2026-01-02T03:04:05Z", page: 1, done: [] }))).toThrow(RangeError);
    } finally {
      parse.mockRestore();
    }
  });

  it("cuts long titles and labels without splitting a surrogate pair", () => {
    const long = `${"a".repeat(299)}\u{1F600}tail`;
    const built = issueDocument(ctx, { ...issue7, title: long, labels: [`${"b".repeat(99)}\u{1F600}`] });
    expect(built.upsert.title).toBe("a".repeat(299));
    expect(refsOf(built.upsert.refs, "label")).toEqual(["b".repeat(99)]);
  });
});
