// Bounded git history/diff reads for project repositories (desktop commit DAG).
// Mirrors project-manager.ts patterns: injectable CommandRunner (execFile with
// timeout + maxBuffer, arg arrays only), slug/config resolution from
// `<home>/projects/<slug>/config.json`, not-a-git-repo degradation to empty
// results, and generic client-facing error messages with server-side logging.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod/v4";
import { PROJECT_SLUG_REGEX } from "./project-manager.js";
import { readJsonFile } from "./state-ops.js";

export interface GitCommitSummary {
  sha: string;
  parents: string[];
  author: string;
  timestamp: string;
  subject: string;
  refs: string[];
  tags: string[];
  head: boolean;
}

export interface GitCommitDiffFile {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  patch: string | null;
  truncated: boolean;
}

export const COMMIT_SHA_REGEX = /^[0-9a-f]{4,64}$/i;

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

type Result<T> = { ok: true } & T;
type Failure = { ok: false; status: number; error: { code: string; message: string } };
type RepoResolution = Result<{ repoPath: string | null }> | Failure;

const DEFAULT_TIMEOUT_MS = 10_000;
// Absolute ceiling on rendered patch lines across all files of one commit.
const MAX_TOTAL_PATCH_LINES = 8_000;
const MAX_PATCH_BYTES = 200_000;
const MAX_COMMIT_PARENTS = 8;
const MAX_COMMIT_REFS = 50;
const MAX_HISTORY_SNAPSHOT_COMMITS = 2_000;
const MAX_HISTORY_SNAPSHOTS = 16;
const HISTORY_SNAPSHOT_TTL_MS = 30 * 60 * 1_000;
const HISTORY_CURSOR_REGEX = /^([a-f0-9]{24})\.(\d{1,4})$/;

const SlugSchema = z.string().trim().regex(PROJECT_SLUG_REGEX);
const CommitShaSchema = z.string().regex(COMMIT_SHA_REGEX);

// %x1f = field separator, %x1e = record separator. Neither can appear in ref
// names; a hostile subject containing one only corrupts its own record.
const LOG_FORMAT = "%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s%x1e";

const execFileAsync = promisify(execFile);

const defaultRunCommand: CommandRunner = async (command, args, options) => {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: options.cwd,
    timeout: options.timeout,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout, stderr };
};

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

function stderrOf(err: unknown): string {
  if (!(err instanceof Error)) return "";
  const stderr = "stderr" in err && typeof (err as { stderr?: unknown }).stderr === "string"
    ? (err as { stderr: string }).stderr
    : "";
  return `${stderr}\n${err.message}`;
}

function isNotAGitRepositoryError(err: unknown): boolean {
  return /not a git repository/i.test(stderrOf(err));
}

function isEmptyRepositoryError(err: unknown): boolean {
  return /does not have any commits yet/i.test(stderrOf(err));
}

function isUnknownRevisionError(err: unknown): boolean {
  return /bad object|unknown revision|ambiguous argument|bad revision/i.test(stderrOf(err));
}

function isMaxBufferError(err: unknown): boolean {
  return /maxBuffer/i.test(stderrOf(err));
}

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

interface ProjectRepoConfig {
  localPath: string;
}

async function readProjectRepoConfig(homePath: string, slug: string): Promise<ProjectRepoConfig | null> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(join(homePath, "projects", slug, "config.json"));
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const localPath = (raw as Record<string, unknown>).localPath;
  return typeof localPath === "string" && localPath.length > 0 ? { localPath } : null;
}

function parseRefList(raw: string): { refs: string[]; tags: string[]; head: boolean } {
  const refs: string[] = [];
  const tags: string[] = [];
  let head = false;
  for (const entry of raw.split(", ")) {
    const value = entry.trim();
    if (!value) continue;
    if (value === "HEAD") {
      head = true;
      continue;
    }
    if (value.startsWith("HEAD -> ")) {
      head = true;
      refs.push(value.slice("HEAD -> ".length));
      continue;
    }
    if (value.startsWith("tag: ")) {
      tags.push(value.slice("tag: ".length));
      continue;
    }
    refs.push(value);
  }
  return { refs, tags, head };
}

