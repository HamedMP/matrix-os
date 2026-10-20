import { z } from "zod/v4";

export class BoundedIntegrationProxyError extends Error {
  constructor() { super("Integration action unavailable"); this.name = "BoundedIntegrationProxyError"; }
}
const inputSchema = z.strictObject({
  externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  url: z.string().max(8192), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  body: z.string().max(65_536).refine(value => Buffer.byteLength(value) <= 65_536).optional(),
  contentType: z.string().regex(/^(?:application\/json|application\/x-www-form-urlencoded|multipart\/related; boundary=[A-Za-z0-9_-]{1,70})$/).optional(),
  tenantId: z.uuid().optional(),
});
export type BoundedIntegrationProxyRequest = z.infer<typeof inputSchema>;
const MAX_BYTES = 1024 * 1024;
function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch((error: unknown) => console.warn("[integrations] Action body cancellation failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  }));
}
export async function withinIntegrationDeadline<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  try {
    return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }), new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new BoundedIntegrationProxyError());
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (!response.ok || (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES))) {
    cancel(response.body); throw new BoundedIntegrationProxyError();
  }
  if (response.status === 204) { cancel(response.body); return { ok: true }; }
  if (!response.body) throw new BoundedIntegrationProxyError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await withinIntegrationDeadline(() => reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES || chunks.length >= 4096) throw new BoundedIntegrationProxyError();
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (error: unknown) {
    cancel(reader); throw error;
  } finally { reader.releaseLock(); }
}

export interface BoundedIntegrationProxyOptions {
  projectId: string;
  environment: "development" | "production";
  getAccessToken: () => Promise<string>;
  /** Repository-owned fixed API origins; never derive from caller parameters. */
  allowedOrigins: readonly string[];
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}
/** Internal transport for action-specific executors, never a generic tool.
 * Callers own operation schemas and construct their own paths/bodies. This seam
 * enforces fixed origins, selected owner/account, byte/chunk/deadline caps,
 * rejects redirects, prefixes upstream headers and never retries mutations.
 * https://pipedream.com/docs/connect/api-proxy
 */
export function createBoundedIntegrationProxy(options: BoundedIntegrationProxyOptions): (input: BoundedIntegrationProxyRequest, callerSignal?: AbortSignal) => Promise<unknown> {
  const projectId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(options.projectId);
  const environment = z.enum(["development", "production"]).parse(options.environment);
  const origins = z.array(z.url().refine(value => { const url = new URL(value); return url.protocol === "https:" && url.origin === value; })).min(1).max(16).parse([...options.allowedOrigins]);
  return async (rawInput, callerSignal) => {
    try {
      const input = inputSchema.parse(rawInput);
      const target = new URL(input.url);
      if (!origins.includes(target.origin) || target.username || target.password || target.hash) throw new BoundedIntegrationProxyError();
      const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const token = await withinIntegrationDeadline(options.getAccessToken, signal);
      const url = new URL(`https://api.pipedream.com/v1/connect/${projectId}/proxy/${Buffer.from(target.href).toString("base64url")}`);
      url.searchParams.set("external_user_id", input.externalUserId);
      url.searchParams.set("account_id", input.accountId);
      const contentType = input.contentType ?? "application/json";
      const response = await withinIntegrationDeadline(() => (options.fetcher ?? fetch)(url.href, {
        method: input.method, redirect: "error", signal,
        headers: { Authorization: `Bearer ${token}`, "x-pd-environment": environment, "x-pd-proxy-accept": "application/json",
          ...(input.body !== undefined ? { "Content-Type": contentType, "x-pd-proxy-content-type": contentType } : {}),
          ...(input.tenantId ? { "x-pd-proxy-xero-tenant-id": input.tenantId } : {}) },
        ...(input.body !== undefined ? { body: input.body } : {}),
      }), signal);
      return await readJson(response, signal);
    } catch (error: unknown) {
      console.warn("[integrations] Bounded proxy failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      throw new BoundedIntegrationProxyError();
    }
  };
}
