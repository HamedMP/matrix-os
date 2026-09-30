/**
 * Shared direct transport client (S06 / T031).
 *
 * Every scope has one authoritative home. The client asks the platform for a
 * short-lived connection ticket, dials the origin the resource directory
 * returned (never a hardcoded one; in this release the platform relay),
 * exchanges the ticket once for a home session with Web Crypto proof of
 * possession, signs every request against that session, renews before the
 * five-minute cap and reconnects with a fresh ticket. A reconnect never
 * extends a lease; the platform is never consulted for authorization.
 * The relay does name the actor before it forwards, so a request to an
 * endpoint on the platform origin carries the platform credentials ticket
 * issuance carries; any other origin receives none.
 * Errors are typed and generic. Nothing reusable is written to storage.
 */
import {
  COLLABORATION_CLIENT_REQUEST_ID_HEADER,
  COLLABORATION_DIRECT_LIMITS,
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER,
  COLLABORATION_EXPECTED_REVISION_HEADER,
  CollaborationAppAssetPathSchema,
  CollaborationAppInstanceIdSchema,
  CollaborationDirectSessionSchema,
  CollaborationFailureResponseSchema,
  CollaborationOwnerRuntimeSessionSchema,
  CollaborationSignedOwnerRuntimeTicketSchema,
  CollaborationOrganizationIdSchema,
  CollaborationRuntimeIdSchema,
  CollaborationSignedConnectionTicketSchema,
  toLogicalRuntimeId,
  type CollaborationDirectSession,
  type CollaborationOwnerRuntimeSession,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  generateProofKey,
  possessionPayload,
  randomHex,
  randomId,
  requestSigningPayload,
  sha256Hex,
  signPayload,
  toBase64Url,
  type ProofKeyPair,
} from "./direct-crypto.js";
import { createDirectStreams, type DirectEventHandlers, type DirectTerminalHandlers } from "./direct-streams.js";
import { classifyCollaborationFailure } from "./failure-classification.js";

const REQUEST_TIMEOUT_MS = COLLABORATION_DIRECT_LIMITS.externalApiTimeoutMs;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SCOPE_RECORDS = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_HEADER = "x-matrix-collaboration-session";
const REQUEST_HEADER = "x-matrix-collaboration-request";
const RELAY_RUNTIME_HEADER = "x-matrix-collaboration-runtime";
/** Set only by the platform relay on its own 401; the relay never forwards it from a home. */
const PLATFORM_CHALLENGE_HEADER = "www-authenticate";

const IssuedTicketSchema = z.object({
  signedTicket: CollaborationSignedConnectionTicketSchema,
  endpoint: z.object({ origin: z.string().url(), protocolVersion: z.number().int() }).strict(),
}).strict();
const IssuedOwnerRuntimeTicketSchema = z.object({
  signedTicket: CollaborationSignedOwnerRuntimeTicketSchema,
  endpoint: z.object({ origin: z.string().url(), protocolVersion: z.number().int() }).strict(),
}).strict();

/** `unauthenticated`: the platform no longer recognizes the actor (sign in again); `denied`: the home ended or refused access. */
export type CollaborationDirectErrorCode =
  | "upgrade_required" | "host_offline" | "unauthenticated" | "denied" | "unavailable" | "not_found" | "invalid_request" | "invalid_response"
  | "access_removed" | "relay_limit" | "forbidden" | "unauthorized" | "resource_missing" | "paused";

/** Safe, generic client error: never carries provider, host or path detail. */
export class CollaborationDirectError extends Error {
  constructor(public readonly code: CollaborationDirectErrorCode, message = "Collaboration unavailable", public readonly retryAfterSeconds?: number) {
    super(message);
    this.name = "CollaborationDirectError";
  }
}

export type DirectScopeState = "idle" | "connecting" | "connected" | "offline" | "upgrade_required" | "unauthenticated" | "denied"
  | "unavailable" | "access_removed" | "relay_limit" | "forbidden" | "unauthorized" | "resource_missing" | "paused";
export type DirectMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export interface DirectDeleteConditions { clientRequestId: string; expectedRevision: string; expectedMemberRevision: string }

export type { DirectEventHandlers, DirectTerminalHandlers } from "./direct-streams.js";

