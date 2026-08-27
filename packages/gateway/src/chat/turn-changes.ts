import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  CanonicalChatTurnChangeSetSchema,
  CanonicalChatTurnDiffResponseSchema,
  CanonicalChatTurnFileReadQuerySchema,
  type CanonicalChatTurnChangeSet,
} from "@matrix-os/contracts";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_GIT_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_READ_LIMIT_BYTES = 256 * 1024;
const MAX_CHANGE_FILES = 200;
const GIT_OBJECT_ID = /^[a-f0-9]{40,64}$/;

export interface ChatTurnCheckpoint {
  tree: string;
  head: string;
}

export interface ChatTurnChangeEnd extends ChatTurnCheckpoint {}

export type ChatTurnGitRunner = (
  root: string,
  args: readonly string[],
  options?: { env?: NodeJS.ProcessEnv; maxBuffer?: number; timeout?: number },
) => Promise<string>;

export class ChatTurnChangeCaptureError extends Error {
  constructor(readonly code: "capture_unavailable" | "file_not_found" | "file_unavailable" | "binary_file") {
    super(code);
    this.name = "ChatTurnChangeCaptureError";
  }
}

function safeGitError(error: unknown): ChatTurnChangeCaptureError {
  console.warn("[chat/turn-changes] Git checkpoint unavailable:", error instanceof Error ? error.name : "UnknownError");
  return new ChatTurnChangeCaptureError("capture_unavailable");
}

const defaultRunGit: ChatTurnGitRunner = async (root, args, options) => {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: options?.env,
    maxBuffer: options?.maxBuffer ?? DEFAULT_GIT_OUTPUT_BYTES,
    timeout: options?.timeout ?? DEFAULT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout;
};

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new ChatTurnChangeCaptureError("capture_unavailable")), timeoutMs);
    timer.unref?.();
    promise.then(resolvePromise, rejectPromise).finally(() => clearTimeout(timer));
  });
}

function fsCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function checkpointRevision(tree: string): string {
  if (!GIT_OBJECT_ID.test(tree)) throw new ChatTurnChangeCaptureError("capture_unavailable");
  return `tree_${tree}`;
}

interface NameStatus {
  path: string;
  previousPath?: string;
  status: CanonicalChatTurnChangeSet["files"][number]["status"];
}

function parseNameStatus(output: string): NameStatus[] {
  const values = output.split("\0");
  const files: NameStatus[] = [];
  for (let index = 0; index < values.length;) {
    const status = values[index++];
    if (!status) continue;
    if (status.startsWith("R")) {
      const previousPath = values[index++];
      const path = values[index++];
      if (previousPath && path) files.push({ path, previousPath, status: "renamed" });
      continue;
    }
    const path = values[index++];
    if (!path) continue;
    files.push({
      path,
      status: status.startsWith("A") ? "added"
        : status.startsWith("D") ? "deleted"
          : status.startsWith("T") ? "binary"
            : "modified",
    });
  }
  return files;
}

export function parseBoundedNumstat(
  output: string,
  retainedPaths: readonly string[],
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const retained = new Set(retainedPaths.slice(0, MAX_CHANGE_FILES));
  const values = output.split("\0");
  const result = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (let index = 0; index < values.length;) {
    const record = values[index++];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      index += 1;
      path = values[index++] ?? "";
    }
    if (!path) continue;
    if (!retained.has(path) || result.size >= MAX_CHANGE_FILES) continue;
    const binary = additionsText === "-" || deletionsText === "-";
    result.set(path, {
      additions: binary ? 0 : Number.parseInt(additionsText, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deletionsText, 10) || 0,
      binary,
    });
  }
  return result;
}

function labelFor(fileCount: number, concurrent: boolean): CanonicalChatTurnChangeSet["label"] {
  if (fileCount === 0) return "No workspace changes";
  return concurrent
    ? "Concurrent workspace changes observed during this turn"
    : "Workspace changes observed during this turn";
}

