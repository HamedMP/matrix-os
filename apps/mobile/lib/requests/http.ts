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
  /** Non-2xx statuses that are an answer rather than a failure; `read` receives the response. */
  expectedStatuses?: readonly number[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Safe display copy plus the status of an actual HTTP refusal, if received. */
export class AuthenticatedRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AuthenticatedRequestError";
  }
}

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
    expectedStatuses,
  }: AuthenticatedRequest,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  if (!token.trim()) throw new AuthenticatedRequestError(errorMessage);

  const timeout = createRequestTimeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
      signal: timeout.signal,
    });
    if (!response.ok && !expectedStatuses?.includes(response.status)) {
      throw new AuthenticatedRequestError(errorMessage, response.status);
    }
    return await read(response);
  } catch (error: unknown) {
    // Only the typed error above proves an HTTP response was received. Network
    // and parsing errors stay uncertain, with no raw body or error text exposed.
    throw new AuthenticatedRequestError(errorMessage, error instanceof AuthenticatedRequestError ? error.status : undefined);
  } finally {
    timeout.cancel();
  }
}

export function createRequestTimeout(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
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
