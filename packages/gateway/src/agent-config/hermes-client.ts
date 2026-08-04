import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:9119";
const DEFAULT_HERMES_TIMEOUT_MS = 10_000;
const MAX_HERMES_JSON_BYTES = 1024 * 1024;
const MAX_HERMES_AUTH_FILE_BYTES = 4 * 1024;
const HERMES_PATH = /^\/api\/[a-z0-9_/-]+$/;
const HERMES_AUTH_VALUE = /^[a-f0-9]{64}$/;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class HermesUnavailableError extends Error {
  constructor(cause?: unknown, diagnostic?: string) {
    super(diagnostic ?? "Hermes upstream is unavailable");
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
    throw new HermesUnavailableError(err, "Hermes dashboard URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HermesUnavailableError(
      undefined,
      `Hermes dashboard URL rejected protocol: ${parsed.protocol}`,
    );
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "::1" || hostname === "localhost") return;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
    && hostname.startsWith("127.")) {
    return;
  }
  throw new HermesUnavailableError(
    undefined,
    `Hermes dashboard URL rejected non-loopback host: ${hostname}`,
  );
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
  authFilePath?: string;
} = {}) {
  const baseUrl = options.baseUrl
    ?? process.env.HERMES_DASHBOARD_URL
    ?? DEFAULT_HERMES_BASE_URL;
  validateHermesDashboardUrl(baseUrl);
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const authFilePath = options.authFilePath ?? join(
    process.env.MATRIX_HOME ?? "/home/matrix/home",
    "system/agent-runtime/hermes-dashboard.env",
  );
  let sessionToken: string | null = null;
  let tokenPromise: Promise<string> | null = null;

  async function readSessionToken(): Promise<string> {
    let handle;
    try {
      handle = await open(authFilePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_HERMES_AUTH_FILE_BYTES || (stat.mode & 0o777) !== 0o600) {
        throw new Error("invalid Hermes dashboard credential file");
      }
      const contents = await handle.readFile({ encoding: "utf8" });
      const values = new Map<string, string>();
      for (const line of contents.split("\n")) {
        if (line === "") continue;
        const separator = line.indexOf("=");
        if (separator <= 0) throw new Error("invalid Hermes dashboard credential entry");
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (values.has(key)) throw new Error("duplicate Hermes dashboard credential entry");
        values.set(key, value);
      }
      if (values.size !== 3
        || values.get("HERMES_DASHBOARD_BASIC_AUTH_USERNAME") !== "matrix"
        || !HERMES_AUTH_VALUE.test(values.get("HERMES_DASHBOARD_BASIC_AUTH_PASSWORD") ?? "")
        || !HERMES_AUTH_VALUE.test(values.get("HERMES_DASHBOARD_BASIC_AUTH_SECRET") ?? "")) {
        throw new Error("invalid Hermes dashboard credentials");
      }
      return values.get("HERMES_DASHBOARD_BASIC_AUTH_SECRET")!;
    } catch (err) {
      throw new HermesUnavailableError(err);
    } finally {
      await handle?.close();
    }
  }

  async function getSessionToken(): Promise<string> {
    if (sessionToken !== null) return sessionToken;
    if (tokenPromise !== null) return tokenPromise;
    tokenPromise = readSessionToken().then((token) => {
      sessionToken = token;
      return token;
    }).finally(() => {
      tokenPromise = null;
    });
    return tokenPromise;
  }

  async function rawFetch(
    path: string,
    init: Omit<RequestInit, "redirect">,
    token: string | null,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.delete("cookie");
    headers.delete("authorization");
    headers.delete("x-hermes-session-token");
    if (token !== null) headers.set("x-hermes-session-token", token);
    try {
      return await fetchImpl(`${normalizedBaseUrl}${path}`, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(DEFAULT_HERMES_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (err) {
      throw new HermesUnavailableError(err);
    }
  }

  async function fetchPath(
    path: string,
    init: Omit<RequestInit, "redirect"> = {},
  ): Promise<Response> {
    validatePath(path);
    let response = await rawFetch(path, init, sessionToken);
    if (response.status !== 401) return response;
    await response.body?.cancel();
    sessionToken = null;
    const authenticatedToken = await getSessionToken();
    response = await rawFetch(path, init, authenticatedToken);
    return response;
  }

  async function requestJson(
    path: string,
    init: Omit<RequestInit, "signal" | "redirect">,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await fetchPath(path, { ...init, signal });
    if (!response.ok) throw new HermesUpstreamResponseError();
    const body = await readBoundedBody(response);
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch (err) {
      throw new HermesInvalidResponseError(err);
    }
  }

  async function readJson(path: string, signal: AbortSignal): Promise<unknown> {
    return requestJson(path, { method: "GET" }, signal);
  }

  return { fetch: fetchPath, readJson, requestJson };
}

export type HermesDashboardClient = ReturnType<typeof createHermesDashboardClient>;
