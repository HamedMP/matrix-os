import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  FILE_DOWNLOAD_TIMEOUT_MS, FILE_DOWNLOAD_IDLE_TIMEOUT_MS,
  FileDownloadRequestSchema, safeDownloadFilename,
  type FileDownloadRequest, type FileDownloadResult, type FileDownloadErrorCode,
} from "@matrix-os/contracts";

interface DownloadAuth {
  getToken(): string | null;
  getGatewayOrigin(): string;
  getStatus(): { signedIn: boolean; runtimeSlot: string; authGeneration: number };
}
interface DownloadDeps {
  auth: DownloadAuth;
  // The native dialog must confirm overwrites. Renderer paths are never accepted.
  chooseDestination: (filename: string) => Promise<string | null>;
  fetchFn?: typeof fetch;
  idleTimeoutMs?: number;
}
class DownloadFailure extends Error {
  constructor(readonly code: FileDownloadErrorCode) { super(code); }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function destinationSnapshot(path: string) {
  try {
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) throw new DownloadFailure("destination_changed");
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error: unknown) {
    if (isMissing(error)) return null;
    throw error;
  }
}

// Race even mock/third-party promises against abort, remove listeners on settle,
// and keep late results consumed. A canceled native dialog cannot initiate I/O.
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

export function createFileDownloadService(deps: DownloadDeps) {
  let active: { id: string; controller: AbortController; done: Promise<FileDownloadResult> } | null = null;
  let disposed = false;
  let dialogPending = false;

  async function run(request: FileDownloadRequest, controller: AbortController): Promise<FileDownloadResult> {
    let temporary: string | null = null;
    let file: FileHandle | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const token = deps.auth.getToken();
    const origin = deps.auth.getGatewayOrigin();
    const current = () => {
      const status = deps.auth.getStatus();
      return status.signedIn && status.runtimeSlot === request.runtimeSlot
        && status.authGeneration === request.authGeneration
        && deps.auth.getGatewayOrigin() === origin && deps.auth.getToken() === token;
    };
    const assertCurrent = () => {
      if (!current()) controller.abort();
      controller.signal.throwIfAborted();
    };

    async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
      const timer = setTimeout(() => controller.abort(new DOMException("Download stalled", "TimeoutError")), ms);
      try { return await abortable(promise, controller.signal); }
      finally { clearTimeout(timer); }
    }

    try {
      if (!token || !current()) return { status: "cancelled" };
      const dialogSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]);
      dialogPending = true;
      const dialog = Promise.resolve().then(() => {
        dialogSignal.throwIfAborted();
        return deps.chooseDestination(safeDownloadFilename(request.path));
      })
        .finally(() => { dialogPending = false; });
      const destination = await abortable(dialog, dialogSignal);
      assertCurrent();
      if (!destination) return { status: "cancelled" };
      if (!isAbsolute(destination)) throw new DownloadFailure("failed");
      const before = await destinationSnapshot(destination);
      assertCurrent();

      const url = new URL("/api/files/media", origin);
      url.searchParams.set("path", request.path);
      url.searchParams.set("download", "true");
      if (request.runtimeSlot !== "primary") url.searchParams.set("runtime", request.runtimeSlot);
      const response = await withTimeout((deps.fetchFn ?? fetch)(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" },
        redirect: "error",
        signal: controller.signal,
      }), FILE_DOWNLOAD_TIMEOUT_MS);
      if (response.body) reader = response.body.getReader();
      if (response.status !== 200) throw new DownloadFailure(response.status === 429 ? "busy"
        : [401, 403, 404].includes(response.status) ? "unavailable" : "failed");
      const rawLength = response.headers.get("content-encoding") ? null : response.headers.get("content-length");
      const expected = rawLength === null ? null : Number(rawLength);
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new DownloadFailure("failed");
      assertCurrent();
      temporary = join(dirname(destination), `.matrix-download-${randomUUID()}.partial`);
      file = await open(temporary, "wx", 0o600);
      let received = 0;
      let progressAtAttempt = 0;
      let failuresWithoutProgress = 0;
      const rawTag = response.headers.get("etag");
      const resumeTag = rawTag && rawTag.length <= 256 && /^"[^"\r\n]+"$/.test(rawTag) ? rawTag : null;
      while (true) {
        try {
          if (reader) {
            while (true) {
              const { done, value } = await withTimeout(reader.read(), deps.idleTimeoutMs ?? FILE_DOWNLOAD_IDLE_TIMEOUT_MS);
              assertCurrent();
              if (done) break;
              const next = received + value.byteLength;
              if (!Number.isSafeInteger(next) || (expected !== null && next > expected)) throw new DownloadFailure("failed");
              try { await file.writeFile(value); }
              catch (writeError: unknown) {
                console.warn("[file-download] destination write failed", writeError);
                throw new DownloadFailure("failed");
              }
              received = next;
            }
          }
          if (expected !== null && received !== expected) throw new Error("Download ended early");
          break;
        } catch (error: unknown) {
          assertCurrent();
          if (error instanceof DownloadFailure || expected === null || !resumeTag || received >= expected) throw error;
          // Reconnect after infrastructure/network interruption without joining
          // different file versions. Repeated failures with no progress are
          // bounded; a progressing download can span multiple request lifetimes.
          failuresWithoutProgress = received === progressAtAttempt ? failuresWithoutProgress + 1 : 0;
          if (failuresWithoutProgress > 2) throw error;
          progressAtAttempt = received;
          console.warn("[file-download] resuming interrupted source", error);
          if (reader) {
            try { await reader.cancel(); }
            catch (cleanupError: unknown) { console.warn("[file-download] interrupted stream cleanup", cleanupError); }
            reader.releaseLock();
            reader = null;
          }
          let retryTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await abortable(new Promise<void>((resolve) => { retryTimer = setTimeout(resolve, 250 * (failuresWithoutProgress + 1)); }), controller.signal);
          } finally { clearTimeout(retryTimer); }
          assertCurrent();
          const resumed = await withTimeout((deps.fetchFn ?? fetch)(url.toString(), {
            headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity", Range: `bytes=${received}-`, "If-Range": resumeTag },
            redirect: "error", signal: controller.signal,
          }), FILE_DOWNLOAD_TIMEOUT_MS);
          if (resumed.body) reader = resumed.body.getReader();
          const range = resumed.headers.get("content-range");
          if (resumed.status !== 206 || resumed.headers.get("etag") !== resumeTag
            || resumed.headers.get("content-encoding")
            || range !== `bytes ${received}-${expected - 1}/${expected}`
            || Number(resumed.headers.get("content-length")) !== expected - received) {
            throw new DownloadFailure("unavailable");
          }
        }
      }
      await file.sync();
      await file.close();
      file = null;
      const after = await destinationSnapshot(destination);
      if (after !== before) throw new DownloadFailure("destination_changed");
      assertCurrent();
      if (before === null) {
        try { await link(temporary, destination); }
        catch (error: unknown) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new DownloadFailure("destination_changed");
          throw error;
        }
      } else {
        await rename(temporary, destination);
      }
      return { status: "saved" };
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return controller.signal.reason instanceof Error && controller.signal.reason.name === "TimeoutError"
          ? { status: "error", code: "timeout" } : { status: "cancelled" };
      }
      if (error instanceof Error && error.name === "TimeoutError") return { status: "error", code: "timeout" };
      if (error instanceof DownloadFailure) return { status: "error", code: error.code };
      console.warn("[file-download] could not save file", error);
      return { status: "error", code: "failed" };
    } finally {
      if (reader) {
        try { await reader.cancel(); }
        catch (error: unknown) { console.warn("[file-download] stream cleanup failed", error); }
        reader.releaseLock();
      }
      if (file) {
        try { await file.close(); }
        catch (error: unknown) { console.warn("[file-download] file close failed", error); }
      }
      if (temporary) {
        try { await unlink(temporary); }
        catch (error: unknown) { if (!isMissing(error)) console.warn("[file-download] partial cleanup failed", error); }
      }
    }
  }

  return {
    download(input: FileDownloadRequest): Promise<FileDownloadResult> {
      const parsed = FileDownloadRequestSchema.safeParse(input);
      if (!parsed.success) return Promise.resolve({ status: "error", code: "unavailable" });
      if (disposed) return Promise.resolve({ status: "cancelled" });
      if (active || dialogPending) return Promise.resolve({ status: "error", code: "busy" });
      const controller = new AbortController();
      const done = run(parsed.data, controller).finally(() => { active = null; });
      active = { id: input.requestId, controller, done };
      return done;
    },
    cancel(requestId: string): { ok: boolean } {
      if (!active || active.id !== requestId) return { ok: false };
      active.controller.abort();
      return { ok: true };
    },
    cancelAll(): void { active?.controller.abort(); },
    async dispose(): Promise<void> {
      disposed = true;
      active?.controller.abort();
      await active?.done;
    },
  };
}
