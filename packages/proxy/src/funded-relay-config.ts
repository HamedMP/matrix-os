const DEFAULT_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
const DEFAULT_RESPONSE_LIMIT_BYTES = 32 * 1024 * 1024;
const DEFAULT_CONTROL_RESPONSE_LIMIT_BYTES = 64 * 1024;
const DEFAULT_PLATFORM_TIMEOUT_MS = 5_000;
const DEFAULT_COUNT_TOKENS_TIMEOUT_MS = 10_000;
const DEFAULT_FIRST_RESPONSE_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_GLOBAL_CONCURRENCY = 64;
const DEFAULT_GLOBAL_RATE_LIMIT = 180;
const DEFAULT_RUNTIME_CONCURRENCY = 2;
const DEFAULT_RATE_LIMIT = 60;
const DEFAULT_RUNTIME_REGISTRY_SIZE = 10_000;
const CLOUDFLARE_GATEWAY_HOST = "gateway.ai.cloudflare.com";

export const COUNT_TOKENS_BODY_LIMIT_BYTES = 256 * 1024;
export const BETA_ID = /^[a-zA-Z0-9][a-zA-Z0-9._=-]{0,127}$/;

export interface FundedRelayConfig {
  gatewayBaseUrl: string;
  gatewayToken: string;
  platformBaseUrl: string;
  relayControlToken: string;
  metadataSecret: string;
  allowedBetas: ReadonlySet<string>;
  platformTimeoutMs: number;
  countTokensTimeoutMs: number;
  firstResponseTimeoutMs: number;
  timeoutMs: number;
  maxBodyBytes: number;
  maxResponseBytes: number;
  maxControlResponseBytes: number;
  globalConcurrency: number;
  globalRateLimitPerMinute: number;
  runtimeConcurrency: number;
  rateLimitPerMinute: number;
  maxRuntimeEntries: number;
}

function readEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error("MATRIX_FUNDED_AI_ENABLED must be 0, 1, false, or true");
}

