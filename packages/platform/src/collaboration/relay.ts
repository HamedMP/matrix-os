/**
 * Transparent collaboration relay (S05 / T103).
 *
 * Extracted from the proxy and WebSocket bridge: the platform terminates TLS
 * and forwards direct-protocol HTTP requests and WebSocket upgrades to the
 * home the resource directory names, as opaque bytes. It makes no allow or
 * deny decision, parses no body or frame, signs nothing and logs no payload.
 * Only coarse byte and connection limits apply, and only connection
 * metadata (actor and runtime ids, resource id, byte counts, timing,
 * outcome) is observable here. A forged or expired ticket is forwarded
 * untouched and rejected by the home. Platform policy storage never sits on
 * this path, so its unavailability cannot touch an in-flight session.
 */
import type { IncomingMessage } from "node:http";
import {
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
} from "@matrix-os/contracts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const RUNTIME = "(?:[A-Za-z0-9:_-]|%3[Aa]){1,128}";
const SESSION_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", new RegExp(`^/api/collaboration/direct-sessions$`)],
  ["POST", new RegExp(`^/api/collaboration/owner-runtime/sessions$`)],
  ["POST", new RegExp(`^/api/collaboration/direct-sessions/(${UUID})/renew$`)],
  ["DELETE", new RegExp(`^/api/collaboration/direct-sessions/(${UUID})$`)],
];
const RUNTIME_ROUTES: ReadonlyArray<readonly [string, RegExp]> = [
  ["POST", new RegExp(`^/api/collaboration/runtimes/(${RUNTIME})/catalog/resolve$`)],
  ["POST", new RegExp(`^/api/collaboration/runtimes/(${RUNTIME})/scopes/preflight$`)],
  ["POST", new RegExp(`^/api/collaboration/runtimes/(${RUNTIME})/scopes$`)],
];
const SCOPE_PATH = new RegExp(`^/api/collaboration/scopes/(${UUID})(?:/|$)`);
const INVITATION_PATH = new RegExp(`^/api/collaboration/invitations/(${UUID})(?:/|$)`);
const DIRECT_SOCKET_PATH = new RegExp(`^/ws/collaboration/direct/scopes/(${UUID})/(events|terminal)$`);
const SESSION_HEADER = "x-matrix-collaboration-session";
const REQUEST_HEADER = "x-matrix-collaboration-request";
/** Session lifecycle routes carry the ticket's logical runtime id here so the relay can route without reading the ticket. */
export const RELAY_RUNTIME_HEADER = "x-matrix-collaboration-runtime";
const LOGICAL_RUNTIME_ID = /^[A-Za-z0-9_-]{1,128}$/;
const FORWARDED_REQUEST_HEADERS = new Set([
  "content-type", "accept", "content-length",
  SESSION_HEADER, REQUEST_HEADER, RELAY_RUNTIME_HEADER,
  COLLABORATION_CLIENT_REQUEST_ID_HEADER, COLLABORATION_EXPECTED_REVISION_HEADER, COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
]);
const FORWARDED_RESPONSE_HEADERS = new Set(["content-type", "content-length", "cache-control"]);
const FORWARDED_SOCKET_HEADERS = new Set(["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol", "sec-websocket-extensions"]);
const MAX_HEADER_VALUE = 8_192;
const MAX_RAW_PATH = 2_048;
const DEFAULT_LIMITS = Object.freeze({
  requestBytes: 96 * 1024,
  responseBytes: 2 * 1024 * 1024,
  exportBytes: 512 * 1024 * 1024,
  requestTimeoutMs: 10_000,
  exportTimeoutMs: 30_000,
  connectionsPerHome: 256,
  connectionsPerActor: 32,
  /** Distinct homes / actors the socket registry tracks at once; beyond that new sockets are refused. */
  maxTrackedHomes: 4_096,
  maxTrackedActors: 16_384,
  /** A relayed socket with no bytes in either direction for this long is evicted and destroyed. */
  socketIdleMs: 10 * 60_000,
  sweepIntervalMs: 60_000,
});

interface RelaySocketReservation {
  lastTouched: number;
  release(): void;
  onEvict?: () => void;
}

