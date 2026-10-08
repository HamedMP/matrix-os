/**
 * Company Brain git adapter: pure parsers for every git output reader.ts
 * consumes (version, rev-parse, rev-list, the -z metadata and name-status
 * logs, ls-tree), git %s/%b message splitting, pull request classification,
 * the spec glob compiler and the path / branch / glob validators. No I/O.
 * Parsers work on bytes, split paths only on NUL, and throw
 * GitSourceError("git_output_malformed") on output they cannot parse.
 */
import { isUtf8 } from "node:buffer";
import {
  GIT_AUTHOR_NAME_MAX_CHARS, GIT_BRANCH_NAME_MAX_CHARS, GIT_BRANCH_NAME_PATTERN, GIT_COMMIT_MESSAGE_MAX_BYTES,
  GIT_MAX_PATHS_PER_COMMIT, GIT_MAX_PR_REFS_PER_DOCUMENT, GIT_MAX_SPEC_GLOBS, GIT_MIN_VERSION,
  GIT_REF_VALUE_MAX_BYTES, GIT_SPEC_GLOB_MAX_CHARS, GIT_SPEC_GLOB_PATTERN, GitSourceError,
  type GitChangeStatus, type GitChangedPath, type GitCommitChanges, type GitCommitClassification,
  type GitCommitMetadata, type GitHostFlavor, type GitObjectFormat, type GitSpecMatcher, type GitTreeEntry,
  type GitVersion,
} from "./types.js";

const NUL = 0x00, TAB = 0x09, LF = 0x0a, UNIT_SEPARATOR = 0x1f;
/**
 * The byte that ends each metadata header field. The author name ends in %n:
 * a commit header line cannot hold a newline, while git keeps %x1f in a name.
 */
const METADATA_FIELD_ENDS = [UNIT_SEPARATOR, UNIT_SEPARATOR, UNIT_SEPARATOR, UNIT_SEPARATOR, LF] as const;
const MAX_PARENTS = 64, MAX_OID_CHARS = 64, MAX_DATE_CHARS = 32;
const MAX_STATUS_TOKEN_CHARS = 5, MAX_LS_TREE_HEADER_CHARS = 128;

const VERSION_LINE = /^git version (\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?/;
const COUNT_OUTPUT = /^\d{1,9}\n?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const SINGLE_PATH_STATUS = /^\n?([ACDMTUXB])$/;
const TWO_PATH_STATUS = /^\n?([RC])\d{1,3}$/;
const LS_TREE_HEADER = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{1,64}) +(-|\d{1,15})$/;
const PATH_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const AUTHOR_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

