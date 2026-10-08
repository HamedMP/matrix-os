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

/** ATX only: up to 3 spaces, 1..6 `#`, then a space, tab or the line end; trailing spaces, tabs and `#` dropped. */
export function headingOf(line: string): { readonly level: number; readonly text: string } | null {
  const start = indentOf(line);
  if (start > MAX_HEADING_INDENT) return null;
  let level = 0;
  while (level <= MAX_HEADING_LEVEL && line[start + level] === "#") level += 1;
  if (level === 0 || level > MAX_HEADING_LEVEL) return null;
  const rest = line.slice(start + level);
  if (rest !== "" && rest[0] !== " " && rest[0] !== "\t") return null;
  let end = rest.length;
  while (end > 0 && " \t#\r".includes(rest[end - 1]!)) end -= 1;
  let from = 0;
  while (from < end && (rest[from] === " " || rest[from] === "\t")) from += 1;
  return { level, text: rest.slice(from, end) };
}

/** Headings outside fenced code; a fence closes on the same character at least as long. */
function scanHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  let open: { readonly char: string; readonly length: number } | null = null;
  lines.forEach((line, index) => {
    const fence = fenceOf(line);
    if (open !== null) {
      if (fence !== null && fence.char === open.char && fence.length >= open.length) open = null;
      return;
    }
    if (fence !== null) {
      open = fence;
      return;
    }
    const heading = headingOf(line);
    if (heading !== null) headings.push({ index, ...heading });
  });
  return headings;
}

function classifyHeading(text: string): "summary" | "invariants" | null {
  if (text.length > HEADING_CLASSIFY_MAX_CHARS) return null;
  let key = text.trim().toLowerCase();
  if (key.endsWith(":")) key = key.slice(0, -1).trimEnd();
  if (key === "summary" || key === "tl;dr" || key === "outcome" || key.startsWith("summary ")) return "summary";
  return INVARIANTS_HEADING.test(key) ? "invariants" : null;
}

/** Cut at the last newline, else space, in the back half of the window; else hard, never splitting a surrogate pair. */
function cutExcerpt(text: string, maxChars: number): string {
  const window = text.slice(0, maxChars + 1);
  let cut = window.lastIndexOf("\n");
  if (cut <= maxChars / 2) cut = window.lastIndexOf(" ");
  if (cut <= maxChars / 2) {
    cut = maxChars;
    const unit = text.charCodeAt(cut - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) cut -= 1;
  }
  return text.slice(0, cut).trimEnd();
}

function boundExcerpt(text: string, heading: string | null, maxChars: number, cutShort: boolean): BrainWhyExcerpt {
  if (text.length <= maxChars) return { heading, text, truncated: cutShort };
  return { heading, text: cutExcerpt(text, maxChars), truncated: true };
}

/** Lines [start, end) without surrounding blank lines or trailing whitespace; null when nothing is left. */
function excerptOf(
  lines: readonly string[],
  range: { readonly start: number; readonly end: number },
  heading: string | null,
  options: BrainWhySectionOptions,
): BrainWhyExcerpt | null {
  let first = range.start;
  let last = range.end;
  while (first < last && isBlank(lines[first]!)) first += 1;
  while (last > first && isBlank(lines[last - 1]!)) last -= 1;
  if (first === last) return null;
  const cutShort = range.end === lines.length && options.messageTruncated === true;
  return boundExcerpt(lines.slice(first, last).join("\n").trimEnd(), heading, options.maxChars, cutShort);
}

/**
 * The first paragraph before the first heading, for pr and commit items without a Summary section; none when it
 * is only the message's closing git trailers or only repeats the title (a one-commit squash list entry).
 */
function leadParagraph(lines: readonly string[], end: number, options: BrainWhySectionOptions): BrainWhyExcerpt | null {
  let first = 0;
  while (first < end && isBlank(lines[first]!)) first += 1;
  let last = first;
  while (last < end && !isBlank(lines[last]!)) last += 1;
  const paragraph = lines.slice(first, last);
  const trailersOnly = paragraph.every((line) => GIT_TRAILER.test(line)) && lines.slice(last).every(isBlank);
  const text = paragraph.join("\n").trim();
  if (text === "" || trailersOnly || text.replace(/^\* /, "") === options.title) return null;
  return boundExcerpt(text, null, options.maxChars, last === lines.length && options.messageTruncated === true);
}

/**
 * The first non-empty Summary and Invariants sections: the lines after the heading up to the next heading of the same
 * or a higher level outside fenced code. Text is a verbatim substring of `message`, cut to maxChars.
 */
export function extractBrainWhySections(
  message: string,
  options: BrainWhySectionOptions,
): { summary: BrainWhyExcerpt | null; invariants: BrainWhyExcerpt | null } {
  const lines = message.split("\n");
  const headings = scanHeadings(lines);
  let summary: BrainWhyExcerpt | null = null;
  let invariants: BrainWhyExcerpt | null = null;
  for (let at = 0; at < headings.length && (summary === null || invariants === null); at += 1) {
    const heading = headings[at]!;
    const kind = classifyHeading(heading.text);
    if (kind === null || (kind === "summary" ? summary : invariants) !== null) continue;
    let next = at + 1;
    while (next < headings.length && headings[next]!.level > heading.level) next += 1;
    const end = headings[next]?.index ?? lines.length;
    const excerpt = excerptOf(lines, { start: heading.index + 1, end }, heading.text, options);
    if (kind === "summary") summary = excerpt;
    else invariants = excerpt;
  }
  if (summary === null && options.kind !== "spec") {
    summary = leadParagraph(lines, headings[0]?.index ?? lines.length, options);
  }
  return { summary, invariants };
}