export interface RelayPreparedSocket {
  home: RelayHome;
  upstreamPath: string;
  headers: string;
  /** Frees the home/actor counts; idempotent, also called by eviction. */
  release(): void;
  /** Records traffic in either direction so the idle sweep keeps the reservation. */
  touch(): void;
  /** Runs when the idle sweep evicts the reservation; the listener destroys the socket. */
  onEvict(hook: () => void): void;
}

export interface RelayHome {
  runtimeId: string;
  origin: string;
}

export interface RelayRoute {
  kind: "session" | "scope" | "invitation" | "runtime";
  identifier?: string;
}

export interface RelayMetadata {
  actorId: string;
  runtimeId: string | null;
  resourceId: string | null;
  method: string;
  path: string;
  requestBytes: number;
  responseBytes: number;
  status: number;
  durationMs: number;
  outcome: "forwarded" | "unroutable" | "rejected" | "upstream_error" | "limit";
}

export type RelayLimits = typeof DEFAULT_LIMITS;

/** Classifies a direct-protocol path; anything else is not relayed. */
export function parseRelayRoute(method: string, path: string): RelayRoute | null {
  if (path.length > MAX_RAW_PATH || /[\r\n]/.test(path)) return null;
  for (const [allowed, pattern] of SESSION_ROUTES) if (method === allowed && pattern.test(path)) return { kind: "session" };
  for (const [allowed, pattern] of RUNTIME_ROUTES) {
    const match = method === allowed ? pattern.exec(path) : null;
    if (match) {
      const identifier = match[1]!.replace(/%3[aA]/g, ":");
      return /^[A-Za-z0-9:_-]{1,128}$/.test(identifier) ? { kind: "runtime", identifier } : null;
    }
  }
  const scope = SCOPE_PATH.exec(path);
  if (scope) return { kind: "scope", identifier: scope[1]! };
  const invitation = INVITATION_PATH.exec(path);
  if (invitation) return { kind: "invitation", identifier: invitation[1]! };
  return null;
}

export function parseRelaySocketPath(rawPath: string): { scopeId: string; purpose: "events" | "terminal"; path: string; query: string } | null {
  if (rawPath.length > MAX_RAW_PATH || /[\r\n]/.test(rawPath)) return null;
  let url: URL;
  try {
    url = new URL(rawPath, "https://relay.invalid");
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[collaboration-relay] socket path parse failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
  const match = DIRECT_SOCKET_PATH.exec(url.pathname);
  if (!match) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "ticket" && key !== "after") || keys.filter((key) => key === "ticket").length !== 1) return null;
  return { scopeId: match[1]!, purpose: match[2] as "events" | "terminal", path: url.pathname, query: url.search.slice(1) };
}

