// Bearer injection for the Terminal window's own session (spec 651 FR-004).
// The renderer never holds a credential: each gateway request names its
// computer, and the trusted core attaches that computer's bearer or nothing.
import { RUNTIME_SLOT_PATTERN as SLOT } from "../../shared/terminal-window";
import { shouldInjectAuth } from "../auth/header-injection";
import type { ComputerCredential } from "./credential-broker";

const VM_ROUTE = /^\/vm\/(pr-[1-9][0-9]{0,8})(?:\/|$)/;

interface AuthSession {
  webRequest: {
    onBeforeSendHeaders(
      listener: (
        details: { id: number; url: string; requestHeaders: Record<string, string> },
        callback: (response: { requestHeaders?: Record<string, string>; cancel?: boolean }) => void,
      ) => void,
    ): void;
    onCompleted(listener: (details: { id: number; url: string; statusCode: number }) => void): void;
    onErrorOccurred(listener: (details: { id: number }) => void): void;
  };
}

// Requests in flight that carry a bearer. A terminal window holds a handful of
// sockets and fetches at a time; the cap only guards against a leak.
const MAX_TRACKED_REQUESTS = 512;

interface AuthBroker {
  credential(slot: string): Promise<ComputerCredential>;
  unauthorized(slot: string, token: string): void;
  confirmed(slot: string): void;
}

/**
 * The computer a gateway request targets: its `runtime` query, a preview
 * `/vm/pr-N` route, or the primary computer when neither is present (the
 * convention every desktop client uses). Null means "not ours": another
 * origin, or a malformed or ambiguous target. A request that names one
 * computer in its path and another in its query is ambiguous: the two could
 * be routed differently, so it gets no bearer at all.
 */
export function resolveRuntimeTarget(requestUrl: string, gatewayOrigin: string | null): string | null {
  if (!shouldInjectAuth(requestUrl, gatewayOrigin)) return null;
  const url = new URL(requestUrl);
  const requested = url.searchParams.getAll("runtime");
  if (requested.length > 1) return null;
  const routed = VM_ROUTE.exec(url.pathname)?.[1];
  // A /vm/ route that names no known kind of computer is not guessed at.
  if (routed === undefined && /^\/vm(?:\/|$)/.test(url.pathname)) return null;
  if (requested[0] !== undefined && routed !== undefined && requested[0] !== routed) return null;
  const slot = requested[0] ?? routed ?? "primary";
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
): { clear(): void } {
  // The bearer each in-flight request was sent with, by request id, so a 401
  // is charged to the token that request carried and never to a newer one.
  const sent = new Map<number, { slot: string; token: string }>();

  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    // Only the trusted core supplies a bearer on this session.
    stripAuthorization(headers);
    const slot = resolveRuntimeTarget(details.url, options.getGatewayOrigin());
    if (!slot) {
      callback({ requestHeaders: headers });
      return;
    }
    void options.broker.credential(slot)
      .then((found) => {
        if (found.token !== null) {
          headers.Authorization = `Bearer ${found.token}`;
          if (sent.size >= MAX_TRACKED_REQUESTS) {
            const oldest = sent.keys().next().value;
            if (oldest !== undefined) sent.delete(oldest);
          }
          sent.set(details.id, { slot, token: found.token });
        } else if (found.reason === "unavailable") {
          // Sending this without a bearer would earn a 401 and tell the owner
          // to sign in again, when the real cause is a credential that could
          // not be fetched just now. Failing the request reads as "try again".
          callback({ cancel: true });
          return;
        }
        callback({ requestHeaders: headers });
      })
      .catch((error: unknown) => {
        console.warn("[terminal-window] bearer lookup failed:", error instanceof Error ? error.name : "UnknownError");
        callback({ cancel: true });
      });
  });

  session.webRequest.onCompleted((details) => {
    const request = sent.get(details.id);
    sent.delete(details.id);
    // Only a request this session sent a bearer on says anything about a token.
    if (!request || resolveRuntimeTarget(details.url, options.getGatewayOrigin()) !== request.slot) return;
    if (details.statusCode === 401) {
      options.broker.unauthorized(request.slot, request.token);
    } else if (details.statusCode === 101 || (details.statusCode >= 200 && details.statusCode < 400)) {
      // 101 is an accepted terminal WebSocket.
      options.broker.confirmed(request.slot);
    }
  });

  session.webRequest.onErrorOccurred((details) => { sent.delete(details.id); });

  /** Forgets every in-flight bearer; called with the broker's own clear on sign-out. */
  return { clear: () => sent.clear() };
}
