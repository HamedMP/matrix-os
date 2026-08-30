import {
  FundedAiRuntimeCredentialIssueResponseSchema,
  type FundedAiRuntimeCredentialIssueResponse,
} from "@matrix-os/contracts";
import { z } from "zod/v4";

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RUN_MS = 10 * 60_000;
const MIN_RUN_MS = 60_000;
const MAX_RUN_MS = 10 * 60_000;
const EXPIRY_SAFETY_MS = 60_000;
const MAX_REFRESH_JITTER_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_ATTEMPTS = 3;
const SAFE_MESSAGE = "Matrix AI is temporarily unavailable";

const HandleSchema = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/);
const IdentityValueSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const RuntimeSlotSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/);
const AuthTokenSchema = z.string().min(32).max(512).regex(/^[A-Za-z0-9._~+/=-]+$/);

export interface FundedAiRuntimeConfig {
  issueUrl: string;
  relayBaseUrl: string;
  platformAuthToken: string;
  identity: { ownerId: string; machineId: string; runtimeSlot: string };
  maxRunMs: number;
  requestTimeoutMs: number;
}

export interface FundedAiCredentialLease {
  token: string;
  tokenId: string;
  expiresAt: string;
  relayBaseUrl: string;
  maxRunMs: number;
}

export interface MatrixFundedCredentialProvider {
  readonly enabled: true;
  readonly maxRunMs: number;
  getCredential(options?: {
    minValidityMs?: number;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }): Promise<FundedAiCredentialLease>;
  invalidate(tokenId?: string): void;
  close(): void;
}

export class FundedAiCredentialError extends Error {
  constructor() {
    super(SAFE_MESSAGE);
    this.name = "FundedAiCredentialError";
  }
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error("Funded AI runtime is misconfigured");
  }
  return value;
}

function parseServiceUrl(raw: string | undefined, originOnly: boolean): URL {
  try {
    if (!raw || raw.length > 2_048 || !/^[A-Za-z0-9:/._~%\[\]-]+$/.test(raw)) {
      throw new Error("invalid");
    }
    const url = new URL(raw ?? "");
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
      || url.username || url.password || url.search || url.hash
      || (originOnly && url.pathname !== "/")) {
      throw new Error("invalid");
    }
    return url;
  } catch {
    throw new Error("Funded AI runtime is misconfigured");
  }
}

