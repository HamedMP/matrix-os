/**
 * A raw Pipedream Connect proxy read for a registry directApi action, with a byte cap and the caller's signal: the
 * SDK proxy buffers and parses a whole response before anyone can check its size, and it cannot be cancelled. Only
 * GET and POST (GraphQL reads) of an https URL the registry built; registry static headers go upstream with the
 * proxy's `x-pd-proxy-` prefix. A provider answer other than 2xx throws BoundedProxyStatusError with its status and
 * rate-limit headers only, never its text. The token supplier belongs to the existing SDK client.
 */
import { z } from "zod/v4";
import { BoundedPipedreamReadError } from "./pipedream-bounded-get.js";

/** Hard ceiling of one read, whatever the caller's signal allows. */
export const BOUNDED_PROXY_TIMEOUT_MS = 30_000;
export const BOUNDED_PROXY_MAX_BYTES_CEILING = 16 * 1024 * 1024;
/** Bytes of an error body read to tell GitHub's secondary rate limit (a 403 whose only sign is its message). */
const ERROR_BODY_MAX_BYTES = 4_096;
const CHUNKS_MAX = 65_536;
const FORWARDED_HEADERS = ["retry-after", "x-ratelimit-remaining"] as const;

const HeaderName = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);
const RequestSchema = z.strictObject({
  externalUserId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:@-]+$/),
  accountId: z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/),
  method: z.enum(["GET", "POST"]),
  url: z.string().max(4_096).refine((value) => {
    const url = URL.canParse(value) ? new URL(value) : null;
    return url !== null && url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
  }),
  params: z.record(z.string().max(256), z.string().max(4_096)).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(HeaderName, z.string().max(1_024)).optional(),
  maxBytes: z.number().int().min(1).max(BOUNDED_PROXY_MAX_BYTES_CEILING),
});
export type BoundedProxyRequest = z.infer<typeof RequestSchema>;
export type BoundedPipedreamProxy = (request: BoundedProxyRequest, signal: AbortSignal) => Promise<unknown>;

/** The provider's status and rate-limit headers; the shape getErrorStatusCode and getRetryAfterSeconds read. */
export class BoundedProxyStatusError extends Error {
  constructor(
    readonly statusCode: number, readonly headers: Headers, readonly body: { readonly message: string } | null,
  ) {
    super(`Integration read failed with status ${statusCode}`);
    this.name = "BoundedProxyStatusError";
  }
}

function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch((error: unknown) => {
    console.warn("[integrations] Bounded proxy body cancellation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  });
}

/** Settles with the operation, or rejects once the signal aborts (token resolution and body reads included). */
async function untilAborted<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => undefined;
  try {
    return await Promise.race([operation(), new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The body as bytes, at most maxBytes; null when it is larger. Cancels the stream on every early exit. */
async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer | null> {
  const length = response.headers.get("content-length");
  if (response.body === null) return Buffer.alloc(0);
  if (length !== null && (!/^\d{1,12}$/.test(length) || Number(length) > maxBytes)) {
    cancel(response.body);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await untilAborted(() => reader.read(), signal);
      if (next.done) return Buffer.concat(chunks, bytes);
      bytes += next.value.byteLength;
      if (bytes > maxBytes || chunks.length >= CHUNKS_MAX) {
        cancel(reader);
        return null;
      }
      chunks.push(next.value);
    }
  } catch (error: unknown) {
    cancel(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Only whether a 403 names a rate limit survives from the provider's error text. */
async function statusError(response: Response, signal: AbortSignal): Promise<BoundedProxyStatusError> {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null && /^[0-9]{1,10}$/.test(value)) headers.set(name, value);
  }
  let body: { readonly message: string } | null = null;
  if (response.status === 403) {
    const raw = await readCapped(response, ERROR_BODY_MAX_BYTES, signal);
    if (raw !== null && /rate limit/i.test(raw.toString("utf8"))) body = { message: "rate limit" };
  } else {
    cancel(response.body);
  }
  return new BoundedProxyStatusError(response.status, headers, body);
}

/** JSON for a JSON (or unlabelled) body, a string for text/*, null for an empty one. */
function decode(raw: Buffer, contentType: string): unknown {
  if (raw.byteLength === 0) return null;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  if (type.startsWith("text/")) return text;
  if (type !== "" && type !== "application/json" && !type.endsWith("+json")) throw new BoundedPipedreamReadError();
  return JSON.parse(text) as unknown;
}

export function createBoundedPipedreamProxy(options: {
  projectId: string;
  environment: "development" | "production";
  getAccessToken: () => Promise<string>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
}): BoundedPipedreamProxy {
  const projectId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/).parse(options.projectId);
  const environment = z.enum(["development", "production"]).parse(options.environment);
  return async (rawRequest, callerSignal) => {
    const request = RequestSchema.parse(rawRequest);
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(BOUNDED_PROXY_TIMEOUT_MS)]);
    signal.throwIfAborted();
    const target = new URL(request.url);
    for (const [key, value] of Object.entries(request.params ?? {})) target.searchParams.set(key, value);
    const url = new URL(`https://api.pipedream.com/v1/connect/${projectId}/proxy/${Buffer.from(target.href).toString("base64url")}`);
    url.searchParams.set("external_user_id", request.externalUserId);
    url.searchParams.set("account_id", request.accountId);
    const headers = new Headers({ "x-pd-environment": environment, Accept: "application/json, text/plain;q=0.9" });
    for (const [name, value] of Object.entries(request.headers ?? {})) headers.set(`x-pd-proxy-${name}`, value);
    if (request.method === "POST") headers.set("content-type", "application/json");
    headers.set("Authorization", `Bearer ${await untilAborted(() => options.getAccessToken(), signal)}`);
    const response = await untilAborted(() => (options.fetcher ?? fetch)(url.href, {
      method: request.method, headers, redirect: "error", signal,
      ...(request.method === "POST" ? { body: JSON.stringify(request.body ?? {}) } : {}),
    }), signal);
    if (!response.ok) throw await statusError(response, signal);
    const raw = await readCapped(response, request.maxBytes, signal);
    if (raw === null) throw new BoundedPipedreamReadError();
    return decode(raw, response.headers.get("content-type") ?? "");
  };
}
