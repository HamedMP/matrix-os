import { lstat, mkdir, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { resolveExistingFileApiPath, resolveWritableFileApiPath } from "../path-security.js";

export const CHAT_ATTACHMENT_DIRECTORY = "temporary/desktop-chat";
export const CHAT_ATTACHMENT_CLEANUP_POLICY = {
  ttlMs: 7 * 24 * 60 * 60 * 1_000,
  maxFiles: 200,
} as const;
export const CHAT_ATTACHMENT_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const DIRECT_CHAT_ATTACHMENT_PATH = /^temporary\/desktop-chat\/([^/\\\u0000-\u001f\u007f]{1,255})$/;

export interface ChatAttachmentCleanupPolicy {
  ttlMs: number;
  maxFiles: number;
}

export interface ChatAttachmentCleanupLifecycle {
  runNow(): Promise<number>;
  waitForIdle(): Promise<void>;
  close(): void;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validatePolicy(policy: ChatAttachmentCleanupPolicy): void {
  if (!Number.isSafeInteger(policy.ttlMs) || policy.ttlMs < 0) {
    throw new Error("InvalidChatAttachmentTtl");
  }
  if (!Number.isSafeInteger(policy.maxFiles) || policy.maxFiles < 0) {
    throw new Error("InvalidChatAttachmentCount");
  }
}

export function isDirectChatAttachmentPath(path: string): boolean {
  const match = DIRECT_CHAT_ATTACHMENT_PATH.exec(path);
  return match !== null && match[1] !== "." && match[1] !== "..";
}

interface CleanupCandidate {
  path: string;
  name: string;
  mtimeMs: number;
}

function compareNewestFirst(left: CleanupCandidate, right: CleanupCandidate): number {
  return right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name);
}

function insertNewestFirst(retained: CleanupCandidate[], candidate: CleanupCandidate): void {
  const insertAt = retained.findIndex((current) => compareNewestFirst(candidate, current) < 0);
  retained.splice(insertAt === -1 ? retained.length : insertAt, 0, candidate);
}

async function unlinkCandidate(candidate: CleanupCandidate): Promise<boolean> {
  try {
    await unlink(candidate.path);
    return true;
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function cleanupChatAttachmentFiles(
  homePath: string,
  policy: ChatAttachmentCleanupPolicy,
  now = Date.now(),
): Promise<number> {
  validatePolicy(policy);
  const writableDirectory = resolveWritableFileApiPath(homePath, CHAT_ATTACHMENT_DIRECTORY);
  if (!writableDirectory) return 0;
  await mkdir(writableDirectory, { recursive: true, mode: 0o700 });
  const directory = resolveExistingFileApiPath(homePath, CHAT_ATTACHMENT_DIRECTORY);
  if (!directory) return 0;

  const retained: CleanupCandidate[] = [];
  let removed = 0;
  const handle = await opendir(directory);
  for await (const entry of handle) {
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const candidate = { path, name: entry.name, mtimeMs: info.mtimeMs };
      if (now - candidate.mtimeMs > policy.ttlMs || policy.maxFiles === 0) {
        if (await unlinkCandidate(candidate)) removed += 1;
        continue;
      }

      if (retained.length < policy.maxFiles) {
        insertNewestFirst(retained, candidate);
        continue;
      }

      const oldestRetained = retained.at(-1)!;
      if (compareNewestFirst(candidate, oldestRetained) < 0) {
        retained.pop();
        if (await unlinkCandidate(oldestRetained)) removed += 1;
        insertNewestFirst(retained, candidate);
      } else {
        if (await unlinkCandidate(candidate)) removed += 1;
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
  }
  return removed;
}

export function createChatAttachmentCleanupLifecycle(options: {
  homePath: string;
  policy?: ChatAttachmentCleanupPolicy;
  intervalMs?: number;
  schedule?: (callback: () => void, intervalMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}): ChatAttachmentCleanupLifecycle {
  const policy = options.policy ?? CHAT_ATTACHMENT_CLEANUP_POLICY;
  const intervalMs = options.intervalMs ?? CHAT_ATTACHMENT_CLEANUP_INTERVAL_MS;
  validatePolicy(policy);
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error("InvalidChatAttachmentCleanupInterval");
  }
  const schedule = options.schedule ?? ((callback, ms) => setInterval(callback, ms));
  const cancel = options.cancel ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let closed = false;
  let inFlight: Promise<number> | null = null;

  const runNow = (): Promise<number> => {
    if (closed) return Promise.resolve(0);
    if (inFlight) return inFlight;
    const cleanup = cleanupChatAttachmentFiles(options.homePath, policy);
    inFlight = cleanup.then(
      (removed) => {
        inFlight = null;
        return removed;
      },
      (error: unknown) => {
        inFlight = null;
        throw error;
      },
    );
    return inFlight;
  };

  const handle = schedule(() => {
    void runNow().catch((error: unknown) => options.onError?.(error));
  }, intervalMs);
  if (typeof handle === "object" && handle !== null && "unref" in handle) {
    const unref = (handle as { unref?: unknown }).unref;
    if (typeof unref === "function") unref.call(handle);
  }

  return {
    runNow,
    async waitForIdle() {
      await inFlight;
    },
    close() {
      if (closed) return;
      closed = true;
      cancel(handle);
    },
  };
}
