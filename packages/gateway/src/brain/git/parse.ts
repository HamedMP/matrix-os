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

const NUL = 0x00, TAB = 0x09, UNIT_SEPARATOR = 0x1f;
const METADATA_HEADER_FIELDS = 5;
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
