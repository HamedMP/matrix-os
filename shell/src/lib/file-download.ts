import {
  DownloadPathSchema, FILE_DOWNLOAD_TIMEOUT_MS,
  safeDownloadFilename, type FileDownloadResult,
} from "@matrix-os/contracts";
import type { FileDownloadTransport } from "@matrix-os/ui";

export function createBrowserFileDownload(baseUrl: string, deps: {
  fetchFn?: typeof fetch;
  save?: (url: string, filename: string) => void;
} = {}) {
  let disposed = false;
  function save(url: string, filename: string) {
    // Same-origin session cookies authenticate the native browser download.
    // Do not fetch the body into a Blob or expose credentials in the URL.
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    try { anchor.click(); }
    finally { anchor.remove(); }
  }
  const download: FileDownloadTransport = async ({ path, signal }) => {
    try {
      if (!DownloadPathSchema.safeParse(path).success) return { status: "error", code: "unavailable" };
      if (disposed || signal.aborted) return { status: "cancelled" };
      const url = `${baseUrl}/api/files/media?path=${encodeURIComponent(path)}&download=true`;
      // Check availability without buffering or transferring file bytes. After
      // handoff, the browser owns progress, disk writes, cancellation, and retry.
      const combined = AbortSignal.any([signal, AbortSignal.timeout(FILE_DOWNLOAD_TIMEOUT_MS)]);
      const response = await (deps.fetchFn ?? fetch)(url, {
        method: "HEAD", credentials: "same-origin", redirect: "error", signal: combined,
      });
      combined.throwIfAborted();
      if (disposed) return { status: "cancelled" };
      if (response.status !== 200) return { status: "error", code: response.status === 429 ? "busy" : [401, 403, 404].includes(response.status) ? "unavailable" : "failed" };
      (deps.save ?? save)(url, safeDownloadFilename(path));
      return { status: "handed_off" };
    } catch (error: unknown) {
      if (disposed || signal.aborted) return { status: "cancelled" };
      const result: FileDownloadResult = { status: "error", code: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "failed" };
      return result;
    }
  };
  return { download, dispose: () => { disposed = true; } };
}
