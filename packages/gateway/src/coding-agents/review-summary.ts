import {
  ReviewSnapshotFileSchema,
  ReviewSnapshotSchema,
  ReviewSummarySchema,
  type ReviewSnapshot,
  type ReviewSummary,
} from "@matrix-os/contracts";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { RequestPrincipal } from "../request-principal.js";
import type { ReviewLoopRecord } from "../review-loop.js";
import {
  parseFindingsFile,
  type FindingsParseFailure,
  type FindingsParseSuccess,
  type ParsedFinding,
} from "../findings-parser.js";

const REVIEW_SUMMARY_LIMIT = 50;
const RAW_REVIEW_SCAN_LIMIT = 100;
const MAX_REVIEW_SCAN_PAGES = 5;
const REVIEW_SNAPSHOT_FILE_LIMIT = 100;
const REVIEW_SNAPSHOT_FINDINGS_PER_FILE_LIMIT = 100;
const REVIEW_DIFF_HUNK_LINE_LIMIT = 120;
const REVIEW_DIFF_LINE_CHAR_LIMIT = 1_000;
const REVIEW_DIFF_OUTPUT_BYTES = 256 * 1024;
const REVIEW_DIFF_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

type ReviewSnapshotErrorCode = "review_not_found" | "review_state_unavailable";
type ReviewSnapshotFile = ReviewSnapshot["files"]["items"][number];
type ReviewSnapshotHunk = ReviewSnapshotFile["hunks"][number];
type ReviewDiffLine = NonNullable<ReviewSnapshotHunk["lines"]>[number];
type ReviewDiffReadResult = {
  ok: true;
  files: ReviewSnapshotFile[];
  hasMore: boolean;
  partial: boolean;
} | {
  ok: false;
};
type ReviewDiffReader = (worktreeRoot: string) => Promise<ReviewDiffReadResult>;

export class CodingAgentReviewSnapshotError extends Error {
  constructor(public readonly code: ReviewSnapshotErrorCode) {
    super(code === "review_not_found" ? "Review was not found" : "Review state unavailable");
  }
}

export interface CodingAgentReviewSummaryStore {
  listReviews(
    principal: RequestPrincipal,
    options?: { cursor?: string },
  ): Promise<{ items: ReviewSummary[]; hasMore: boolean; limit: number; nextCursor?: string }>;
  getReviewSnapshot?(
    principal: RequestPrincipal,
    reviewId: string,
  ): Promise<ReviewSnapshot>;
}

export interface ReviewLoopStore {
  getReview?(reviewId: string): Promise<
    { ok: true; review: ReviewLoopRecord } |
    { ok: false; status: number; error: { code: string; message: string } }
  >;
  listReviews(input?: unknown): Promise<
    { ok: true; reviews: ReviewLoopRecord[]; nextCursor: string | null } |
    { ok: false; status: number; error: { code: string; message: string } }
  >;
}

function ownerIdsFor(options: { ownerId?: string; principalOwnerIds?: readonly string[] }): string[] {
  const ids: string[] = [];
  for (const id of [options.ownerId, ...(options.principalOwnerIds ?? [])]) {
    if (!id || ids.includes(id) || ids.length >= 8) continue;
    ids.push(id);
  }
  return ids;
}

function canReadReviewSummaries(principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (ownerIds.length > 0) return ownerIds.includes(principal.userId);
  return principal.source === "configured-container" || principal.source === "dev-default";
}

function findingsFor(review: ReviewLoopRecord): ReviewSummary["findings"] {
  const latest = review.rounds
    .slice()
    .reverse()
    .find((round) => typeof round.findingsCount === "number" || round.severityCounts);
  if (!latest) return undefined;
  const high = latest.severityCounts?.high ?? 0;
  const medium = latest.severityCounts?.medium ?? 0;
  const low = latest.severityCounts?.low ?? 0;
  return {
    total: latest.findingsCount ?? high + medium + low,
    high,
    medium,
    low,
  };
}

function safeStatusFor(review: ReviewLoopRecord): string | undefined {
  if (review.status === "failed_parse") return "Review output could not be read. Try another review run.";
  if (review.status === "failed") return "Review stopped before completion. Try again.";
  if (review.status === "stalled") return "Review needs attention before continuing.";
  return undefined;
}

