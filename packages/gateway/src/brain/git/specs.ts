/**
 * Git source adapter: one spec file at a window end -> its part documents.
 * A file splits into at most GIT_MAX_SPEC_PARTS parts of at most
 * GIT_SPEC_PART_MAX_BYTES, preferring `## ` heading and line boundaries.
 * Parts beyond the new count, and every part of a removed file, are
 * tombstoned. Pure functions.
 */
import { isUtf8 } from "node:buffer";
import { BRAIN_TITLE_MAX_CHARS } from "../index.js";
import { clampTitle, sanitizeText, specPartDocumentId } from "./documents.js";
import { blobPermalink } from "./permalinks.js";
import {
  GIT_MAX_SPEC_PARTS,
  GIT_PROVENANCE,
  GIT_SPEC_FILE_MAX_BYTES,
  GIT_SPEC_PART_MAX_BYTES,
  GIT_SPEC_TITLE_SCAN_BYTES,
  GitSourceError,
  type GitDocumentContext,
  type GitDocumentRef,
  type GitSpecDocuments,
  type GitSpecFile,
  type GitSyncNotice,
  type GitUpsertDraft,
} from "./types.js";

/** Smallest byte budget that always fits one code point. */
const MIN_PART_BYTES = 4;
const EMPTY_FILE_TEXT = "(empty file)";
const NOT_TEXT_BODY = "This file is not UTF-8 text and was not indexed.";
/** Used only on bytes that passed isUtf8; a leading BOM is dropped so it never hides the `# ` title line. */
const utf8 = new TextDecoder("utf-8");

function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

/** UTF-16 units of the longest prefix of text[start..] that fits maxBytes and ends on a code point boundary. */
function unitsWithin(text: string, start: number, maxBytes: number): number {
  let bytes = 0;
  let index = start;
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!;
    const size = utf8Size(codePoint);
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return index - start;
}

function softCut(window: string): number {
  const min = Math.floor(window.length / 2);
  const heading = window.lastIndexOf("\n## ");
  if (heading >= min) return heading + 1;
  const newline = window.lastIndexOf("\n");
  return newline >= min ? newline + 1 : window.length;
}

function splitWith(text: string, maxBytes: number, hard: boolean): string[] {
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    const units = unitsWithin(text, start, maxBytes);
    if (start + units === text.length) break;
    const cut = hard ? units : softCut(text.slice(start, start + units));
    parts.push(text.slice(start, start + cut));
    start += cut;
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * Deterministic split: `parts.join("") === text`, every part at most maxBytes
 * of UTF-8. Prefers cutting before a `## ` heading, then after a newline, in
 * the second half of the window; falls back to a hard split on code point
 * boundaries when the soft split needs more than GIT_MAX_SPEC_PARTS parts.
 */
export function splitSpecText(text: string, maxBytes: number): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_PART_BYTES) throw new GitSourceError("internal_error");
  const soft = splitWith(text, maxBytes, false);
  return soft.length > GIT_MAX_SPEC_PARTS ? splitWith(text, maxBytes, true) : soft;
}

function isHeadingSpace(char: string | undefined): boolean {
  return char === " " || char === "\t";
}

/** The capture of /^#[ \t]+(.+?)[ \t#]*$/ on one line, without backtracking; null when it does not match. */
function headingText(line: string): string | null {
  if (!line.startsWith("#")) return null;
  const rest = line.slice(1);
  let spaces = 0;
  while (isHeadingSpace(rest[spaces])) spaces += 1;
  if (spaces === 0) return null;
  let tail = rest.length;
  while (tail > 0 && (isHeadingSpace(rest[tail - 1]) || rest[tail - 1] === "#")) tail -= 1;
  if (spaces < rest.length) return rest.slice(spaces, Math.max(spaces + 1, tail));
  return spaces >= 2 ? rest.slice(spaces - 1, spaces) : null;
}

/** Index of the next JS line terminator (as `$` with the m flag sees them), or text.length. */
function lineEndFrom(text: string, from: number): number {
  for (let index = from; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit === 0x0a || unit === 0x0d || unit === 0x2028 || unit === 0x2029) return index;
  }
  return text.length;
}

