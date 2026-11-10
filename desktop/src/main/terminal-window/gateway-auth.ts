// Bearer injection for the Terminal window's own session (spec 651 FR-004).
// The renderer never holds a credential: each gateway request names its
// computer, and the trusted core attaches that computer's bearer or nothing.
import { shouldInjectAuth } from "../auth/header-injection";

const SLOT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VM_ROUTE = /^\/vm\/(pr-[1-9][0-9]{0,8})(?:\/|$)/;

interface AuthSession {
  webRequest: {
    onBeforeSendHeaders(
      listener: (
        details: { url: string; requestHeaders: Record<string, string> },
        callback: (response: { requestHeaders: Record<string, string> }) => void,
      ) => void,
    ): void;
    onCompleted(listener: (details: { url: string; statusCode: number }) => void): void;
  };
}

interface AuthBroker {
  token(slot: string): Promise<string | null>;
  unauthorized(slot: string, token: string): void;
  confirmed(slot: string): void;
}

/**
 * The computer a gateway request targets: its `runtime` query, a preview
 * `/vm/pr-N` route, or the primary computer when neither is present (the
 * convention every desktop client uses). Null means "not ours": another
 * origin, or a malformed or ambiguous target.
 */
export function resolveRuntimeTarget(requestUrl: string, gatewayOrigin: string | null): string | null {
  if (!shouldInjectAuth(requestUrl, gatewayOrigin)) return null;
  const url = new URL(requestUrl);
  const requested = url.searchParams.getAll("runtime");
  if (requested.length > 1) return null;
  const slot = requested[0] ?? VM_ROUTE.exec(url.pathname)?.[1] ?? "primary";
  return SLOT.test(slot) ? slot : null;
}

function stripAuthorization(headers: Record<string, string>): void {
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "authorization") delete headers[name];
  }
}

export function installTerminalWindowAuth(
  session: AuthSession,
  options: { broker: AuthBroker; getGatewayOrigin(): string | null },
): void {
  // The last bearer attached per computer, so a 401 is charged to the token
  // that was refused. Keyed by inventory slot: at most 20 entries.
  const attached = new Map<string, string>();

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    // Only the trusted core supplies a bearer on this session.
    stripAuthorization(headers);
    const slot = resolveRuntimeTarget(details.url, options.getGatewayOrigin());
    if (!slot) {
      callback({ requestHeaders: headers });
      return;
    }
    void options.broker.token(slot)
      .then((token) => {
        if (token) {
          headers.Authorization = `Bearer ${token}`;
          if (attached.size >= 20 && !attached.has(slot)) attached.clear();
          attached.set(slot, token);
        }
      })
      .catch((error: unknown) => {
        console.warn("[terminal-window] bearer lookup failed:", error instanceof Error ? error.name : "UnknownError");
      })
      .finally(() => callback({ requestHeaders: headers }));
  });

  session.webRequest.onCompleted((details) => {
    const slot = resolveRuntimeTarget(details.url, options.getGatewayOrigin());
    if (!slot) return;
    if (details.statusCode === 401) {
      const token = attached.get(slot);
      if (token) options.broker.unauthorized(slot, token);
    } else if (details.statusCode >= 200 && details.statusCode < 400) {
      options.broker.confirmed(slot);
    }
  });
}