export function parseGitLog(stdout: string): GitCommitSummary[] {
  const commits: GitCommitSummary[] = [];
  for (const record of stdout.split("\x1e")) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\x1f");
    if (parts.length < 6 || !parts[0]) continue;
    const [sha, parentsRaw, author, timestamp, refsRaw] = parts;
    const subject = parts.slice(5).join("\x1f");
    const { refs, tags, head } = parseRefList(refsRaw ?? "");
    commits.push({
      sha: sha!.slice(0, 64),
      parents: (parentsRaw ?? "").split(" ").filter(Boolean).slice(0, MAX_COMMIT_PARENTS),
      author: (author ?? "").slice(0, 200),
      timestamp: (timestamp ?? "").slice(0, 64),
      subject: subject.slice(0, 2_000),
      refs: refs.slice(0, MAX_COMMIT_REFS).map((ref) => ref.slice(0, 200)),
      tags: tags.slice(0, MAX_COMMIT_REFS).map((tag) => tag.slice(0, 200)),
      head,
    });
  }
  return commits;
}

interface ParsedPatch {
  files: GitCommitDiffFile[];
  truncated: boolean;
}

function unquoteGitPath(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith("\"") || !value.endsWith("\"") || value.length < 2) return value;
  const encoded = value.slice(1, -1);
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    "\\": 0x5c,
    "\"": 0x22,
  };
  for (let index = 0; index < encoded.length;) {
    const char = encoded[index]!;
    if (char !== "\\") {
      const codePoint = encoded.codePointAt(index)!;
      const literal = String.fromCodePoint(codePoint);
      bytes.push(...Buffer.from(literal, "utf8"));
      index += literal.length;
      continue;
    }
    const escaped = encoded[index + 1];
    if (escaped === undefined) {
      bytes.push(0x5c);
      break;
    }
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      let cursor = index + 2;
      while (octal.length < 3 && cursor < encoded.length && /[0-7]/.test(encoded[cursor]!)) {
        octal += encoded[cursor]!;
        cursor += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      index = cursor;
      continue;
    }
    const decoded = escapes[escaped];
    if (decoded !== undefined) bytes.push(decoded);
    else bytes.push(...Buffer.from(escaped, "utf8"));
    index += 2;
  }
  return Buffer.from(bytes).toString("utf8");
}

