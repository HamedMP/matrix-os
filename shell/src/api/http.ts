import { getGatewayUrl } from "@/lib/gateway";

const DEFAULT_TIMEOUT_MS = 10_000;

export type ClientApiErrorCategory = "unauthorized" | "offline" | "timeout" | "notFound" | "server";

export class ClientApiError extends Error {
  readonly category: ClientApiErrorCategory;
  readonly detail?: string;

  constructor(category: ClientApiErrorCategory, options?: { cause?: unknown; detail?: string }) {
    super(clientErrorMessage(category), options);
    this.name = "ClientApiError";
    this.category = category;
    this.detail = options?.detail;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ShellApiClientOptions {
  getGatewayUrl?: () => string;
  fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface ShellApiClient {
  get<T>(path: string, options?: RequestOptions): Promise<T>;
  post<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  patch<T>(path: string, body: unknown, options?: RequestOptions): Promise<T>;
  delete<T>(path: string, options?: RequestOptions): Promise<T>;
}

export function createShellApiClient(options: ShellApiClientOptions = {}): ShellApiClient {
  const resolveGatewayUrl = options.getGatewayUrl ?? getGatewayUrl;
  const fetchFn = options.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  }));

  async function request<T>(path: string, init: RequestInit, requestOptions?: RequestOptions): Promise<T> {
    const timeout = AbortSignal.timeout(requestOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = requestOptions?.signal ? AbortSignal.any([requestOptions.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchFn(`${resolveGatewayUrl().replace(/\/$/, "")}${path}`, { ...init, signal });
    } catch (error: unknown) {
      throw new ClientApiError(classifyTransportError(error), { cause: error });
    }

    if (!response.ok) {
      throw new ClientApiError(classifyHttpStatus(response.status), {
        detail: await safeErrorDetail(response),
      });
    }

    try {
      return await response.json() as T;
    } catch (error: unknown) {
      throw new ClientApiError("server", { cause: error });
    }
  }

  const json = <T>(method: "POST" | "PUT" | "PATCH", path: string, body: unknown, requestOptions?: RequestOptions): Promise<T> =>
    request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, requestOptions);

  return {
    get: <T>(path: string, requestOptions?: RequestOptions) => request<T>(path, { method: "GET" }, requestOptions),
    post: <T>(path: string, body: unknown, requestOptions?: RequestOptions) => json<T>("POST", path, body, requestOptions),
    put: <T>(path: string, body: unknown, requestOptions?: RequestOptions) => json<T>("PUT", path, body, requestOptions),
    patch: <T>(path: string, body: unknown, requestOptions?: RequestOptions) => json<T>("PATCH", path, body, requestOptions),
    delete: <T>(path: string, requestOptions?: RequestOptions) => request<T>(path, { method: "DELETE" }, requestOptions),
  };
}

export const shellApi = createShellApiClient();

function clientErrorMessage(category: ClientApiErrorCategory): string {
  return {
    unauthorized: "Your session has expired. Please sign in again.",
    offline: "Can't reach Matrix OS. Check your connection.",
    timeout: "The request timed out. Please try again.",
    notFound: "That item could not be found.",
    server: "Something went wrong. Please try again.",
  }[category];
}

function classifyHttpStatus(status: number): ClientApiErrorCategory {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "notFound";
  return "server";
}

function classifyTransportError(error: unknown): ClientApiErrorCategory {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return error instanceof TypeError ? "offline" : "server";
}

async function safeErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = await response.clone().json() as { error?: unknown };
    const value = typeof body.error === "object" && body.error
      ? (body.error as { code?: unknown }).code
      : body.error;
    return typeof value === "string" && /^[a-z][a-z0-9_]{2,48}$/.test(value) ? value : undefined;
  } catch (error: unknown) {
    console.warn("[client-api] gateway error response could not be parsed", error instanceof Error ? error.name : "unknown");
    return undefined;
  }
}