const GITHUB_MERGE_SUBJECT = /^Merge pull request #([1-9]\d{0,8}) from (\S{1,255})$/;
const GITHUB_PR_SUFFIX = /^(?:(.*\S)\s+)?\(#([1-9]\d{0,8})\)$/s;
const GITHUB_MENTION = /(?<![\w/&#])#([1-9]\d{0,8})(?!\d)/g;
const GITLAB_MERGE_LINE = /^See merge request (\S{1,255})!([1-9]\d{0,8})$/m;
/** Branch names are at most 255 characters, so a longer subject is never a GitLab merge subject. */
const GITLAB_MERGE_SUBJECT = /^Merge branch '[^\n]{1,255}' into '[^\n]{1,255}'$/;
const GITLAB_MERGE_SUBJECT_MAX_CHARS = 600;
const GITLAB_MERGE_LINE_PREFIX = "See merge request";

const lossyUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

function malformed(): never { throw new GitSourceError("git_output_malformed"); }

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** Strict UTF-8 decode (BOM kept); null when the bytes are not valid UTF-8. */
function decodeStrict(bytes: Uint8Array): string | null {
  return isUtf8(bytes) ? lossyUtf8.decode(bytes) : null;
}

/** Longest prefix of at most maxBytes that ends on a code-point boundary (the whole input when it fits). */
function cutUtf8(bytes: Uint8Array, maxBytes: number): Uint8Array {
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end);
}

/** Drops a multi-byte sequence that truncated output cut short. */
function dropIncompleteTail(bytes: Uint8Array): Uint8Array {
  let lead = bytes.length - 1;
  while (lead >= 0 && bytes.length - lead < 4 && (bytes[lead] & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return bytes;
  const first = bytes[lead];
  const needed = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
  return bytes.length - lead < needed ? bytes.subarray(0, lead) : bytes;
}

/** NUL-terminated tokens plus whatever follows the last NUL. */
function splitNul(stdout: Uint8Array): { tokens: Uint8Array[]; tail: Uint8Array } {
  const tokens: Uint8Array[] = [];
  let start = 0;
  for (let at = stdout.indexOf(NUL); at !== -1; at = stdout.indexOf(NUL, start)) {
    tokens.push(stdout.subarray(start, at));
    start = at + 1;
  }
  return { tokens, tail: stdout.subarray(start) };
}

function isBlankLine(line: string): boolean { return line.trim() === ""; }

function dropLeadingBlankLines(lines: readonly string[]): readonly string[] {
  let index = 0;
  while (index < lines.length && isBlankLine(lines[index])) index += 1;
  return lines.slice(index);
}

// Small command outputs.

export function parseGitVersion(stdout: Uint8Array): GitVersion | null {
  const match = VERSION_LINE.exec(latin1(stdout.subarray(0, 256)));
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: match[3] === undefined ? 0 : Number(match[3]) };
}

export function isSupportedGitVersion(version: GitVersion): boolean {
  if (version.major !== GIT_MIN_VERSION.major) return version.major > GIT_MIN_VERSION.major;
  return version.minor >= GIT_MIN_VERSION.minor;
}

export interface GitRevParseInfo {
  readonly shallow: boolean;
  readonly objectFormat: GitObjectFormat;
  readonly toplevel: string;
  readonly gitDir: string;
  readonly commonDir: string;
}

/**
 * Output of `rev-parse --is-shallow-repository --show-object-format
 * --show-toplevel --absolute-git-dir --path-format=absolute --git-common-dir`:
 * exactly five lines, so a path containing a newline is malformed.
 */
export function parseRevParseInfo(stdout: Uint8Array): GitRevParseInfo {
  const text = decodeStrict(stdout) ?? malformed();
  const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  if (lines.length !== 5) malformed();
  const [shallow, objectFormat, toplevel, gitDir, commonDir] = lines as [string, string, string, string, string];
  if (shallow !== "true" && shallow !== "false") malformed();
  if (objectFormat !== "sha1" && objectFormat !== "sha256") malformed();
  for (const path of [toplevel, gitDir, commonDir]) if (!path.startsWith("/") || path.includes("\u0000")) malformed();
  return { shallow: shallow === "true", objectFormat, toplevel, gitDir, commonDir };
}

/** One sha per line, as printed (rev-list: newest first). Empty output is []. */
export function parseShaLines(stdout: Uint8Array, shaPattern: RegExp): string[] {
  const text = latin1(stdout);
  if (text === "") return [];
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").map((line) => (shaPattern.test(line) ? line : malformed()));
}

export function parseCount(stdout: Uint8Array): number {
  if (stdout.length > 16) malformed();
  const text = latin1(stdout);
  if (!COUNT_OUTPUT.test(text)) malformed();
  return Number.parseInt(text, 10);
}

// Metadata log: GIT_COMMIT_METADATA_FORMAT with -z.

/** The `git log -z --format=` string parseCommitMetadata reads. */
export const GIT_COMMIT_METADATA_FORMAT = "%H%x1f%P%x1f%cI%x1f%aI%x1f%an%n%B";

/**
 * Records end in NUL. With `truncated` (the per-commit fallback hit its
 * maxBuffer) a final record without its NUL is kept when its five header
 * field ends are present, and is marked messageTruncated.
 */
export function parseCommitMetadata(stdout: Uint8Array, options: { shaPattern: RegExp; truncated: boolean }): GitCommitMetadata[] {
  const { tokens, tail } = splitNul(stdout);
  if (tail.length > 0 && !options.truncated) malformed();
  const records = tokens.map((record) => parseMetadataRecord(record, headerCuts(record) ?? malformed(), options.shaPattern, false));
  const tailCuts = tail.length > 0 ? headerCuts(tail) : null;
  if (tailCuts !== null) records.push(parseMetadataRecord(tail, tailCuts, options.shaPattern, true));
  return records;
}

/** Offsets of the five header field ends; null when the record has fewer. */
function headerCuts(record: Uint8Array): number[] | null {
  const cuts: number[] = [];
  let from = 0;
  for (const end of METADATA_FIELD_ENDS) {
    const at = record.indexOf(end, from);
    if (at === -1) return null;
    cuts.push(at);
    from = at + 1;
  }
  return cuts;
}

function parseMetadataRecord(
  record: Uint8Array, cuts: readonly number[], shaPattern: RegExp, partial: boolean,
): GitCommitMetadata {
  const field = (index: number): Uint8Array => record.subarray(index === 0 ? 0 : cuts[index - 1] + 1, cuts[index]);
  const sha = asciiField(field(0), MAX_OID_CHARS);
  const parentsText = asciiField(field(1), MAX_PARENTS * (MAX_OID_CHARS + 1));
  const committedAt = asciiField(field(2), MAX_DATE_CHARS);
  const authoredAt = asciiField(field(3), MAX_DATE_CHARS);
  if (!shaPattern.test(sha) || !ISO_DATE.test(committedAt) || !ISO_DATE.test(authoredAt)) malformed();
  const parents = parentsText === "" ? [] : parentsText.split(" ");
  if (parents.length > MAX_PARENTS || !parents.every((parent) => shaPattern.test(parent))) malformed();
  let message = record.subarray(cuts[METADATA_FIELD_ENDS.length - 1] + 1);
  let messageTruncated = partial;
  if (partial) message = dropIncompleteTail(message);
  if (message.length > GIT_COMMIT_MESSAGE_MAX_BYTES) {
    message = cutUtf8(message, GIT_COMMIT_MESSAGE_MAX_BYTES);
    messageTruncated = true;
  }
  const { subject, body } = splitCommitMessage(lossyUtf8.decode(message));
  const authorName = cleanAuthorName(lossyUtf8.decode(field(4)));
  return { sha, parents, committedAt, authoredAt, authorName, subject, body, messageTruncated };
}

function asciiField(bytes: Uint8Array, maxChars: number): string {
  if (bytes.length > maxChars) malformed();
  return latin1(bytes);
}

/**
 * Control characters removed, at most GIT_AUTHOR_NAME_MAX_CHARS code points.
 * A code point takes at most two UTF-16 units, so the bounded slice always
 * holds the first MAX code points whole before Array.from splits it.
 */
function cleanAuthorName(raw: string): string {
  const cleaned = raw.replace(AUTHOR_CONTROL_CHARS, "").trim();
  const codePoints = Array.from(cleaned.slice(0, GIT_AUTHOR_NAME_MAX_CHARS * 2));
  return codePoints.slice(0, GIT_AUTHOR_NAME_MAX_CHARS).join("").trimEnd();
}

/** git %s / %b semantics; nothing is normalized beyond trimming subject lines. */
export function splitCommitMessage(message: string): { subject: string; body: string } {
  const lines = dropLeadingBlankLines(message.split("\n"));
  let index = 0;
  const subjectLines: string[] = [];
  while (index < lines.length && !isBlankLine(lines[index])) {
    subjectLines.push(lines[index].trim());
    index += 1;
  }
  const body = dropLeadingBlankLines(lines.slice(index)).join("\n").trimEnd();
  return { subject: subjectLines.join(" "), body };
}

// Name-status log: `<sha>\0\n<S>\0<path>\0...<nextsha>\0` (--format=%H -z).

interface ChangesBuilder {
  readonly sha: string; readonly paths: GitChangedPath[]; readonly specPaths: string[];
  totalPaths: number; invalidPaths: number; truncated: boolean;
}

/**
 * Byte-level state machine: a header must match shaPattern, a status token
 * is followed by its path(s), and path tokens are consumed unconditionally,
 * so a path that looks like a sha is never mistaken for a header.
 */
export function parseNameStatusLog(
  stdout: Uint8Array,
  options: { shaPattern: RegExp; isSpecPath: (path: string) => boolean; truncated: boolean },
): Array<{ sha: string; changes: GitCommitChanges }> {
  const { tokens, tail } = splitNul(stdout);
  if (tail.length > 0 && !options.truncated) malformed();
  const commits: ChangesBuilder[] = [];
  let current: ChangesBuilder | null = null;
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index];
    const sha = headerSha(token, options.shaPattern);
    if (sha !== null) {
      current = { sha, paths: [], specPaths: [], totalPaths: 0, invalidPaths: 0, truncated: false };
      commits.push(current);
      index += 1;
      continue;
    }
    if (current === null) malformed();
    const status = parseStatusToken(token) ?? malformed();
    if (index + status.pathCount >= tokens.length) {
      if (options.truncated) break;
      malformed();
    }
    addChange(current, status.status, tokens.slice(index + 1, index + 1 + status.pathCount), options.isSpecPath);
    index += 1 + status.pathCount;
  }
  if (options.truncated && commits.length > 0) commits[commits.length - 1].truncated = true;
  return commits.map(({ sha, paths, specPaths, totalPaths, invalidPaths, truncated }) => ({
    sha, changes: { paths, totalPaths, invalidPaths, truncated, specPaths },
  }));
}

function headerSha(token: Uint8Array, shaPattern: RegExp): string | null {
  if (token.length !== 40 && token.length !== 64) return null;
  const text = latin1(token);
  return shaPattern.test(text) ? text : null;
}

function parseStatusToken(token: Uint8Array): { status: GitChangeStatus; pathCount: 1 | 2 } | null {
  if (token.length === 0 || token.length > MAX_STATUS_TOKEN_CHARS) return null;
  const text = latin1(token);
  const single = SINGLE_PATH_STATUS.exec(text);
  if (single !== null) return { status: single[1] as GitChangeStatus, pathCount: 1 };
  const double = TWO_PATH_STATUS.exec(text);
  if (double !== null) return { status: double[1] as GitChangeStatus, pathCount: 2 };
  return null;
}

/** One change line: counted once; dropped whole when any of its paths is not indexable. */
function addChange(
  builder: ChangesBuilder, status: GitChangeStatus, rawPaths: readonly Uint8Array[], isSpecPath: (path: string) => boolean,
): void {
  builder.totalPaths += 1;
  const paths: string[] = [];
  for (const raw of rawPaths) {
    const path = raw.length > GIT_REF_VALUE_MAX_BYTES ? null : decodeStrict(raw);
    if (path === null || !isIndexablePath(path)) {
      builder.invalidPaths += 1;
      return;
    }
    paths.push(path);
  }
  for (const path of paths) if (isSpecPath(path)) builder.specPaths.push(path);
  if (builder.paths.length >= GIT_MAX_PATHS_PER_COMMIT) {
    builder.truncated = true;
    return;
  }
  const path = paths[paths.length - 1];
  builder.paths.push(paths.length === 2 ? { status, path, previousPath: paths[0] } : { status, path });
}

// ls-tree -r -z -l: `<mode> <type> <oid> <size>\t<path>\0`.

/** Entries whose path is not valid UTF-8 are skipped (they can never be spec paths). */
export function parseLsTree(stdout: Uint8Array, shaPattern: RegExp): GitTreeEntry[] {
  const { tokens, tail } = splitNul(stdout);
  if (tail.length > 0) malformed();
  const entries: GitTreeEntry[] = [];
  for (const record of tokens) {
    const tab = record.indexOf(TAB);
    if (tab === -1 || tab > MAX_LS_TREE_HEADER_CHARS || tab === record.length - 1) malformed();
    const header = LS_TREE_HEADER.exec(latin1(record.subarray(0, tab)));
    if (header === null || !shaPattern.test(header[3])) malformed();
    const path = decodeStrict(record.subarray(tab + 1));
    if (path === null) continue;
    const size = header[4] === "-" ? null : Number(header[4]);
    entries.push({ mode: header[1], type: header[2] as GitTreeEntry["type"], oid: header[3], size, path });
  }
  return entries;
}

// Classification.

type ClassifiableCommit = { readonly subject: string; readonly body: string; readonly parents: readonly string[] };

export function classifyCommit(commit: ClassifiableCommit, flavor: GitHostFlavor): GitCommitClassification {
  return flavor === "gitlab" ? classifyGitlab(commit) : classifyGithub(commit);
}

function classifyGithub(commit: ClassifiableCommit): GitCommitClassification {
  const isMerge = commit.parents.length >= 2;
  const merge = isMerge ? GITHUB_MERGE_SUBJECT.exec(commit.subject) : null;
  if (merge !== null) {
    const number = Number(merge[1]);
    const lines = dropLeadingBlankLines(commit.body.split("\n"));
    const title = lines.length > 0 ? lines[0].trim() : "";
    const body = dropLeadingBlankLines(lines.slice(1)).join("\n").trimEnd();
    return {
      kind: "pull_request", number, form: "merge_branch", branch: merge[2],
      title, body, mentions: subjectMentions(commit.subject, number),
    };
  }
  const squash = GITHUB_PR_SUFFIX.exec(commit.subject);
  if (squash !== null) {
    const number = Number(squash[2]);
    return {
      kind: "pull_request", number, form: isMerge ? "merge_titled" : "squash", branch: null,
      title: squash[1] ?? "", body: commit.body, mentions: subjectMentions(commit.subject, number),
    };
  }
  return { kind: "commit", title: commit.subject, body: commit.body, mentions: subjectMentions(commit.subject, null) };
}

/** `#N` in a GitLab message names an issue, so GitLab classification never reports mentions. */
function classifyGitlab(commit: ClassifiableCommit): GitCommitClassification {
  const merge = GITLAB_MERGE_LINE.exec(commit.body);
  if (merge === null) return { kind: "commit", title: commit.subject, body: commit.body, mentions: [] };
  const isMergeSubject = commit.subject.length <= GITLAB_MERGE_SUBJECT_MAX_CHARS && GITLAB_MERGE_SUBJECT.test(commit.subject);
  const title = isMergeSubject
    ? commit.body.split("\n").map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith(GITLAB_MERGE_LINE_PREFIX)) ?? ""
    : commit.subject;
  const number = Number(merge[2]);
  return { kind: "pull_request", number, form: "gitlab_merge", branch: null, title, body: commit.body, mentions: [] };
}

