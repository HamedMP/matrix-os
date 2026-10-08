/**
 * brain_why: the pull request, commit and spec documents whose path refs equal a repository path or sit under it,
 * newest first, with each body's Summary and Invariants sections lifted out verbatim and bounded. Never syncs.
 */
import {
  BRAIN_WHY_DEFAULT_LIMIT, BRAIN_WHY_EXCERPT_MAX_CHARS, BRAIN_WHY_MATCHED_PATHS_MAX, BRAIN_WHY_SPECS_MAX,
  type BrainWhyDetail, type BrainWhyExcerpt, type BrainWhyItem, type BrainWhyKind,
  type BrainWhyLink, type BrainWhyMatch, type BrainWhyPage, type BrainWhyQuery,
} from "./api/types.js";
import { brainCiteLabel } from "./cite.js";
import { GIT_PROVENANCE, GIT_TRUNCATION_MARKER, isIndexablePath } from "./git/index.js";
import { BrainStoreError, type BrainDocument, type BrainRefMatch, type BrainScopeKey } from "./index.js";
import type { BrainRepository } from "./repository.js";

/** The footer the git adapter appends to pull request and commit bodies (spec 552). */
export interface BrainGitFooter {
  /** The commit message before the footer, without the adapter's truncation marker. */
  readonly message: string;
  /** The adapter cut the message to fit the store's document size limit. */
  readonly messageTruncated: boolean;
  readonly sha: string;
  readonly number: number | null;
  readonly sigil: "#" | "!" | null;
  /** A `Merge pull request #N from <branch>` commit. */
  readonly mergedBranch: boolean;
}

export interface BrainWhySectionOptions {
  readonly kind: BrainWhyKind;
  /** UTF-16 units per excerpt. */
  readonly maxChars: number;
  /** A section that reaches the end of a cut message is marked truncated. */
  readonly messageTruncated?: boolean;
  /** The document title: a lead paragraph that only repeats it is no summary. */
  readonly title?: string;
}

const WHY_PROVENANCES = [GIT_PROVENANCE.pullRequest, GIT_PROVENANCE.commit, GIT_PROVENANCE.spec];
const FOOTER_COMMIT = /^Commit: (?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FOOTER_PULL_REQUEST = /^Pull request: #(\d{1,9})$/;
const FOOTER_MERGE_REQUEST = /^Merge request: !(\d{1,9})$/;
const FOOTER_MERGED_BRANCH = "Merged branch: ";
const FOOTER_OTHER_LINES = [/^Author: /, /^Committed: /, /^Changed paths: \d{1,10}(?: \(\d{1,10} indexed\))?$/];
const HEADING_CLASSIFY_MAX_CHARS = 200;
const INVARIANTS_HEADING = /\binvariants?\b/;
/** A git trailer line such as `Co-authored-by: A <a@b>` or `Signed-off-by: B`. */
const GIT_TRAILER = /^[A-Za-z][A-Za-z0-9-]*: \S/;
const MAX_HEADING_INDENT = 3;
const MAX_HEADING_LEVEL = 6;
const MIN_FENCE_LENGTH = 3;

// Paths.

/** A trailing "/" means the folder only; the rest must be an indexable repo path (the repo root is not). */
export function normalizeBrainWhyPath(raw: string): { readonly path: string; readonly match: BrainWhyMatch } | null {
  const folder = raw.endsWith("/");
  const path = folder ? raw.slice(0, -1) : raw;
  return isIndexablePath(path) ? { path, match: folder ? "folder" : "file_or_folder" } : null;
}

// Footer.

function messageBefore(lines: readonly string[], end: number): { message: string; messageTruncated: boolean } {
  let stop = end;
  while (stop > 0 && isBlank(lines[stop - 1]!)) stop -= 1;
  const message = lines.slice(0, stop).join("\n");
  return message.endsWith(GIT_TRUNCATION_MARKER)
    ? { message: message.slice(0, -GIT_TRUNCATION_MARKER.length), messageTruncated: true }
    : { message, messageTruncated: false };
}

/** The footer starts at the last `Commit: <sha>` line followed only by footer lines; null when there is none. */
export function parseBrainGitFooter(body: string): BrainGitFooter | null {
  const lines = body.split("\n");
  let number: number | null = null;
  let sigil: "#" | "!" | null = null;
  let mergedBranch = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (FOOTER_COMMIT.test(line)) {
      return { ...messageBefore(lines, index), sha: line.slice("Commit: ".length), number, sigil, mergedBranch };
    }
    const pullRequest = FOOTER_PULL_REQUEST.exec(line);
    const mergeRequest = pullRequest === null ? FOOTER_MERGE_REQUEST.exec(line) : null;
    if (pullRequest !== null || mergeRequest !== null) {
      number = Number((pullRequest ?? mergeRequest)![1]);
      sigil = pullRequest !== null ? "#" : "!";
    } else if (line.startsWith(FOOTER_MERGED_BRANCH)) {
      mergedBranch = true;
    } else if (!FOOTER_OTHER_LINES.some((pattern) => pattern.test(line))) {
      return null;
    }
  }
  return null;
}

// Markdown sections.

interface Heading {
  readonly index: number;
  readonly level: number;
  readonly text: string;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function indentOf(line: string): number {
  let spaces = 0;
  while (spaces <= MAX_HEADING_INDENT && line[spaces] === " ") spaces += 1;
  return spaces;
}

/** Up to 3 spaces, then 3 or more backticks or tildes. */
export function fenceOf(line: string): { readonly char: string; readonly length: number } | null {
  const start = indentOf(line);
  const char = line[start];
  if (start > MAX_HEADING_INDENT || (char !== "`" && char !== "~")) return null;
  let end = start;
  while (line[end] === char) end += 1;
  return end - start >= MIN_FENCE_LENGTH ? { char, length: end - start } : null;
}
