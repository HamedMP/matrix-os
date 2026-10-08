/**
 * Git source adapter: stable document ids, text helpers, and the mapping from
 * one first-parent commit to one pull request or commit document plus its
 * refs. Pure functions; specs.ts maps spec files.
 */
import { createHash } from "node:crypto";
import { BRAIN_DOCUMENT_MAX_BYTES, BRAIN_TITLE_MAX_CHARS } from "../index.js";
import { classifyCommit } from "./parse.js";
import { commitPermalink, pullRequestPermalink } from "./permalinks.js";
import {
  GIT_DOCUMENT_ID_VERSION,
  GIT_MAX_PR_REFS_PER_DOCUMENT,
  GIT_MAX_REFS_PER_DOCUMENT,
  GIT_MAX_SPEC_REFS_PER_DOCUMENT,
  GIT_PROVENANCE,
  GIT_SHORT_SHA_LENGTH,
  GIT_TRUNCATION_MARKER,
  type GitCommitClassification,
  type GitCommitDocument,
  type GitCommitRecord,
  type GitDocumentContext,
  type GitDocumentRef,
  type GitRefKind,
  type GitSpecMatcher,
  type GitSyncNotice,
} from "./types.js";

// Stable ids: sha256 of a fixed tuple, never of content.

function gitDocumentId(identity: string, tail: readonly (string | number)[]): string {
  return createHash("sha256")
    .update(JSON.stringify([GIT_DOCUMENT_ID_VERSION, identity, ...tail]), "utf8")
    .digest("hex");
}

export function pullRequestDocumentId(identity: string, number: number): string {
  return gitDocumentId(identity, ["pr", number]);
}

export function commitDocumentId(identity: string, sha: string): string {
  return gitDocumentId(identity, ["commit", sha]);
}

export function specPartDocumentId(identity: string, path: string, part: number): string {
  return gitDocumentId(identity, ["file", path, part]);
}

// Text helpers.

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Postgres refuses U+0000 in TEXT; replace it with U+FFFD. */
export function sanitizeText(value: string): string {
  return value.replaceAll("\u0000", "\ufffd");
}

/** Cuts to at most maxBytes of UTF-8 on a code point boundary. */
export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };
  let end = Math.max(0, Math.floor(maxBytes));
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

function clampOnce(raw: string, maxChars: number): string {
  let title = sanitizeText(raw).replace(/\s+/g, " ").trim();
  if (title.length > maxChars) {
    title = title.slice(0, maxChars);
    const last = title.charCodeAt(title.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) title = title.slice(0, -1);
    title = title.trim();
  }
  return title;
}

/** One line of at most maxChars UTF-16 units, never splitting a surrogate pair; `fallback` when empty. */
export function clampTitle(raw: string, fallback: string, maxChars: number = BRAIN_TITLE_MAX_CHARS): string {
  const title = clampOnce(raw, maxChars);
  return title !== "" ? title : clampOnce(fallback, maxChars);
}

// Commit and pull request documents.

type PullRequestClassification = Extract<GitCommitClassification, { kind: "pull_request" }>;

class RefCollector {
  readonly refs: GitDocumentRef[] = [];
  private readonly seen = new Set<string>();
  private readonly perKind: Record<GitRefKind, number> = { path: 0, pr: 0, spec: 0 };

  count(kind: GitRefKind): number {
    return this.perKind[kind];
  }

  add(kind: GitRefKind, value: string): void {
    const key = JSON.stringify([kind, value]);
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.refs.push({ kind, value });
    this.perKind[kind] += 1;
  }
}

/** Own PR number, subject mentions, spec directories, then changed paths up to the per-document cap. */
function buildCommitRefs(
  commit: GitCommitRecord,
  classification: GitCommitClassification,
  matcher: GitSpecMatcher,
): { refs: readonly GitDocumentRef[]; indexedPathRefs: number } {
  const collector = new RefCollector();
  if (classification.kind === "pull_request") collector.add("pr", String(classification.number));
  for (const mention of classification.mentions) {
    if (collector.count("pr") >= GIT_MAX_PR_REFS_PER_DOCUMENT) break;
    collector.add("pr", String(mention));
  }
  const specCandidates = [...commit.changes.specPaths, ...commit.changes.paths.map((change) => change.path)];
  for (const path of specCandidates) {
    if (collector.count("spec") >= GIT_MAX_SPEC_REFS_PER_DOCUMENT) break;
    const dir = matcher.specDirOf(path);
    if (dir !== null) collector.add("spec", dir);
  }
  for (const change of commit.changes.paths) {
    if (collector.refs.length >= GIT_MAX_REFS_PER_DOCUMENT) break;
    collector.add("path", change.path);
  }
  return { refs: collector.refs, indexedPathRefs: collector.count("path") };
}

