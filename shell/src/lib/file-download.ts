import {
  DownloadPathSchema, FILE_DOWNLOAD_TIMEOUT_MS, MAX_FILE_DOWNLOAD_BYTES,
  safeDownloadFilename, type FileDownloadResult,
} from "@matrix-os/contracts";
import type { FileDownloadTransport } from "@matrix-os/ui";

export function createBrowserFileDownload(baseUrl: string, deps: {
  fetchFn?: typeof fetch;
  save?: (blob: Blob, filename: string) => void;
} = {}) {
  let objectUrl: string | null = null;
  let revokeTimer: ReturnType<typeof setTimeout> | null = null;
  function dispose() {
    if (revokeTimer !== null) clearTimeout(revokeTimer);
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    revokeTimer = null;
    objectUrl = null;
  }
  function save(blob: Blob, filename: string) {
    // Retain at most one object URL, and revoke even if Files stays mounted.
    dispose();
    objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    try { anchor.click(); }
    finally {
      anchor.remove();
      revokeTimer = setTimeout(dispose, 30_000);
    }
  }
  const download: FileDownloadTransport = async ({ path, signal }) => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS)]);
    try {
      if (!DownloadPathSchema.safeParse(path).success) return { status: "error", code: "unavailable" };
      combined.throwIfAborted();
      const response = await (deps.fetchFn ?? fetch)(`${baseUrl}/api/files/blob?path=${encodeURIComponent(path)}`, {
        credentials: "same-origin", redirect: "error", signal: combined,
      });
      if (response.body) reader = response.body.getReader();
      combined.throwIfAborted();
      if (!response.ok) return { status: "error", code: response.status === 413 ? "too_large" : [401, 403, 404].includes(response.status) ? "unavailable" : "failed" };
      // Fetch decodes compressed responses. Content-Length then describes wire
      // bytes, so only compare decoded bytes for uncompressed responses.
      const rawLength = response.headers.get("content-encoding") ? null : response.headers.get("content-length");
      const expected = rawLength === null ? null : Number(rawLength);
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) return { status: "error", code: "failed" };
      if (expected !== null && expected > MAX_FILE_DOWNLOAD_BYTES) return { status: "error", code: "too_large" };
      // One bounded buffer avoids millions of tiny stream chunks retaining
      // an unbounded amount of array/object overhead.
      const buffer = new Uint8Array(MAX_FILE_DOWNLOAD_BYTES);
      let total = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          combined.throwIfAborted();
          if (done) break;
          if (total + value.byteLength > MAX_FILE_DOWNLOAD_BYTES) return { status: "error", code: "too_large" };
          buffer.set(value, total);
          total += value.byteLength;
        }
      }
      if (expected !== null && total !== expected) return { status: "error", code: "failed" };
      combined.throwIfAborted();
      (deps.save ?? save)(new Blob([buffer.subarray(0, total)], { type: "application/octet-stream" }), safeDownloadFilename(path));
      return { status: "handed_off" };
    } catch (error: unknown) {
      if (signal.aborted) return { status: "cancelled" };
      const result: FileDownloadResult = { status: "error", code: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "failed" };
      return result;
    } finally {
      if (reader) {
        try { await reader.cancel(); }
        catch (error: unknown) { console.warn("[file-download] stream cleanup failed", error instanceof Error ? error.name : "UnknownError"); }
        reader.releaseLock();
      }
    }
  };
  return { download, dispose };
}
