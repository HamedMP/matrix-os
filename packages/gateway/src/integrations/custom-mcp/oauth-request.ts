import { request as httpsRequest } from "node:https";
import { createPinnedCustomMcpLookup } from "./pinned-lookup.js";
import { validateCustomMcpUrl } from "./security.js";

const DEADLINE_MS = 10_000;
const RESPONSE_LIMIT = 64 * 1024;
export function createOAuthDeadline(): AbortSignal { return AbortSignal.timeout(DEADLINE_MS); }
export async function withinOAuthDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new Error("OAuth request timed out"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener("abort", abort); }
}

/** One absolute deadline includes DNS validation, request and streamed body. */
export async function pinnedOAuthRequest(input: {
  method: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal;
}): Promise<{ status: number; body: unknown }> {
  const signal = input.signal ?? createOAuthDeadline();
  const target = await withinOAuthDeadline(validateCustomMcpUrl(input.url), signal);
  signal.throwIfAborted();
  return withinOAuthDeadline(new Promise((resolve, reject) => {
    const request = httpsRequest(target.url, {
      method: input.method,
      headers: { accept: "application/json", ...(input.body ? { "content-length": String(Buffer.byteLength(input.body)) } : {}), ...input.headers },
      lookup: createPinnedCustomMcpLookup(target), servername: target.url.hostname,
      timeout: DEADLINE_MS, signal,
    }, response => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        response.destroy(); reject(new Error("OAuth redirects are not allowed")); return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > RESPONSE_LIMIT || chunks.length >= 4096) { response.destroy(new Error("OAuth response limit exceeded")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          signal.throwIfAborted();
          const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
          resolve({ status, body: raw ? JSON.parse(raw) : undefined });
        } catch (error: unknown) {
          console.warn("[custom-mcp/oauth] response parse failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
          reject(new Error("OAuth server returned invalid JSON"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("OAuth request timed out")));
    request.on("error", reject);
    request.end(input.body);
  }), signal);
}