function fallbackTitle(commit: GitCommitRecord, classification: GitCommitClassification): string {
  if (classification.kind === "commit") return `Commit ${commit.sha.slice(0, GIT_SHORT_SHA_LENGTH)}`;
  return classification.form === "gitlab_merge"
    ? `Merge request !${classification.number}`
    : `Pull request #${classification.number}`;
}

function pullRequestFooterLines(classification: PullRequestClassification): string[] {
  const lines = classification.form === "gitlab_merge"
    ? [`Merge request: !${classification.number}`]
    : [`Pull request: #${classification.number}`];
  if (classification.form === "merge_branch" && classification.branch !== null) {
    lines.push(`Merged branch: ${classification.branch}`);
  }
  return lines;
}

function commitFooter(commit: GitCommitRecord, classification: GitCommitClassification, indexedPathRefs: number): string {
  const total = commit.changes.totalPaths;
  const lines = [
    `Commit: ${commit.sha}`,
    `Author: ${commit.authorName === "" ? "unknown" : commit.authorName}`,
    `Committed: ${commit.committedAt}`,
    ...(classification.kind === "pull_request" ? pullRequestFooterLines(classification) : []),
    indexedPathRefs === total ? `Changed paths: ${total}` : `Changed paths: ${total} (${indexedPathRefs} indexed)`,
  ];
  return sanitizeText(lines.join("\n"));
}

/** Message verbatim, then the footer; the message is cut with a marker to fit the store byte limit. */
function composeBody(
  message: string,
  messageTruncated: boolean,
  title: string,
  footer: string,
): { body: string; truncated: boolean } {
  if (message === "") return { body: footer, truncated: false };
  const budget = BRAIN_DOCUMENT_MAX_BYTES - utf8ByteLength(title) - utf8ByteLength(footer) - 2;
  if (utf8ByteLength(message) <= budget && !messageTruncated) {
    return { body: `${message}\n\n${footer}`, truncated: false };
  }
  const kept = truncateUtf8(message, Math.max(0, budget - utf8ByteLength(GIT_TRUNCATION_MARKER))).value;
  return { body: `${kept}${GIT_TRUNCATION_MARKER}\n\n${footer}`, truncated: true };
}

/** One first-parent commit as a pull request document (squash or merge of #N / !N) or a commit document. */
export function buildCommitDocument(commit: GitCommitRecord, ctx: GitDocumentContext): GitCommitDocument {
  const classification = classifyCommit(
    { subject: commit.subject, body: commit.body, parents: commit.parents },
    ctx.webBase.flavor,
  );
  const isPullRequest = classification.kind === "pull_request";
  const title = clampTitle(classification.title, fallbackTitle(commit, classification));
  const { refs, indexedPathRefs } = buildCommitRefs(commit, classification, ctx.matcher);
  const footer = commitFooter(commit, classification, indexedPathRefs);
  const composed = composeBody(sanitizeText(classification.body), commit.messageTruncated, title, footer);
  const notices: GitSyncNotice[] = [];
  if (commit.changes.truncated || indexedPathRefs < commit.changes.paths.length) notices.push("paths_truncated");
  if (commit.changes.invalidPaths > 0) notices.push("invalid_paths_dropped");
  if (composed.truncated) notices.push("message_truncated");
  return {
    draft: {
      documentId: classification.kind === "pull_request"
        ? pullRequestDocumentId(ctx.identity, classification.number)
        : commitDocumentId(ctx.identity, commit.sha),
      title,
      body: composed.body,
      permalink: classification.kind === "pull_request"
        ? pullRequestPermalink(ctx.webBase, classification.number)
        : commitPermalink(ctx.webBase, commit.sha),
      sourceUpdatedAt: commit.committedAt,
      provenance: isPullRequest ? GIT_PROVENANCE.pullRequest : GIT_PROVENANCE.commit,
      refs,
    },
    notices,
  };
}
