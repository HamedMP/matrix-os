export type BrowserAddressResolution =
  | {
      disposition: "runtime";
      url: string;
      remoteHost: "127.0.0.1" | "::1" | "localhost";
      remotePort: number;
    }
  | { disposition: "public"; url: string };

export type RuntimeBrowserNavigationDecision =
  | { disposition: "rewrite"; url: string }
  | { disposition: "block" }
  | { disposition: "external" };

const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const DOMAIN_LIKE = /^(?:[^\s/:]+\.)+[^\s/:]+(?::\d+)?(?:[/?#].*)?$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function isIpv4Loopback(host: string): boolean {
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseHttpUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (err: unknown) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
  ) return null;
  return parsed;
}

export function resolveBrowserAddress(value: string): BrowserAddressResolution | null {
  const input = value.trim();
  if (!input) return null;
  if (SCHEME.test(input) && !/^https?:/i.test(input)) return null;
  if (/^(?:localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(input)) return null;

  const loopbackShorthand = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d+(?:[/?#].*)?$/i.test(input);
  const urlInput = /^https?:/i.test(input)
    ? input
    : loopbackShorthand
      ? `http://${input}`
      : DOMAIN_LIKE.test(input)
        ? `https://${input}`
        : null;

  if (!urlInput) {
    const params = new URLSearchParams({ q: input });
    return { disposition: "public", url: `https://www.google.com/search?${params.toString()}` };
  }

  const parsed = parseHttpUrl(urlInput);
  if (!parsed) return null;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  // The runtime tunnel currently targets only canonical 127.0.0.1. Never let
  // another address in 127/8 fall through to the user's local browser.
  if (isIpv4Loopback(host) && host !== "127.0.0.1") return null;
  if (LOOPBACK_HOSTS.has(host)) {
    if (parsed.protocol !== "http:" || parsed.port === "") return null;
    const remotePort = Number(parsed.port);
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) return null;
    return {
      disposition: "runtime",
      url: parsed.toString(),
      remoteHost: host as "127.0.0.1" | "::1" | "localhost",
      remotePort,
    };
  }
  return { disposition: "public", url: parsed.toString() };
}

export function resolveRuntimeBrowserNavigation(
  value: string,
  remotePort: number,
  localOrigin: string,
): RuntimeBrowserNavigationDecision {
  const target = parseHttpUrl(value);
  const local = parseHttpUrl(localOrigin);
  if (!target || !local || local.protocol !== "http:") return { disposition: "block" };

  const localHost = local.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(localHost) || local.port === "") return { disposition: "block" };

  const resolved = resolveBrowserAddress(target.toString());
  if (!resolved) return { disposition: "block" };
  // A runtime page controls this navigation. Do not hand hostname resolution
  // to the user's browser: a DNS alias or rebinding response could otherwise
  // reach loopback/private services outside the authenticated tunnel. Public
  // URLs entered directly in BrowserTab still use resolveBrowserAddress().
  if (resolved.disposition === "public") return { disposition: "block" };
  if (resolved.remotePort !== remotePort) return { disposition: "block" };

  local.pathname = target.pathname;
  local.search = target.search;
  local.hash = target.hash;
  return { disposition: "rewrite", url: local.toString() };
}