function toReviewSummary(review: ReviewLoopRecord): ReviewSummary | null {
  const parsed = ReviewSummarySchema.safeParse({
    id: review.id,
    projectId: review.projectSlug,
    worktreeId: review.worktreeId,
    status: review.status,
    pullRequestNumber: review.pr,
    round: review.round,
    maxRounds: review.maxRounds,
    reviewer: review.reviewer,
    implementer: review.implementer,
    findings: findingsFor(review),
    safeStatus: safeStatusFor(review),
    updatedAt: review.updatedAt,
  });
  return parsed.success ? parsed.data : null;
}

type FindingsReader = (path: string) => Promise<FindingsParseSuccess | FindingsParseFailure>;

function latestSuccessfulFindingsRound(review: ReviewLoopRecord) {
  return review.rounds
    .slice()
    .reverse()
    .find((round) => round.parserStatus === "success" && typeof round.findingsPath === "string" && round.findingsPath.length > 0)
}

function reviewOwnerMatchesPrincipal(review: ReviewLoopRecord, principal: RequestPrincipal, ownerIds: readonly string[]): boolean {
  if (!canReadReviewSummaries(principal, ownerIds)) return false;
  if (!review.ownerId) return false;
  return ownerIds.includes(review.ownerId);
}

function safeFindingsPath(input: { homePath?: string; review: ReviewLoopRecord; round: number; findingsPath?: string }): string | null {
  if (!input.homePath || !input.findingsPath) return null;
  if (input.findingsPath !== `.matrix/review-round-${input.round}.md`) return null;
  const safeProject = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(input.review.projectSlug);
  const safeWorktree = /^wt_[A-Za-z0-9_-]{1,128}$/.test(input.review.worktreeId);
  if (!safeProject || !safeWorktree) return null;
  const worktreeRoot = resolve(input.homePath, "projects", input.review.projectSlug, "worktrees", input.review.worktreeId);
  const resolved = resolve(worktreeRoot, input.findingsPath);
  return resolved.startsWith(`${worktreeRoot}${sep}`) ? resolved : null;
}

function safeWorktreeRoot(input: { homePath?: string; review: ReviewLoopRecord }): string | null {
  if (!input.homePath) return null;
  const safeProject = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(input.review.projectSlug);
  const safeWorktree = /^wt_[A-Za-z0-9_-]{1,128}$/.test(input.review.worktreeId);
  if (!safeProject || !safeWorktree) return null;
  return resolve(input.homePath, "projects", input.review.projectSlug, "worktrees", input.review.worktreeId);
}

function hunkIdFor(path: string, index: number): string {
  return `hunk_${path.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 96)}_${index}`;
}