export interface CollaborationDirectClientOptions {
  /** The platform origin used for identity, discovery and ticket issuance. */
  platformBaseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * Actor authentication for the platform origin only: ticket issuance and, while a resource
   * endpoint is the platform relay, relay-bound requests (the relay strips it before forwarding).
   * Never sent to any other origin.
   */
  getHeaders?: () => Promise<Record<string, string>>;
  webSocketFactory?: (url: string) => WebSocket;
  /** The origin this client runs on; the home checks it against its allowlist. */
  clientOrigin?: string;
  subtle?: SubtleCrypto;
  now?: () => Date;
}

/** Largest resource body a client may hold in memory; the platform relay also caps responses at 2 MiB. */
export const COLLABORATION_CONTENT_MAX_BYTES = 2 * 1024 * 1024;

/** Bytes of one shared file, bounded in memory; `too_large` carries the declared size when the home sent one. */
export type CollaborationContent =
  | { status: "ok"; bytes: Uint8Array; contentType: string; size: number }
  | { status: "too_large"; size: number | null };

export interface CollaborationDirectClient {
  request(scopeId: string, method: DirectMethod, path: string, body?: unknown, conditions?: DirectDeleteConditions): Promise<unknown>;
  /** Signed GET of bounded file bytes or a scoped app asset. */
  requestContent(scopeId: string, path: string, options: { maxBytes: number }): Promise<CollaborationContent>;
  requestOwnerRuntime(runtimeId: string, organizationId: string, path: string, body: unknown): Promise<unknown>;
  requestOwnerProject(runtimeId: string, organizationId: string, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  subscribeEvents(scopeId: string, handlers: DirectEventHandlers): () => void;
  subscribeTerminal(scopeId: string, handlers: DirectTerminalHandlers): () => void;
  describe(scopeId: string): { state: DirectScopeState; origin: string | null; expiresAt: string | null };
  /** Closes one scope's session (or all) on the home, best effort. */
  close(scopeId?: string): void;
  /** Test seam: the in-memory proof key for a scope; the private key is not extractable. */
  inspectKeys(scopeId: string): ProofKeyPair | null;
}

export interface DirectConnected { session: CollaborationDirectSession; origin: string; key: ProofKeyPair }
type Connected = DirectConnected;

interface ScopeRecord {
  state: DirectScopeState;
  connected: Connected | null;
  pending: Promise<Connected> | null;
  key: ProofKeyPair | null;
  generation: number;
}
interface OwnerRuntimeRecord {
  connected: { session: CollaborationOwnerRuntimeSession; origin: string; key: ProofKeyPair } | null;
  pending: Promise<{ session: CollaborationOwnerRuntimeSession; origin: string; key: ProofKeyPair }> | null;
  key: ProofKeyPair | null;
}

export function createCollaborationDirectClient(options: CollaborationDirectClientOptions): CollaborationDirectClient {
  const platform = requireOrigin(options.platformBaseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const clientOrigin = options.clientOrigin ?? globalThis.location?.origin ?? platform.origin;
  const scopes = new Map<string, ScopeRecord>();
  let disposed = false;
  const ownerRuntimes = new Map<string, OwnerRuntimeRecord>();

  const record = (scopeId: string): ScopeRecord => {
    if (disposed) throw new CollaborationDirectError("denied", "Collaboration session closed");
    let entry = scopes.get(scopeId);
    if (!entry) {
      if (scopes.size >= MAX_SCOPE_RECORDS) {
        const oldest = scopes.keys().next().value;
        if (oldest) closeScope(oldest);
      }
      entry = { state: "idle", connected: null, pending: null, key: null, generation: 0 };
      scopes.set(scopeId, entry);
    }
    return entry;
  };

  const platformAuthorization = async (): Promise<string | null> => {
    const provided = await options.getHeaders?.();
    const authorization = provided?.Authorization ?? provided?.authorization;
    return authorization && authorization.length <= 4_096 ? authorization : null;
  };

  const platformHeaders = async (): Promise<Headers> => {
    const headers = new Headers({ accept: "application/json", "content-type": "application/json" });
    const authorization = await platformAuthorization();
    if (authorization) headers.set("authorization", authorization);
    return headers;
  };

  /**
   * The relay authenticates the actor before forwarding, so an endpoint on the platform origin gets
   * exactly what ticket issuance gets: the same-origin cookie on the web and any provided
   * Authorization (Electron's trusted core injects its own at the network layer). Every other
   * origin gets no credential at all.
   */
  const endpointCredentials = async (origin: string, headers: Headers): Promise<RequestCredentials> => {
    if (origin !== platform.origin) return "omit";
    const authorization = await platformAuthorization();
    if (authorization) headers.set("authorization", authorization);
    return "same-origin";
  };

  /** A 401 the platform relay itself answered: the actor must sign in again; a home's 401 never carries it. */
  const isPlatformChallenge = (response: Response, origin: string): boolean =>
    origin === platform.origin && response.status === 401 && response.headers.has(PLATFORM_CHALLENGE_HEADER);

  /** Platform: `POST /api/collaboration/connections`. A 404/503 means the home is unreachable or the scope is unknown. */
  const issueTicket = async (scopeId: string, purpose: "direct_session" | "events" | "terminal", key: ProofKeyPair) => {
    const current = purpose === "direct_session" ? scopes.get(scopeId) : null;
    const generation = current?.generation;
    const response = await guardedFetch(fetchImpl, new URL("/api/collaboration/connections", platform).href, {
      method: "POST",
      headers: await platformHeaders(),
      credentials: "same-origin",
      redirect: "error",
      body: JSON.stringify({ clientRequestId: randomId(), scopeId, purpose, proofPublicKey: key.publicKeyRaw }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    try {
      await throwForResponse(response, isPlatformChallenge(response, platform.origin), true);
    } catch (error: unknown) {
      if (current && scopes.get(scopeId) === current && current.generation === generation && current.key === key
        && error instanceof CollaborationDirectError) current.state = scopeStateFor(error.code);
      throw error;
    }
    const raw = await readJson(response);
    // A newer platform protocol is an upgrade signal before any strict parsing rejects it.
    const advertised = (raw as { endpoint?: { protocolVersion?: unknown }; signedTicket?: { ticket?: { protocolVersion?: unknown } } } | null);
    const versions = [advertised?.endpoint?.protocolVersion, advertised?.signedTicket?.ticket?.protocolVersion];
    if (versions.some((version) => typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION)) {
      throw new CollaborationDirectError("upgrade_required", "Collaboration client update required");
    }
    const issued = IssuedTicketSchema.safeParse(raw);
    if (!issued.success) throw new CollaborationDirectError("invalid_response");
    if (issued.data.signedTicket.ticket.resource.scopeId !== scopeId) throw new CollaborationDirectError("invalid_response");
    return { signedTicket: issued.data.signedTicket, origin: requireOrigin(issued.data.endpoint.origin).origin };
  };

  const homeJson = async (origin: string, path: string, query: string, body: unknown, runtimeId: string): Promise<unknown> => {
    const url = new URL(path, origin);
    url.search = query;
    const headers = new Headers({ accept: "application/json", "content-type": "application/json", [RELAY_RUNTIME_HEADER]: runtimeId });
    const response = await guardedFetch(fetchImpl, url.href, {
      method: "POST",
      headers,
      credentials: await endpointCredentials(origin, headers),
      redirect: "error",
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await throwForResponse(response, isPlatformChallenge(response, origin));
    return readJson(response);
  };

  const exchange = async (scopeId: string, key: ProofKeyPair): Promise<Connected> => {
    const { signedTicket, origin } = await issueTicket(scopeId, "direct_session", key);
    const possession = await signPayload(key, possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose: "direct_session" }), options.subtle);
    const session = CollaborationDirectSessionSchema.safeParse(await homeJson(origin, "/api/collaboration/direct-sessions", `scope=${scopeId}`, {
      clientRequestId: randomId(), signedTicket, proofPublicKey: key.publicKeyRaw, possession, clientOrigin,
    }, signedTicket.ticket.runtime.runtimeId));
    if (!session.success || session.data.scopeId !== scopeId || session.data.runtimeId !== signedTicket.ticket.runtime.runtimeId) {
      throw new CollaborationDirectError("invalid_response");
    }
    return { session: session.data, origin, key };
  };

  const exchangeOwnerRuntime = async (runtimeId: string, organizationId: string, key: ProofKeyPair): Promise<NonNullable<OwnerRuntimeRecord["connected"]>> => {
    const response = await guardedFetch(fetchImpl, new URL("/api/collaboration/owner-runtime/connections", platform).href, {
      method: "POST", headers: await platformHeaders(), credentials: "same-origin", redirect: "error",
      body: JSON.stringify({ clientRequestId: randomId(), runtimeId, organizationId, proofPublicKey: key.publicKeyRaw }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await throwForResponse(response, isPlatformChallenge(response, platform.origin), true);
    const raw = await readJson(response);
    const advertised = (raw as { endpoint?: { protocolVersion?: unknown }; signedTicket?: { ticket?: { protocolVersion?: unknown } } } | null);
    if ([advertised?.endpoint?.protocolVersion, advertised?.signedTicket?.ticket?.protocolVersion]
      .some((version) => typeof version === "number" && version !== COLLABORATION_DIRECT_PROTOCOL_VERSION)) {
      throw new CollaborationDirectError("upgrade_required", "Collaboration client update required");
    }
    const issued = IssuedOwnerRuntimeTicketSchema.safeParse(raw);
    // The same canonicalization the platform and the home apply: only a VPS
    // enrollment id is rewritten, so a logical runtime id keeps its case.
    const logicalRuntimeId = toLogicalRuntimeId(runtimeId);
    if (!issued.success || issued.data.signedTicket.ticket.organizationId !== organizationId
      || issued.data.signedTicket.ticket.runtime.runtimeId !== logicalRuntimeId) throw new CollaborationDirectError("invalid_response");
    const { signedTicket } = issued.data;
    const origin = requireOrigin(issued.data.endpoint.origin).origin;
    const possession = await signPayload(key, possessionPayload({ ticketNonce: signedTicket.ticket.nonce, purpose: "owner_runtime" }), options.subtle);
    const session = CollaborationOwnerRuntimeSessionSchema.safeParse(await homeJson(origin, "/api/collaboration/owner-runtime/sessions", "", {
      clientRequestId: randomId(), signedTicket, proofPublicKey: key.publicKeyRaw, possession, clientOrigin,
    }, logicalRuntimeId));
    if (!session.success || session.data.organizationId !== organizationId || session.data.runtimeId !== logicalRuntimeId) {
      throw new CollaborationDirectError("invalid_response");
    }
    return { session: session.data, origin, key };
  };

  const renew = async (scopeId: string, current: Connected): Promise<Connected> => {
    const { signedTicket } = await issueTicket(scopeId, "direct_session", current.key);
    const session = CollaborationDirectSessionSchema.safeParse(await homeJson(
      current.origin, `/api/collaboration/direct-sessions/${current.session.id}/renew`, `scope=${scopeId}`,
      { clientRequestId: randomId(), signedTicket },
      current.session.runtimeId,
    ));
    if (!session.success || session.data.id !== current.session.id) throw new CollaborationDirectError("invalid_response");
    return { ...current, session: session.data };
  };

  const closedError = () => new CollaborationDirectError("denied", "Collaboration session closed");

  /** A close increments the record generation, fencing every pending exchange or renewal. */
  const ensure = async (scopeId: string, fresh = false): Promise<Connected> => {
    if (disposed) throw closedError();
    const entry = record(scopeId);
    if (entry.pending) return entry.pending;
    const generation = entry.generation;
    const active = () => !disposed && scopes.get(scopeId) === entry && entry.generation === generation;
    const current = entry.connected;
    const at = now().getTime();
    if (current && !fresh && Date.parse(current.session.expiresAt) > at + 1_000
      && Date.parse(current.session.renewAfter) > at) return current;

    const connectFresh = async (): Promise<Connected> => {
      entry.key ??= await generateProofKey(options.subtle);
      if (!active()) throw closedError();
      const connected = await exchange(scopeId, entry.key);
      if (!active()) {
        closeConnected(scopeId, connected);
        throw closedError();
      }
      entry.connected = connected;
      entry.state = "connected";
      return connected;
    };
    const connect = async (): Promise<Connected> => {
      try {
        if (current && !fresh && Date.parse(current.session.expiresAt) > at + 1_000) {
          try {
            const renewed = await renew(scopeId, current);
            if (!active()) throw closedError();
            entry.connected = renewed;
            entry.state = "connected";
            return renewed;
          } catch (error: unknown) {
            if (!active()) throw closedError();
            if (error instanceof CollaborationDirectError
              && ["upgrade_required", "host_offline", "unauthenticated", "access_removed", "relay_limit", "forbidden", "unauthorized", "resource_missing", "paused"].includes(error.code)) throw error;
          }
        }
        if (!active()) throw closedError();
        entry.connected = null;
        return await connectFresh();
      } catch (error: unknown) {
        if (active()) {
          entry.connected = null;
          entry.state = error instanceof CollaborationDirectError ? scopeStateFor(error.code) : "idle";
        }
        throw error;
      }
    };
    entry.state = "connecting";
    const pending = connect();
    entry.pending = pending;
    const clearPending = () => { if (entry.pending === pending) entry.pending = null; };
    void pending.then(clearPending, clearPending);
    return pending;
  };

  const ensureOwnerRuntime = async (runtimeId: string, organizationId: string, fresh = false): Promise<NonNullable<OwnerRuntimeRecord["connected"]>> => {
    const id = `${runtimeId}\u0000${organizationId}`;
    let entry = ownerRuntimes.get(id);
    if (!entry) {
      if (ownerRuntimes.size >= 16) ownerRuntimes.delete(ownerRuntimes.keys().next().value!);
      entry = { connected: null, pending: null, key: null };
    } else ownerRuntimes.delete(id);
    ownerRuntimes.set(id, entry);
    if (entry.pending) return entry.pending;
    if (entry.connected && !fresh && Date.parse(entry.connected.session.renewAfter) > now().getTime()) return entry.connected;
    entry.pending = (async () => {
      entry!.key ??= await generateProofKey(options.subtle);
      const connected = await exchangeOwnerRuntime(runtimeId, organizationId, entry!.key);
      entry!.connected = connected;
      return connected;
    })().catch((error: unknown) => { entry!.connected = null; throw error; }).finally(() => { entry!.pending = null; });
    return entry.pending;
  };

  const signedFetch = async (_scopeId: string, connected: { session: { id: string; runtimeId: string }; origin: string; key: ProofKeyPair }, method: DirectMethod, path: string, query: string, body: string | undefined, conditions?: DirectDeleteConditions, ownerProject = false) => {
    const bodyBytes = new TextEncoder().encode(body ?? "");
    const conditional = conditions
      ? new TextEncoder().encode(JSON.stringify({ clientRequestId: conditions.clientRequestId, expectedRevision: conditions.expectedRevision, expectedMemberRevision: conditions.expectedMemberRevision }))
      : new Uint8Array();
    const signature = {
      protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION,
      sessionId: connected.session.id,
      method,
      path,
      query,
      bodyDigest: await sha256Hex(bodyBytes, options.subtle),
      conditionalHeadersDigest: await sha256Hex(conditional, options.subtle),
      nonce: randomHex(),
      issuedAt: now().toISOString(),
    };
    const proof = await signPayload(connected.key, requestSigningPayload(signature), options.subtle);
    const headers = new Headers({ accept: "application/json" });
    if (body !== undefined) headers.set("content-type", "application/json");
    headers.set(SESSION_HEADER, connected.session.id);
    headers.set(RELAY_RUNTIME_HEADER, connected.session.runtimeId);
    headers.set(REQUEST_HEADER, toBase64Url(new TextEncoder().encode(JSON.stringify({ signature, proof }))));
    if (ownerProject) headers.set("x-matrix-collaboration-owner-runtime", "1");
    if (conditions) {
      headers.set(COLLABORATION_CLIENT_REQUEST_ID_HEADER, conditions.clientRequestId);
      headers.set(COLLABORATION_EXPECTED_REVISION_HEADER, conditions.expectedRevision);
      headers.set(COLLABORATION_EXPECTED_MEMBER_REVISION_HEADER, conditions.expectedMemberRevision);
    }
    const url = new URL(path, connected.origin);
    url.search = query;
    return guardedFetch(fetchImpl, url.href, {
      method, headers, credentials: await endpointCredentials(connected.origin, headers), redirect: "error",
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  };

  const closeConnected = (scopeId: string, connected: Connected) => {
    void signedFetch(scopeId, connected, "DELETE", `/api/collaboration/direct-sessions/${connected.session.id}`, "", undefined)
      .then((response) => response.body?.cancel())
      .catch((error: unknown) => { console.warn("[collaboration-direct] session close failed", error instanceof Error ? error.name : "UnknownError"); });
  };

  const request: CollaborationDirectClient["request"] = async (scopeId, method, rawPath, body, conditions) => {
    if (!UUID.test(scopeId)) throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    const { path, query } = splitPath(rawPath, scopeId);
    const serialized = method === "DELETE" || body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > COLLABORATION_DIRECT_LIMITS.httpJsonBytes) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const initial = record(scopeId);
    const generation = initial.generation;
    let connected = await ensure(scopeId);
    if (disposed || initial.generation !== generation) throw closedError();
    let response = await signedFetch(scopeId, connected, method, path, query, serialized, conditions);
    if (disposed || initial.generation !== generation) { await response.body?.cancel(); throw closedError(); }
    if (response.status === 401 && !isPlatformChallenge(response, connected.origin)) {
      // The session ended on the home (expiry, denial or a new authority generation): one fresh ticket, one retry.
      await response.body?.cancel();
      const entry = record(scopeId);
      entry.connected = null;
      connected = await ensure(scopeId, true);
      response = await signedFetch(scopeId, connected, method, path, query, serialized, conditions);
      if (disposed || initial.generation !== generation) { await response.body?.cancel(); throw closedError(); }
    }
    // The home session outlives a lapsed platform session, so it is kept for when the actor signs back in.
    const challenged = isPlatformChallenge(response, connected.origin);
    if (challenged) initial.state = "unauthenticated";
    else if (initial.state === "unauthenticated") initial.state = "connected";
    await throwForResponse(response, challenged);
    if (response.status === 204) {
      await response.body?.cancel();
      return null;
    }
    return readJson(response);
  };

  const requestOwnerRuntime: CollaborationDirectClient["requestOwnerRuntime"] = async (runtimeId, organizationId, path, body) => {
    if (!CollaborationRuntimeIdSchema.safeParse(runtimeId).success || !CollaborationOrganizationIdSchema.safeParse(organizationId).success
      || !body || typeof body !== "object" || (body as { organizationId?: unknown }).organizationId !== organizationId) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const prefix = `/api/collaboration/runtimes/${encodeURIComponent(runtimeId)}`;
    if (![`${prefix}/catalog/resolve`, `${prefix}/scopes/preflight`, `${prefix}/scopes`].includes(path)) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > COLLABORATION_DIRECT_LIMITS.httpJsonBytes) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    let connected = await ensureOwnerRuntime(runtimeId, organizationId);
    let response = await signedFetch(runtimeId, connected, "POST", path, "", serialized);
    if (response.status === 401 && !isPlatformChallenge(response, connected.origin)) {
      await response.body?.cancel();
      connected = await ensureOwnerRuntime(runtimeId, organizationId, true);
      response = await signedFetch(runtimeId, connected, "POST", path, "", serialized);
    }
    await throwForResponse(response, isPlatformChallenge(response, connected.origin));
    if (response.status === 204) { await response.body?.cancel(); return null; }
    return readJson(response);
  };

  const requestOwnerProject: CollaborationDirectClient["requestOwnerProject"] = async (runtimeId, organizationId, method, path, body) => {
    if (!CollaborationRuntimeIdSchema.safeParse(runtimeId).success || !CollaborationOrganizationIdSchema.safeParse(organizationId).success) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const project = /^\/api\/collaboration\/scopes\/([0-9a-f-]{36})(?:\/(members|project\/inventory|project\/confirm))?$/.exec(path);
    if (!project || !UUID.test(project[1]!) || (project[2] === "project/confirm" ? method !== "POST" : method !== "GET")
      || (method === "GET" && body !== undefined) || (method === "POST" && (body === undefined || typeof body !== "object"))) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > COLLABORATION_DIRECT_LIMITS.httpJsonBytes) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    let connected = await ensureOwnerRuntime(runtimeId, organizationId);
    let response = await signedFetch(runtimeId, connected, method, path, "", serialized, undefined, true);
    if (response.status === 401 && !isPlatformChallenge(response, connected.origin)) {
      await response.body?.cancel();
      connected = await ensureOwnerRuntime(runtimeId, organizationId, true);
      response = await signedFetch(runtimeId, connected, method, path, "", serialized, undefined, true);
    }
    await throwForResponse(response, isPlatformChallenge(response, connected.origin));
    return readJson(response);
  };

  const requestContent: CollaborationDirectClient["requestContent"] = async (scopeId, rawPath, { maxBytes }) => {
    if (!UUID.test(scopeId) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > COLLABORATION_CONTENT_MAX_BYTES) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const { path, query } = splitPath(rawPath, scopeId);
    const fileContent = new RegExp(`^/api/collaboration/scopes/${scopeId}/files/[0-9a-f-]{36}/content$`).test(path);
    const appAsset = new RegExp(`^/api/collaboration/scopes/${scopeId}/apps/([^/]+)/assets/(.+)$`).exec(path);
    const scopedAsset = Boolean(appAsset && CollaborationAppInstanceIdSchema.safeParse(appAsset[1]).success
      && CollaborationAppAssetPathSchema.safeParse(appAsset[2]).success);
    if (query !== "" || (!fileContent && !scopedAsset)) {
      throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
    }
    const initial = record(scopeId);
    const generation = initial.generation;
    let connected = await ensure(scopeId);
    if (disposed || initial.generation !== generation) throw closedError();
    let response = await signedFetch(scopeId, connected, "GET", path, "", undefined);
    if (disposed || initial.generation !== generation) { await response.body?.cancel(); throw closedError(); }
    if (response.status === 401 && !isPlatformChallenge(response, connected.origin)) {
      await response.body?.cancel();
      record(scopeId).connected = null;
      connected = await ensure(scopeId, true);
      response = await signedFetch(scopeId, connected, "GET", path, "", undefined);
      if (disposed || initial.generation !== generation) { await response.body?.cancel(); throw closedError(); }
    }
    if (response.status === 503 && await isRelayTooLarge(response)) {
      await response.body?.cancel();
      return { status: "too_large", size: null };
    }
    const challenged = isPlatformChallenge(response, connected.origin);
    if (challenged) initial.state = "unauthenticated";
    else if (initial.state === "unauthenticated") initial.state = "connected";
    await throwForResponse(response, challenged);
    return readBoundedContent(response, maxBytes);
  };

  const streams = createDirectStreams({
    ensure,
    issueTicket: (scopeId, purpose, key) => issueTicket(scopeId, purpose, key),
    subtle: options.subtle,
    webSocketFactory: options.webSocketFactory,
  });

  const closeScope = (scopeId: string) => {
    streams.closeScope(scopeId);
    const entry = scopes.get(scopeId);
    if (!entry) return;
    entry.generation += 1;
    const connected = entry.connected;
    entry.connected = null;
    entry.pending = null;
    entry.key = null;
    entry.state = "idle";
    scopes.delete(scopeId);
    if (connected) closeConnected(scopeId, connected);
  };

  return {
    request,
    requestContent,
    requestOwnerRuntime,
    requestOwnerProject,
    subscribeEvents: streams.subscribeEvents,
    subscribeTerminal: streams.subscribeTerminal,
    describe: (scopeId) => {
      const entry = scopes.get(scopeId);
      return { state: entry?.state ?? "idle", origin: entry?.connected?.origin ?? null, expiresAt: entry?.connected?.session.expiresAt ?? null };
    },
    close: (scopeId) => {
      if (scopeId) closeScope(scopeId);
      else {
        disposed = true;
        streams.closeAll();
        for (const id of [...scopes.keys()]) closeScope(id);
        ownerRuntimes.clear();
      }
    },
    inspectKeys: (scopeId) => scopes.get(scopeId)?.key ?? null,
  };
}

function splitPath(rawPath: string, scopeId: string): { path: string; query: string } {
  if (rawPath.length > 1_024 || rawPath.includes("..") || rawPath.includes("//") || rawPath.includes("#")) {
    throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
  }
  const [path = "", query = ""] = rawPath.split("?", 2);
  const scopePrefix = `/api/collaboration/scopes/${scopeId}`;
  const scoped = path === scopePrefix || path.startsWith(`${scopePrefix}/`);
  const invitation = /^\/api\/collaboration\/invitations\/[0-9a-f-]{36}(?:\/(?:accept|decline))?$/.test(path);
  if (!scoped && !invitation) throw new CollaborationDirectError("invalid_request", "Invalid collaboration request");
  return { path, query };
}

function requireOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[collaboration-direct] origin parse failed", error instanceof Error ? error.name : "UnknownError");
    throw new CollaborationDirectError("invalid_response");
  }
  if (!url.hostname || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new CollaborationDirectError("invalid_response");
  }
  return url;
}

async function guardedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error: unknown) {
    console.warn("[collaboration-direct] request failed", error instanceof Error ? error.name : "UnknownError");
    throw new CollaborationDirectError("unavailable");
  }
}

/** A platform challenge is distinct from a home session denial. */
async function throwForResponse(response: Response, platformChallenge = false, ticketEndpoint = false): Promise<void> {
  if (response.ok) return;
  let body: unknown;
  try {
    body = await readJson(response);
  } catch (error: unknown) {
    if (!(error instanceof CollaborationDirectError)) console.warn("[collaboration-direct] failure body rejected", error instanceof Error ? error.name : "UnknownError");
  }
  // A relay challenge requires a fresh platform login. A home's 401 means its
  // own direct session was rejected, even if it sends the same wire code.
  if (response.status === 401 && platformChallenge) {
    throw new CollaborationDirectError("unauthenticated", "Sign in again to continue");
  }
  if (response.status === 401 && !ticketEndpoint) throw new CollaborationDirectError("denied", "Collaboration action denied");
  const parsed = CollaborationFailureResponseSchema.safeParse(body);
  if (parsed.success) {
    const classified = classifyCollaborationFailure({ status: response.status, ...parsed.data });
    if (classified.state !== "unavailable" || response.status === 503) {
      throw new CollaborationDirectError(classified.state, classified.message, classified.retryAfterSeconds);
    }
  }
  if (response.status === 404) throw new CollaborationDirectError("unavailable");
  if (response.status === 426) throw new CollaborationDirectError("upgrade_required", "Collaboration client update required");
  if (response.status === 401) throw new CollaborationDirectError("unauthorized", "Sign in again to continue");
  if (response.status === 403) throw new CollaborationDirectError("forbidden", "Collaboration action denied");
  if (response.status === 409 || response.status === 413 || response.status === 422) throw new CollaborationDirectError("invalid_request", "Collaboration state changed");
  throw new CollaborationDirectError("unavailable");
}

function scopeStateFor(code: CollaborationDirectErrorCode): DirectScopeState {
  if (code === "host_offline") return "offline";
  if (["upgrade_required", "unauthenticated", "denied", "unavailable", "access_removed", "relay_limit", "forbidden", "unauthorized", "resource_missing", "paused"].includes(code)) {
    return code as DirectScopeState;
  }
  return "idle";
}

/** The platform relay answers a declared oversize response with a 503 carrying `code: "too_large"`. */
async function isRelayTooLarge(response: Response): Promise<boolean> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) return false;
  if (Number(response.headers.get("content-length") ?? 0) > 1_024) return false;
  try {
    const text = await response.clone().text();
    if (text.length > 1_024) return false;
    const body = JSON.parse(text) as unknown;
    return typeof body === "object" && body !== null && (body as { code?: unknown }).code === "too_large";
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[collaboration-direct] relay error parse failed", error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

async function readBoundedContent(response: Response, maxBytes: number): Promise<CollaborationContent> {
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  const declaredSize = declared !== null && Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
  if (declaredSize !== null && declaredSize > maxBytes) {
    await response.body?.cancel();
    return { status: "too_large", size: declaredSize };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (reader) {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        return { status: "too_large", size: declaredSize };
      }
      chunks.push(next.value);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return {
    status: "ok",
    bytes,
    contentType: /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mediaType) ? mediaType : "application/octet-stream",
    size: received,
  };
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.startsWith("application/json")) {
    await response.body?.cancel();
    throw new CollaborationDirectError("invalid_response");
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new CollaborationDirectError("invalid_response");
  }
  if (!response.body) throw new CollaborationDirectError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CollaborationDirectError("invalid_response");
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const text = new TextDecoder().decode(bytes);
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[collaboration-direct] response parse failed", error instanceof Error ? error.name : "UnknownError");
    throw new CollaborationDirectError("invalid_response");
  }
}