/** First `# ` heading whose line starts within GIT_SPEC_TITLE_SCAN_BYTES; null when there is none. */
function specHeading(text: string): string | null {
  const scanUnits = unitsWithin(text, 0, GIT_SPEC_TITLE_SCAN_BYTES);
  let lineStart = 0;
  while (lineStart < scanUnits) {
    const lineEnd = lineEndFrom(text, lineStart);
    const heading = headingText(text.slice(lineStart, lineEnd));
    if (heading !== null) return heading;
    lineStart = lineEnd + 1;
  }
  return null;
}

function decodeStrict(content: Uint8Array): string | null {
  return isUtf8(content) ? utf8.decode(content) : null;
}

function partIds(ctx: GitDocumentContext, path: string, from: number): string[] {
  const ids: string[] = [];
  for (let part = from; part <= GIT_MAX_SPEC_PARTS; part += 1) ids.push(specPartDocumentId(ctx.identity, path, part));
  return ids;
}

function specRefs(file: GitSpecFile, ctx: GitDocumentContext): GitDocumentRef[] {
  const refs: GitDocumentRef[] = [{ kind: "path", value: file.path }];
  const dir = ctx.matcher.specDirOf(file.path);
  if (dir !== null) refs.push({ kind: "spec", value: dir });
  return refs;
}

function partTitle(base: string, path: string, part: number, total: number): string {
  if (total === 1) return clampTitle(base, path);
  const suffix = ` (part ${part} of ${total})`;
  return clampTitle(base, path, BRAIN_TITLE_MAX_CHARS - suffix.length) + suffix;
}

function specDrafts(file: GitSpecFile, ctx: GitDocumentContext, base: string, bodies: readonly string[]): GitUpsertDraft[] {
  const permalink = blobPermalink(ctx.webBase, file.touchSha, file.path);
  const refs = specRefs(file, ctx);
  return bodies.map((body, index) => ({
    documentId: specPartDocumentId(ctx.identity, file.path, index + 1),
    title: partTitle(base, file.path, index + 1, bodies.length),
    body,
    permalink,
    sourceUpdatedAt: file.touchCommittedAt,
    provenance: GIT_PROVENANCE.spec,
    refs,
  }));
}

function stub(file: GitSpecFile, ctx: GitDocumentContext, base: string, body: string, notice: GitSyncNotice): GitSpecDocuments {
  return { upserts: specDrafts(file, ctx, base, [body]), deletions: partIds(ctx, file.path, 2), notices: [notice] };
}

function oversizeBody(size: number): string {
  return `This file is ${size} bytes, over the ${GIT_SPEC_FILE_MAX_BYTES} byte indexing limit. Open the permalink to read it.`;
}

/** Under the byte limit, but replacing NUL (1 byte) with U+FFFD (3 bytes) needs more than GIT_MAX_SPEC_PARTS parts. */
function expandedBody(size: number): string {
  return `This file is ${size} bytes and needs more than ${GIT_MAX_SPEC_PARTS} parts once its NUL characters are replaced. Open the permalink to read it.`;
}

/** Part documents and part tombstones for one touched spec path at the window end. */
export function buildSpecDocuments(file: GitSpecFile, ctx: GitDocumentContext): GitSpecDocuments {
  if (file.blob === null) return { upserts: [], deletions: partIds(ctx, file.path, 1), notices: [] };
  if (file.blob.content === null) return stub(file, ctx, file.path, oversizeBody(file.blob.size), "spec_file_oversize");
  const decoded = decodeStrict(file.blob.content);
  if (decoded === null) return stub(file, ctx, file.path, NOT_TEXT_BODY, "spec_file_not_text");
  const text = decoded === "" ? EMPTY_FILE_TEXT : sanitizeText(decoded);
  const base = specHeading(text) ?? file.path;
  const bodies = splitSpecText(text, GIT_SPEC_PART_MAX_BYTES);
  if (bodies.length > GIT_MAX_SPEC_PARTS) return stub(file, ctx, base, expandedBody(file.blob.size), "spec_file_oversize");
  return { upserts: specDrafts(file, ctx, base, bodies), deletions: partIds(ctx, file.path, bodies.length + 1), notices: [] };
}
