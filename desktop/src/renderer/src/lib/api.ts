// Typed gateway client (contracts/gateway-contract.md). Auth rides the
// Authorization header injected by the trusted core at the network layer —
// this module never sees the credential. Every call has a timeout.
import { AppError, classifyHttpStatus, classifyTransportError, safeErrorDetail } from "../../../shared/app-error";

const API_TIMEOUT_MS = 10_000;

export function buildGatewayUrl(baseUrl: string, path: string, runtimeSlot: string): string {
  const base = baseUrl.replace(/\/$/, "");
  if (runtimeSlot === "primary") return `${base}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${base}${path}${sep}runtime=${encodeURIComponent(runtimeSlot)}`;
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  getRuntimeSlot: () => string;
  fetchFn?: FetchFn;
  // Invoked once when the gateway rejects the request with 401 (token expired
  // or revoked), so the app can drop the stale session and prompt re-auth.
  onUnauthorized?: () => void;
}

export interface BoundedReadOptions {
  // Hard cap on the bytes read from the response body. The stat that sized a
  // file can be stale by the time the body is fetched, so the cap must apply
  // to the transfer itself; exceeding it rejects with "file_too_large".
  maxBytes?: number;
}

export interface RequestTimeoutOptions {
  /** Internal operation-specific timeout. Every request remains bounded. */
  timeoutMs?: number;
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  getText(path: string, options?: BoundedReadOptions): Promise<string>;
  getBlob(path: string, options?: BoundedReadOptions): Promise<Blob>;
  post<T>(path: string, body: unknown, options?: RequestTimeoutOptions): Promise<T>;
  postBytes<T>(path: string, body: Blob, headers: Record<string, string>, options?: RequestTimeoutOptions): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestTimeoutOptions): Promise<T>;
  putBytes<T>(path: string, body: Blob, headers: Record<string, string>, options?: RequestTimeoutOptions): Promise<T>;
  delete<T>(path: string): Promise<T>;
  putText<T>(path: string, body: string): Promise<T>;
  baseUrl: string;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchFn: FetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));

  async function send(path: string, init: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
    const url = buildGatewayUrl(options.baseUrl, path, options.getRuntimeSlot());
    let response: Response;
    try {
      response = await fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      throw new AppError(classifyTransportError(err), { cause: err });
    }
    if (!response.ok) {
      if (response.status === 401) options.onUnauthorized?.();
      // Extract the gateway's safe error CODE (e.g. invalid_session_request) so
      // callers can surface a specific reason instead of only the generic copy.
      let detail: string | undefined;
      try {
        const body = (await response.clone().json()) as { error?: unknown };
        const err = body.error;
        detail = safeErrorDetail(typeof err === "object" && err ? (err as { code?: unknown }).code : err);
      } catch {
        // Non-JSON / empty body — no detail to surface.
      }
      throw new AppError(classifyHttpStatus(response.status), detail ? { detail } : undefined);
    }
    return response;
  }

  async function request<T>(path: string, init: RequestInit, options?: RequestTimeoutOptions): Promise<T> {
    const response = await send(path, init, options?.timeoutMs);
    try {
      return (await response.json()) as T;
    } catch (err: unknown) {
      throw new AppError("server", { cause: err });
    }
  }

  async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array[]> {
    const reader = response.body?.getReader();
    if (!reader) {
      // Test doubles and legacy responses may not expose a stream; the cap
      // still applies to the buffered body.
      const buffered = new Uint8Array(await response.arrayBuffer());
      if (buffered.byteLength > maxBytes) throw new Error("file_too_large");
      return [buffered];
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error("file_too_large");
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
    return chunks;
  }

  async function requestText(path: string, init: RequestInit, bounds?: BoundedReadOptions): Promise<string> {
    const response = await send(path, init);
    try {
      if (bounds?.maxBytes !== undefined) {
        const chunks = await readBoundedBytes(response, bounds.maxBytes);
        const decoder = new TextDecoder();
        return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
      }
      return await response.text();
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "file_too_large") throw err;
      throw new AppError("server", { cause: err });
    }
  }

  async function requestBlob(path: string, init: RequestInit, bounds?: BoundedReadOptions): Promise<Blob> {
    const response = await send(path, init);
    try {
      if (bounds?.maxBytes !== undefined) {
        const chunks = await readBoundedBytes(response, bounds.maxBytes);
        const type = response.headers.get("content-type") ?? "";
        return new Blob(chunks as BlobPart[], type ? { type } : undefined);
      }
      return await response.blob();
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "file_too_large") throw err;
      throw new AppError("server", { cause: err });
    }
  }

  return {
    baseUrl: options.baseUrl,
    get: (path) => request(path, { method: "GET" }),
    getText: (path, boundedOptions) => requestText(path, { method: "GET" }, boundedOptions),
    getBlob: (path, boundedOptions) => requestBlob(path, { method: "GET" }, boundedOptions),
    post: (path, body, requestOptions) =>
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, requestOptions),
    postBytes: (path, body, headers, requestOptions) =>
      request(path, { method: "POST", headers, body }, requestOptions),
    patch: (path, body) =>
      request(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    put: (path, body, requestOptions) =>
      request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, requestOptions),
    putBytes: (path, body, headers, requestOptions) =>
      request(path, { method: "PUT", headers, body }, requestOptions),
    // The gateway task DELETE route parses the JSON body unconditionally, so a
    // body-less DELETE 400s; always send an empty JSON object.
    delete: (path) =>
      request(path, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    putText: (path, body) =>
      request(path, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body,
      }),
  };
}
