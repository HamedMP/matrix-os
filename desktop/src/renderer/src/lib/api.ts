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

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  getText(path: string): Promise<string>;
  getBlob(path: string): Promise<Blob>;
  post<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete<T>(path: string): Promise<T>;
  putText<T>(path: string, body: string): Promise<T>;
  baseUrl: string;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchFn: FetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));

  async function send(path: string, init: RequestInit): Promise<Response> {
    const url = buildGatewayUrl(options.baseUrl, path, options.getRuntimeSlot());
    let response: Response;
    try {
      response = await fetchFn(url, {
        ...init,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
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

  async function request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await send(path, init);
    try {
      return (await response.json()) as T;
    } catch (err: unknown) {
      throw new AppError("server", { cause: err });
    }
  }

  async function requestText(path: string, init: RequestInit): Promise<string> {
    const response = await send(path, init);
    try {
      return await response.text();
    } catch (err: unknown) {
      throw new AppError("server", { cause: err });
    }
  }

  async function requestBlob(path: string, init: RequestInit): Promise<Blob> {
    const response = await send(path, init);
    try {
      return await response.blob();
    } catch (err: unknown) {
      throw new AppError("server", { cause: err });
    }
  }

  return {
    baseUrl: options.baseUrl,
    get: (path) => request(path, { method: "GET" }),
    getText: (path) => requestText(path, { method: "GET" }),
    getBlob: (path) => requestBlob(path, { method: "GET" }),
    post: (path, body) =>
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    patch: (path, body) =>
      request(path, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    put: (path, body) =>
      request(path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
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
