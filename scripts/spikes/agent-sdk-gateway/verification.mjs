import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

export const TARGET_AGENT_SDK_VERSION = "0.3.251";
export const OPENROUTER_ANTHROPIC_BASE_URL = "https://openrouter.ai/api";
export const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth";
export const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";

const REQUIRED_RUNTIME_EXPORTS = ["createSdkMcpServer", "query", "tool"];
const ALLOWED_CLOUDFLARE_METADATA_KEYS = new Set([
  "access_source",
  "matrix_user_ref",
  "model_ref",
  "run_ref",
  "runtime_ref",
  "team_ref",
]);

function isSafeCallback(url) {
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1")
  );
}

function requireBoundedString(value, label, { min = 1, max = 512 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new Error(`${label} must be a string between ${min} and ${max} characters`);
  }
  return value;
}

function hasDeclaration(declarationText, pattern) {
  return pattern.test(declarationText);
}

export function verifyAgentSdkArtifacts({
  manifest,
  declarationText,
  runtimeExports,
  hookEvents,
}) {
  const exports = new Set(runtimeExports);
  const events = new Set(hookEvents);
  const checks = {
    abortController: hasDeclaration(
      declarationText,
      /abortController\?:\s*AbortController\s*;/,
    ),
    agents: hasDeclaration(
      declarationText,
      /agents\?:\s*Record<string,\s*AgentDefinition>\s*;/,
    ),
    hooks: hasDeclaration(
      declarationText,
      /hooks\?:\s*Partial<Record<HookEvent,\s*HookCallbackMatcher\[\]>>\s*;/,
    ),
    inProcessMcp:
      exports.has("createSdkMcpServer") &&
      hasDeclaration(
        declarationText,
        /mcpServers\?:\s*Record<string,\s*McpServerConfig>\s*;/,
      ),
    preToolUse: exports.has("HOOK_EVENTS") && events.has("PreToolUse"),
    query: exports.has("query"),
    resume: hasDeclaration(declarationText, /resume\?:\s*string\s*;/),
    skills: hasDeclaration(
      declarationText,
      /skills\?:\s*string\[\]\s*\|\s*['"]all['"]\s*;/,
    ),
    structuredOutput: hasDeclaration(
      declarationText,
      /structured_output\?:\s*unknown\s*;/,
    ),
    tool: exports.has("tool"),
    usage: hasDeclaration(
      declarationText,
      /modelUsage:\s*Record<string,\s*ModelUsage>\s*;/,
    ),
  };

  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (manifest?.version !== TARGET_AGENT_SDK_VERSION) {
    failed.unshift(
      `version (expected ${TARGET_AGENT_SDK_VERSION}, received ${String(manifest?.version)})`,
    );
  }
  if (failed.length > 0) {
    throw new Error(`Agent SDK verification failed: ${failed.join(", ")}`);
  }

  return { version: manifest.version, checks };
}

export async function inspectAgentSdkInstallation(packageDirectory) {
  const manifestPath = path.join(packageDirectory, "package.json");
  const declarationPath = path.join(packageDirectory, "sdk.d.ts");
  const runtimePath = path.join(packageDirectory, "sdk.mjs");
  const [manifestText, declarationText, runtime] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(declarationPath, "utf8"),
    import(pathToFileURL(runtimePath).href),
  ]);
  const manifest = JSON.parse(manifestText);

  return verifyAgentSdkArtifacts({
    manifest,
    declarationText,
    runtimeExports: Object.keys(runtime),
    hookEvents: Array.isArray(runtime.HOOK_EVENTS) ? runtime.HOOK_EVENTS : [],
  });
}

export function parseClaudeAuthStatus(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error("Invalid Claude auth status JSON", { cause: error });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    typeof value.loggedIn !== "boolean" ||
    typeof value.authMethod !== "string" ||
    value.authMethod.length > 64 ||
    typeof value.apiProvider !== "string" ||
    value.apiProvider.length > 64
  ) {
    throw new Error("Invalid Claude auth status shape", {
      cause: new TypeError("unexpected auth status fields"),
    });
  }
  return {
    loggedIn: value.loggedIn,
    authMethod: value.authMethod,
    apiProvider: value.apiProvider,
  };
}

export function formatVerificationFailure(error) {
  if (!(error instanceof Error)) return "Unknown failure: verification failed";
  const safePrefixes = [
    "Agent SDK verification failed:",
    "Agent SDK runtime exports missing:",
    "Invalid Claude auth status",
    "Set MATRIX_AGENT_SDK_PACKAGE_DIR",
    "MATRIX_CLAUDE_BIN must be an absolute path",
    "Claude auth status check failed",
    "Agent SDK fake-provider",
    "Agent SDK did not emit",
    "Fake provider did not bind",
  ];
  const safeMessage = safePrefixes.some((prefix) => error.message.startsWith(prefix))
    ? error.message
    : "verification failed";
  return `${error.name}: ${safeMessage}`;
}

export function buildAgentSdkTransportEnvironment({ baseUrl, authToken }) {
  const parsed = new URL(baseUrl);
  const isLoopback =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new Error("Agent SDK base URL must use HTTPS (except loopback spikes)");
  }
  requireBoundedString(authToken, "Agent SDK auth token", { max: 4096 });

  return {
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_BASE_URL: parsed.toString().replace(/\/$/, ""),
  };
}

export function buildOpenRouterAuthorizeUrl({ callbackUrl, codeChallenge }) {
  const callback = new URL(callbackUrl);
  if (!isSafeCallback(callback)) {
    throw new Error("OpenRouter callback must use HTTPS or loopback HTTP");
  }
  requireBoundedString(callback.searchParams.get("state"), "owner-bound state", {
    min: 16,
    max: 512,
  });
  requireBoundedString(codeChallenge, "PKCE code challenge", { min: 43, max: 128 });
  if (!/^[A-Za-z0-9_-]+$/.test(codeChallenge)) {
    throw new Error("PKCE code challenge must be base64url encoded");
  }

  const authorize = new URL(OPENROUTER_AUTHORIZE_URL);
  authorize.searchParams.set("callback_url", callback.toString());
  authorize.searchParams.set("code_challenge", codeChallenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  return authorize.toString();
}

export function buildOpenRouterExchangeRequest({ code, codeVerifier }) {
  requireBoundedString(code, "OpenRouter authorization code", { max: 2048 });
  requireBoundedString(codeVerifier, "PKCE code verifier", { min: 43, max: 128 });
  if (!/^[A-Za-z0-9._~-]+$/.test(codeVerifier)) {
    throw new Error("PKCE code verifier contains invalid characters");
  }

  return {
    url: OPENROUTER_EXCHANGE_URL,
    init: {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(10_000),
    },
  };
}

export function verifyCloudflareMetadata(metadata) {
  const entries = Object.entries(metadata);
  if (entries.length > 5) {
    throw new Error("Cloudflare custom metadata accepts at most five entries");
  }
  for (const [key, value] of entries) {
    if (!ALLOWED_CLOUDFLARE_METADATA_KEYS.has(key)) {
      throw new Error("Cloudflare metadata must be content-free and use allowlisted keys");
    }
    requireBoundedString(value, `Cloudflare metadata ${key}`, { max: 128 });
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function assertRequiredRuntimeExports(runtime) {
  const missing = REQUIRED_RUNTIME_EXPORTS.filter(
    (exportName) => typeof runtime[exportName] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(`Agent SDK runtime exports missing: ${missing.join(", ")}`);
  }
}
