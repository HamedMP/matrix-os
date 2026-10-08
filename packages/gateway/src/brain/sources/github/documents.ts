/**
 * GitHub source documents: stable ids, text, permalinks and refs for pull requests, issues, reviews and review
 * comments. Pure. Ids are sha256 of ["brain_github_v1", externalRef, kind, number or id], never of content.
 * Permalinks are built from the configured repository, never copied from provider URLs.
 */
import { createHash } from "node:crypto";
import {
  BRAIN_COMMIT_SHA_PATTERN, BRAIN_DOCUMENT_ID_VERSIONS, BRAIN_LABEL_REF_MAX_CHARS, BRAIN_PERSON_KEY_PATTERN,
  BRAIN_PROVENANCES, BRAIN_REFS_PER_KIND_MAX,
} from "../../contracts.js";
import { isIndexablePath } from "../../git/index.js";
import {
  BRAIN_DOCUMENT_MAX_BYTES, BRAIN_DOCUMENT_REFS_MAX, BRAIN_REF_VALUE_MAX_BYTES, BRAIN_TITLE_MAX_CHARS,
  type BrainDocumentRef, type BrainSyncUpsertInput,
} from "../../index.js";
import type { GithubIssue, GithubPull, GithubReview, GithubReviewComment } from "./schemas.js";
import { GITHUB_DOCUMENT_KINDS, GITHUB_WEB_BASE } from "./types.js";

export const GITHUB_TRUNCATION_MARKER =
  "\n\n[Truncated: the rest of this text is over the Company Brain document size limit.]";
const CLOSING_PATTERN =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})?#([1-9][0-9]{0,8})\b/gi;

export interface GithubDocumentContext { readonly externalRef: string; readonly repo: string }
/** An upsert whose complete ref set is always present. */
export type GithubUpsert = BrainSyncUpsertInput & { readonly refs: readonly BrainDocumentRef[] };
export interface GithubBuiltDocument { readonly upsert: GithubUpsert; readonly truncated: boolean }

export function githubDocumentId(externalRef: string, kind: string, key: number): string {
  return createHash("sha256")
    .update(JSON.stringify([BRAIN_DOCUMENT_ID_VERSIONS.github, externalRef, kind, key]), "utf8").digest("hex");
}

export function personKey(login: string | undefined): string | null {
  if (login === undefined) return null;
  const key = `github:${login.toLowerCase()}`;
  return BRAIN_PERSON_KEY_PATTERN.test(key) ? key : null;
}

function clean(value: string): string {
  return value.replaceAll("\u0000", "\uFFFD");
}

function cutUtf16(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const cut = value.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function title(raw: string, fallback: string): string {
  const line = cutUtf16(clean(raw).replace(/\s+/g, " ").trim(), BRAIN_TITLE_MAX_CHARS).trim();
  return line === "" ? fallback : line;
}

/** Called only for text over maxBytes. */
function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  let end = Math.max(0, maxBytes);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return encoded.subarray(0, end).toString("utf8");
}

/** Text verbatim, then the footer; the text is cut with a marker so title and body fit the store limit. */
function composeBody(text: string, footer: string, documentTitle: string): { body: string; truncated: boolean } {
  const content = clean(text).trim();
  if (content === "") return { body: footer, truncated: false };
  const budget = BRAIN_DOCUMENT_MAX_BYTES - Buffer.byteLength(documentTitle, "utf8") - Buffer.byteLength(footer, "utf8") - 2;
  if (Buffer.byteLength(content, "utf8") <= budget) return { body: `${content}\n\n${footer}`, truncated: false };
  const kept = truncateUtf8(content, budget - Buffer.byteLength(GITHUB_TRUNCATION_MARKER, "utf8"));
  return { body: `${kept}${GITHUB_TRUNCATION_MARKER}\n\n${footer}`, truncated: true };
}

function footerOf(lines: readonly (string | null)[]): string {
  return clean(lines.filter((line): line is string => line !== null).join("\n"));
}

/** Deduplicated refs within the per-kind caps (pr and path: one each) and the store's per-document cap. */
class RefSet {
  readonly refs: BrainDocumentRef[] = [];
  private readonly seen = new Set<string>();
  private readonly counts = new Map<string, number>();

  add(kind: string, value: string | null): this {
    if (value === null || value === "" || Buffer.byteLength(value, "utf8") > BRAIN_REF_VALUE_MAX_BYTES) return this;
    const cap = (BRAIN_REFS_PER_KIND_MAX as Readonly<Record<string, number>>)[kind] ?? 1;
    const key = `${kind}\u0000${value}`;
    if (this.seen.has(key) || (this.counts.get(kind) ?? 0) >= cap || this.refs.length >= BRAIN_DOCUMENT_REFS_MAX) return this;
    this.seen.add(key);
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
    this.refs.push({ kind, value });
    return this;
  }
}

function labelNames(issue: GithubIssue): string[] {
  return (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name)
    .map((name) => cutUtf16(clean(name).normalize("NFC").trim(), BRAIN_LABEL_REF_MAX_CHARS).trim())
    .filter((name) => name !== "");
}

function logins(users: readonly { login: string }[] | null | undefined): string[] {
  return (users ?? []).map((user) => user.login);
}

/** Issues a pull request description closes (close, fix, resolve and their forms), as "#N", this repository only. */
export function closingIssues(body: string, repo: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(CLOSING_PATTERN)) {
    if (match[1] !== undefined && match[1].toLowerCase() !== repo.toLowerCase()) continue;
    const ref = `#${match[2]}`;
    if (!found.includes(ref)) found.push(ref);
    if (found.length >= BRAIN_REFS_PER_KIND_MAX.issue) break;
  }
  return found;
}

function pullStatus(issue: GithubIssue, pull: GithubPull): string {
  if (pull.merged_at ?? issue.pull_request?.merged_at) return "merged";
  if (issue.state === "closed") return "closed";
  return pull.draft ?? issue.draft ? "draft" : "open";
}

interface DocumentParts {
  readonly kind: string; readonly key: number; readonly title: string; readonly fallbackTitle: string;
  readonly text: string; readonly footer: readonly (string | null)[]; readonly path: string;
  readonly sourceUpdatedAt: string; readonly provenance: string; readonly refs: RefSet;
}

function build(ctx: GithubDocumentContext, parts: DocumentParts): GithubBuiltDocument {
  const documentTitle = title(parts.title, parts.fallbackTitle);
  const composed = composeBody(parts.text, footerOf(parts.footer), documentTitle);
  return {
    upsert: {
      documentId: githubDocumentId(ctx.externalRef, parts.kind, parts.key), title: documentTitle, body: composed.body,
      permalink: `${GITHUB_WEB_BASE}/${ctx.repo}/${parts.path}`, sourceUpdatedAt: parts.sourceUpdatedAt,
      provenance: parts.provenance, refs: parts.refs.refs,
    },
    truncated: composed.truncated,
  };
}
