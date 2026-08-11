const MAX_AUTH_URL_LENGTH = 2048;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]+$/;
const TRUSTED_AUTH_URL_PATTERN = /https:\/\/(?:claude\.ai|auth\.openai\.com)\/[^\s"'<>)}\]]{0,2048}/g;

export type TerminalAuthProvider = "claude" | "codex";

export interface TerminalAuthLink {
  provider: TerminalAuthProvider;
  providerLabel: "Claude Code" | "Codex";
  url: string;
}

function stripTerminalControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function hasSafeUrlEnvelope(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    url.toString().length <= MAX_AUTH_URL_LENGTH
  );
}

function hasValidOAuthParams(url: URL): boolean {
  const state = url.searchParams.get("state");
  return (
    url.searchParams.get("response_type") === "code" &&
    Boolean(url.searchParams.get("client_id")) &&
    Boolean(state && OAUTH_STATE_PATTERN.test(state))
  );
}

function isTrustedClaudeAuthUrl(url: URL): boolean {
  return (
    hasSafeUrlEnvelope(url) &&
    url.origin === "https://claude.ai" &&
    url.pathname === "/oauth/authorize" &&
    hasValidOAuthParams(url) &&
    !url.searchParams.has("redirect")
  );
}

function isTrustedCodexDeviceUrl(url: URL): boolean {
  return (
    hasSafeUrlEnvelope(url) &&
    url.origin === "https://auth.openai.com" &&
    url.pathname === "/codex/device" &&
    url.search === ""
  );
}

export function mayContainTerminalAuthLink(raw: string): boolean {
  return raw.includes("claude.ai/oauth/authorize") || raw.includes("auth.openai.com/codex/");
}

export function extractTrustedTerminalAuthLink(raw: string): TerminalAuthLink | null {
  const output = stripTerminalControlSequences(raw);
  TRUSTED_AUTH_URL_PATTERN.lastIndex = 0;

  for (const match of output.matchAll(TRUSTED_AUTH_URL_PATTERN)) {
    const candidate = match[0].replace(/[.,;:!?]+$/, "");
    let url: URL;
    try {
      url = new URL(candidate);
    } catch (_err: unknown) {
      continue;
    }

    if (isTrustedClaudeAuthUrl(url)) {
      return { provider: "claude", providerLabel: "Claude Code", url: url.toString() };
    }
    if (isTrustedCodexDeviceUrl(url)) {
      return { provider: "codex", providerLabel: "Codex", url: url.toString() };
    }
  }

  return null;
}

export function scanTerminalAuthOutput(raw: string): {
  link: TerminalAuthLink | null;
  bufferedOutput: string;
} {
  const link = extractTrustedTerminalAuthLink(raw);
  return {
    link,
    bufferedOutput: link ? "" : raw,
  };
}