export function loadFundedAiRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): FundedAiRuntimeConfig | undefined {
  if (env.MATRIX_FUNDED_AI_ENABLED !== "true" && env.MATRIX_FUNDED_AI_ENABLED !== "1") return undefined;
  try {
    const platform = parseServiceUrl(env.PLATFORM_INTERNAL_URL, true);
    const relay = parseServiceUrl(env.MATRIX_FUNDED_AI_RELAY_URL, false);
    const handle = HandleSchema.parse(env.MATRIX_HANDLE);
    const platformAuthToken = AuthTokenSchema.parse(env.MATRIX_AUTH_TOKEN);
    const identity = {
      ownerId: IdentityValueSchema.parse(env.MATRIX_CLERK_USER_ID),
      machineId: IdentityValueSchema.parse(env.MATRIX_MACHINE_ID),
      runtimeSlot: RuntimeSlotSchema.parse(env.MATRIX_RUNTIME_SLOT),
    };
    return {
      issueUrl: new URL(
        `/internal/containers/${encodeURIComponent(handle)}/ai/funded-credential`,
        platform,
      ).toString(),
      relayBaseUrl: relay.toString().replace(/\/$/, ""),
      platformAuthToken,
      identity,
      maxRunMs: boundedInteger(
        env.MATRIX_FUNDED_AI_RUN_TIMEOUT_MS,
        DEFAULT_MAX_RUN_MS,
        MIN_RUN_MS,
        MAX_RUN_MS,
      ),
      requestTimeoutMs: boundedInteger(
        env.MATRIX_FUNDED_AI_CREDENTIAL_TIMEOUT_MS,
        DEFAULT_REQUEST_TIMEOUT_MS,
        500,
        10_000,
      ),
    };
  } catch {
    throw new Error("Funded AI runtime is misconfigured");
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new FundedAiCredentialError();
  if (!response.body) throw new FundedAiCredentialError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch((error: unknown) => {
          console.warn(
            "[funded-ai-credentials] response cancellation failed:",
            error instanceof Error ? error.name : "UnknownError",
          );
        });
        throw new FundedAiCredentialError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new FundedAiCredentialError();
  }
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch((error: unknown) => {
    console.warn(
      "[funded-ai-credentials] response cancellation failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
  });
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new FundedAiCredentialError());
    const abort = () => {
      clearTimeout(timer);
      reject(new FundedAiCredentialError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortSignal(
  input: AbortSignal | undefined,
  timeoutMs: number,
  makeTimeoutSignal: (ms: number) => AbortSignal,
): AbortSignal {
  const timeout = makeTimeoutSignal(timeoutMs);
  return input ? AbortSignal.any([input, timeout]) : timeout;
}

export function createFundedAiCredentialManager(
  config: FundedAiRuntimeConfig,
  dependencies: {
    fetchFn?: typeof fetch;
    now?: () => number;
    random?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    makeTimeoutSignal?: (ms: number) => AbortSignal;
  } = {},
): MatrixFundedCredentialProvider {
  const fetchFn = dependencies.fetchFn ?? fetch;
  const now = dependencies.now ?? Date.now;
  const random = dependencies.random ?? Math.random;
  const sleep = dependencies.sleep ?? defaultSleep;
  const makeTimeoutSignal = dependencies.makeTimeoutSignal ?? AbortSignal.timeout;
  let cached: FundedAiCredentialLease | undefined;
  let inFlight: Promise<FundedAiCredentialLease> | undefined;
  let closed = false;
  const lifetime = new AbortController();

  function validateIssued(
    value: FundedAiRuntimeCredentialIssueResponse,
    minValidityMs: number,
  ): FundedAiCredentialLease {
    if (!value.policy.enabled
      || value.identity.ownerId !== config.identity.ownerId
      || value.identity.machineId !== config.identity.machineId
      || value.identity.runtimeSlot !== config.identity.runtimeSlot
      || Date.parse(value.credential.expiresAt) - now() < minValidityMs) {
      throw new FundedAiCredentialError();
    }
    return {
      token: value.credential.token,
      tokenId: value.credential.tokenId,
      expiresAt: value.credential.expiresAt,
      relayBaseUrl: config.relayBaseUrl,
      maxRunMs: config.maxRunMs,
    };
  }

  async function acquire(minValidityMs: number, callerSignal?: AbortSignal): Promise<FundedAiCredentialLease> {
    const callerAndLifetime = callerSignal
      ? AbortSignal.any([callerSignal, lifetime.signal])
      : lifetime.signal;
    const signal = abortSignal(callerAndLifetime, config.requestTimeoutMs, makeTimeoutSignal);
    let lastTransient = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetchFn(config.issueUrl, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${config.platformAuthToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: "{}",
        });
        if (!response.ok) {
          await discardResponse(response);
          lastTransient = [429, 502, 503, 504].includes(response.status);
          if (!lastTransient) throw new FundedAiCredentialError();
        } else {
          const parsed = FundedAiRuntimeCredentialIssueResponseSchema.safeParse(await readBoundedJson(response));
          if (!parsed.success) throw new FundedAiCredentialError();
          return validateIssued(parsed.data, minValidityMs);
        }
      } catch (error) {
        if (error instanceof FundedAiCredentialError) throw error;
        lastTransient = !signal.aborted;
      }
      if (!lastTransient || attempt === MAX_ATTEMPTS - 1) break;
      const delay = 100 * (2 ** attempt) + Math.floor(random() * 100);
      await sleep(delay, signal);
    }
    throw new FundedAiCredentialError();
  }

  return {
    enabled: true,
    maxRunMs: config.maxRunMs,
    async getCredential(options = {}) {
      if (closed) throw new FundedAiCredentialError();
      const minValidityMs = Math.max(
        options.minValidityMs ?? config.maxRunMs + EXPIRY_SAFETY_MS,
        EXPIRY_SAFETY_MS,
      );
      const refreshJitter = Math.floor(random() * MAX_REFRESH_JITTER_MS);
      if (!options.forceRefresh && cached
        && Date.parse(cached.expiresAt) - now() >= minValidityMs + refreshJitter) {
        return cached;
      }
      if (!inFlight) {
        inFlight = acquire(minValidityMs, options.signal)
          .then((lease) => {
            if (closed) throw new FundedAiCredentialError();
            cached = lease;
            return lease;
          })
          .finally(() => {
            inFlight = undefined;
          });
      }
      return await inFlight;
    },
    invalidate(tokenId) {
      if (!tokenId || cached?.tokenId === tokenId) cached = undefined;
    },
    close() {
      closed = true;
      cached = undefined;
      lifetime.abort();
    },
  };
}