/** Reserve the collaboration socket namespace so old and malformed paths cannot fall into generic VPS routing. */
export function isCollaborationWebSocketCandidate(rawPath: string): boolean {
  if (rawPath.length > MAX_RAW_PATH || /[\r\n]/.test(rawPath)) return false;
  try {
    return new URL(rawPath, "https://relay.invalid").pathname.startsWith("/ws/collaboration/");
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[collaboration-relay] socket path classification failed", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

export class CollaborationRelay {
  private readonly limits: RelayLimits;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly homeConnections = new Map<string, number>();
  private readonly actorConnections = new Map<string, number>();
  /** Live socket reservations by id; bounded by the tracked-home/actor caps and swept by idle time. */
  private readonly reservations = new Map<number, RelaySocketReservation>();
  private nextReservationId = 1;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private readonly options: {
    resolveScopeHome(scopeId: string): Promise<RelayHome | null>;
    resolveInvitationHome(actorId: string, invitationId: string): Promise<RelayHome | null>;
    resolveRuntimeHome(actorId: string, runtimeId: string): Promise<RelayHome | null>;
    /** Session lifecycle routes: the home named by the logical runtime id in `x-matrix-collaboration-runtime`, which the ticket binds and the home re-verifies. */
    resolveSessionHome(logicalRuntimeId: string): Promise<RelayHome | null>;
    fetchImpl?: typeof fetch;
    limits?: Partial<RelayLimits>;
    now?: () => number;
    onMetadata?(metadata: RelayMetadata): void;
  }) {
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /** Forwards one HTTP request as opaque bytes. The body is never parsed or logged. */
  async forward(input: {
    actorId: string;
    method: string;
    path: string;
    query: string;
    headers: Headers;
    body: ReadableStream<Uint8Array> | Uint8Array | null;
    contentLength?: number;
  }): Promise<Response> {
    const startedAt = this.now();
    const route = parseRelayRoute(input.method, input.path);
    const finish = (status: number, outcome: RelayMetadata["outcome"], runtimeId: string | null, responseBytes = 0) => {
      this.options.onMetadata?.({
        actorId: input.actorId, runtimeId, resourceId: route?.identifier ?? null, method: input.method, path: input.path,
        requestBytes: input.contentLength ?? (input.body instanceof Uint8Array ? input.body.byteLength : 0), responseBytes,
        status, durationMs: this.now() - startedAt, outcome,
      });
    };
    if (!route) {
      finish(404, "rejected", null);
      return plain("Collaboration route not found", 404);
    }
    const declared = input.contentLength ?? (input.body instanceof Uint8Array ? input.body.byteLength : undefined);
    if (declared !== undefined && declared > this.limits.requestBytes) {
      finish(413, "limit", null);
      return plain("Collaboration request too large", 413);
    }
    const home = await this.resolveHome(input.actorId, route, input.headers.get(RELAY_RUNTIME_HEADER));
    if (!home) {
      finish(404, "unroutable", null);
      return plain("Collaboration route not found", 404);
    }
    const isExport = input.method === "GET" && /\/exports\/[0-9a-f-]{36}$/.test(input.path);
    // A chunked upload declares no length, so the check above cannot see it. The relay holds
    // its own limit against the bytes themselves rather than trusting whatever body limit the
    // caller mounted in front of it, which is a different constant in a different package.
    // Overflow errors the stream, which aborts the upstream request mid-body; `overflowed`
    // tells the rejection apart from a genuine upstream failure.
    let overflowed = false;
    let settleRequestBody: (() => void) | undefined;
    // Settles when the upload finishes, overflows, or is abandoned by whoever was reading it.
    const requestBodySettled = input.body instanceof ReadableStream
      ? new Promise<void>((resolve) => { settleRequestBody = resolve; })
      : Promise.resolve();
    const requestBody = input.body instanceof ReadableStream
      ? boundedRequestStream(input.body, this.limits.requestBytes, () => { overflowed = true; }, () => { settleRequestBody?.(); })
      : input.body;
    const headers = new Headers();
    input.headers.forEach((value, name) => {
      if (FORWARDED_REQUEST_HEADERS.has(name.toLowerCase()) && value.length <= MAX_HEADER_VALUE && !/[\r\n]/.test(value)) headers.set(name, value);
    });
    let response: Response;
    try {
      response = await this.fetchImpl(`${home.origin}${input.path}${input.query ? `?${input.query}` : ""}`, {
        method: input.method,
        headers,
        body: requestBody instanceof Uint8Array
          ? (requestBody.byteLength === 0 ? undefined : Uint8Array.from(requestBody).buffer)
          : requestBody ?? undefined,
        ...(requestBody instanceof ReadableStream ? { duplex: "half" } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(isExport ? this.limits.exportTimeoutMs : this.limits.requestTimeoutMs),
      } as RequestInit);
    } catch (error: unknown) {
      if (overflowed) {
        finish(413, "limit", home.runtimeId);
        return plain("Collaboration request too large", 413);
      }
      console.warn("[collaboration-relay] upstream unavailable", error instanceof Error ? error.name : "UnknownError");
      finish(503, "upstream_error", home.runtimeId);
      return plain("Collaboration unavailable", 503);
    }
    // The home may answer before the upload is done. The relay never answers for a body it
    // did not see through to a settled end -- completed, overflowed, or cancelled by whoever
    // was reading it -- so an overflow can never be discovered after the client has already
    // been handed the home's status. The wait for that end is bounded so an upload nobody
    // finishes cannot stall the reply; past the bound the relay has refused to finish
    // forwarding the body, and the home's answer no longer describes the request that was
    // made, so it is discarded rather than relayed. A truncated upload never reads as fine.
    const settled = requestBody instanceof ReadableStream
      ? await settleWithin(requestBodySettled, isExport ? this.limits.exportTimeoutMs : this.limits.requestTimeoutMs)
      : true;
    if (!settled) {
      await response.body?.cancel();
      console.warn("[collaboration-relay] request body did not settle before the upstream answer was due");
      finish(503, "upstream_error", home.runtimeId);
      return plain("Collaboration unavailable", 503);
    }
    if (overflowed) {
      await response.body?.cancel();
      finish(413, "limit", home.runtimeId);
      return plain("Collaboration request too large", 413);
    }
    const maxBytes = isExport ? this.limits.exportBytes : this.limits.responseBytes;
    const contentLength = Number(response.headers.get("content-length") ?? -1);
    if (contentLength > maxBytes) {
      await response.body?.cancel();
      finish(503, "limit", home.runtimeId);
      return plain("Collaboration unavailable", 503);
    }
    const responseHeaders = new Headers({ "cache-control": "private, no-store" });
    response.headers.forEach((value, name) => {
      if (FORWARDED_RESPONSE_HEADERS.has(name.toLowerCase()) && value.length <= MAX_HEADER_VALUE) responseHeaders.set(name, value);
    });
    let counted = 0;
    const body = response.body ? boundedStream(response.body, maxBytes, (bytes) => { counted = bytes; }, () => finish(response.status, "forwarded", home.runtimeId, counted)) : null;
    if (!body) finish(response.status, "forwarded", home.runtimeId, 0);
    return new Response(body, { status: response.status, headers: responseHeaders });
  }

  /** Starts the recurring stale-socket sweep; idempotent. `close()` stops it for good. */
  startSweep(): void {
    if (this.sweepTimer || this.closed) return;
    this.sweepTimer = setInterval(() => { this.sweepStaleSockets(); }, this.limits.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /** Test seam: the sweep timer must not outlive the relay. */
  sweepRunning(): boolean {
    return this.sweepTimer !== undefined;
  }

  /**
   * Shutdown drain. Every live reservation is released and its eviction hook run
   * (the upgrade listener destroys the relayed socket) before the directory and
   * dispatcher this relay depends on are torn down, so no socket is left pointing
   * at a dead upstream. One failing hook does not strand the reservations behind
   * it, and `prepareSocket` refuses afterwards rather than reserving a socket
   * nothing will ever drain. Idempotent.
   */
  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    if (this.closed) return;
    this.closed = true;
    for (const reservation of [...this.reservations.values()]) {
      reservation.release();
      try {
        reservation.onEvict?.();
      } catch (error: unknown) {
        console.warn("[collaboration-relay] socket drain hook failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
    this.reservations.clear();
    this.homeConnections.clear();
    this.actorConnections.clear();
  }

  /**
   * Evicts every reservation idle for longer than `socketIdleMs`: its counts are
   * released and its eviction hook (the upgrade listener destroys the socket) runs.
   * Returns the number evicted.
   */
  sweepStaleSockets(): number {
    const cutoff = this.now() - this.limits.socketIdleMs;
    let evicted = 0;
    for (const reservation of [...this.reservations.values()]) {
      if (reservation.lastTouched > cutoff) continue;
      reservation.release();
      evicted += 1;
      try {
        reservation.onEvict?.();
      } catch (error: unknown) {
        console.warn("[collaboration-relay] socket eviction hook failed", error instanceof Error ? error.name : "UnknownError");
      }
    }
    return evicted;
  }

  /** Resolves the home for a WebSocket upgrade and builds the upstream headers; no ticket is read or verified here. */
  async prepareSocket(input: { actorId: string; rawPath: string; incomingHeaders: IncomingMessage["headers"]; externalHost: string }): Promise<RelayPreparedSocket | null> {
    if (this.closed) return null;
    const socket = parseRelaySocketPath(input.rawPath);
    if (!socket) return null;
    let home: RelayHome | null;
    try {
      home = await this.options.resolveScopeHome(socket.scopeId);
    } catch (error: unknown) {
      console.warn("[collaboration-relay] socket directory lookup failed", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
    if (!home) return null;
    const homeCount = this.homeConnections.get(home.runtimeId) ?? 0;
    const actorCount = this.actorConnections.get(input.actorId) ?? 0;
    if (homeCount >= this.limits.connectionsPerHome || actorCount >= this.limits.connectionsPerActor) return null;
    // Overall bound on distinct keys: a new home or actor is refused once the registry is full.
    if ((homeCount === 0 && this.homeConnections.size >= this.limits.maxTrackedHomes)
      || (actorCount === 0 && this.actorConnections.size >= this.limits.maxTrackedActors)) return null;
    this.homeConnections.set(home.runtimeId, homeCount + 1);
    this.actorConnections.set(input.actorId, actorCount + 1);
    const lines = Object.entries(input.incomingHeaders).flatMap(([name, raw]) => {
      if (!FORWARDED_SOCKET_HEADERS.has(name) || raw === undefined) return [];
      const value = Array.isArray(raw) ? raw.join(", ") : raw;
      if (value.length > MAX_HEADER_VALUE || /[\r\n]/.test(value)) return [];
      return `${name}: ${value}`;
    });
    lines.push(`x-forwarded-host: ${input.externalHost}`, "x-forwarded-proto: https");
    const id = this.nextReservationId++;
    const reservation: RelaySocketReservation = {
      lastTouched: this.now(),
      release: () => {
        if (!this.reservations.delete(id)) return;
        decrement(this.homeConnections, home.runtimeId);
        decrement(this.actorConnections, input.actorId);
      },
    };
    this.reservations.set(id, reservation);
    return {
      home,
      upstreamPath: `${socket.path}${socket.query ? `?${socket.query}` : ""}`,
      headers: lines.join("\r\n"),
      release: reservation.release,
      touch: () => { reservation.lastTouched = this.now(); },
      onEvict: (hook) => { reservation.onEvict = hook; },
    };
  }

  connectionCounts(): { homes: number; actors: number } {
    let homes = 0;
    let actors = 0;
    for (const value of this.homeConnections.values()) homes += value;
    for (const value of this.actorConnections.values()) actors += value;
    return { homes, actors };
  }

  private async resolveHome(actorId: string, route: RelayRoute, runtimeHeader: string | null): Promise<RelayHome | null> {
    try {
      if (route.kind === "scope") return await this.options.resolveScopeHome(route.identifier!);
      if (route.kind === "invitation") return await this.options.resolveInvitationHome(actorId, route.identifier!);
      if (route.kind === "runtime") return await this.options.resolveRuntimeHome(actorId, route.identifier!);
      if (!runtimeHeader || !LOGICAL_RUNTIME_ID.test(runtimeHeader)) return null;
      return await this.options.resolveSessionHome(runtimeHeader);
    } catch (error: unknown) {
      console.warn("[collaboration-relay] directory lookup failed", error instanceof Error ? error.name : "UnknownError");
      return null;
    }
  }
}

/**
 * Caps a forwarded request body at `maxBytes`. The home is never handed more than the limit:
 * the overflowing chunk is not enqueued, the source is cancelled and the stream errors, which
 * aborts the in-flight upstream request.
 */
function boundedRequestStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number,
  onOverflow: () => void,
  onSettled: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          reader.releaseLock();
          onSettled();
          return;
        }
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          onOverflow();
          await reader.cancel();
          controller.error(new Error("Collaboration request exceeds safe limits"));
          onSettled();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error: unknown) {
        console.warn("[collaboration-relay] request stream failed", error instanceof Error ? error.name : "UnknownError");
        controller.error(new Error("Collaboration unavailable"));
        onSettled();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      onSettled();
    },
  });
}

/**
 * Waits for a settled signal without letting it become an unbounded wait. Answers whether the
 * signal arrived, so the caller can tell a finished body from one it gave up on.
 */
async function settleWithin(settled: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedStream(source: ReadableStream<Uint8Array>, maxBytes: number, onBytes: (bytes: number) => void, onDone: () => void): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let size = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          reader.releaseLock();
          onDone();
          return;
        }
        size += chunk.value.byteLength;
        onBytes(size);
        if (size > maxBytes) {
          await reader.cancel();
          controller.error(new Error("Collaboration response exceeds safe limits"));
          onDone();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (error: unknown) {
        console.warn("[collaboration-relay] response stream failed", error instanceof Error ? error.name : "UnknownError");
        controller.error(new Error("Collaboration unavailable"));
        onDone();
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
      onDone();
    },
  });
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key); else map.set(key, next);
}

function plain(message: string, status: 404 | 413 | 503): Response {
  return new Response(message, { status, headers: { "cache-control": "private, no-store", "content-type": "text/plain; charset=utf-8" } });
}