function parseRangeStart(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "0", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseRangeLines(value: string | undefined): number {
  if (value === undefined) return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function readGitPathToken(input: string, startIndex = 0): { token: string; nextIndex: number } | null {
  let index = startIndex;
  while (input[index] === " ") index += 1;
  if (index >= input.length) return null;
  if (input[index] !== '"') {
    const end = input.indexOf(" ", index);
    const nextIndex = end === -1 ? input.length : end;
    return { token: input.slice(index, nextIndex), nextIndex };
  }

  index += 1;
  let token = "";
  while (index < input.length) {
    const char = input[index]!;
    if (char === '"') {
      return { token, nextIndex: index + 1 };
    }
    if (char !== "\\") {
      token += char;
      index += 1;
      continue;
    }
    const escaped = input[index + 1];
    if (!escaped) return null;
    if (/[0-7]/.test(escaped)) {
      const octal = input.slice(index + 1, index + 4).match(/^[0-7]{1,3}/)?.[0] ?? escaped;
      token += String.fromCharCode(Number.parseInt(octal, 8));
      index += 1 + octal.length;
      continue;
    }
    token += escaped === "t" ? "\t" : escaped === "n" ? "\n" : escaped;
    index += 2;
  }
  return null;
}

function cleanGitPathToken(token: string, options: { stripTabMetadata?: boolean } = {}): string {
  const value = options.stripTabMetadata ? token.split("\t")[0] ?? token : token;
  return value.startsWith("a/") || value.startsWith("b/")
    ? value.slice(2)
    : value;
}

function parseDiffGitHeader(line: string): { oldPath: string; newPath: string } | null {
  if (!line.startsWith("diff --git ")) return null;
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith("a/")) {
    const candidates: Array<{ oldPath: string; newPath: string }> = [];
    let separator = rest.indexOf(" b/");
    while (separator !== -1) {
      const oldRaw = rest.slice(0, separator);
      const newRaw = rest.slice(separator + 1);
      if (oldRaw.startsWith("a/") && newRaw.startsWith("b/")) {
        candidates.push({
          oldPath: cleanGitPathToken(oldRaw),
          newPath: cleanGitPathToken(newRaw),
        });
      }
      separator = rest.indexOf(" b/", separator + 1);
    }
    return candidates.find((candidate) => candidate.oldPath === candidate.newPath)
      ?? candidates[candidates.length - 1]
      ?? null;
  }
  const oldToken = readGitPathToken(rest);
  if (!oldToken) return null;
  const newToken = readGitPathToken(rest, oldToken.nextIndex);
  if (!newToken) return null;
  return {
    oldPath: cleanGitPathToken(oldToken.token),
    newPath: cleanGitPathToken(newToken.token),
  };
}

function markDiffReadResultPartial(result: ReviewDiffReadResult): ReviewDiffReadResult {
  if (!result.ok) return result;
  return {
    ...result,
    files: result.files.map((file) => ({ ...file, partial: true })),
    hasMore: true,
    partial: true,
  };
}

function parseDiffFileMarker(line: string, marker: "--- " | "+++ "): string | null {
  if (!line.startsWith(marker)) return null;
  const raw = line.slice(marker.length);
  if (raw.startsWith('"')) {
    const token = readGitPathToken(raw);
    if (!token || token.token === "/dev/null") return null;
    return cleanGitPathToken(token.token);
  }
  if (raw === "/dev/null") return null;
  return cleanGitPathToken(raw, { stripTabMetadata: true });
}

function parseUnifiedDiff(stdout: string): ReviewDiffReadResult {
  const files: ReviewSnapshotFile[] = [];
  let current: {
    path: string;
    status: ReviewSnapshotFile["status"];
    additions: number;
    deletions: number;
    hunks: ReviewSnapshotFile["hunks"];
    partial: boolean;
  } | null = null;
  let hasMore = false;
  let oldLine = 0;
  let newLine = 0;

  const pushCurrent = () => {
    if (!current) return;
    const parsed = ReviewSnapshotFileSchema.safeParse({
      path: current.path,
      status: current.status,
      additions: current.additions,
      deletions: current.deletions,
      partial: current.partial,
      hunks: current.hunks.slice(0, 100),
    });
    if (!parsed.success) {
      current = null;
      return;
    }
    if (files.length >= REVIEW_SNAPSHOT_FILE_LIMIT) {
      hasMore = true;
      current = null;
      return;
    }
    files.push(parsed.data);
    current = null;
  };

  const markCurrentPartial = () => {
    if (!current) return;
    current.partial = true;
    hasMore = true;
    const hunk = current.hunks[current.hunks.length - 1];
    if (hunk) hunk.partial = true;
  };

  const addCurrentHunkLine = (line: ReviewDiffLine) => {
    if (!current) return;
    const hunk = current.hunks[current.hunks.length - 1];
    if (!hunk) return;
    if ((hunk.lines?.length ?? 0) >= REVIEW_DIFF_HUNK_LINE_LIMIT) {
      markCurrentPartial();
      return;
    }
    const content = line.content.slice(0, REVIEW_DIFF_LINE_CHAR_LIMIT);
    const partial = content.length < line.content.length;
    hunk.lines = [...(hunk.lines ?? []), { ...line, content }];
    if (partial) markCurrentPartial();
  };

  for (const line of stdout.split("\n")) {
    const diffHeader = parseDiffGitHeader(line);
    if (diffHeader) {
      pushCurrent();
      current = {
        path: diffHeader.newPath || diffHeader.oldPath,
        status: "modified",
        additions: 0,
        deletions: 0,
        hunks: [],
        partial: false,
      };
      oldLine = 0;
      newLine = 0;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) {
      current.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.status = "deleted";
      continue;
    }
    if (line.startsWith("similarity index") || line.startsWith("rename from ") || line.startsWith("rename to ")) {
      current.status = "renamed";
      continue;
    }
    if (line.startsWith("Binary files ")) {
      current.status = "binary";
      current.partial = true;
      continue;
    }
    const newPath = parseDiffFileMarker(line, "+++ ");
    if (newPath) {
      current.path = newPath;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunk) {
      if (current.hunks.length >= 100) {
        current.partial = true;
        hasMore = true;
        continue;
      }
      oldLine = parseRangeStart(hunk[1]);
      newLine = parseRangeStart(hunk[3]);
      current.hunks.push({
        id: hunkIdFor(current.path, current.hunks.length),
        oldStart: oldLine,
        oldLines: parseRangeLines(hunk[2]),
        newStart: newLine,
        newLines: parseRangeLines(hunk[4]),
        heading: line.slice(0, 120),
        partial: false,
        lines: [],
      });
      continue;
    }
    if (line.startsWith("\\ No newline")) continue;
    if (line.startsWith(" ") && current.hunks.length > 0) {
      addCurrentHunkLine({ kind: "context", oldLine, newLine, content: line.slice(1) });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
      if (current.hunks.length > 0) {
        addCurrentHunkLine({ kind: "add", newLine, content: line.slice(1) });
        newLine += 1;
      }
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
      if (current.hunks.length > 0) {
        addCurrentHunkLine({ kind: "remove", oldLine, content: line.slice(1) });
        oldLine += 1;
      }
    }
  }
  pushCurrent();
  return {
    ok: true,
    files,
    hasMore,
    partial: hasMore || files.some((file) => file.partial),
  };
}

function capReviewHunkLines(hunk: ReviewSnapshotHunk): ReviewSnapshotHunk {
  let partial = hunk.partial;
  const lines = (hunk.lines ?? []).slice(0, REVIEW_DIFF_HUNK_LINE_LIMIT).map((line) => {
    const content = line.content.slice(0, REVIEW_DIFF_LINE_CHAR_LIMIT);
    if (content.length < line.content.length) partial = true;
    return { ...line, content } as ReviewDiffLine;
  });
  if ((hunk.lines?.length ?? 0) > REVIEW_DIFF_HUNK_LINE_LIMIT) partial = true;
  return {
    ...hunk,
    partial,
    lines: lines.length > 0 ? lines : hunk.lines,
  };
}

function capReviewSnapshotFile(file: ReviewSnapshotFile): ReviewSnapshotFile {
  const hunks = file.hunks.map(capReviewHunkLines);
  return {
    ...file,
    partial: file.partial || hunks.some((hunk) => hunk.partial),
    hunks,
  };
}

async function execGit(worktreeRoot: string, args: string[], options: { maxBuffer?: number; logFailure?: boolean } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REVIEW_DIFF_TIMEOUT_MS);
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", worktreeRoot, ...args],
      {
        encoding: "utf8",
        maxBuffer: options.maxBuffer ?? REVIEW_DIFF_OUTPUT_BYTES,
        signal: controller.signal,
      },
    );
    return stdout;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (options.logFailure ?? true) {
      console.warn("[coding-agents] review diff unavailable", code ? `(${code})` : "");
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readGitReviewDiff(worktreeRoot: string): Promise<ReviewDiffReadResult> {
  try {
    await access(worktreeRoot);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(code)) {
      return { ok: false };
    }
    console.warn("[coding-agents] review worktree unavailable");
    return { ok: false };
  }
  const diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=3"];
  let base: string | undefined;
  for (const candidate of ["origin/HEAD", "origin/main", "origin/master", "origin/develop"]) {
    base = (await execGit(worktreeRoot, ["merge-base", "HEAD", candidate], {
      maxBuffer: 64 * 1024,
      logFailure: false,
    }))?.trim();
    if (base) break;
  }
  const baseStdout = base
    ? await execGit(worktreeRoot, [...diffArgs, base, "--", "."], { logFailure: false })
    : null;
  if (base && baseStdout === null) {
    return { ok: true, files: [], hasMore: true, partial: true };
  }
  if (!base) {
    const headStdout = await execGit(worktreeRoot, [...diffArgs, "HEAD", "--", "."], { logFailure: false });
    if (headStdout !== null) {
      if (headStdout.trim().length === 0) {
        return { ok: true, files: [], hasMore: true, partial: true };
      }
      return markDiffReadResultPartial(parseUnifiedDiff(headStdout));
    }
    const workingTreeStdout = await execGit(worktreeRoot, [...diffArgs, "--", "."]);
    if (workingTreeStdout === null) return { ok: false };
    if (workingTreeStdout.trim().length === 0) {
      return { ok: true, files: [], hasMore: true, partial: true };
    }
    return markDiffReadResultPartial(parseUnifiedDiff(workingTreeStdout));
  }
  const stdout = baseStdout;
  return stdout === null ? { ok: false } : parseUnifiedDiff(stdout);
}

