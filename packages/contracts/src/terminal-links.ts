const MAX_URL_LENGTH = 2048;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]+$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const LEGACY_CLAUDE_CODE_CLIENT_ID = "claude-cli";
const CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CODE_CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";
const TERMINAL_URL_PATTERN = /https?:\/\/[^\s\\<>"')\]}]+/g;

export type TerminalAuthProvider = "claude" | "codex";
export type TerminalLinkKind = "web" | "claude-auth" | "codex-auth";

export interface TerminalLinkEntry {
  url: string;
  hostname: string;
  displayPath: string;
  kind: TerminalLinkKind;
  providerLabel?: "Claude Code" | "Codex";
}

export interface TerminalLinkMatch {
  entry: TerminalLinkEntry;
  text: string;
  startIndex: number;
}

export function stripTerminalControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, " ")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, " ");
}

function hasSafeUrlEnvelope(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:")
    && url.username === ""
    && url.password === ""
    && url.toString().length <= MAX_URL_LENGTH
  );
}

function hasValidOAuthParams(url: URL): boolean {
  const state = url.searchParams.get("state");
  return (
    url.searchParams.get("response_type") === "code"
    && Boolean(url.searchParams.get("client_id"))
    && Boolean(state && OAUTH_STATE_PATTERN.test(state))
  );
}

function isTrustedClaudeAuthUrl(url: URL): boolean {
  const hasTrustedEnvelope =
    hasSafeUrlEnvelope(url)
    && url.protocol === "https:"
    && url.hash === ""
    && (url.origin === "https://claude.ai" || url.origin === "https://claude.com")
    && hasValidOAuthParams(url)
    && !url.searchParams.has("redirect");
  if (!hasTrustedEnvelope) return false;

  if (url.pathname === "/oauth/authorize") {
    return (
      url.origin === "https://claude.ai"
      && url.searchParams.get("client_id") === LEGACY_CLAUDE_CODE_CLIENT_ID
      && !url.searchParams.has("redirect_uri")
    );
  }
  const codeChallenge = url.searchParams.get("code_challenge");
  return (
    url.origin === "https://claude.com"
    && url.pathname === "/cai/oauth/authorize"
    && url.searchParams.get("client_id") === CLAUDE_CODE_CLIENT_ID
    && url.searchParams.get("code") === "true"
    && url.searchParams.get("redirect_uri") === CLAUDE_CODE_CALLBACK_URL
    && url.searchParams.get("code_challenge_method") === "S256"
    && Boolean(codeChallenge && PKCE_CHALLENGE_PATTERN.test(codeChallenge))
  );
}

function isTrustedCodexDeviceUrl(url: URL): boolean {
  return (
    hasSafeUrlEnvelope(url)
    && url.protocol === "https:"
    && url.hash === ""
    && url.origin === "https://auth.openai.com"
    && url.pathname === "/codex/device"
    && url.search === ""
  );
}

function isProviderAuthSurface(url: URL): boolean {
  const isClaudeAuth =
    (url.origin === "https://claude.ai" || url.origin === "https://claude.com")
    && (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/cai/oauth/"));
  const isOpenAiAuth =
    url.origin === "https://auth.openai.com"
    && (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/codex/"));
  return isClaudeAuth || isOpenAiAuth;
}

function trimUrlCandidate(raw: string): string {
  return raw.replace(/[.,;:!?]+$/, "");
}

function toTerminalLinkEntry(url: URL): TerminalLinkEntry {
  const base = {
    url: url.toString(),
    hostname: url.host,
    displayPath: url.pathname || "/",
  };
  if (isTrustedClaudeAuthUrl(url)) {
    return { ...base, kind: "claude-auth", providerLabel: "Claude Code" };
  }
  if (isTrustedCodexDeviceUrl(url)) {
    return { ...base, kind: "codex-auth", providerLabel: "Codex" };
  }
  return { ...base, kind: "web" };
}

export function mayContainTerminalLink(raw: string): boolean {
  return raw.includes("http://") || raw.includes("https://");
}

export function extractTerminalLinkMatches(raw: string): TerminalLinkMatch[] {
  const output = stripTerminalControlSequences(raw);
  const matches: TerminalLinkMatch[] = [];
  TERMINAL_URL_PATTERN.lastIndex = 0;

  for (const match of output.matchAll(TERMINAL_URL_PATTERN)) {
    const candidate = trimUrlCandidate(match[0]);
    if (candidate.length > MAX_URL_LENGTH) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch (_err: unknown) {
      continue;
    }
    if (!hasSafeUrlEnvelope(parsed)) continue;
    if (
      isProviderAuthSurface(parsed)
      && !isTrustedClaudeAuthUrl(parsed)
      && !isTrustedCodexDeviceUrl(parsed)
    ) {
      continue;
    }
    matches.push({
      entry: toTerminalLinkEntry(parsed),
      text: candidate,
      startIndex: match.index ?? 0,
    });
  }

  return matches;
}

export function extractTerminalLinks(raw: string): TerminalLinkEntry[] {
  const entries: TerminalLinkEntry[] = [];
  for (const { entry } of extractTerminalLinkMatches(raw)) {
    if (!entries.some((existing) => existing.url === entry.url)) entries.push(entry);
  }
  return entries;
}

function latestRejectedProviderAuthCandidate(raw: string): string {
  const output = stripTerminalControlSequences(raw).trimEnd();
  let retainedCandidate = "";
  TERMINAL_URL_PATTERN.lastIndex = 0;

  for (const match of output.matchAll(TERMINAL_URL_PATTERN)) {
    const candidate = trimUrlCandidate(match[0]);
    if (candidate.length > MAX_URL_LENGTH) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch (_err: unknown) {
      continue;
    }
    if (
      hasSafeUrlEnvelope(parsed)
      && isProviderAuthSurface(parsed)
      && !isTrustedClaudeAuthUrl(parsed)
      && !isTrustedCodexDeviceUrl(parsed)
    ) {
      retainedCandidate = candidate;
    }
  }
  return retainedCandidate;
}

export function scanTerminalLinkOutput(raw: string): {
  entries: TerminalLinkEntry[];
  bufferedOutput: string;
} {
  const entries = extractTerminalLinks(raw);
  const providerCandidate = latestRejectedProviderAuthCandidate(raw);
  return {
    entries,
    bufferedOutput: providerCandidate || (entries.length > 0 ? "" : raw),
  };
}

export function resolveTerminalLink(rawUrl: string): TerminalLinkEntry | null {
  return extractTerminalLinkMatches(rawUrl).find(
    (match) => match.startIndex === 0 && match.text.length === rawUrl.length,
  )?.entry ?? null;
}