function readRequired(env: NodeJS.ProcessEnv, name: string, maxLength = 4_096): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when Matrix-funded AI is enabled`);
  if (value.length > maxLength) throw new Error(`${name} is too long`);
  return value;
}

function readSecret(env: NodeJS.ProcessEnv, name: string): string {
  const value = readRequired(env, name);
  if (value.length < 32) throw new Error(`${name} must be at least 32 characters`);
  return value;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function readGatewayBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = readRequired(env, "CLOUDFLARE_AI_GATEWAY_URL", 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    if (error instanceof TypeError) throw new Error("CLOUDFLARE_AI_GATEWAY_URL must be a valid URL");
    throw error;
  }
  const path = url.pathname.replace(/\/$/, "");
  const pathSegments = path.split("/").filter(Boolean);
  const isExpectedPath = pathSegments.length === 4
    && pathSegments[0] === "v1"
    && /^[a-f0-9]{32}$/.test(pathSegments[1] ?? "")
    && /^[a-zA-Z0-9_-]{1,64}$/.test(pathSegments[2] ?? "")
    && pathSegments[3] === "anthropic";
  if (url.protocol !== "https:" || url.hostname !== CLOUDFLARE_GATEWAY_HOST || url.port !== ""
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || !isExpectedPath) {
    throw new Error("CLOUDFLARE_AI_GATEWAY_URL must be an official Anthropic gateway URL");
  }
  return `${url.origin}${path}`;
}

function readPlatformBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = readRequired(env, "PLATFORM_INTERNAL_URL", 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    if (error instanceof TypeError) throw new Error("PLATFORM_INTERNAL_URL must be a valid URL");
    throw error;
  }
  if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")
    || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("PLATFORM_INTERNAL_URL must be an HTTP(S) origin without credentials or a path");
  }
  return url.origin;
}

function readAllowedBetas(env: NodeJS.ProcessEnv): ReadonlySet<string> {
  const raw = env.MATRIX_FUNDED_AI_BETAS?.trim() ?? "";
  if (raw.length > 4_096) throw new Error("MATRIX_FUNDED_AI_BETAS is too long");
  const betas = [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (betas.length > 32 || betas.some((beta) => !BETA_ID.test(beta))) {
    throw new Error("MATRIX_FUNDED_AI_BETAS must contain at most 32 valid beta IDs");
  }
  return new Set(betas);
}

export function resolveFundedRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): FundedRelayConfig | null {
  if (!readEnabled(env.MATRIX_FUNDED_AI_ENABLED)) return null;
  const gatewayBaseUrl = readGatewayBaseUrl(env);
  const platformBaseUrl = readPlatformBaseUrl(env);
  const gatewayToken = readSecret(env, "CLOUDFLARE_AI_GATEWAY_TOKEN");
  const relayControlToken = readSecret(env, "AI_RELAY_CONTROL_TOKEN");
  const metadataSecret = readSecret(env, "AI_RELAY_METADATA_SECRET");
  if (new Set([gatewayToken, relayControlToken, metadataSecret]).size !== 3) {
    throw new Error("Funded AI relay credentials must be distinct");
  }
  return {
    gatewayBaseUrl,
    gatewayToken,
    platformBaseUrl,
    relayControlToken,
    metadataSecret,
    allowedBetas: readAllowedBetas(env),
    platformTimeoutMs: readInteger(env, "MATRIX_FUNDED_AI_PLATFORM_TIMEOUT_MS", DEFAULT_PLATFORM_TIMEOUT_MS, 500, 30_000),
    countTokensTimeoutMs: readInteger(
      env, "MATRIX_FUNDED_AI_COUNT_TOKENS_TIMEOUT_MS", DEFAULT_COUNT_TOKENS_TIMEOUT_MS, 500, 60_000,
    ),
    firstResponseTimeoutMs: readInteger(
      env, "MATRIX_FUNDED_AI_FIRST_RESPONSE_TIMEOUT_MS", DEFAULT_FIRST_RESPONSE_TIMEOUT_MS, 1_000, 60_000,
    ),
    timeoutMs: readInteger(env, "MATRIX_FUNDED_AI_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 10_000, 15 * 60_000),
    maxBodyBytes: readInteger(
      env, "MATRIX_FUNDED_AI_MAX_BODY_BYTES", DEFAULT_BODY_LIMIT_BYTES, 256, 8 * 1024 * 1024,
    ),
    maxResponseBytes: readInteger(
      env, "MATRIX_FUNDED_AI_MAX_RESPONSE_BYTES", DEFAULT_RESPONSE_LIMIT_BYTES, 1_024, 128 * 1024 * 1024,
    ),
    maxControlResponseBytes: readInteger(
      env, "MATRIX_FUNDED_AI_MAX_CONTROL_RESPONSE_BYTES", DEFAULT_CONTROL_RESPONSE_LIMIT_BYTES, 1_024, 1024 * 1024,
    ),
    globalConcurrency: readInteger(
      env, "MATRIX_FUNDED_AI_GLOBAL_CONCURRENCY", DEFAULT_GLOBAL_CONCURRENCY, 1, 10_000,
    ),
    globalRateLimitPerMinute: readInteger(
      env, "MATRIX_FUNDED_AI_GLOBAL_RATE_LIMIT", DEFAULT_GLOBAL_RATE_LIMIT, 1, 10_000,
    ),
    runtimeConcurrency: readInteger(
      env, "MATRIX_FUNDED_AI_RUNTIME_CONCURRENCY", DEFAULT_RUNTIME_CONCURRENCY, 1, 100,
    ),
    rateLimitPerMinute: readInteger(
      env, "MATRIX_FUNDED_AI_RATE_LIMIT", DEFAULT_RATE_LIMIT, 1, 10_000,
    ),
    maxRuntimeEntries: readInteger(
      env, "MATRIX_FUNDED_AI_MAX_RUNTIME_ENTRIES", DEFAULT_RUNTIME_REGISTRY_SIZE, 1, 100_000,
    ),
  };
}