function parseDiffHunks(output: string, path: string) {
  const hunks: Array<{
    id: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    heading?: string;
    partial: boolean;
    lines: Array<Record<string, unknown>>;
  }> = [];
  let current: typeof hunks[number] | undefined;
  let oldLine = 0;
  let newLine = 0;
  let resultPartial = false;
  for (const line of output.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (header) {
      if (hunks.length >= 100) {
        resultPartial = true;
        current = undefined;
        continue;
      }
      oldLine = Number.parseInt(header[1] ?? "0", 10);
      newLine = Number.parseInt(header[3] ?? "0", 10);
      const heading = (header[5] ?? "").trim().slice(0, 120);
      current = {
        id: `hunk_${createHash("sha256").update(`${path}\0${hunks.length}`).digest("hex").slice(0, 24)}`,
        oldStart: oldLine,
        oldLines: Number.parseInt(header[2] ?? "1", 10),
        newStart: newLine,
        newLines: Number.parseInt(header[4] ?? "1", 10),
        ...(heading ? { heading } : {}),
        partial: false,
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current || line.startsWith("\\ No newline")) continue;
    if (![" ", "+", "-"].includes(line[0] ?? "")) continue;
    if (current.lines.length >= 120) {
      current.partial = true;
      resultPartial = true;
      continue;
    }
    const rawContent = line.slice(1);
    const content = rawContent.slice(0, 1_000);
    if (content.length < rawContent.length) {
      current.partial = true;
      resultPartial = true;
    }
    if (line.startsWith(" ")) {
      current.lines.push({ kind: "context", oldLine, newLine, content });
      oldLine += 1;
      newLine += 1;
    } else if (line.startsWith("+")) {
      current.lines.push({ kind: "add", newLine, content });
      newLine += 1;
    } else {
      current.lines.push({ kind: "remove", oldLine, content });
      oldLine += 1;
    }
  }
  return { hunks, partial: resultPartial };
}

export function createChatTurnChangeCapture(options: {
  runGit?: ChatTurnGitRunner;
  timeoutMs?: number;
  outputLimitBytes?: number;
  readLimitBytes?: number;
} = {}) {
  const runGit = options.runGit ?? defaultRunGit;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 30_000));
  const outputLimitBytes = Math.max(1_024, Math.min(options.outputLimitBytes ?? DEFAULT_GIT_OUTPUT_BYTES, DEFAULT_GIT_OUTPUT_BYTES));
  const readLimitBytes = Math.max(1, Math.min(options.readLimitBytes ?? DEFAULT_READ_LIMIT_BYTES, DEFAULT_READ_LIMIT_BYTES));

  const git = async (root: string, args: readonly string[], commandOptions?: { env?: NodeJS.ProcessEnv; maxBuffer?: number }) => {
    try {
      return await withTimeout(runGit(root, args, { ...commandOptions, timeout: timeoutMs }), timeoutMs);
    } catch (error: unknown) {
      if (error instanceof ChatTurnChangeCaptureError) throw error;
      throw safeGitError(error);
    }
  };

  const snapshot = async (rootInput: string): Promise<ChatTurnCheckpoint> => {
    const root = resolve(rootInput);
    let temp = "";
    try {
      const stats = await lstat(root);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ChatTurnChangeCaptureError("capture_unavailable");
      temp = await mkdtemp(join(tmpdir(), "matrix-chat-turn-checkpoint-"));
      const indexPath = join(temp, "index");
      const env = { ...process.env, GIT_INDEX_FILE: indexPath, GIT_OPTIONAL_LOCKS: "0" };
      await git(root, ["read-tree", "HEAD"], { env, maxBuffer: 64 * 1024 });
      await git(root, ["add", "-A", "--", "."], { env, maxBuffer: outputLimitBytes });
      const [tree, head] = await Promise.all([
        git(root, ["write-tree"], { env, maxBuffer: 64 * 1024 }),
        git(root, ["rev-parse", "HEAD"], { maxBuffer: 64 * 1024 }),
      ]);
      const parsed = { tree: tree.trim(), head: head.trim() };
      if (!GIT_OBJECT_ID.test(parsed.tree) || !GIT_OBJECT_ID.test(parsed.head)) {
        throw new ChatTurnChangeCaptureError("capture_unavailable");
      }
      return parsed;
    } catch (error: unknown) {
      if (error instanceof ChatTurnChangeCaptureError) throw error;
      throw safeGitError(error);
    } finally {
      if (temp) {
        await rm(temp, { recursive: true, force: true }).catch((error: unknown) => {
          console.warn("[chat/turn-changes] Checkpoint temp cleanup failed:", error instanceof Error ? error.name : "UnknownError");
        });
      }
    }
  };

  return {
    captureStart: snapshot,

    async captureFinal(input: {
      root: string;
      start: ChatTurnCheckpoint;
      identity: {
        chatId: string;
        turnId: string;
        runId: string;
        projectId: string;
        executionRoot: CanonicalChatTurnChangeSet["executionRoot"];
      };
      capturedAt: string;
    }): Promise<{ changes: CanonicalChatTurnChangeSet; end: ChatTurnChangeEnd }> {
      const end = await snapshot(input.root);
      const [names, numstat] = await Promise.all([
        git(input.root, ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--name-status", "-z", input.start.tree, end.tree, "--", "."], { maxBuffer: outputLimitBytes }),
        git(input.root, ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--numstat", "-z", input.start.tree, end.tree, "--", "."], { maxBuffer: outputLimitBytes }),
      ]);
      const nameStatus = parseNameStatus(names);
      const stats = parseBoundedNumstat(
        numstat,
        nameStatus.slice(0, MAX_CHANGE_FILES).map((file) => file.path),
      );
      const changedFileCount = nameStatus.length;
      const projected = nameStatus.slice(0, MAX_CHANGE_FILES).map((file) => {
        const counts = stats.get(file.path) ?? { additions: 0, deletions: 0, binary: file.status === "binary" };
        return {
          ...file,
          status: counts.binary ? "binary" as const : file.status,
          additions: counts.additions,
          deletions: counts.deletions,
          partial: counts.binary,
        };
      });
      const additions = projected.reduce((total, file) => total + file.additions, 0);
      const deletions = projected.reduce((total, file) => total + file.deletions, 0);
      const concurrent = input.start.head !== end.head;
      const partial = nameStatus.length > MAX_CHANGE_FILES || projected.some((file) => file.partial);
      const revision = createHash("sha256")
        .update(JSON.stringify({ version: 1, ...input.identity, before: input.start.tree, after: end.tree }))
        .digest("hex");
      return {
        end,
        changes: CanonicalChatTurnChangeSetSchema.parse({
          ...input.identity,
          revision: `turnrev_${revision}`,
          beforeRevision: checkpointRevision(input.start.tree),
          afterRevision: checkpointRevision(end.tree),
          source: "workspace_checkpoints",
          label: labelFor(changedFileCount, concurrent),
          concurrent,
          partial,
          files: projected,
          totals: { changedFileCount, additions, deletions },
          capturedAt: input.capturedAt,
        }),
      };
    },

    async readFile(input: {
      root: string;
      path: string;
      version: "before" | "after" | "current";
      start: ChatTurnCheckpoint;
      end: ChatTurnChangeEnd;
    }): Promise<{
      path: string;
      version: "before" | "after" | "current";
      label: "Before turn" | "After turn" | "Current file";
      content: string;
      encoding: "utf8";
      truncated: boolean;
      sizeBytes: number;
    }> {
      const parsedRequest = CanonicalChatTurnFileReadQuerySchema.safeParse({ path: input.path, version: input.version });
      if (!parsedRequest.success) throw new ChatTurnChangeCaptureError("file_not_found");
      const request = parsedRequest.data;
      const root = await realpath(resolve(input.root)).catch((error: unknown) => {
        console.warn("[chat/turn-changes] Workspace root unavailable:", error instanceof Error ? error.name : "UnknownError");
        throw new ChatTurnChangeCaptureError("file_unavailable");
      });
      let content: Buffer;
      let sizeBytes: number;
      if (request.version === "current") {
        const target = resolve(root, request.path);
        if (!isWithin(root, target)) throw new ChatTurnChangeCaptureError("file_not_found");
        let stats: Awaited<ReturnType<typeof lstat>>;
        let targetReal: string;
        try {
          stats = await lstat(target);
          if (stats.isSymbolicLink() || !stats.isFile()) throw new ChatTurnChangeCaptureError("file_not_found");
          targetReal = await realpath(target);
        } catch (error: unknown) {
          if (error instanceof ChatTurnChangeCaptureError) throw error;
          if (["ENOENT", "ENOTDIR", "EACCES"].includes(fsCode(error))) throw new ChatTurnChangeCaptureError("file_not_found");
          throw new ChatTurnChangeCaptureError("file_unavailable");
        }
        if (!isWithin(root, targetReal)) throw new ChatTurnChangeCaptureError("file_not_found");
        const handle = await open(targetReal, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error: unknown) => {
          if (["ELOOP", "ENOENT", "ENOTDIR", "EACCES"].includes(fsCode(error))) {
            throw new ChatTurnChangeCaptureError("file_not_found");
          }
          throw new ChatTurnChangeCaptureError("file_unavailable");
        });
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) {
            throw new ChatTurnChangeCaptureError("file_not_found");
          }
          sizeBytes = Number(opened.size);
          const buffer = Buffer.alloc(readLimitBytes + 1);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          content = buffer.subarray(0, Number(bytesRead));
        } finally {
          await handle.close();
        }
      } else {
        const tree = request.version === "before" ? input.start.tree : input.end.tree;
        const listing = await git(root, ["ls-tree", "-z", tree, "--", request.path], { maxBuffer: 16 * 1024 });
        const match = listing.match(/^([0-9]{6}) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/);
        if (!match || match[3] !== request.path || match[1] === "120000") {
          throw new ChatTurnChangeCaptureError("file_not_found");
        }
        const objectId = match[2]!;
        sizeBytes = Number.parseInt((await git(root, ["cat-file", "-s", objectId], { maxBuffer: 64 * 1024 })).trim(), 10);
        const text = await git(root, ["cat-file", "blob", objectId], { maxBuffer: readLimitBytes + 1 });
        content = Buffer.from(text, "utf8");
      }
      if (content.includes(0)) throw new ChatTurnChangeCaptureError("binary_file");
      const truncated = sizeBytes > readLimitBytes || content.byteLength > readLimitBytes;
      const bounded = content.subarray(0, readLimitBytes);
      return {
        path: request.path,
        version: request.version,
        label: request.version === "before" ? "Before turn" : request.version === "after" ? "After turn" : "Current file",
        content: bounded.toString("utf8"),
        encoding: "utf8",
        truncated,
        sizeBytes,
      };
    },

    async readDiff(input: {
      root: string;
      path: string;
      start: ChatTurnCheckpoint;
      end: ChatTurnChangeEnd;
      file: CanonicalChatTurnChangeSet["files"][number];
    }) {
      const parsedPath = CanonicalChatTurnFileReadQuerySchema.safeParse({ path: input.path, version: "after" });
      if (!parsedPath.success || input.file.path !== parsedPath.data.path) {
        throw new ChatTurnChangeCaptureError("file_not_found");
      }
      if (input.file.status === "binary") {
        return CanonicalChatTurnDiffResponseSchema.shape.file.parse({ ...input.file, hunks: [] });
      }
      const output = await git(resolve(input.root), [
        "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=3",
        input.start.tree, input.end.tree, "--", input.file.path,
      ], { maxBuffer: outputLimitBytes });
      const parsed = parseDiffHunks(output, input.file.path);
      return CanonicalChatTurnDiffResponseSchema.shape.file.parse({
        ...input.file,
        partial: input.file.partial || parsed.partial,
        hunks: parsed.hunks,
      });
    },
  };
}

export type ChatTurnChangeCapture = ReturnType<typeof createChatTurnChangeCapture>;