function snapshotFilesFromFindings(review: ReviewLoopRecord, findings: ParsedFinding[]) {
  const files = new Map<string, ParsedFinding[]>();
  let hasMore = false;
  for (const finding of findings) {
    if (files.size >= REVIEW_SNAPSHOT_FILE_LIMIT && !files.has(finding.file)) {
      hasMore = true;
      continue;
    }
    const current = files.get(finding.file) ?? [];
    if (current.length >= REVIEW_SNAPSHOT_FINDINGS_PER_FILE_LIMIT) {
      hasMore = true;
      continue;
    }
    current.push(finding);
    files.set(finding.file, current);
  }

  const items = [...files.entries()]
    .map(([path, fileFindings], fileIndex) => ReviewSnapshotFileSchema.safeParse({
      path,
      status: "modified",
      additions: 0,
      deletions: 0,
      partial: true,
      hunks: fileFindings.map((finding, findingIndex) => ({
        id: `hunk_${review.id}_${fileIndex}_${findingIndex}`,
        oldStart: finding.line,
        oldLines: 1,
        newStart: finding.line,
        newLines: 1,
        heading: `Finding ${finding.id}`,
        partial: true,
      })),
      findings: fileFindings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        line: finding.line,
        summary: finding.summary,
      })),
    }))
    .filter((parsed) => parsed.success)
    .map((parsed) => parsed.data);
  return { items, hasMore };
}