function pathFromDiffMarker(line: string, marker: string, prefix: string): string | null {
  if (!line.startsWith(marker)) return null;
  const value = unquoteGitPath(line.slice(marker.length));
  if (value === "/dev/null") return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function pathFromDiffHeader(line: string): string | null {
  if (!line.startsWith("diff --git ")) return null;
  const raw = line.slice("diff --git ".length);
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let escaped = false;
  for (const char of raw) {
    if (!quoted && /\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += char;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") quoted = !quoted;
  }
  if (token) tokens.push(token);
  const bPath = tokens[1] ? unquoteGitPath(tokens[1]) : null;
  return bPath?.startsWith("b/") ? bPath.slice(2) : null;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

export function parseCommitPatch(stdout: string, options: { maxFiles: number; maxLines: number }): ParsedPatch {
  const files: GitCommitDiffFile[] = [];
  let truncated = false;
  let totalPatchLines = 0;
  const sections = stdout.split(/(?=^diff --git )/m);
  for (const section of sections) {
    if (!section.startsWith("diff --git ")) continue;
    if (files.length >= options.maxFiles) {
      truncated = true;
      break;
    }
    const lines = section.split("\n");
    let status = "M";
    let oldPath: string | null = null;
    let path: string | null = null;
    let binary = false;
    let hunkStart = -1;
    const headerScan = Math.min(lines.length, 12);
    for (let i = 0; i < headerScan; i += 1) {
      const line = lines[i]!;
      if (line.startsWith("new file mode")) status = "A";
      else if (line.startsWith("deleted file mode")) status = "D";
      else if (line.startsWith("rename from ")) {
        status = "R";
        oldPath = unquoteGitPath(line.slice("rename from ".length));
      } else if (line.startsWith("copy from ")) {
        status = "C";
        oldPath = unquoteGitPath(line.slice("copy from ".length));
      } else if (line.startsWith("rename to ")) {
        path = unquoteGitPath(line.slice("rename to ".length));
      } else if (line.startsWith("copy to ")) {
        path = unquoteGitPath(line.slice("copy to ".length));
      } else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        binary = true;
      }
      if (hunkStart < 0 && line.startsWith("@@")) hunkStart = i;
    }
    for (const line of lines) {
      const next = pathFromDiffMarker(line, "+++ ", "b/");
      if (next) {
        path = next;
        break;
      }
    }
    if (!path) {
      for (const line of lines) {
        const prev = pathFromDiffMarker(line, "--- ", "a/");
        if (prev) {
          path = prev;
          break;
        }
      }
    }
    if (!path) {
      // Binary and mode-only sections carry no ---/+++ markers; fall back to
      // the diff header's b-side path.
      path = pathFromDiffHeader(lines[0] ?? "");
    }
    if (!path) continue;
    if (status === "R" || status === "C") {
      // rename/copy headers already captured oldPath; path came from +++ b/.
    }
    const hunkLines = hunkStart >= 0 ? lines.slice(hunkStart) : [];
    let additions = 0;
    let deletions = 0;
    for (const line of hunkLines) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
    let patch: string | null = null;
    let fileTruncated = false;
    if (binary) {
      additions = 0;
      deletions = 0;
    } else if (hunkLines.length > 0) {
      const remaining = MAX_TOTAL_PATCH_LINES - totalPatchLines;
      const budget = Math.max(0, Math.min(options.maxLines, remaining));
      if (hunkLines.length > budget) {
        fileTruncated = true;
        truncated = true;
      }
      if (budget > 0) {
        patch = hunkLines.slice(0, budget).join("\n");
        totalPatchLines += Math.min(hunkLines.length, budget);
        const bounded = truncateUtf8(patch, MAX_PATCH_BYTES);
        patch = bounded.value;
        if (bounded.truncated) {
          fileTruncated = true;
          truncated = true;
        }
      } else {
        fileTruncated = true;
        truncated = true;
      }
    }
    files.push({
      path,
      oldPath,
      status,
      additions: binary ? null : additions,
      deletions: binary ? null : deletions,
      binary,
      patch,
      truncated: fileTruncated,
    });
  }
  return { files, truncated };
}

function parseNameStatus(stdout: string, maxFiles: number): { files: GitCommitDiffFile[]; truncated: boolean } {
  const tokens = stdout.split("\0").filter((token) => token.length > 0);
  const files: GitCommitDiffFile[] = [];
  let truncated = false;
  for (let i = 0; i < tokens.length;) {
    const statusToken = tokens[i]!;
    const letter = statusToken[0]!;
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      i += 3;
      if (!newPath) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push({
        path: newPath,
        oldPath: oldPath ?? null,
        status: letter,
        additions: null,
        deletions: null,
        binary: false,
        patch: null,
        truncated: true,
      });
    } else if ("MADTCUXB".includes(letter)) {
      const filePath = tokens[i + 1];
      i += 2;
      if (!filePath) continue;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      files.push({
        path: filePath,
        oldPath: null,
        status: letter,
        additions: null,
        deletions: null,
        binary: false,
        patch: null,
        truncated: true,
      });
    } else {
      i += 1;
    }
  }
  return { files, truncated };
}

export function createGitLog(options: {
  homePath: string;
  runCommand?: CommandRunner;
  now?: () => string;
}) {
  const homePath = resolve(options.homePath);
  const runCommand = options.runCommand ?? defaultRunCommand;
  const historySnapshots = new Map<string, {
    repoPath: string;
    commits: GitCommitSummary[];
    refreshedAt: string;
    lastTouchedAt: number;
    lastTouchedOrder: number;
  }>();
  let historyAccessOrder = 0;

  function sweepHistorySnapshots(now: number): void {
    for (const [token, snapshot] of historySnapshots) {
      if (now - snapshot.lastTouchedAt > HISTORY_SNAPSHOT_TTL_MS) historySnapshots.delete(token);
    }
  }

  function reserveHistorySnapshotSlot(now: number): void {
    sweepHistorySnapshots(now);
    if (historySnapshots.size < MAX_HISTORY_SNAPSHOTS) return;
    const oldest = [...historySnapshots.entries()]
      .sort((left, right) => left[1].lastTouchedOrder - right[1].lastTouchedOrder)[0];
    if (oldest) historySnapshots.delete(oldest[0]);
  }

  function nextHistoryCursor(token: string, offset: number, total: number): string | null {
    return offset < total ? `${token}.${offset}` : null;
  }

  // Resolves the project's repository path, or null when there is no usable
  // repository (not a git repo, or the Matrix home repo itself — never expose
  // OS-owned history through a project surface).
  async function resolveRepo(slug: string): Promise<RepoResolution> {
    if (!SlugSchema.safeParse(slug).success) {
      return failure(400, "invalid_slug", "Project slug is invalid");
    }
    const config = await readProjectRepoConfig(homePath, slug);
    if (!config) return failure(404, "not_found", "Project was not found");
    let repoTopLevel: string;
    try {
      const probe = await runCommand("git", ["rev-parse", "--show-toplevel"], {
        cwd: config.localPath,
        timeout: DEFAULT_TIMEOUT_MS,
      });
      repoTopLevel = probe.stdout.trim();
    } catch (err: unknown) {
      if (isNotAGitRepositoryError(err)) return { ok: true, repoPath: null };
      if (err instanceof Error) console.warn("[git-log] Failed to probe git worktree:", err.message);
      return failure(502, "git_request_failed", "Git request failed");
    }
    let repoReal: string;
    try {
      const [homeReal, resolvedRepo] = await Promise.all([realpath(homePath), realpath(repoTopLevel)]);
      repoReal = resolvedRepo;
      if (homeReal === repoReal) return { ok: true, repoPath: null };
    } catch (err: unknown) {
      if (err instanceof Error) console.warn("[git-log] Failed to resolve repository path:", err.message);
      return failure(502, "git_request_failed", "Git request failed");
    }
    return { ok: true, repoPath: repoReal };
  }

  return {
    async listCommits(
      slug: string,
      opts: { limit: number; cursor?: string },
    ): Promise<Result<{ commits: GitCommitSummary[]; nextCursor: string | null; refreshedAt: string }> | Failure> {
      const repo = await resolveRepo(slug);
      if (!repo.ok) return repo;
      const refreshedAt = nowIso(options.now);
      if (!repo.repoPath) return { ok: true, commits: [], nextCursor: null, refreshedAt };
      const now = Date.now();
      sweepHistorySnapshots(now);
      if (opts.cursor) {
        const parsedCursor = HISTORY_CURSOR_REGEX.exec(opts.cursor);
        const token = parsedCursor?.[1];
        const offset = parsedCursor?.[2] ? Number(parsedCursor[2]) : Number.NaN;
        const snapshot = token ? historySnapshots.get(token) : undefined;
        if (!snapshot || snapshot.repoPath !== repo.repoPath || !Number.isSafeInteger(offset)) {
          return failure(409, "stale_cursor", "Commit history changed. Refresh and try again");
        }
        snapshot.lastTouchedAt = now;
        snapshot.lastTouchedOrder = ++historyAccessOrder;
        const commits = snapshot.commits.slice(offset, offset + opts.limit);
        return {
          ok: true,
          commits,
          nextCursor: nextHistoryCursor(token!, offset + commits.length, snapshot.commits.length),
          refreshedAt: snapshot.refreshedAt,
        };
      }
      try {
        const result = await runCommand(
          "git",
          ["log", "--all", "--date-order", `--format=${LOG_FORMAT}`, "-n", String(MAX_HISTORY_SNAPSHOT_COMMITS + 1)],
          { cwd: repo.repoPath, timeout: DEFAULT_TIMEOUT_MS },
        );
        const snapshotCommits = parseGitLog(result.stdout).slice(0, MAX_HISTORY_SNAPSHOT_COMMITS);
        const commits = snapshotCommits.slice(0, opts.limit);
        let nextCursor: string | null = null;
        if (commits.length < snapshotCommits.length) {
          reserveHistorySnapshotSlot(now);
          let token: string;
          do {
            token = randomBytes(12).toString("hex");
          } while (historySnapshots.has(token));
          historySnapshots.set(token, {
            repoPath: repo.repoPath,
            commits: snapshotCommits,
            refreshedAt,
            lastTouchedAt: now,
            lastTouchedOrder: ++historyAccessOrder,
          });
          nextCursor = nextHistoryCursor(token, commits.length, snapshotCommits.length);
        }
        return {
          ok: true,
          commits,
          nextCursor,
          refreshedAt,
        };
      } catch (err: unknown) {
        if (isEmptyRepositoryError(err) || isNotAGitRepositoryError(err)) {
          return { ok: true, commits: [], nextCursor: null, refreshedAt };
        }
        if (err instanceof Error) console.warn("[git-log] Failed to list commits:", err.message);
        return failure(502, "git_request_failed", "Git request failed");
      }
    },

    async getCommitDiff(
      slug: string,
      sha: string,
      opts: { maxFiles: number; maxLines: number },
    ): Promise<Result<{ files: GitCommitDiffFile[]; truncated: boolean; refreshedAt: string }> | Failure> {
      if (!CommitShaSchema.safeParse(sha).success) {
        return failure(400, "invalid_sha", "Commit identifier is invalid");
      }
      const repo = await resolveRepo(slug);
      if (!repo.ok) return repo;
      const refreshedAt = nowIso(options.now);
      if (!repo.repoPath) return { ok: true, files: [], truncated: false, refreshedAt };
      try {
        const result = await runCommand(
          "git",
          ["show", "--format=", "--patch", "--no-color", "--default-prefix", "--no-ext-diff", "-M", "--first-parent", "--unified=3", sha],
          { cwd: repo.repoPath, timeout: DEFAULT_TIMEOUT_MS },
        );
        const parsed = parseCommitPatch(result.stdout, { maxFiles: opts.maxFiles, maxLines: opts.maxLines });
        return { ok: true, files: parsed.files, truncated: parsed.truncated, refreshedAt };
      } catch (err: unknown) {
        if (isUnknownRevisionError(err)) return failure(404, "not_found", "Commit was not found");
        if (!isMaxBufferError(err)) {
          if (err instanceof Error) console.warn("[git-log] Failed to read commit diff:", err.message);
          return failure(502, "git_request_failed", "Git request failed");
        }
      }
      // Patch exceeded the read buffer: degrade to the bounded name-status
      // listing so gigantic commits still show their file set.
      try {
        const fallback = await runCommand(
          "git",
          ["show", "--format=", "--name-status", "--no-color", "-z", "-M", "--first-parent", sha],
          { cwd: repo.repoPath, timeout: DEFAULT_TIMEOUT_MS },
        );
        const parsed = parseNameStatus(fallback.stdout, opts.maxFiles);
        return { ok: true, files: parsed.files, truncated: true, refreshedAt };
      } catch (err: unknown) {
        if (isUnknownRevisionError(err)) return failure(404, "not_found", "Commit was not found");
        if (err instanceof Error) console.warn("[git-log] Failed to read commit file list:", err.message);
        return failure(502, "git_request_failed", "Git request failed");
      }
    },
  };
}
