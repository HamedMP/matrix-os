const MAX_URL_LENGTH = 2048;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]+$/;
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const CLAUDE_CODE_CALLBACK_URL = "https://platform.claude.com/oauth/code/callback";
const TERMINAL_URL_PATTERN = /https?:\/\/[^\s<>"')\]}]+/g;

export const MAX_TERMINAL_LINKS = 20;

export type TerminalAuthProvider = "claude" | "codex";
export type TerminalLinkKind = "web" | "claude-auth" | "codex-auth";
export type TerminalLinksPresentation = "expanded" | "collapsed" | "hidden";

export interface TerminalAuthLink {
  provider: TerminalAuthProvider;
  providerLabel: "Claude Code" | "Codex";
  url: string;
}

export interface TerminalLinkEntry {
  url: string;
  hostname: string;
  displayPath: string;
  kind: TerminalLinkKind;
  providerLabel?: "Claude Code" | "Codex";
}

export interface TerminalLinksState {
  entries: TerminalLinkEntry[];
  presentation: TerminalLinksPresentation;
  activeUrl: string | null;
}

export type TerminalLinksEvent =
  | { type: "linksDetected"; entries: TerminalLinkEntry[] }
  | { type: "collapse" }
  | { type: "dismiss" }
  | { type: "showList" }
  | { type: "reset" };

export const INITIAL_TERMINAL_LINKS_STATE: TerminalLinksState = {
  entries: [],
  presentation: "hidden",
  activeUrl: null,
};

export function stripTerminalControlSequences(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function hasSafeUrlEnvelope(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.toString().length <= MAX_URL_LENGTH
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
  const hasTrustedEnvelope =
    hasSafeUrlEnvelope(url) &&
    url.protocol === "https:" &&
    url.hash === "" &&
    (url.origin === "https://claude.ai" || url.origin === "https://claude.com") &&
    hasValidOAuthParams(url) &&
    !url.searchParams.has("redirect");
  if (!hasTrustedEnvelope) return false;

  if (url.pathname === "/oauth/authorize") return true;
  const codeChallenge = url.searchParams.get("code_challenge");
  return (
    url.pathname === "/cai/oauth/authorize" &&
    url.searchParams.get("code") === "true" &&
    url.searchParams.get("redirect_uri") === CLAUDE_CODE_CALLBACK_URL &&
    url.searchParams.get("code_challenge_method") === "S256" &&
    Boolean(codeChallenge && PKCE_CHALLENGE_PATTERN.test(codeChallenge))
  );
}

function isTrustedCodexDeviceUrl(url: URL): boolean {
  return (
    hasSafeUrlEnvelope(url) &&
    url.protocol === "https:" &&
    url.hash === "" &&
    url.origin === "https://auth.openai.com" &&
    url.pathname === "/codex/device" &&
    url.search === ""
  );
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

export function extractTerminalLinks(raw: string): TerminalLinkEntry[] {
  const output = stripTerminalControlSequences(raw);
  const entries: TerminalLinkEntry[] = [];
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
    const entry = toTerminalLinkEntry(parsed);
    if (!entries.some((existing) => existing.url === entry.url)) {
      entries.push(entry);
    }
  }

  return entries;
}

export function mayContainTerminalAuthLink(raw: string): boolean {
  return (
    raw.includes("claude.ai/oauth/authorize") ||
    raw.includes("claude.ai/cai/oauth/authorize") ||
    raw.includes("claude.com/cai/oauth/authorize") ||
    raw.includes("auth.openai.com/codex/")
  );
}

export function extractTrustedTerminalAuthLink(raw: string): TerminalAuthLink | null {
  for (const entry of extractTerminalLinks(raw)) {
    if (entry.kind === "claude-auth") {
      return { provider: "claude", providerLabel: "Claude Code", url: entry.url };
    }
    if (entry.kind === "codex-auth") {
      return { provider: "codex", providerLabel: "Codex", url: entry.url };
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

export function terminalLinksReducer(
  state: TerminalLinksState,
  event: TerminalLinksEvent,
): TerminalLinksState {
  switch (event.type) {
    case "linksDetected": {
      const newEntries = event.entries.filter(
        (entry, index, entries) =>
          entries.findIndex((candidate) => candidate.url === entry.url) === index &&
          !state.entries.some((existing) => existing.url === entry.url),
      );
      if (newEntries.length === 0) return state;
      const newestFirst = [...newEntries].reverse();
      return {
        entries: [...newestFirst, ...state.entries].slice(0, MAX_TERMINAL_LINKS),
        presentation: "expanded",
        activeUrl: newestFirst[0]?.url ?? state.activeUrl,
      };
    }
    case "collapse":
    case "showList":
      return state.entries.length === 0
        ? state
        : { ...state, presentation: "collapsed" };
    case "dismiss":
      return state.presentation === "hidden"
        ? state
        : { ...state, presentation: "hidden" };
    case "reset":
      return INITIAL_TERMINAL_LINKS_STATE;
  }
}