function mergeDiffAndFindings(input: {
  diff: ReviewDiffReadResult | null;
  findings: ReturnType<typeof snapshotFilesFromFindings>;
}) {
  if (!input.diff?.ok) return input.findings;
  if (input.diff.files.length === 0) {
    return {
      items: input.findings.items,
      hasMore: input.diff.hasMore || input.diff.partial || input.findings.hasMore,
    };
  }
  const findingsByPath = new Map(input.findings.items.map((file) => [file.path, file.findings ?? []]));
  const files: ReviewSnapshotFile[] = [];
  let hasMore = input.diff.hasMore || input.findings.hasMore;
  for (const file of input.diff.files) {
    const cappedFile = capReviewSnapshotFile(file);
    const parsed = ReviewSnapshotFileSchema.safeParse({
      ...cappedFile,
      findings: findingsByPath.get(cappedFile.path),
    });
    if (!parsed.success) continue;
    files.push(parsed.data);
  }
  const diffPaths = new Set(files.map((file) => file.path));
  for (const findingFile of input.findings.items) {
    if (diffPaths.has(findingFile.path)) continue;
    if (files.length >= REVIEW_SNAPSHOT_FILE_LIMIT) {
      hasMore = true;
      break;
    }
    files.push(findingFile);
  }
  return { items: files.slice(0, REVIEW_SNAPSHOT_FILE_LIMIT), hasMore };
}

async function toPartialReviewSnapshot(
  review: ReviewLoopRecord,
  options: { findingsReader: FindingsReader; diffReader: ReviewDiffReader; homePath?: string },
): Promise<ReviewSnapshot | null> {
  const summary = toReviewSummary(review);
  if (!summary) return null;
  const findingsRound = latestSuccessfulFindingsRound(review);
  const findingsPath = findingsRound
    ? safeFindingsPath({
      homePath: options.homePath,
      review,
      round: findingsRound.round,
      findingsPath: findingsRound.findingsPath,
    })
    : null;
  const parsedFindings = findingsPath ? await options.findingsReader(findingsPath) : null;
  const worktreeRoot = safeWorktreeRoot({ homePath: options.homePath, review });
  const parsedDiff = worktreeRoot ? await options.diffReader(worktreeRoot) : null;
  const findingsFiles = parsedFindings?.ok ? snapshotFilesFromFindings(review, parsedFindings.findings) : { items: [], hasMore: false };
  const files = mergeDiffAndFindings({ diff: parsedDiff, findings: findingsFiles });
  const snapshotPartial = !parsedDiff?.ok || parsedDiff.partial || files.hasMore || files.items.some((file) => file.partial);
  const parsed = ReviewSnapshotSchema.safeParse({
    review: summary,
    files: {
      items: files.items.slice(0, REVIEW_SNAPSHOT_FILE_LIMIT),
      hasMore: files.hasMore,
      limit: REVIEW_SNAPSHOT_FILE_LIMIT,
    },
    partial: snapshotPartial,
    safeNotice: snapshotPartial
      ? files.items.length > 0
        ? "Some diff content is unavailable. Showing bounded review metadata."
        : "Diff content is not available yet. Showing bounded review state."
      : undefined,
    updatedAt: review.updatedAt,
  });
  return parsed.success ? parsed.data : null;
}

