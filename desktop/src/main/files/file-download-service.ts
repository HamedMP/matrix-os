import { randomUUID } from "node:crypto";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { FileHandle } from "node:fs/promises";
import {
  FILE_DOWNLOAD_TIMEOUT_MS, MAX_FILE_DOWNLOAD_BYTES,
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
    let transferSignal: AbortSignal | null = null;
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
      transferSignal?.throwIfAborted();
    };

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

      transferSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS)]);
      const url = new URL("/api/files/blob", origin);
      url.searchParams.set("path", request.path);
      if (request.runtimeSlot !== "primary") url.searchParams.set("runtime", request.runtimeSlot);
      const response = await abortable((deps.fetchFn ?? fetch)(url.toString(), {
        headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" },
        redirect: "error",
        signal: transferSignal,
      }), transferSignal);
      if (response.body) reader = response.body.getReader();
      if (!response.ok) throw new DownloadFailure(response.status === 413 ? "too_large"
        : [401, 403, 404].includes(response.status) ? "unavailable" : "failed");
      const rawLength = response.headers.get("content-encoding") ? null : response.headers.get("content-length");
      const expected = rawLength === null ? null : Number(rawLength);
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw new DownloadFailure("failed");
      if (expected !== null && expected > MAX_FILE_DOWNLOAD_BYTES) throw new DownloadFailure("too_large");
      assertCurrent();
      temporary = join(dirname(destination), `.matrix-download-${randomUUID()}.partial`);
      file = await open(temporary, "wx", 0o600);
      let received = 0;
      if (reader) {
        while (true) {
          const { done, value } = await abortable(reader.read(), transferSignal);
          assertCurrent();
          if (done) break;
          received += value.byteLength;
          if (received > MAX_FILE_DOWNLOAD_BYTES) throw new DownloadFailure("too_large");
          // FileHandle.writeFile handles partial writes; each chunk appends at
          // the current file position without buffering the entire response.
          await file.writeFile(value);
        }
      }
      if (expected !== null && received !== expected) throw new DownloadFailure("failed");
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
      if (controller.signal.aborted) return { status: "cancelled" };
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
