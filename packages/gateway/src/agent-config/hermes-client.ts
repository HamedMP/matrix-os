const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:9119";
const DEFAULT_HERMES_TIMEOUT_MS = 10_000;
const MAX_HERMES_JSON_BYTES = 1024 * 1024;
const HERMES_PATH = /^\/api\/[a-z0-9_/-]+$/;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HermesUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Hermes upstream is unavailable");
    this.name = "HermesUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class HermesResponseTooLargeError extends Error {
  constructor() {
    super("Hermes response exceeded its size limit");
    this.name = "HermesResponseTooLargeError";
  }
}

export class HermesUpstreamResponseError extends Error {
  constructor() {
    super("Hermes upstream returned an unsuccessful response");
    this.name = "HermesUpstreamResponseError";
  }
}

export class HermesInvalidResponseError extends Error {
  constructor(cause?: unknown) {
    super("Hermes upstream returned an invalid response");
    this.name = "HermesInvalidResponseError";
    if (cause !== undefined) this.cause = cause;
  }
}

export function validateHermesDashboardUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new HermesUnavailableError(err);
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "::1" || hostname === "localhost") return;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    && hostname.startsWith("127.")) {
    return;
  }
  throw new HermesUnavailableError();
}

function validatePath(path: string): void {
  if (!HERMES_PATH.test(path) || path.includes("..") || path.includes("//")) {
    throw new TypeError("Invalid Hermes API path");
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_HERMES_JSON_BYTES) {
      await response.body?.cancel();
      throw new HermesResponseTooLargeError();
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_HERMES_JSON_BYTES) {
        await reader.cancel();
        throw new HermesResponseTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createHermesDashboardClient(options: {
  baseUrl?: string;
  fetchImpl?: FetchLike;
} = {}) {
  const baseUrl = options.baseUrl
    ?? process.env.HERMES_DASHBOARD_URL
    ?? DEFAULT_HERMES_BASE_URL;
  validateHermesDashboardUrl(baseUrl);
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  async function fetchPath(
    path: string,
    init: Omit<RequestInit, "redirect"> = {},
  ): Promise<Response> {
    validatePath(path);
    try {
      return await fetchImpl(`${normalizedBaseUrl}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(DEFAULT_HERMES_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      throw new HermesUnavailableError(err);
    }
  }

  async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetchPath(path, { signal });
    if (!response.ok) throw new HermesUpstreamResponseError();
    const body = await readBoundedBody(response);
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch (err) {
      throw new HermesInvalidResponseError(err);
    }
  }

  return { fetch: fetchPath, readJson };
}

export type HermesDashboardClient = ReturnType<typeof createHermesDashboardClient>;