export function createCodingAgentReviewSummaryStore(
  store: ReviewLoopStore,
  options: {
    ownerId?: string;
    principalOwnerIds?: readonly string[];
    findingsReader?: FindingsReader;
    diffReader?: ReviewDiffReader;
    homePath?: string;
  } = {},
): CodingAgentReviewSummaryStore {
  const ownerIds = ownerIdsFor(options);
  const findingsReader = options.findingsReader ?? parseFindingsFile;
  const diffReader = options.diffReader ?? readGitReviewDiff;
  return {
    async listReviews(principal: RequestPrincipal, listOptions: { cursor?: string } = {}) {
      if (!canReadReviewSummaries(principal, ownerIds)) {
        return { items: [], hasMore: false, limit: REVIEW_SUMMARY_LIMIT };
      }
      const validSummaries: ReviewSummary[] = [];
      let cursor = listOptions.cursor;
      let rawContinuationCursor: string | undefined;
      const seenCursors = new Set<string>();
      for (let page = 0; page < MAX_REVIEW_SCAN_PAGES && validSummaries.length <= REVIEW_SUMMARY_LIMIT; page += 1) {
        if (cursor && seenCursors.has(cursor)) break;
        if (cursor) seenCursors.add(cursor);
        const result = await store.listReviews({ limit: RAW_REVIEW_SCAN_LIMIT, cursor });
        if (!result.ok) {
          throw new Error("Review state unavailable");
        }
        validSummaries.push(
          ...result.reviews
            .filter((review) => ownerIds.length === 0 || reviewOwnerMatchesPrincipal(review, principal, ownerIds))
            .map(toReviewSummary)
            .filter((summary): summary is ReviewSummary => summary !== null),
        );
        if (!result.nextCursor) break;
        if (seenCursors.has(result.nextCursor)) {
          rawContinuationCursor = undefined;
          break;
        }
        rawContinuationCursor = result.nextCursor;
        cursor = result.nextCursor;
      }
      const items = validSummaries.slice(0, REVIEW_SUMMARY_LIMIT);
      const hasMore = validSummaries.length > REVIEW_SUMMARY_LIMIT || rawContinuationCursor !== undefined;
      return {
        items,
        hasMore,
        nextCursor: hasMore ? items[items.length - 1]?.id ?? rawContinuationCursor : undefined,
        limit: REVIEW_SUMMARY_LIMIT,
      };
    },

    async getReviewSnapshot(principal: RequestPrincipal, reviewId: string) {
      if (!canReadReviewSummaries(principal, ownerIds)) {
        throw new CodingAgentReviewSnapshotError("review_not_found");
      }
      if (!("getReview" in store) || typeof store.getReview !== "function") {
        throw new CodingAgentReviewSnapshotError("review_state_unavailable");
      }
      const result = await store.getReview(reviewId);
      if (!result.ok) {
        throw new CodingAgentReviewSnapshotError(result.status === 404 || result.status === 403 ? "review_not_found" : "review_state_unavailable");
      }
      if (!reviewOwnerMatchesPrincipal(result.review, principal, ownerIds)) {
        throw new CodingAgentReviewSnapshotError("review_not_found");
      }
      const snapshot = await toPartialReviewSnapshot(result.review, { findingsReader, diffReader, homePath: options.homePath });
      if (!snapshot) {
        throw new CodingAgentReviewSnapshotError("review_state_unavailable");
      }
      return snapshot;
    },
  };
}