/** Other `#N` in the subject, deduplicated, in order, own number excluded, capped. */
function subjectMentions(subject: string, own: number | null): number[] {
  const mentions: number[] = [];
  for (const match of subject.matchAll(GITHUB_MENTION)) {
    const number = Number(match[1]);
    if (number === own || mentions.includes(number)) continue;
    mentions.push(number);
    if (mentions.length >= GIT_MAX_PR_REFS_PER_DOCUMENT) break;
  }
  return mentions;
}

// Spec globs.

/** At most one `*` per segment (GIT_SPEC_GLOB_PATTERN), so a compiled glob matches in linear time. */
export function isValidSpecGlob(glob: string): boolean {
  if (typeof glob !== "string" || glob.length === 0 || glob.length > GIT_SPEC_GLOB_MAX_CHARS) return false;
  if (!GIT_SPEC_GLOB_PATTERN.test(glob)) return false;
  return glob.split("/").every((segment) => segment !== "." && segment !== "..");
}

interface CompiledGlob { readonly full: RegExp; readonly dir: RegExp | null }

/** Duplicates are dropped; an invalid glob, no globs or too many distinct globs is invalid_options. */
export function compileSpecGlobs(globs: readonly string[]): GitSpecMatcher {
  const unique: string[] = [];
  for (const glob of globs) {
    if (!isValidSpecGlob(glob)) throw new GitSourceError("invalid_options");
    if (unique.includes(glob)) continue;
    if (unique.length >= GIT_MAX_SPEC_GLOBS) throw new GitSourceError("invalid_options");
    unique.push(glob);
  }
  if (unique.length === 0) throw new GitSourceError("invalid_options");
  const compiled = unique.map((glob) => compileGlob(glob, unique));
  return {
    globs: unique,
    matches: (path: string): boolean => compiled.some((glob) => glob.full.test(path)),
    specDirOf: (path: string): string | null => {
      for (const glob of compiled) {
        const match = glob.dir === null ? null : glob.dir.exec(path);
        if (match !== null) return match[1];
      }
      return null;
    },
  };
}

