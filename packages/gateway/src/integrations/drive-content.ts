import { z } from "zod/v4";
import { DriveReadInput } from "./drive-validation.js";
import { createReadCoalescer } from "./read-coalescer.js";

export const DRIVE_CONTENT_MAX_BYTES = 512 * 1024;
type ErrorCode = "unsupported_file_type" | "file_too_large" | "file_access_denied" | "file_not_found" | "rate_limited" | "read_failed";
export class DriveContentError extends Error {
  constructor(readonly code: ErrorCode = "read_failed") { super("File content unavailable"); this.name = "DriveContentError"; }
}
export interface DriveFileContent { fileId: string; name?: string; mimeType: string; content: string; bytes: number }
const defaults: Record<string, string> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const isText = (mime: string) => /^text\//.test(mime) || ["application/json", "application/xml", "application/yaml", "application/x-yaml", "application/octet-stream"].includes(mime);
function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch((error: unknown) => console.warn("[integrations] File body cancellation failed", { errorName: error instanceof Error ? error.name : "UnknownError" }));
}
async function deadline<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), new Promise<never>((_, reject) => {
      abort = () => reject(new DriveContentError()); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}
async function readBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const size = response.headers.get("content-length");
  if (!response.body || (size !== null && (!/^\d+$/.test(size) || Number(size) > maxBytes))) {
    cancel(response.body); throw new DriveContentError("file_too_large");
  }
  const reader = response.body.getReader();
  const buffer = new Uint8Array(maxBytes); let bytes = 0;
  try {
    while (true) {
      const next = await deadline(() => reader.read(), signal);
      if (next.done) break;
      if (next.value.byteLength > maxBytes - bytes) throw new DriveContentError("file_too_large");
      buffer.set(next.value, bytes);
      bytes += next.value.byteLength;
    }
    signal.throwIfAborted();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes));
  } catch (error: unknown) {
    cancel(reader);
    if (error instanceof DriveContentError) throw error;
    console.warn("[integrations] File decode failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    throw new DriveContentError();
  } finally { reader.releaseLock(); }
}

/** Fixed Drive endpoints only; Pipedream retains credentials and owner/account authorization. */
export function createDriveContentReader(options: {
  projectId: string; environment: "development" | "production"; getAccessToken: () => Promise<string>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}) {
  const projectId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(options.projectId);
  const environment = z.enum(["development", "production"]).parse(options.environment);
  const coalesce = createReadCoalescer();
  return async (raw: unknown): Promise<DriveFileContent> => {
    const input = DriveReadInput.parse(raw);
    const { externalUserId, accountId, fileId } = input;
    return coalesce(JSON.stringify([externalUserId, accountId, fileId, input.mimeType, input.exportMimeType]), async () => {
      const signal = AbortSignal.timeout(30_000);
      try {
        const token = await deadline(options.getAccessToken, signal);
        const request = async (target: URL): Promise<Response> => {
          const url = new URL(`https://api.pipedream.com/v1/connect/${projectId}/proxy/${Buffer.from(target.href).toString("base64url")}`);
          url.searchParams.set("external_user_id", externalUserId); url.searchParams.set("account_id", accountId);
          const response = await deadline(() => (options.fetcher ?? fetch)(url.href, { method: "GET", redirect: "error", signal,
            headers: { Authorization: `Bearer ${token}`, "x-pd-environment": environment } }), signal);
          if (!response.ok) {
            cancel(response.body);
            throw new DriveContentError(response.status === 403 ? "file_access_denied" : response.status === 404 ? "file_not_found" : response.status === 429 ? "rate_limited" : "read_failed");
          }
          return response;
        };
        const target = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
        let mimeType = input.mimeType; let name: string | undefined;
        if (!mimeType) {
          target.searchParams.set("fields", "name,mimeType,capabilities(canDownload)");
          target.searchParams.set("supportsAllDrives", "true");
          const data = z.object({ name: z.string().max(1024).optional(), mimeType: z.string().max(128), capabilities: z.object({ canDownload: z.boolean() }).optional() })
            .parse(JSON.parse(await readBody(await request(target), 16 * 1024, signal)));
          if (data.capabilities?.canDownload === false) throw new DriveContentError("file_access_denied");
          mimeType = data.mimeType; name = data.name;
          target.search = "";
        }
        const exportType = defaults[mimeType];
        if (exportType) {
          const chosen = input.exportMimeType ?? exportType;
          const allowed = mimeType.endsWith("document") ? ["text/plain", "text/markdown"]
            : mimeType.endsWith("spreadsheet") ? ["text/csv", "text/tab-separated-values"] : ["text/plain"];
          if (!allowed.includes(chosen)) throw new DriveContentError("unsupported_file_type");
          target.pathname += "/export"; target.searchParams.set("mimeType", chosen); mimeType = chosen;
        } else {
          if (!isText(mimeType) || input.exportMimeType) throw new DriveContentError("unsupported_file_type");
          target.searchParams.set("alt", "media"); target.searchParams.set("supportsAllDrives", "true");
        }
        const response = await request(target);
        const actualType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (actualType && !isText(actualType)) { cancel(response.body); throw new DriveContentError("unsupported_file_type"); }
        const content = await readBody(response, DRIVE_CONTENT_MAX_BYTES, signal);
        if (/\x00|[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(content) || /^(%PDF-|PK\x03\x04)/.test(content)) throw new DriveContentError("unsupported_file_type");
        return { fileId, ...(name ? { name } : {}), mimeType, content, bytes: Buffer.byteLength(content) };
      } catch (error: unknown) {
        if (error instanceof DriveContentError) throw error;
        console.warn("[integrations] File read failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
        throw new DriveContentError();
      }
    });
  };
}
