interface ResponseSchema<T> {
  parse(value: unknown): T;
}

interface AuthenticatedJsonRequest<T> {
  url: string;
  token: string;
  schema: ResponseSchema<T>;
  errorMessage: string;
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface AuthenticatedRequest {
  url: string;
  token: string;
  errorMessage: string;
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function buildGatewayRequestUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export async function fetchAuthenticatedJson<T>({
  url,
  token,
  schema,
  errorMessage,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  method,
  headers,
  body,
}: AuthenticatedJsonRequest<T>): Promise<T> {
  return fetchAuthenticatedResponse(
    { url, token, errorMessage, timeoutMs, method, headers, body },
    async (response) => schema.parse(await response.json()),
  );
}

export async function fetchAuthenticatedResponse<T>(
  {
    url,
    token,
    errorMessage,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    method,
    headers,
    body,
  }: AuthenticatedRequest,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  if (!token.trim()) throw new Error(errorMessage);

  const timeout = createRequestTimeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
      signal: timeout.signal,
    });
    if (!response.ok) {
      // Dev-only diagnostic: the response body can carry a validation/error
      // code that "Request failed" alone can't tell you. Never surface this
      // text to the UI — only the generic errorMessage below is thrown.
      let bodyPreview = "";
      try {
        bodyPreview = (await response.clone().text()).slice(0, 500);
      } catch {
        // best-effort only
      }
      console.warn(
        "[mobile] authenticated request failed",
        method ?? "GET",
        url,
        response.status,
        bodyPreview,
      );
      throw new Error("Request failed");
    }
    return await read(response);
  } catch (error) {
    if (!(error instanceof Error && error.message === "Request failed")) {
      console.warn(
        "[mobile] authenticated request failed",
        method ?? "GET",
        url,
        error instanceof Error ? `${error.name}: ${error.message}` : typeof error,
      );
    }
    throw new Error(errorMessage);
  } finally {
    timeout.cancel();
  }
}

function createRequestTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const timeout = (AbortSignal as { timeout?: (milliseconds: number) => AbortSignal }).timeout;
  if (typeof timeout === "function") {
    return { signal: timeout(timeoutMs), cancel: () => undefined };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}