/** A literal folder that holds another glob's folders (`specs` beside `specs/*`) is not a spec folder itself. */
function compileGlob(glob: string, all: readonly string[]): CompiledGlob {
  const fragments = glob.split("/").map(globSegmentFragment);
  const folder = glob.slice(0, Math.max(0, glob.lastIndexOf("/")));
  const container = !folder.includes("*")
    && all.some((other) => other.startsWith(`${folder}/`) && other.lastIndexOf("/") > folder.length);
  return {
    full: new RegExp(`^${fragments.join("/")}$`),
    dir: fragments.length >= 2 && !container ? new RegExp(`^(${fragments.slice(0, -1).join("/")})/`) : null,
  };
}

function globSegmentFragment(segment: string): string {
  if (segment === "*") return "[^/]+";
  return segment.split("*").map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
}

// Validators.

/** A repo-relative path that can be stored verbatim as a ref value. */
export function isIndexablePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0 || path.length > GIT_REF_VALUE_MAX_BYTES) return false;
  if (!path.isWellFormed() || PATH_CONTROL_CHARS.test(path) || path.startsWith("/")) return false;
  if (Buffer.byteLength(path, "utf8") > GIT_REF_VALUE_MAX_BYTES) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isSafeBranchName(name: string): boolean {
  return typeof name === "string" && name.length <= GIT_BRANCH_NAME_MAX_CHARS && GIT_BRANCH_NAME_PATTERN.test(name);
}
